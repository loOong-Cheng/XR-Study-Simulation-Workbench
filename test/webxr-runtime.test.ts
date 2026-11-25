// The built-in WebXR runtime (src/runtimes/webxr-mcp.ts) against a tiny offline app.
// Needs Google Chrome (CHROME_PATH, or the default install location); skipped without it.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, constants as osConstants, getPriority, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { defaultSettings, runtimeLimits } from "../src/settings.js";

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

// Servers end with this file's tests, also when a test hangs and --test-timeout cancels it.
const children = new Set<ChildProcess>();
after(() => children.forEach((c) => c.kill()));
function client(jobDir: string, path = server) {
  const child = spawn(process.execPath, [path, jobDir], { stdio: ["pipe", "pipe", "ignore"] });
  children.add(child);
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
  const close = () => new Promise<void>((ok) => (child.exitCode !== null || child.signalCode !== null ? ok() : (child.on("exit", () => ok()), child.stdin!.end())));
  // Ends the server (and its Chrome) when a test failed before closing it, so `node --test` never waits on it.
  const kill = () => void (child.exitCode === null && child.signalCode === null && child.kill());
  return { rpc, call, close, kill, pid: child.pid! };
}

test("WebXR runtime: per-design object IDs, audit trace and clean shutdown", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  let mcp: ReturnType<typeof client> | undefined;
  try {
    const appDir = join(root, "app"),
      jobDir = join(root, "job");
    await mkdir(appDir);
    await mkdir(jobDir);
    await writeFile(join(appDir, "index.html"), app);
    const designs = ["one", "two"].map((id) => ({ id, label: id, practice: null, main: { caseId: `${id}-main`, phaseId: "main" } }));
    await writeFile(join(jobDir, "job.json"), JSON.stringify({ webxr: { jobId: "t", budget: 40, chromePath: chrome, app: { dir: appDir, query: "?design={condition}" }, designs } }));
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("xr-webxr-") && !n.startsWith("xr-webxr-test-")));
    mcp = client(jobDir);
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });

    // Without app.capabilities the basic contract: look, list_objects and select, no pointer or app actions.
    const names = ((await mcp.rpc("tools/list")).result.tools as { name: string }[]).map((t) => t.name).sort();
    assert.deepEqual(names, ["app_state", "list_objects", "look", "open_design", "screenshot", "select"]);
    const seen: string[] = [];
    for (const d of designs) {
      const opened = (await mcp.call("open_design", { design: d.id })).text ?? "";
      assert.match(opened, /^Opened/);
      // Only documented state fields reach the agent (found and errors are not among them).
      assert.doesNotMatch(opened, /errors|found/);
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
    // Each selection carries the app's reply; wrong ones are scored answers too, and the task was submitted.
    const selections = events.filter((e) => e.type === "action" && e.action === "select-target");
    assert.ok(selections.every((e) => e.scored === true && typeof e.result.correct === "boolean" && /^obj-\d$/.test(e.args.object)));
    assert.deepEqual(events.filter((e) => e.type === "case-end").map((e) => e.submitted), [true, true]);
    assert.deepEqual(events.find((e) => e.type === "runtime").capabilities, ["screenshot", "look", "pointer-select", "phase-events"]);

    // Chrome's temporary profile is removed when the server ends (Windows keeps it locked until Chrome exits).
    const left = readdirSync(tmpdir()).filter((n) => n.startsWith("xr-webxr-") && !n.startsWith("xr-webxr-test-") && !before.has(n));
    assert.deepEqual(left, []);
  } finally {
    mcp?.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("WebXR instructions follow the study's tasks and the app's declared capabilities; undeclared required actions are warned about", async () => {
  const { playInstructions } = await import("../src/executor/runner.js");
  const { webxrActionWarnings, webxrCapabilities } = await import("../src/executor/runtimes.js");
  const { validateAgents, validateStudy } = await import("../src/core/validation.js");
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../examples/graphics-quality");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const manifest = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
  const ids = study.cases.filter((c) => c.conditionId === "low").map((c) => c.id);
  // The example declares look and select by ID (and quality-lock, a promise the runtime cannot check).
  assert.deepEqual(webxrCapabilities(manifest), ["screenshot", "look", "pointer-select", "phase-events", "quality-lock"]);
  assert.deepEqual(webxrCapabilities({ app: { serve: "app", query: "" } }), ["screenshot", "look", "pointer-select", "phase-events"], "without app.capabilities: the basic contract");
  const graphics = playInstructions("webxr", ["low"], study, ids, manifest.app.instructions, webxrCapabilities(manifest));
  assert.match(graphics, /look turns the viewpoint/);
  assert.match(graphics, /at least 12 actions/);
  assert.match(graphics, /How to use the webxr tools: look orbits the viewpoint around the table/);
  assert.doesNotMatch(graphics, /point_at|act\(/);
  // A pointing study: no look, no selection by ID, a view before each click.
  const pointing = structuredClone(study);
  pointing.cases.forEach((c) => (c.observeBeforeEachAction = true));
  const text = playInstructions("webxr", ["low"], pointing, ids, undefined, ["screenshot", "pointer-xy", "phase-events"]);
  assert.match(text, /point_at\(x, y\) moves the pointer and click\(x, y\) clicks/);
  assert.match(text, /fresh screenshot before each action/);
  assert.doesNotMatch(text, /look turns|list_objects|around the table|select the requested/);

  assert.deepEqual(webxrActionWarnings(study, agents, manifest), [], "look-around and select-target are recorded for this app");
  const loco = structuredClone(study);
  loco.cases.forEach((c) => (c.requiredActions = ["teleport", "complete-task"]));
  const [warning] = webxrActionWarnings(loco, agents, manifest);
  assert.match(warning, /Required action "teleport" \([a-z]+-(practice|main), .*…\) is not one the WebXR runtime records for this app \(complete-task, look-around, select-target\)/);
  assert.deepEqual(webxrActionWarnings(loco, agents, { app: { ...manifest.app, actions: [{ name: "teleport" }] } }), []);
});

/** A job folder serving `html` as the app, with the given runtime spec fields. */
async function webxrJob(root: string, html: string, webxr: Record<string, unknown>) {
  const appDir = join(root, "app"),
    jobDir = join(root, "job");
  await mkdir(appDir);
  await mkdir(jobDir);
  await writeFile(join(appDir, "index.html"), html);
  await writeFile(join(jobDir, "job.json"), JSON.stringify({ webxr: { jobId: "t", budget: 80, chromePath: chrome, app: { dir: appDir, query: "?design={condition}" }, ...webxr } }));
  return jobDir;
}
const traceOf = async (jobDir: string) => (await readFile(join(jobDir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).event).filter(Boolean);
const toolNames = async (mcp: ReturnType<typeof client>) => ((await mcp.rpc("tools/list")).result.tools as { name: string }[]).map((t) => t.name).sort();

// A Fitts-style pointing app: four 60 px targets in a row, one active at a time. Practice: 2 clicks,
// main: 3; `trial` counts clicks (per target), so only the phase tells practice from main. The switch to
// the main block comes 300 ms after the last practice click. Design "fn" answers window.xrStudy.pointer();
// design "events" listens to real mouse clicks only.
const pointingApp = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#222"><canvas id="c" width="1280" height="720" style="display:block"></canvas><script>
const design = new URLSearchParams(location.search).get("design");
const W = 60, targets = [0, 1, 2, 3].map((i) => ({ id: "t" + i, x: 240 + i * 260, y: 360 }));
const blocks = [{ phase: "practice", n: 2 }, { phase: "main", n: 3 }];
const s = { block: -1, k: 0, hits: 0, misses: 0, done: false, waiting: false, phase: "idle", t0: performance.now() };
const log = [];
const active = () => (s.block < 0 || s.done ? null : targets[(s.k + s.block) % 4]);
const g = document.getElementById("c").getContext("2d");
function draw() { g.fillStyle = "#222"; g.fillRect(0, 0, 1280, 720); for (const t of targets) { g.beginPath(); g.arc(t.x, t.y, W / 2, 0, 7); g.fillStyle = active() === t ? "#2f7de1" : "#555"; g.fill(); } }
function startBlock(b) { s.block = b; s.k = 0; s.phase = blocks[b].phase; s.waiting = false; draw(); }
const under = (px, py) => targets.find((t) => Math.hypot(px - t.x, py - t.y) <= W / 2) || null;
function clickAt(px, py) {
  if (s.block < 0 || s.done || s.waiting) return { accepted: false, reason: "No active target." };
  const target = active(), hit = under(px, py) === target;
  hit ? s.hits++ : s.misses++;
  log.push({ block: s.block, k: s.k, target: target.id, hit });
  if (++s.k >= blocks[s.block].n) {
    if (s.block === 0) { s.waiting = true; setTimeout(() => startBlock(1), 300); }
    else { s.done = true; s.phase = "questionnaire"; }
  }
  draw();
  return { accepted: true, hit };
}
window.xrStudy = {
  getState: () => ({ phase: s.phase, trial: s.block < 0 ? -1 : s.block * 10 + s.k, done: s.done, instruction: s.done ? "" : "Click the blue target.", timeMs: Math.round(performance.now() - s.t0), public: { hits: s.hits, misses: s.misses }, secret: targets.map((t) => t.id) }),
  start: () => startBlock(0),
  listObjects: () => targets.map((t) => ({ id: t.id, x: t.x / 1280, y: t.y / 720, onScreen: true })),
  log: () => log,
};
if (design === "fn") window.xrStudy.pointer = (x, y, kind) => { const o = under(x * 1280, y * 720); return kind === "move" ? { over: o && o.id } : kind === "up" ? clickAt(x * 1280, y * 720) : undefined; };
else document.getElementById("c").addEventListener("click", (e) => clickAt(e.clientX, e.clientY));
draw();
</script></body>`;

test("WebXR runtime: pointer tools only with pointer-xy; hits and misses, filtered state, delayed phase changes, app clock and app log", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  try {
    const designs = ["fn", "events"].map((id) => ({ id, label: id, practice: { caseId: `${id}-practice`, phaseId: "practice" }, main: { caseId: `${id}-main`, phaseId: "main" } }));
    const jobDir = await webxrJob(root, pointingApp, { capabilities: ["screenshot", "pointer-xy", "phase-events"], designs });
    const mcp = client(jobDir);
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.deepEqual(await toolNames(mcp), ["app_state", "click", "open_design", "point_at", "screenshot"], "no select by ID, no look: the app did not declare them");
    // Target centres in screen fractions; the active one is targets[(k + block) % 4].
    const at = (i: number) => ({ x: (240 + i * 260) / 1280, y: 0.5 });

    const opened = (await mcp.call("open_design", { design: "fn" })).text!;
    assert.match(opened, /"hits":0/);
    assert.doesNotMatch(opened, /secret|t0|timeMs/, "only documented fields and public reach the agent");
    const pointed = JSON.parse((await mcp.call("point_at", at(0))).text!);
    assert.match(pointed.result.over, /^obj-[1-4]$/, "what is under the pointer, by neutral ID");
    assert.equal((await mcp.call("screenshot")).content?.[0]?.type, "image");
    assert.equal(JSON.parse((await mcp.call("click", { x: 0.5, y: 0.1 })).text!).result.hit, false, "a click beside the target misses");
    // The second practice click ends practice; the main block starts 300 ms later, within this call.
    const last = JSON.parse((await mcp.call("click", at(1))).text!);
    assert.equal(last.result.hit, true);
    assert.equal(last.state.phase, "main");
    for (const i of [1, 2, 3]) assert.equal(JSON.parse((await mcp.call("click", at(i))).text!).result.hit, true);
    assert.equal(JSON.parse((await mcp.call("app_state")).text!).done, true);
    assert.match((await mcp.call("click", at(0))).text!, /finished\. Open the next design with open_design \(events\)/);

    // Real mouse events: the app's own click handler decides; the runtime records no outcome.
    await mcp.call("open_design", { design: "events" });
    assert.match((await mcp.call("click", at(0))).text!, /reports no outcome/);
    await mcp.call("click", { x: 0.5, y: 0.1 });
    for (const i of [1, 2, 3]) await mcp.call("click", at(i));
    assert.match((await mcp.call("app_state")).text!, /"done":true.*"hits":4,"misses":1/);
    await mcp.close();

    const events = await traceOf(jobDir);
    assert.deepEqual(events.filter((e) => e.type === "case-start").map((e) => e.caseId), ["fn-practice", "fn-main", "events-practice", "events-main"]);
    assert.deepEqual(events.filter((e) => e.type === "case-end").map((e) => [e.caseId, e.submitted]), [["fn-practice", true], ["fn-main", true], ["events-practice", true], ["events-main", true]]);
    const clicks = (caseId: string) => events.filter((e) => e.type === "action" && e.action === "select-target" && e.caseId === caseId);
    // Both practice clicks belong to practice although `trial` rose after the first (the phase decides).
    assert.deepEqual(clicks("fn-practice").map((e) => e.result.hit), [false, true]);
    assert.deepEqual(clicks("fn-main").map((e) => e.result.hit), [true, true, true]);
    assert.ok(clicks("fn-practice").every((e) => e.scored && e.completed && typeof e.args.x === "number"));
    assert.deepEqual(clicks("events-practice").map((e) => [e.result, e.scored]), [[null, true], [null, true]]);
    assert.equal(clicks("events-main").length, 3);
    assert.equal(events.find((e) => e.type === "action" && e.action === "point").scored, false);
    assert.equal(events.find((e) => e.type === "observation").captures[0].clock, "app", "the app's clock (getState().timeMs)");
    // The app's own log, per design, in the job folder (never shown to the agent).
    assert.deepEqual(readdirSync(join(jobDir, "app-logs")).sort(), ["01-fn.json", "02-events.json"]);
    const appLog = JSON.parse(await readFile(join(jobDir, "app-logs", "01-fn.json"), "utf8"));
    assert.deepEqual([appLog.design, appLog.opened, appLog.entries.length], ["fn", 1, 5]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// A locomotion-style app: its own actions (teleport, declared in job.json; turn, listed by the app),
// a flag that appears after a teleport and is hidden behind a pillar, a view limited to polar 120°.
const actionApp = `<!doctype html><meta charset="utf-8"><body style="background:#567"><script>
const s = { trial: -1, done: false, spawned: false, pos: "start" };
window.xrStudy = {
  getState: () => ({ phase: s.done ? "questionnaire" : "main", trial: s.trial, done: s.done, instruction: "Teleport to the flag, then select it.", public: { position: s.pos } }),
  start: () => { s.trial = 0; },
  listObjects: () => [{ id: "rock", x: 0.2, y: 0.5, onScreen: true, visible: true, mass: 3 }, { id: "pillar", x: 0.6, y: 0.5, onScreen: true }, ...(s.spawned ? [{ id: "flag", x: 0.8, y: 0.4, onScreen: true, visible: false }] : [])],
  select: (id) => (id === "flag" ? ((s.done = true), { accepted: true, correct: true }) : { accepted: true, correct: false }),
  look: (azimuth, polar) => ({ azimuth, polar: Math.min(120, polar) }),
  act: (name, args) => new Promise((ok) => setTimeout(() => {
    if (name === "turn") return ok({ accepted: true });
    if (name === "inspect") return ok({ accepted: ["rock", "pillar", "flag"].includes(args.target) && args.list[0] === "rock" });
    if (args.to === "wall") return ok({ accepted: false, reason: "A wall is in the way." });
    s.pos = args.to; s.spawned = true; ok({ accepted: true });
  }, 150)),
  actions: () => [{ name: "turn", params: { degrees: "number" }, scored: false }, { name: "inspect", params: { target: "object ID" }, scored: false }],
};
</script></body>`;

test("WebXR runtime: app actions, late and hidden objects, limited view, abandoned tasks", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  try {
    const designs = ["one", "two"].map((id) => ({ id, label: id, practice: null, main: { caseId: `${id}-main`, phaseId: "main" } }));
    const jobDir = await webxrJob(root, actionApp, {
      capabilities: ["screenshot", "look", "pointer-select", "actions", "phase-events"],
      actions: [{ name: "teleport", description: "Teleport to a marker", params: { to: "string" } }],
      designs,
    });
    const mcp = client(jobDir);
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
    assert.deepEqual(await toolNames(mcp), ["act", "app_state", "list_objects", "look", "open_design", "screenshot", "select"]);
    assert.match((await mcp.call("open_design", { design: "one" })).text!, /teleport\(to\): Teleport to a marker; turn\(degrees\)/);
    const before = JSON.parse((await mcp.call("list_objects")).text!) as Record<string, unknown>[];
    assert.equal(before.length, 2);
    assert.ok(before.every((o) => !("mass" in o) && typeof o.x === "number"), "documented fields only");
    assert.match((await mcp.call("look", { azimuth: 0, polar: 170 })).text!, /view is limited.*polar 120°/);
    const refused = JSON.parse((await mcp.call("act", { name: "teleport", args: { to: "wall" } })).text!);
    assert.deepEqual(refused.result, { accepted: false, reason: "A wall is in the way." });
    await mcp.call("act", { name: "teleport", args: { to: "flag" } });
    await mcp.call("act", { name: "turn", args: { degrees: 90 } });
    assert.match((await mcp.call("act", { name: "fly" })).text!, /Unknown action "fly"\. Actions: teleport/);
    // The flag appeared: existing IDs stay, the new object gets the next one, without a position (hidden).
    const after = JSON.parse((await mcp.call("list_objects")).text!) as Record<string, unknown>[];
    assert.deepEqual(after.slice(0, 2), before);
    assert.deepEqual(after[2], { id: "obj-3", visible: false, onScreen: true });
    // Leaving the design before the app reports done: the task is not submitted.
    await mcp.call("open_design", { design: "two" });
    await mcp.call("act", { name: "teleport", args: { to: "flag" } });
    await mcp.call("list_objects");
    const ids = (await readFile(join(jobDir, "object-ids.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    const flag = Object.entries(ids.at(-1).shownToApp as Record<string, string>).find(([, app]) => app === "flag")![0];
    // Neutral IDs inside an action's arguments (at any depth) reach the app as its own IDs.
    const rock = Object.entries(ids.at(-1).shownToApp as Record<string, string>).find(([, app]) => app === "rock")![0];
    assert.equal(JSON.parse((await mcp.call("act", { name: "inspect", args: { target: flag, list: [rock] } })).text!).result.accepted, true);
    assert.equal(JSON.parse((await mcp.call("select", { object: flag })).text!).result.correct, true);
    assert.match((await mcp.call("select", { object: flag })).text!, /finished\. That was the last design: submit your forecast\./);
    await mcp.close();

    assert.deepEqual(ids.filter((m) => m.added).map((m) => [m.design, Object.values(m.added)]), [["one", ["flag"]], ["two", ["flag"]]]);
    const events = await traceOf(jobDir);
    assert.deepEqual(events.filter((e) => e.type === "case-end").map((e) => [e.caseId, e.submitted]), [["one-main", false], ["two-main", true]]);
    const acts = events.filter((e) => e.type === "action" && e.caseId === "one-main").map((e) => [e.action, e.completed, e.scored]);
    assert.deepEqual(acts, [["look-around", true, false], ["teleport", false, false], ["teleport", true, true], ["turn", true, false]]);
    assert.deepEqual(events.find((e) => e.action === "teleport").result, { accepted: false, reason: "A wall is in the way." });
    // The trace keeps the arguments as the agent sent them (neutral IDs).
    assert.deepEqual(events.find((e) => e.action === "inspect").args, { target: flag, list: [rock] });
    assert.ok(events.find((e) => e.type === "runtime").capabilities.includes("actions"));
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

// A task that ends 900 ms after its last click, with no state change in between (a fade-out):
// two clicks finish it. Design "busy" reports busy: true while the fade runs.
const delayedApp = `<!doctype html><meta charset="utf-8"><body style="background:#333"><script>
const design = new URLSearchParams(location.search).get("design");
const s = { clicks: 0, done: false, fading: false };
window.xrStudy = {
  getState: () => ({ phase: s.done ? "questionnaire" : "main", trial: s.clicks, done: s.done, instruction: "Click twice.", public: { clicks: s.clicks }, ...(design === "busy" ? { busy: s.fading } : {}) }),
  start: () => {},
  pointer: (x, y, kind) => {
    if (kind !== "up") return undefined;
    if (s.done || s.fading) return { accepted: false, reason: "No active target." };
    if (++s.clicks === 2) { s.fading = true; setTimeout(() => { s.fading = false; s.done = true; }, 900); }
    return { accepted: true, hit: true };
  },
};
</script></body>`;
const studyServerPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/runtimes/study-mcp.js");

test("WebXR runtime: a transition after the last action still finishes the task (next design, busy apps, the forecast gate, the session's end)", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  try {
    const ids = ["a", "busy", "b"];
    const designs = ids.map((id) => ({ id, label: id, practice: null, main: { caseId: `${id}-main`, phaseId: "main" } }));
    const jobDir = await webxrJob(root, delayedApp, { capabilities: ["screenshot", "pointer-xy", "phase-events"], designs });
    // The study server reads the same job.json: the required cases and the runtime (for the flush before judging).
    const spec = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8"));
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        ...spec,
        jobId: "t",
        attemptId: "a1",
        budget: 80,
        tokenBudget: null,
        projectDir: null,
        participantId: null,
        designs: ids.map((id) => ({ id, label: id })),
        targets: [{ id: "m", label: "M", unit: "", scale: "likert", aggregation: "arithmetic" }],
        app: { runtime: "webxr", cases: ids.map((id) => ({ caseId: `${id}-main`, conditionId: id })) },
      }),
    );
    const mcp = client(jobDir);
    const study = client(jobDir, studyServerPath);
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
    await study.rpc("initialize", { protocolVersion: "2025-06-18" });
    const click = () => mcp.call("click", { x: 0.5, y: 0.5 });

    // Opening the next design at once: the runtime waits for the fade, so the task counts as finished.
    await mcp.call("open_design", { design: "a" });
    await click();
    assert.equal(JSON.parse((await click()).text!).state.done, false, "the fade outlasts the 400 ms settle");
    await mcp.call("open_design", { design: "busy" });
    // An app that reports busy is read until it is not: the click's own reply already says done.
    await click();
    assert.equal(JSON.parse((await click()).text!).state.done, true);
    // The forecast right after the last click: the study server asks the runtime to flush first.
    await mcp.call("open_design", { design: "b" });
    await click();
    await click();
    const forecast = { predictions: ids.map((design) => ({ design, outcome: "m", value: 3 })) };
    assert.match((await study.call("submit_forecast", forecast)).text!, /Forecast accepted/);
    await mcp.close();
    await study.close();
    const events = await traceOf(jobDir);
    assert.deepEqual(events.filter((e) => e.type === "case-end").map((e) => [e.caseId, e.submitted]), [["a-main", true], ["busy-main", true], ["b-main", true]]);
    assert.ok(events.findIndex((e) => e.type === "forecast") > events.findIndex((e) => e.type === "case-end" && e.caseId === "b-main"), "finished before the forecast");
    assert.equal(JSON.parse(await readFile(join(jobDir, "forecast.json"), "utf8")).toolCalls, 9);

    // The session ends right after the last click (no forecast): the task still counts as finished.
    const second = join(root, "second");
    await mkdir(second);
    await writeFile(join(second, "job.json"), JSON.stringify({ webxr: { ...spec.webxr, designs: [designs[0]] } }));
    const end = client(second);
    await end.rpc("initialize", { protocolVersion: "2025-06-18" });
    await end.call("open_design", { design: "a" });
    await end.call("click", { x: 0.5, y: 0.5 });
    await end.call("click", { x: 0.5, y: 0.5 });
    await end.close();
    assert.deepEqual((await traceOf(second)).filter((e) => e.type === "case-end").map((e) => e.submitted), [true]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("WebXR runtime: the study's motor-noise model moves clicks off the requested point, reproducibly per seed; the trace keeps both", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  try {
    const designs = [{ id: "fn", label: "fn", practice: { caseId: "fn-practice", phaseId: "practice" }, main: { caseId: "fn-main", phaseId: "main" } }];
    const landed: unknown[][] = [];
    for (const run of ["one", "two"]) {
      await mkdir(join(root, run));
      const jobDir = await webxrJob(join(root, run), pointingApp, { capabilities: ["screenshot", "pointer-xy", "phase-events"], designs, pointer: { scatter: "gaussian", sdPx: { fn: 25 }, seed: 42 } });
      const mcp = client(jobDir);
      await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
      await mcp.call("open_design", { design: "fn" });
      for (const i of [0, 1, 1, 2, 3]) await mcp.call("click", { x: (240 + i * 260) / 1280, y: 0.5 });
      await mcp.close();
      const clicks = (await traceOf(jobDir)).filter((e) => e.type === "action" && e.action === "select-target");
      assert.equal(clicks.length, 5);
      for (const c of clicks) assert.ok(c.args.landed && typeof c.args.x === "number", JSON.stringify(c.args));
      assert.ok(clicks.some((c) => c.args.landed.x !== c.args.x || c.args.landed.y !== c.args.y), "the clicks land beside the requested points");
      // Within a few SDs of the requested point (25 px on 1280 × 720).
      assert.ok(clicks.every((c) => Math.abs(c.args.landed.x - c.args.x) * 1280 < 150 && Math.abs(c.args.landed.y - c.args.y) * 720 < 150));
      landed.push(clicks.map((c) => c.args.landed));
    }
    assert.deepEqual(landed[0], landed[1], "the same seed gives the same scatter");
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("exposure: a task left unfinished is not finished; calls after the forecast are reported apart", async () => {
  const { caseProgress, unfinishedCases } = await import("../src/runtimes/exposure.js");
  const { callsUntilForecast, sessionWarnings } = await import("../src/executor/runner.js");
  const events = [
    { type: "case-start", caseId: "p" },
    { type: "case-end", caseId: "p", submitted: true },
    { type: "case-start", caseId: "m" },
    { type: "case-end", caseId: "m", submitted: false },
  ];
  assert.deepEqual(caseProgress(["p", "m", "x"], events), { missing: ["m", "x"], started: ["m"] });
  assert.deepEqual(unfinishedCases(["p", "m"], [...events, { type: "case-start", caseId: "m" }, { type: "case-end", caseId: "m", submitted: true }]), [], "started again and finished");
  assert.deepEqual(unfinishedCases(["m"], [...events, { type: "forecast" }, { type: "case-start", caseId: "m" }, { type: "case-end", caseId: "m", submitted: true }]), ["m"], "not after the forecast");
  assert.deepEqual(callsUntilForecast(150, { toolCalls: 91 }), { calls: 91, afterForecast: 59 });
  assert.deepEqual(callsUntilForecast(12, null), { calls: 12, afterForecast: 0 });
  assert.deepEqual(callsUntilForecast(12, { toolCalls: 40 }), { calls: 12, afterForecast: 0 }, "a count above the total is not trusted");
  const run = { status: "completed", execution: { synthetic: false, toolCallsAfterForecast: 59 }, trace: events } as never;
  const [exposure, after] = sessionWarnings(["p", "m"], "webxr", run);
  assert.match(exposure, /submitted without required exposure \(1 of 2 required tasks not finished: m; 1 of them started but left unfinished\)/);
  assert.equal(after, "59 tool calls after the forecast was accepted (not counted)");
});

// Counts its animation frames and finishes its task inside the animation loop, 10 frames after the
// target is selected, as an app with a frame-driven transition does. look() changes what it draws.
const framesApp = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#888"><canvas id="c" width="1280" height="720"></canvas><script>
const s = { frames: 0, phase: "idle", trial: -1, done: false, pending: -1, shade: 0 };
const ctx = document.getElementById("c").getContext("2d");
function loop() {
  s.frames++;
  if (s.pending >= 0 && s.frames >= s.pending) { s.done = true; s.pending = -1; }
  ctx.fillStyle = "rgb(" + s.shade + ",40,40)";
  ctx.fillRect(0, 0, 1280, 720);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.xrStudy = {
  getState: () => ({ phase: s.done ? "questionnaire" : s.phase, trial: s.trial, done: s.done, public: { frames: s.frames } }),
  start: () => { s.phase = "main"; s.trial = 0; },
  listObjects: () => [{ id: "a", x: 0.5, y: 0.5, onScreen: true }],
  select: () => { s.pending = s.frames + 10; return { accepted: true, correct: true }; },
  look: (azimuth) => { s.shade = Math.min(255, Math.abs(Math.round(azimuth))); },
};
</script></body>`;

test("WebXR runtime: frames on demand (none between tool calls, a fresh one per screenshot, full rate while a transition settles), app.idleFps 60 draws every frame, below-normal priority", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-"));
  const servers: ReturnType<typeof client>[] = [];
  try {
    const appDir = join(root, "app");
    await mkdir(appDir);
    await writeFile(join(appDir, "index.html"), framesApp);
    const open = async (idleFps?: number) => {
      const jobDir = join(root, `job-${idleFps ?? "default"}`);
      await mkdir(jobDir);
      const designs = [{ id: "one", label: "one", practice: null, main: { caseId: "one-main", phaseId: "main" } }];
      await writeFile(join(jobDir, "job.json"), JSON.stringify({ webxr: { jobId: "frames", budget: 60, chromePath: chrome, app: { dir: appDir, query: "?design={condition}" }, designs, ...(idleFps !== undefined ? { idleFps } : {}) } }));
      const mcp = client(jobDir);
      servers.push(mcp);
      await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
      assert.match((await mcp.call("open_design", { design: "one" })).text ?? "", /^Opened/);
      const frames = async () => JSON.parse((await mcp.call("app_state")).text!).public.frames as number;
      return { mcp, jobDir, frames };
    };
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // Paced (the default): the app draws nothing while the agent thinks between tool calls.
    const paced = await open();
    // Chrome renders in software: the runtime (and the Chrome it starts) runs below normal priority.
    assert.equal(getPriority(paced.mcp.pid), osConstants.priority.PRIORITY_BELOW_NORMAL);
    const f0 = await paced.frames();
    await pause(1500);
    const f1 = await paced.frames();
    assert.ok(f1 - f0 <= 1, `no frames between tool calls (${f1 - f0} drawn)`);
    // A screenshot draws one fresh frame first, so it shows what look() changed.
    const before = (await paced.mcp.call("screenshot")).content[0].data as string;
    await paced.mcp.call("look", { azimuth: 200, polar: 90 });
    const after = (await paced.mcp.call("screenshot")).content[0].data as string;
    assert.notEqual(after, before, "the screenshot after look shows the new view");
    const f2 = await paced.frames();
    assert.ok(f2 - f1 >= 2 && f2 - f1 <= 6, `about one frame per screenshot (${f2 - f1} for two)`);
    // A transition the app makes in its animation loop still completes while the runtime settles.
    const selected = JSON.parse((await paced.mcp.call("select", { object: "obj-1" })).text!);
    assert.equal(selected.state.done, true, "the frame-driven transition finished during settle");
    await paced.mcp.close();
    const events = (await readFile(join(paced.jobDir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).event).filter(Boolean);
    assert.deepEqual(events.filter((e) => e.type === "case-end").map((e) => e.submitted), [true]);

    // app.idleFps 60: every frame, as before pacing.
    const every = await open(60);
    // Headless Chrome takes a moment after loading before it draws frames at full rate.
    await pause(2000);
    const g0 = await every.frames();
    await pause(1500);
    assert.ok((await every.frames()) - g0 >= 20, "frames keep running between tool calls");
    await every.mcp.close();
  } finally {
    servers.forEach((m) => m.kill());
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test("WebXR sessions at the same time: one per 4 logical cores by default; Settings overrides it", () => {
  const base = { jobTimeoutMinutes: 30 };
  assert.equal(runtimeLimits({ ...base, runtimes: {} }, "webxr").maxParallel, Math.max(1, Math.floor(availableParallelism() / 4)));
  assert.equal(runtimeLimits({ ...base, runtimes: { webxr: { maxParallel: 5 } } }, "webxr").maxParallel, 5);
  assert.equal(runtimeLimits({ ...base, runtimes: {} }, "unity").maxParallel, 1);
  assert.equal(runtimeLimits({ ...base, runtimes: {} }, "none").maxParallel, Infinity);
});
