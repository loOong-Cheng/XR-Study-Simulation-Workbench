// WebXR runtime MCP server (stdio): serves a WebXR study app, drives it in a
// headless Chrome over the DevTools protocol and exposes only what a participant
// could see or do, through the app's window.xrStudy contract
// (docs/runtime-adapters.md → "The window.xrStudy contract"). Which tools the agent gets
// follows what the app declares (workspace.json → app.capabilities and app.actions).
//   node dist/runtimes/webxr-mcp.js <job-dir>
// Observation is mono: the desktop page has no stereo pair.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync, realpathSync, statSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { normalAction, type AppAction } from "../executor/runtimes.js";
import { agentPath } from "./guard.js";
import { budgetNearlyUsed, serveMcp, takeToolCall, text, ToolError, type Tool } from "./mcp.js";

interface WebXRSpec {
  jobId: string;
  budget: number;
  tokenBudget?: number | null;
  chromePath: string;
  app: { dir: string; query: string };
  /** Participant of an individual job, for {participant} in the app query ("population" otherwise). */
  participant?: string | null;
  /** screenshot plus what the app declares (workspace.json → app.capabilities); older job files: the basic contract. */
  capabilities?: string[];
  /** The app's own actions (workspace.json → app.actions), for the act tool. */
  actions?: AppAction[];
  /** Designs in the order this job must visit them, with their case IDs per phase. */
  designs: { id: string; label: string; practice: { caseId: string; phaseId: string } | null; main: { caseId: string; phaseId: string } | null }[];
  /** How long a transition may take after an action, in ms (workspace.json → app.settleMs; default 3000). */
  settleMs?: number;
  /** The study's motor-noise model for clicks (workspace.json → app.pointer) with this job's seed; absent: clicks land where asked. */
  pointer?: PointerNoise | null;
}
/** Endpoint scatter of clicks (docs/runtime-adapters.md → "Motor noise"): a Gaussian with a fixed SD, or one derived from an effective width (SD = We / 4.133). */
interface PointerNoise {
  scatter: "gaussian" | "fitts";
  sdPx?: number | Record<string, number>;
  effectiveWidthPx?: number | Record<string, number>;
  seed: number;
}
const jobDir = resolve(process.argv[2] ?? ".");
const spec = (JSON.parse(await readFile(join(jobDir, "job.json"), "utf8")) as { webxr: WebXRSpec }).webxr;
const caps = new Set(spec.capabilities ?? ["screenshot", "look", "pointer-select", "phase-events"]);
const settleMs = typeof spec.settleMs === "number" && Number.isFinite(spec.settleMs) && spec.settleMs >= 0 ? Math.min(30_000, spec.settleMs) : 3000;
const declaredActions = (spec.actions ?? []).map(normalAction).filter((a): a is AppAction => !!a);
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const log = (entry: Record<string, unknown>) =>
  appendFile(join(jobDir, "trace.jsonl"), JSON.stringify({ t: Date.now(), server: "webxr", ...entry }) + "\n");
async function countCall(tool: string) {
  if (spec.tokenBudget && (await budgetNearlyUsed(jobDir, spec.tokenBudget)))
    throw new ToolError(`Token budget of ${spec.tokenBudget} tokens is nearly used up. Submit your forecast now.`);
  // Checked before it is written: a refused call is not counted (calls.log holds accepted calls only).
  if (!(await takeToolCall(jobDir, tool, spec.budget))) throw new ToolError(`Tool budget of ${spec.budget} calls is used up. Submit your forecast now.`);
}

// ---------- static app server ----------
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm" };
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
    // Only files of the app folder (symlinks resolved), as the campaign fingerprinted them: never
    // human results or run records, dot files or OS clutter.
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
  // A task left unfinished is recorded as not submitted.
  const open = stage !== "done" ? current() : null;
  ws = undefined;
  design = undefined;
  stage = "done";
  if (open) await log({ event: { type: "case-end", caseId: open.caseId, phaseId: open.phaseId, submitted: false } });
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
  // Named after the job: a Chrome left behind shows only --user-data-dir, which then names its session.
  profile = await mkdtemp(join(tmpdir(), `xr-webxr-${String(spec.jobId ?? "job").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}-`));
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
      // Linux CI runners and root cannot use Chrome's sandbox (Ubuntu 24.04 restricts user namespaces): only there.
      ...(process.platform === "linux" && (process.env.CI || process.getuid?.() === 0) ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
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
// Its capabilities are Chrome's screenshots plus what the app declares in workspace.json.
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
      capabilities: [...caps],
    },
  });
}
async function evaluate(expression: string, timeoutMs = 30_000): Promise<any> {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  if (r.exceptionDetails) throw new ToolError(`App error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasFn = async (name: string) => (await evaluate(`typeof window.xrStudy?.[${JSON.stringify(name)}] === "function"`)) === true;

// ---------- what reaches the agent: documented fields only ----------
type Raw = Record<string, any>;
/** The app's `public` object, if it is one and not too long; undefined otherwise. */
function capped(x: unknown): unknown {
  if (!x || typeof x !== "object") return undefined;
  const s = JSON.stringify(x);
  return s.length <= 4000 ? x : "(the app's public data is too long to show)";
}
/** What the agent sees of getState(): phase, trial, done, instruction and the app's `public` object. */
function publicState(s: Raw | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!s) return out;
  if (typeof s.phase === "string") out.phase = s.phase.slice(0, 200);
  if (Number.isFinite(s.trial)) out.trial = s.trial;
  if (typeof s.done === "boolean") out.done = s.done;
  if (typeof s.instruction === "string") out.instruction = s.instruction.slice(0, 2000);
  const p = capped(s.public);
  if (p !== undefined) out.public = p;
  return out;
}
/** The neutral ID of an app object for the agent (an unmapped one is never named). */
function shownObject(v: unknown): unknown {
  if (v === null || v === undefined || v === false) return null;
  if (v === true) return true;
  return appToShown.get(String(v)) ?? "an object";
}
/** What the agent sees of the app's reply to an action: accepted, correct, hit, reason, over and `public`. */
async function publicReply(r: unknown): Promise<Record<string, unknown> | null> {
  if (!r || typeof r !== "object") return null;
  const x = r as Raw;
  const out: Record<string, unknown> = {};
  for (const k of ["accepted", "correct", "hit"]) if (typeof x[k] === "boolean") out[k] = x[k];
  if (typeof x.reason === "string") out.reason = x.reason.slice(0, 300);
  if ("over" in x) {
    if (typeof x.over === "string" && !appToShown.has(x.over)) await refreshObjects();
    out.over = shownObject(x.over);
  }
  const p = capped(x.public);
  if (p !== undefined) out.public = p;
  return Object.keys(out).length ? out : null;
}
/** What the agent sees of one listed object: neutral ID, onScreen and visible as the app reports them, and a position only when visible. */
function publicObject(o: Raw): Record<string, unknown> {
  const out: Record<string, unknown> = { id: appToShown.get(String(o.id)) ?? "unknown" };
  if (typeof o.visible === "boolean") out.visible = o.visible;
  if (typeof o.onScreen === "boolean") out.onScreen = o.onScreen;
  if (o.visible !== false) for (const k of ["x", "y"]) if (Number.isFinite(o[k])) out[k] = Math.round(o[k] * 10_000) / 10_000;
  const p = capped(o.public);
  if (p !== undefined) out.public = p;
  return out;
}

// ---------- case bookkeeping (audit trace) ----------
let design: WebXRSpec["designs"][number] | undefined;
let stage: "practice" | "main" | "done" = "done";
let openedAt = 0;
let frames = 0;
let opened = 0;
/** The last app state the bookkeeping saw (raw), and the viewport in CSS pixels. */
let last: Raw | null = null;
let view = { w: 1280, h: 720 };
const current = () => (design ? (stage === "practice" ? design.practice : stage === "main" ? design.main : null) : null);
async function enter(next: "practice" | "main") {
  stage = next;
  const c = current();
  if (!c) return;
  await log({ event: { type: "phase", phaseId: c.phaseId } });
  await log({ event: { type: "case-start", caseId: c.caseId, phaseId: c.phaseId } });
}
/** End the current case: submitted only when the app moved on or reported done. */
async function end(submitted: boolean) {
  const c = current();
  if (c) await log({ event: { type: "case-end", caseId: c.caseId, phaseId: c.phaseId, submitted } });
}
async function action(name: string, f: { scored: boolean; completed?: boolean; result?: Record<string, unknown> | null; args?: Record<string, unknown> }) {
  const c = current();
  if (c)
    await log({
      event: { type: "action", caseId: c.caseId, phaseId: c.phaseId, action: name, completed: f.completed ?? true, scored: f.scored, ...(f.result !== undefined ? { result: f.result } : {}), ...(f.args ? { args: f.args } : {}) },
    });
}
async function rawState(): Promise<Raw> {
  const s = await evaluate("window.xrStudy.getState()");
  return s && typeof s === "object" ? s : {};
}
/**
 * The practice case ends when the app leaves the "practice" phase (when it reports one), otherwise
 * when `trial` increases. An app that counts trials per target should report phase "practice".
 */
function practiceOver(before: Raw, now: Raw): boolean {
  if (before.phase === "practice") return typeof now.phase === "string" && now.phase !== "practice";
  return Number.isFinite(before.trial) && Number.isFinite(now.trial) && now.trial > before.trial;
}
/** Advance the cases from a new app state: practice → main, and main → done (the app's log is saved then). */
async function track(now: Raw) {
  const before = last;
  last = now;
  if (!design || !before) return;
  if (stage === "practice" && (practiceOver(before, now) || now.done === true)) {
    await action("complete-task", { scored: false });
    await end(true);
    await enter("main");
  }
  if (stage === "main" && now.done === true) {
    await action("complete-task", { scored: false });
    await end(true);
    stage = "done";
    await saveAppLog();
  }
}
/** At the start of every tool call: catch transitions that happened since (animations, timers). */
async function check(): Promise<void> {
  if (design && ws) await track(await rawState());
}
const stableKey = (s: Raw) => JSON.stringify(publicState(s));
/**
 * After an action: read the state until it has not changed for 400 ms (at most 2 s), and on while
 * the app reports `busy: true` (at most settleMs), so delayed transitions (a teleport fade, an
 * animated walk) land in the right case. Apps may also return a Promise from an action that
 * resolves when it is done.
 */
async function settle(trackChanges = true): Promise<Raw> {
  let s = await rawState();
  if (trackChanges) await track(s);
  let key = stableKey(s);
  let since = Date.now();
  const start = since;
  while ((Date.now() < start + 2000 && Date.now() - since < 400) || (s.busy === true && Date.now() < start + settleMs)) {
    await wait(100);
    const next = await rawState();
    if (stableKey(next) !== key) {
      key = stableKey(next);
      since = Date.now();
      if (trackChanges) await track(next);
    }
    s = next;
  }
  last = s;
  return s;
}
/** When the agent last acted on the app (start, an action, a click, a look): a transition may follow within settleMs. */
let lastActionAt = 0;
/**
 * Before a case is ended as unfinished (the agent opens another design, the session ends, or the
 * study server asks before it judges a forecast): wait for a transition the app may still make
 * after the agent's last action. An app that reports `busy` is read until it reports busy: false
 * (at most settleMs); without it the runtime watches until settleMs after the last action. Stops as
 * soon as the open case ends.
 */
async function flush(): Promise<void> {
  if (!design || !ws || stage === "done") return;
  const open = current();
  const busyUntil = Date.now() + settleMs;
  for (;;) {
    const s = await rawState();
    await track(s);
    // track() may have ended the case (stage is "done" then, or the next case is open).
    if (current() !== open || s.busy === false) return;
    if (Date.now() >= (s.busy === true ? busyUntil : lastActionAt + settleMs)) return;
    await wait(100);
  }
}
function requireOpen() {
  if (!design) throw new ToolError("Open a design first with open_design.");
}
function requireActive() {
  requireOpen();
  if (stage !== "done") return;
  const i = spec.designs.findIndex((d) => d.id === design!.id);
  const next = spec.designs[i + 1];
  throw new ToolError(
    `The task of ${design!.label} is finished. ${next ? `Open the next design with open_design (${next.id}).` : "That was the last design: submit your forecast."}`,
  );
}

// ---------- the app's log (kept in the job folder, never shown to the agent) ----------
/**
 * app-logs/<nn>-<design>.json: {design, opened (the nth open_design), savedAt, entries (what
 * window.xrStudy.log() returned)}. Saving runs as zip exports it; loading checks this shape.
 */
async function saveAppLog() {
  if (!design || !ws) return;
  try {
    const entries = await evaluate(`(async () => { const l = window.xrStudy?.log; return typeof l === "function" ? JSON.stringify(await l.call(window.xrStudy)) ?? "null" : null; })()`, 10_000);
    if (typeof entries !== "string") return;
    if (entries.length > 50_000_000) return void (await log({ appLog: null, note: "The app's log is larger than 50 MB and was not saved." }));
    const name = `${String(opened).padStart(2, "0")}-${design.id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200)}.json`;
    const body = `{"design":${JSON.stringify(design.id)},"opened":${opened},"savedAt":${JSON.stringify(new Date().toISOString())},"entries":${entries}}`;
    await mkdir(join(jobDir, "app-logs"), { recursive: true });
    await writeFile(join(jobDir, "app-logs", name), body + "\n");
    await log({ appLog: `app-logs/${name}` });
  } catch {
    // the app's log is optional
  }
}

// ---------- neutral object IDs ----------
// The agent sees IDs drawn afresh for every design (obj-1 … obj-N in a random order), so it cannot carry
// "obj-3 was the target" from one design to the next, or read the mapping from the app's code. It has to
// find the objects in what it sees. Objects that appear later get the next IDs (in a random order among
// themselves); existing IDs never change. The mapping is written to object-ids.jsonl in the job folder.
let shownToApp = new Map<string, string>();
let appToShown = new Map<string, string>();
async function appObjects(): Promise<Raw[] | null> {
  if (!(await hasFn("listObjects"))) return null;
  const list = await evaluate("window.xrStudy.listObjects()");
  return Array.isArray(list) ? list.filter((o) => o && typeof o === "object" && o.id !== undefined && o.id !== null) : [];
}
async function refreshObjects(): Promise<Raw[] | null> {
  const objects = await appObjects();
  if (!objects || !design) return objects;
  const added = [...new Set(objects.map((o) => String(o.id)))].filter((id) => !appToShown.has(id));
  if (added.length) {
    const first = shownToApp.size;
    const shown = added.map((_, i) => `obj-${first + i + 1}`);
    for (let i = shown.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [shown[i], shown[j]] = [shown[j], shown[i]];
    }
    added.forEach((id, i) => (shownToApp.set(shown[i], id), appToShown.set(id, shown[i])));
    await appendFile(
      join(jobDir, "object-ids.jsonl"),
      JSON.stringify({ t: Date.now(), design: design.id, shownToApp: Object.fromEntries(shownToApp), ...(first ? { added: Object.fromEntries(added.map((id) => [appToShown.get(id), id])) } : {}) }) + "\n",
    );
  }
  return objects;
}

// ---------- pointer ----------
/** A point on the screen as fractions of its width and height from the top-left corner. */
function point(args: Record<string, unknown>) {
  const x = Number(args.x),
    y = Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
    throw new ToolError("x and y are fractions of the screen from its top-left corner, each from 0 to 1 (0.5, 0.5 is the centre).");
  return { x: Math.round(x * 10_000) / 10_000, y: Math.round(y * 10_000) / 10_000 };
}
// Motor noise (workspace.json → app.pointer): a modelling assumption the researcher chooses, off by
// default. Each click's endpoint is drawn from an isotropic Gaussian around the requested point, from
// a generator seeded per job (job.json → webxr.pointer.seed), so a session's scatter can be reproduced.
let rng = (spec.pointer?.seed ?? 0) >>> 0;
/** mulberry32: a small, fixed generator, uniform in [0, 1). */
function uniform(): number {
  rng = (rng + 0x6d2b79f5) >>> 0;
  let t = rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** The per-axis SD in CSS pixels for the open design, or 0 (no noise for this design). */
function scatterSd(): number {
  const p = spec.pointer;
  if (!p || !design) return 0;
  const pick = (v: number | Record<string, number> | undefined) => (typeof v === "number" ? v : v && typeof v === "object" ? v[design!.id] : undefined);
  const value = p.scatter === "fitts" ? (pick(p.effectiveWidthPx) ?? 0) / 4.133 : (pick(p.sdPx) ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}
/** Where a click asked for at (x, y) lands: the same point without a noise model, else beside it (kept on the screen). */
function landing(x: number, y: number): { x: number; y: number } {
  const sd = scatterSd();
  if (!sd) return { x, y };
  // Box–Muller: two independent standard normals, one per axis.
  const r = Math.sqrt(-2 * Math.log(1 - uniform())),
    a = 2 * Math.PI * uniform();
  const px = Math.min(view.w - 1, Math.max(0, x * view.w + sd * r * Math.cos(a)));
  const py = Math.min(view.h - 1, Math.max(0, y * view.h + sd * r * Math.sin(a)));
  return { x: Math.round((px / view.w) * 10_000) / 10_000, y: Math.round((py / view.h) * 10_000) / 10_000 };
}
/** Draw the pointer (a crosshair) into the page, so screenshots show where it is. */
async function showPointer(x: number, y: number) {
  await evaluate(`(() => {
    let c = document.getElementById("xr-study-pointer");
    if (!c) {
      c = document.createElement("div");
      c.id = "xr-study-pointer";
      c.setAttribute("aria-hidden", "true");
      c.style.cssText = "position:fixed;width:0;height:0;pointer-events:none;z-index:2147483647";
      c.innerHTML = '<svg width="29" height="29" viewBox="-14.5 -14.5 29 29" style="position:absolute;left:-14.5px;top:-14.5px;overflow:visible"><g fill="none" stroke-linecap="round"><g stroke="#000" stroke-width="4"><circle r="6"/><path d="M0 -13V-8M0 8V13M-13 0H-8M8 0H13"/></g><g stroke="#fff" stroke-width="2"><circle r="6"/><path d="M0 -13V-8M0 8V13M-13 0H-8M8 0H13"/></g></g><circle r="1.3" fill="#ff2d2d"/></svg>';
      document.documentElement.appendChild(c);
    }
    c.style.left = (${x} * innerWidth) + "px";
    c.style.top = (${y} * innerHeight) + "px";
  })()`);
}
/**
 * One pointer step. With window.xrStudy.pointer(x, y, kind) the app handles it and replies;
 * otherwise real mouse events go to the page, as from a participant's mouse (no reply).
 */
async function pointer(x: number, y: number, kind: "move" | "down" | "up", own: boolean): Promise<unknown> {
  if (own) return evaluate(`window.xrStudy.pointer(${x}, ${y}, ${JSON.stringify(kind)})`);
  const type = kind === "move" ? "mouseMoved" : kind === "down" ? "mousePressed" : "mouseReleased";
  await cdp("Input.dispatchMouseEvent", { type, x: x * view.w, y: y * view.h, button: kind === "move" ? "none" : "left", buttons: kind === "down" ? 1 : 0, clickCount: kind === "move" ? 0 : 1, pointerType: "mouse" });
  return null;
}
const replied = (r: unknown) => !!r && typeof r === "object" && ["accepted", "hit", "correct", "over"].some((k) => k in (r as Raw));

// ---------- the app's own actions ----------
async function availableActions(): Promise<AppAction[]> {
  const fromApp = (await hasFn("actions")) ? await evaluate("window.xrStudy.actions()") : null;
  const all = [...declaredActions, ...(Array.isArray(fromApp) ? fromApp.map(normalAction).filter((a): a is AppAction => !!a) : [])];
  return [...new Map(all.map((a) => [a.name, a])).values()];
}
/**
 * An action's arguments as the app needs them: every string that is exactly a neutral ID shown for
 * this design (obj-3), at any depth, becomes the app's own ID; everything else passes unchanged.
 */
async function toAppIds(v: unknown): Promise<unknown> {
  if (typeof v === "string" && /^obj-\d+$/.test(v)) {
    if (!shownToApp.has(v)) await refreshObjects();
    return shownToApp.get(v) ?? v;
  }
  if (Array.isArray(v)) return Promise.all(v.map(toAppIds));
  if (v && typeof v === "object") return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await toAppIds(x)])));
  return v;
}
const describeActions = (list: AppAction[]) =>
  list.map((a) => `${a.name}(${a.params ? Object.keys(a.params).join(", ") : ""})${a.description ? `: ${a.description}` : ""}`).join("; ");

const designs = spec.designs.map((d) => d.id).join(", ");
const tools: Tool[] = [
  {
    name: "open_design",
    description: `Open one design of the study in the running app and start its first task (the practice task, if there is one). Visit the designs in this order: ${designs}. Opening the next design before the app finished this one leaves its task unfinished.`,
    inputSchema: { type: "object", properties: { design: { type: "string", enum: spec.designs.map((d) => d.id) } }, required: ["design"] },
    async handler(args) {
      await countCall("open_design");
      const d = spec.designs.find((x) => x.id === args.design);
      if (!d) throw new ToolError("Unknown design.");
      if (design) {
        // A transition the app makes shortly after the last action (a fade before "done") still counts.
        await flush().catch(() => undefined);
        // Leaving a design before the app reported it done: the task is not submitted.
        if (stage !== "done") {
          await saveAppLog();
          await end(false);
          stage = "done";
        }
      }
      await browser();
      const query = spec.app.query.replace("{condition}", encodeURIComponent(d.id)).replace("{participant}", encodeURIComponent(spec.participant ?? "population"));
      await cdp("Page.navigate", { url: `http://127.0.0.1:${appPort}/${query}` }, 90_000);
      for (let i = 0; i < 150; i++) {
        await wait(200);
        if (await evaluate("typeof window.xrStudy === 'object' && window.xrStudy !== null").catch(() => false)) break;
        if (i === 149) throw new ToolError("The app did not become ready (window.xrStudy missing).");
      }
      design = d;
      stage = "done";
      opened++;
      openedAt = Date.now();
      last = null;
      shownToApp = new Map();
      appToShown = new Map();
      const needs = ["getState", "start", ...(caps.has("look") ? ["look"] : []), ...(caps.has("pointer-select") ? ["listObjects", "select"] : []), ...(caps.has("actions") ? ["act"] : [])];
      const lacking = (await evaluate(`${JSON.stringify(needs)}.filter((n) => typeof window.xrStudy[n] !== "function")`)) as string[];
      if (lacking.length) throw new ToolError(`The app's window.xrStudy has no ${lacking.join(", ")}, which its declared capabilities need (workspace.json → app.capabilities). Tell the researcher.`);
      view = await evaluate("({ w: innerWidth, h: innerHeight })");
      await refreshObjects();
      await evaluate("window.xrStudy.start()");
      lastActionAt = Date.now();
      await enter(d.practice ? "practice" : "main");
      const state = await settle(false);
      await refreshObjects();
      const acts = caps.has("actions") ? await availableActions() : [];
      return text(`Opened ${d.label}. ${JSON.stringify(publicState(state))}${acts.length ? `\nActions you can take with act: ${describeActions(acts)}` : ""}`);
    },
  },
  {
    name: "screenshot",
    description: "See the current view (a single image, as a participant on a desktop display would). The pointer, once moved, shows as a crosshair.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      await countCall("screenshot");
      requireOpen();
      await check();
      const shot = await cdp("Page.captureScreenshot", { format: "jpeg", quality: 82, fromSurface: true });
      const bytes = Buffer.from(shot.data, "base64");
      frames++;
      await mkdir(join(jobDir, "screenshots"), { recursive: true });
      await writeFile(join(jobDir, "screenshots", `${String(frames).padStart(3, "0")}-${design!.id}.jpg`), bytes);
      const c = current();
      // The app's own clock when it reports one (getState().timeMs), else wall time since the design opened.
      const appTime = Number.isFinite(last?.timeMs) ? Number(last!.timeMs) : null;
      if (c)
        await log({
          event: {
            type: "observation",
            caseId: c.caseId,
            phaseId: c.phaseId,
            captures: [{ eye: "mono", sha256: sha(bytes), frameId: `${spec.jobId}-${frames}`, simulationTimeMs: appTime ?? Date.now() - openedAt, clock: appTime !== null ? "app" : "wall" }],
          },
        });
      return [{ type: "image", data: shot.data, mimeType: "image/jpeg" }];
    },
  },
  {
    name: "app_state",
    description: "What the app shows the participant now: the phase, the instruction, whether this design's task is done, and the progress the app displays.",
    inputSchema: { type: "object", properties: {} },
    async handler() {
      await countCall("app_state");
      requireOpen();
      await check();
      return text(JSON.stringify(publicState(last)));
    },
  },
];
if (caps.has("look"))
  tools.push({
    name: "look",
    description: "Turn the viewpoint the way a participant turns their head: azimuth in degrees around the vertical axis (0 = the starting direction, positive turns right), polar in degrees down from straight up (0 = up, 90 = level, 180 = straight down). The app may limit the view; the reply says so.",
    inputSchema: { type: "object", properties: { azimuth: { type: "number" }, polar: { type: "number" } }, required: ["azimuth", "polar"] },
    async handler(args) {
      await countCall("look");
      requireOpen();
      await check();
      const azimuth = Number(args.azimuth),
        asked = Number(args.polar);
      if (!Number.isFinite(azimuth) || !Number.isFinite(asked)) throw new ToolError("azimuth and polar are numbers in degrees.");
      const polar = Math.min(180, Math.max(0, asked));
      const reply = (await evaluate(`window.xrStudy.look(${azimuth}, ${polar})`)) as Raw | undefined;
      lastActionAt = Date.now();
      // The app may reply with the view it applied ({azimuth, polar}) when it limits the view.
      const applied = reply && typeof reply === "object" && Number.isFinite(reply.azimuth) && Number.isFinite(reply.polar) ? { azimuth: Number(reply.azimuth), polar: Number(reply.polar) } : { azimuth, polar };
      const turn = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180) > 0.01;
      const limited = turn(applied.azimuth, azimuth) || Math.abs(applied.polar - asked) > 0.01;
      await action("look-around", { scored: false, args: { azimuth, polar: asked } });
      return text(
        limited
          ? `The view is limited: you asked for azimuth ${azimuth}°, polar ${asked}°; the view is now azimuth ${Math.round(applied.azimuth * 10) / 10}°, polar ${Math.round(applied.polar * 10) / 10}°. Take a screenshot to see it.`
          : "View changed. Take a screenshot to see it.",
      );
    },
  });
if (caps.has("pointer-select"))
  tools.push(
    {
      name: "list_objects",
      description:
        "Objects you can select: neutral IDs (obj-1 …), whether each is on screen and visible as the app reports it, and screen positions of visible ones (x, y from 0 to 1 from the top-left corner). Names and materials are not given; look at a screenshot. The IDs are drawn afresh for every design; objects that appear later get new IDs.",
      inputSchema: { type: "object", properties: {} },
      async handler() {
        await countCall("list_objects");
        requireOpen();
        await check();
        const objects = (await refreshObjects()) ?? [];
        const shown = objects.map(publicObject);
        shown.sort((a, b) => Number(String(a.id).slice(4)) - Number(String(b.id).slice(4)));
        return text(JSON.stringify(shown));
      },
    },
    {
      name: "select",
      description: "Select an object by its ID from list_objects, as a participant clicks it. The app decides whether it was right; wrong selections count as errors.",
      inputSchema: { type: "object", properties: { object: { type: "string" } }, required: ["object"] },
      async handler(args) {
        await countCall("select");
        requireOpen();
        await check();
        requireActive();
        const shown = String(args.object);
        if (!shownToApp.has(shown)) await refreshObjects();
        const appId = shownToApp.get(shown);
        if (!appId) throw new ToolError(`Unknown object "${shown}". Use an ID from list_objects for this design; IDs change with every design.`);
        const result = await publicReply(await evaluate(`window.xrStudy.select(${JSON.stringify(appId)})`));
        lastActionAt = Date.now();
        const accepted = result?.accepted !== false;
        await action("select-target", { scored: accepted, completed: accepted, result, args: { object: shown } });
        const state = await settle();
        return text(JSON.stringify({ result, state: publicState(state) }));
      },
    },
  );
if (caps.has("pointer-xy"))
  tools.push(
    {
      name: "point_at",
      description:
        "Move the pointer to a point on the screen: x and y from 0 to 1, from the top-left corner (0.5, 0.5 is the centre). Screenshots show it as a crosshair; the reply says what the app reports under it, if anything. Nothing is clicked.",
      inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
      async handler(args) {
        await countCall("point_at");
        requireOpen();
        await check();
        const { x, y } = point(args);
        const own = await hasFn("pointer");
        await showPointer(x, y);
        const result = await publicReply(await pointer(x, y, "move", own));
        lastActionAt = Date.now();
        await action("point", { scored: false, result, args: { x, y } });
        return text(JSON.stringify({ pointer: { x, y }, ...(result ? { result } : {}) }));
      },
    },
    {
      name: "click",
      description:
        "Click at a point on the screen, as a participant clicks with the mouse: the pointer moves there (x and y from 0 to 1 from the top-left corner) and presses. The app decides what was hit; a click beside the target is a miss.",
      inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
      async handler(args) {
        await countCall("click");
        requireOpen();
        await check();
        requireActive();
        const asked = point(args);
        // With the study's motor-noise model the click lands beside the requested point (the trace keeps both).
        const { x, y } = landing(asked.x, asked.y);
        const own = await hasFn("pointer");
        // The app's state apart from its clock, to tell whether a real mouse click did anything.
        const snapshot = async () => JSON.stringify({ ...(await rawState()), timeMs: undefined });
        const before = await snapshot();
        await showPointer(x, y);
        let reply: unknown = null;
        for (const kind of ["move", "down", "up"] as const) {
          const r = await pointer(x, y, kind, own);
          if (replied(r)) reply = r;
        }
        lastActionAt = Date.now();
        if (!own) await wait(100);
        const result = await publicReply(reply);
        // With real mouse events the app gives no reply: a click counts when the app's state changed.
        const accepted = own ? result?.accepted !== false : (await snapshot()) !== before;
        await action("select-target", { scored: accepted, completed: accepted, result: own ? result : null, args: { ...asked, ...(spec.pointer ? { landed: { x, y } } : {}) } });
        const state = await settle();
        return text(JSON.stringify({ result: own ? result : "The app reports no outcome for mouse clicks; see a screenshot or app_state.", state: publicState(state) }));
      },
    },
  );
if (caps.has("actions"))
  tools.push({
    name: "act",
    description: `Perform one of the app's own actions, as a participant would${declaredActions.length ? ` (${describeActions(declaredActions).slice(0, 1500)})` : ""}. name is the action, args its parameters; open_design lists the actions. The app decides whether the action works; a refused one is not counted as done.`,
    inputSchema: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name"] },
    async handler(args) {
      await countCall("act");
      requireOpen();
      await check();
      requireActive();
      const name = String(args.name ?? "");
      const params = args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};
      if (JSON.stringify(params).length > 2000) throw new ToolError("The action's args are too long.");
      const known = await availableActions();
      const a = known.find((x) => x.name === name);
      if (!a) throw new ToolError(`Unknown action "${name}". Actions: ${describeActions(known) || "none"}.`);
      // Neutral object IDs in the arguments reach the app as its own IDs; the trace keeps what the agent sent.
      const forApp = await toAppIds(params);
      const result = await publicReply(await evaluate(`window.xrStudy.act(${JSON.stringify(name)}, ${JSON.stringify(forApp)})`));
      lastActionAt = Date.now();
      const accepted = result?.accepted !== false;
      await action(name, { scored: accepted && a.scored !== false, completed: accepted, result, args: params });
      const state = await settle();
      return text(JSON.stringify({ result, state: publicState(state) }));
    },
  });
let chain: Promise<unknown> = Promise.resolve();
for (const t of tools) {
  const run = t.handler;
  t.handler = (args) => {
    const next = chain.then(() => run(args));
    chain = next.catch(() => undefined);
    return next;
  };
}
/** Run `f` after the tool call in progress, as one more call in the queue. */
function queued<T>(f: () => Promise<T>): Promise<T> {
  const next = chain.then(f);
  chain = next.catch(() => undefined);
  return next;
}
// Before the study server judges a forecast it asks for a flush (it writes flush-request.json
// {id}); the runtime records what the app did since the last tool call, waits for a pending
// transition (flush) and answers with flush-done.json {id}. Nothing is recorded once the forecast
// was accepted (forecast.json): only the closing case-end may follow it.
const flushRequest = join(jobDir, "flush-request.json");
const forecastAccepted = () => existsSync(join(jobDir, "forecast.json"));
let answering = false;
const watcher = setInterval(() => {
  if (answering || !existsSync(flushRequest)) return;
  answering = true;
  void (async () => {
    let id: unknown = null;
    try {
      id = (JSON.parse(await readFile(flushRequest, "utf8")) as { id?: unknown }).id ?? null;
    } catch {
      // being written: try again on the next tick
      return;
    }
    await rm(flushRequest, { force: true }).catch(() => undefined);
    await queued(() => (forecastAccepted() ? Promise.resolve() : flush())).catch(() => undefined);
    const done = join(jobDir, "flush-done.json");
    await writeFile(`${done}.tmp`, JSON.stringify({ id, t: Date.now() }));
    await rename(`${done}.tmp`, done);
  })()
    .catch(() => undefined)
    .finally(() => (answering = false));
}, 100);
watcher.unref();
// Chrome must never outlive this server, however it ends. An unfinished task's app log is kept.
const shutdown = async () => {
  clearInterval(watcher);
  // A transition shortly after the last action still counts when the session ends without a forecast.
  if (!forecastAccepted()) await Promise.race([queued(flush).catch(() => undefined), wait(settleMs + 2000)]);
  if (design && stage !== "done") await saveAppLog();
  await resetBrowser();
  server.close();
};
process.on("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
process.on("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.on("exit", () => chrome?.kill("SIGKILL"));
serveMcp("webxr", "0.5.0", tools, shutdown);
