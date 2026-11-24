// The built-in WebXR runtime (src/runtimes/webxr-mcp.ts) against a tiny offline app.
// Needs Google Chrome (CHROME_PATH, or the default install location); skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { defaultSettings } from "../src/settings.js";

const chrome = process.env.CHROME_PATH || defaultSettings().chromePath;
const server = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/runtimes/webxr-mcp.js");

// Three objects; "a" is the target in every design. No network, no WebGL.
const app = `<!doctype html><meta charset="utf-8"><body style="background:#888"><script>
const truth = { a: true, b: false, c: false };
const state = { trial: -1, phase: "idle", errors: 0, done: false, found: 0 };
window.xrStudy = {
  getState: () => ({ phase: state.done ? "questionnaire" : state.phase, trial: state.trial, found: state.found, errors: state.errors, done: state.done }),
  start: () => { state.trial = 0; state.phase = "main"; },
  listObjects: () => ["a", "b", "c"].map((id, i) => ({ id, x: 0.25 + i * 0.25, y: 0.5, onScreen: true })),
  select: (id) => {
    if (!(id in truth)) return { accepted: false, reason: "Unknown object." };
    if (truth[id]) { state.found = 1; state.done = true; } else state.errors++;
    return { accepted: true, correct: truth[id] };
  },
  look: () => undefined,
};
</script></body>`;

function client(jobDir: string) {
  const child = spawn(process.execPath, [server, jobDir], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok) => {
      const id = ++seq;
      waiting.set(id, ok);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { error: r.result?.isError === true, text: r.result?.content?.[0]?.text as string | undefined, content: r.result?.content };
  };
  const close = () => new Promise<void>((ok) => (child.on("exit", () => ok()), child.stdin!.end()));
  return { rpc, call, close };
}

test("WebXR runtime: per-design object IDs, audit trace and clean shutdown", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  try {
    const appDir = join(root, "app"),
      jobDir = join(root, "job");
    await mkdir(appDir);
    await mkdir(jobDir);
    await writeFile(join(appDir, "index.html"), app);
    const designs = ["one", "two"].map((id) => ({ id, label: id, practice: null, main: { caseId: `${id}-main`, phaseId: "main" } }));
    await writeFile(join(jobDir, "job.json"), JSON.stringify({ webxr: { jobId: "t", budget: 40, chromePath: chrome, app: { dir: appDir, query: "?design={condition}" }, designs } }));
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("xr-webxr-") && !n.startsWith("xr-webxr-test-")));
    const mcp = client(jobDir);
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });

    const seen: string[] = [];
    for (const d of designs) {
      assert.match((await mcp.call("open_design", { design: d.id })).text ?? "", /^Opened/);
      const objects = JSON.parse((await mcp.call("list_objects")).text!) as { id: string }[];
      assert.deepEqual(objects.map((o) => o.id), ["obj-1", "obj-2", "obj-3"], "shown IDs are neutral and sorted");
      // The app's own IDs never reach the agent.
      assert.ok((await mcp.call("select", { object: "a" })).error);
      // Find the target by trying the shown IDs, as a participant would by looking.
      let target = "";
      for (const o of objects) {
        const r = JSON.parse((await mcp.call("select", { object: o.id })).text!);
        if (r.result.correct) {
          target = o.id;
          break;
        }
      }
      assert.ok(target, "a shown ID maps to the target");
      seen.push(target);
      const shot = await mcp.call("screenshot");
      assert.equal(shot.content?.[0]?.type, "image");
    }
    await mcp.close();

    const mapping = (await readFile(join(jobDir, "object-ids.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(mapping.map((m) => m.design), ["one", "two"]);
    for (const [i, m] of mapping.entries()) assert.equal(m.shownToApp[seen[i]], "a", "audit file records the mapping used");

    const events = (await readFile(join(jobDir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).event);
    assert.deepEqual(events.filter((e) => e.type === "case-start").map((e) => e.caseId), ["one-main", "two-main"]);
    assert.deepEqual(events.filter((e) => e.type === "case-end").map((e) => e.caseId), ["one-main", "two-main"]);
    // Finishing a task reports complete-task, the action every generated case requires.
    assert.deepEqual(events.filter((e) => e.type === "action" && e.action === "complete-task").map((e) => e.caseId), ["one-main", "two-main"]);

    // Chrome's temporary profile is removed when the server ends (Windows keeps it locked until Chrome exits).
    const left = readdirSync(tmpdir()).filter((n) => n.startsWith("xr-webxr-") && !n.startsWith("xr-webxr-test-") && !before.has(n));
    assert.deepEqual(left, []);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
