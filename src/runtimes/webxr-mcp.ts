// WebXR runtime MCP server (stdio): serves a WebXR study app, drives it in a
// headless Chrome over the DevTools protocol and exposes only what a participant
// could see or do. The app must expose window.xrStudy (see the graphics-quality
// example): start, select, look, listObjects, getState.
//   node dist/runtimes/webxr-mcp.js <job-dir>
// Observation is mono: the desktop page has no stereo pair.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { agentPath } from "./guard.js";
import { budgetNearlyUsed, serveMcp, text, ToolError, type Tool } from "./mcp.js";

interface WebXRSpec {
  jobId: string;
  budget: number;
  tokenBudget?: number | null;
  chromePath: string;
  app: { dir: string; query: string };
  /** Participant of an individual job, for {participant} in the app query ("population" otherwise). */
  participant?: string | null;
  /** Designs in the order this job must visit them, with their case IDs per phase. */
  designs: { id: string; label: string; practice: { caseId: string; phaseId: string } | null; main: { caseId: string; phaseId: string } | null }[];
}
const jobDir = resolve(process.argv[2] ?? ".");
const spec = (JSON.parse(await readFile(join(jobDir, "job.json"), "utf8")) as { webxr: WebXRSpec }).webxr;
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const log = (entry: Record<string, unknown>) =>
  appendFile(join(jobDir, "trace.jsonl"), JSON.stringify({ t: Date.now(), server: "webxr", ...entry }) + "\n");
async function countCall(tool: string) {
  if (spec.tokenBudget && (await budgetNearlyUsed(jobDir, spec.tokenBudget)))
    throw new ToolError(`Token budget of ${spec.tokenBudget} tokens is nearly used up. Submit your forecast now.`);
  await appendFile(join(jobDir, "calls.log"), tool + "\n");
  const used = (await readFile(join(jobDir, "calls.log"), "utf8")).trim().split("\n").length;
  if (used > spec.budget) throw new ToolError(`Tool budget of ${spec.budget} calls is used up. Submit your forecast now.`);
}

// ---------- static app server ----------
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm" };
const appRoot = (() => {
  try {
    return realpathSync(resolve(spec.app.dir));
  } catch {
    return resolve(spec.app.dir);
  }
})();
let appPort = 0;
const server: Server = createServer(async (req, res) => {
  try {
    const path = resolve(appRoot, "." + decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    // Only files of the app folder (symlinks resolved); never human results or run records.
    const real = agentPath(appRoot, path === appRoot || (existsSync(path) && statSync(path).isDirectory()) ? join(path, "index.html") : path);
    if (!real || !statSync(real).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": types[extname(real)] ?? "application/octet-stream" });
    res.end(await readFile(real));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
appPort = (server.address() as { port: number }).port;

// ---------- Chrome over DevTools ----------
let chrome: ChildProcess | undefined;
let profile: string | undefined;
let ws: WebSocket | undefined;
let seq = 0;
const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
function cdp(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<any> {
  return new Promise((ok, fail) => {
    if (!ws) return fail(new ToolError("The app is not open. Call open_design."));
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      void resetBrowser();
      fail(new ToolError(`The app did not respond within ${timeoutMs / 1000} s and was restarted. Call open_design again for the design you were on.`));
    }, timeoutMs);
    pending.set(id, {
      ok: (v) => (clearTimeout(timer), ok(v)),
      fail: (e) => (clearTimeout(timer), fail(e)),
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
/** Close Chrome and forget the open design; the next open_design starts a fresh browser. */
async function resetBrowser() {
  const socket = ws;
  ws = undefined;
  design = undefined;
  stage = "done";
  for (const [id, p] of pending) {
    pending.delete(id);
    p.fail(new ToolError("The app was restarted. Call open_design again."));
  }
  try {
    socket?.close();
  } catch {
    // already closed
  }
  const proc = chrome;
  chrome = undefined;
  if (proc && proc.exitCode === null && proc.signalCode === null) {
    // Wait for Chrome to exit before removing its profile: on Windows its files stay locked until then.
    const exited = new Promise((ok) => proc.once("exit", ok));
    proc.kill("SIGKILL");
    await Promise.race([exited, new Promise((ok) => setTimeout(ok, 5000))]);
  }
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  profile = undefined;
}
async function browser(): Promise<void> {
  if (ws) return;
  profile = await mkdtemp(join(tmpdir(), "xr-webxr-"));
  chrome = spawn(
    spec.chromePath,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      "--window-size=1280,720",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const port = await new Promise<number>((ok, fail) => {
    const timer = setTimeout(() => fail(new ToolError("Chrome did not start. Check the Chrome path in Settings.")), 20_000);
    let buf = "";
    chrome!.stderr!.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        ok(Number(m[1]));
      }
    });
    chrome!.on("error", (e) => fail(new ToolError(`Chrome could not start: ${e.message}`)));
  });
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new ToolError("No Chrome page available.");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((ok, fail) => {
    ws!.onopen = () => ok();
    ws!.onerror = () => fail(new ToolError("DevTools connection failed."));
  });
  ws.onclose = () => {
    if (ws) void resetBrowser();
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(String(m.data));
    const p = msg.id !== undefined ? pending.get(msg.id) : undefined;
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.fail(new ToolError(msg.error.message)) : p.ok(msg.result);
  };
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await reportRuntime();
}
// The runtime's own identity for the audit (bridge contract: a "runtime" trace event), once per session.
let reported = false;
async function reportRuntime() {
  if (reported) return;
  reported = true;
  let version = "unknown";
  try {
    version = String((await cdp("Browser.getVersion")).product ?? "unknown");
  } catch {
    // older DevTools endpoints: keep "unknown"
  }
  await log({
    event: {
      type: "runtime",
      engine: "webxr",
      engineVersion: version,
      backend: "chrome-headless",
      deviceProfile: "webxr-desktop-browser-1280x720",
      observation: "mono",
      capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"],
    },
  });
}
async function evaluate(expression: string): Promise<any> {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new ToolError(`App error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- case bookkeeping (audit trace) ----------
let design: WebXRSpec["designs"][number] | undefined;
let stage: "practice" | "main" | "done" = "done";
let openedAt = 0;
let frames = 0;
const current = () => (design ? (stage === "practice" ? design.practice : stage === "main" ? design.main : null) : null);
async function enter(next: "practice" | "main") {
  stage = next;
  const c = current();
  if (!c) return;
  await log({ event: { type: "phase", phaseId: c.phaseId } });
  await log({ event: { type: "case-start", caseId: c.caseId, phaseId: c.phaseId } });
}
async function end() {
  const c = current();
  if (c) await log({ event: { type: "case-end", caseId: c.caseId, phaseId: c.phaseId, submitted: true } });
}
async function action(name: string) {
  const c = current();
  if (c) await log({ event: { type: "action", caseId: c.caseId, phaseId: c.phaseId, action: name, completed: true } });
}

// ---------- neutral object IDs ----------
// The agent sees IDs drawn afresh for every design (obj-1 … obj-N in a random order), so it cannot carry
// "obj-3 was the target" from one design to the next, or read the mapping from the app's code. It has to
// find the objects in what it sees. The mapping is written to object-ids.jsonl in the job folder for audit.
let shownToApp = new Map<string, string>();
let appToShown = new Map<string, string>();
async function drawObjectIds(designId: string) {
  const appIds = ((await evaluate("window.xrStudy.listObjects()")) as { id: string }[]).map((o) => String(o.id));
  const shown = appIds.map((_, i) => `obj-${i + 1}`);
  for (let i = shown.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shown[i], shown[j]] = [shown[j], shown[i]];
  }
  shownToApp = new Map(appIds.map((id, i) => [shown[i], id]));
  appToShown = new Map(appIds.map((id, i) => [id, shown[i]]));
  await appendFile(join(jobDir, "object-ids.jsonl"), JSON.stringify({ t: Date.now(), design: designId, shownToApp: Object.fromEntries(shownToApp) }) + "\n");
}

const tools: Tool[] = [
  {
    name: "open_design",
    description: `Open one design of the study in the running app and start its practice trial. Visit the designs in this order: ${spec.designs.map((d) => d.id).join(", ")}.`,
    inputSchema: { type: "object", properties: { design: { type: "string", enum: spec.designs.map((d) => d.id) } }, required: ["design"] },
    async handler(args) {
      await countCall("open_design");
      const d = spec.designs.find((x) => x.id === args.design);
      if (!d) throw new ToolError("Unknown design.");
      if (design && stage !== "done") await end();
      await browser();
      const query = spec.app.query.replace("{condition}", encodeURIComponent(d.id)).replace("{participant}", encodeURIComponent(spec.participant ?? "population"));
      await cdp("Page.navigate", { url: `http://127.0.0.1:${appPort}/${query}` }, 90_000);
      for (let i = 0; i < 150; i++) {
        await wait(200);
        if (await evaluate("typeof window.xrStudy === 'object'").catch(() => false)) break;
        if (i === 149) throw new ToolError("The app did not become ready (window.xrStudy missing).");
      }
      design = d;
      openedAt = Date.now();
      await drawObjectIds(d.id);
      await evaluate("window.xrStudy.start()");
      await enter(d.practice ? "practice" : "main");
      return text(`Opened ${d.label}. ${JSON.stringify(await evaluate("window.xrStudy.getState()"))}`);
    },
  },
  {
    name: "look",
    description: "Turn the viewpoint around the table: azimuth in degrees (0 = front), polar angle in degrees from straight up (≈60 looks at the table).",
    inputSchema: { type: "object", properties: { azimuth: { type: "number" }, polar: { type: "number" } }, required: ["azimuth", "polar"] },
    async handler(args) {
      await countCall("look");
      if (!design) throw new ToolError("Open a design first.");
      await evaluate(`window.xrStudy.look(${Number(args.azimuth) || 0}, ${Math.min(89, Math.max(5, Number(args.polar) || 60))})`);
      await action("look-around");
      return text("View changed. Take a screenshot to see it.");
    },
  },
  {
    name: "screenshot",
    description: "See the current view (single image, as a participant on a desktop display would).",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      await countCall("screenshot");
      if (!design) throw new ToolError("Open a design first.");
      const shot = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 82, fromSurface: true });
      const bytes = Buffer.from(shot.data, "base64");
      frames++;
      await mkdir(join(jobDir, "screenshots"), { recursive: true });
      await writeFile(join(jobDir, "screenshots", `${String(frames).padStart(3, "0")}-${design.id}.jpg`), bytes);
      const c = current();
      if (c)
        await log({
          event: {
            type: "observation",
            caseId: c.caseId,
            phaseId: c.phaseId,
            captures: [{ eye: "mono", sha256: sha(bytes), frameId: `${spec.jobId}-${frames}`, simulationTimeMs: Date.now() - openedAt }],
          },
        });
      return [{ type: "image", data: shot.data, mimeType: "image/jpeg" }];
    },
  },
  {
    name: "list_objects",
    description: "Neutral object IDs (obj-1 …) with their current screen positions (0–1). Names and materials are not given; look at the screenshot. The IDs are drawn afresh for every design.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      await countCall("list_objects");
      if (!design) throw new ToolError("Open a design first.");
      const objects = (await evaluate("window.xrStudy.listObjects()")) as { id: string }[];
      const shown = objects.map((o) => ({ ...o, id: appToShown.get(String(o.id)) ?? "unknown" }));
      shown.sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
      return text(JSON.stringify(shown));
    },
  },
  {
    name: "select",
    description: "Select an object by its ID, like a participant clicking it. Wrong selections count as errors.",
    inputSchema: { type: "object", properties: { object: { type: "string" } }, required: ["object"] },
    async handler(args) {
      await countCall("select");
      if (!design || stage === "done") throw new ToolError("Open a design first.");
      const before = await evaluate("window.xrStudy.getState()");
      const appId = shownToApp.get(String(args.object));
      if (!appId) throw new ToolError(`Unknown object "${String(args.object)}". Use an ID from list_objects for this design; IDs change with every design.`);
      const result = await evaluate(`window.xrStudy.select(${JSON.stringify(appId)})`);
      await action("select-target");
      const after = await evaluate("window.xrStudy.getState()");
      if (stage === "practice" && after.trial > before.trial) {
        await action("complete-task");
        await end();
        await enter("main");
      }
      if (after.done && (stage as string) !== "done") {
        await action("complete-task");
        await end();
        stage = "done";
      }
      return text(JSON.stringify({ result, state: after }));
    },
  },
  {
    name: "app_state",
    description: "Current task state: phase, instruction, found targets, wrong selections.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      await countCall("app_state");
      if (!design) throw new ToolError("Open a design first.");
      return text(JSON.stringify(await evaluate("window.xrStudy.getState()")));
    },
  },
];
let chain: Promise<unknown> = Promise.resolve();
for (const t of tools) {
  const run = t.handler;
  t.handler = (args) => {
    const next = chain.then(() => run(args));
    chain = next.catch(() => undefined);
    return next;
  };
}
// Chrome must never outlive this server, however it ends.
const shutdown = async () => {
  await resetBrowser();
  server.close();
};
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("exit", () => chrome?.kill("SIGKILL"));
serveMcp("webxr", "0.4.0", tools, shutdown);
