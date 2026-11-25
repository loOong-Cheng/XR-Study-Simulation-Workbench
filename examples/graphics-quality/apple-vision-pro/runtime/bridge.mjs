#!/usr/bin/env node
// Study bridge for the Apple Vision Pro version of suite 3: a stdio MCP server (docs/runtime-adapters.md,
// "Study bridge contract") that plays the visionOS study app in the visionOS simulator. It offers the
// same participant tools as the built-in WebXR runtime (open_design, screenshot, app_state, look,
// list_objects, select), so the two runtimes can be compared on one study. Settings → Runtimes → visionos:
//   command  node
//   args     examples/graphics-quality/apple-vision-pro/runtime/bridge.mjs {jobFile}
//   optional --app <GraphicsQuality.app> --device <simulator name or UDID>
// Build the app first: node examples/graphics-quality/apple-vision-pro/runtime/build.mjs. macOS, Node 22+,
// standard library only.
import { createHash, randomInt } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SimError, VisionSim } from "./sim.mjs";

// stdout is the MCP channel: anything else written there breaks the session. Log to stderr.
const say = (...a) => process.stderr.write(`[visionos-bridge] ${a.join(" ")}\n`);

// ---------- the session: job.json ----------
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const jobFile = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--"))) ?? process.env.XR_STUDY_JOB_FILE;
const job = JSON.parse(readFileSync(jobFile, "utf8"));
const app = job.app;
if (!app) throw new Error("job.json has no app section: this configuration does not use the app.");
const jobDir = process.env.XR_STUDY_JOB_DIR ?? dirname(jobFile);
const tracePath = process.env.XR_STUDY_TRACE ?? app.trace ?? join(jobDir, "trace.jsonl");
const shotsDir = app.screenshots ?? join(jobDir, "screenshots");
const SERVER = app.runtime ?? "visionos";
const participant = job.participantId ?? "population";
const sim = new VisionSim({ app: opt("--app"), device: opt("--device"), log: (m) => say(m) });

const trace = (event) => appendFileSync(tracePath, JSON.stringify({ t: Date.now(), server: SERVER, event }) + "\n");

// ---------- state in the job folder (Claude Code may start a crashed bridge again) ----------
const statePath = join(jobDir, "bridge-state.json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { next: 0, design: null, stage: null, frames: 0, opened: 0, shownToApp: {}, openedAt: 0 };
const save = () => {
  writeFileSync(statePath + ".tmp", JSON.stringify(state));
  renameSync(statePath + ".tmp", statePath);
};
const design = () => app.designs.find((d) => d.id === state.design) ?? null;
const currentCase = () => (state.stage === "practice" || state.stage === "main" ? design()?.[state.stage] ?? null : null);

class ToolError extends Error {}

// ---------- budgets (shared with the study server: calls.log, one line per accepted call) ----------
function checkBudgets(tool) {
  if (job.tokenBudget) {
    let u = {};
    try {
      u = JSON.parse(readFileSync(join(jobDir, "usage.json"), "utf8"));
    } catch {
      // not written yet
    }
    if (u.submitNow === true || (Number(u.tokens) || 0) >= job.tokenBudget * 0.9)
      throw new ToolError(`Token budget of ${job.tokenBudget} tokens is nearly used up. Submit your forecast now.`);
  }
  const lock = join(jobDir, "calls.lock");
  let held = false;
  for (let i = 0; i < 400 && !held; i++) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (e) {
      if (e.code !== "EEXIST") break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 2000) rmdirSync(lock);
      } catch {
        // released meanwhile
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    let used = 0;
    try {
      used = readFileSync(join(jobDir, "calls.log"), "utf8").split("\n").filter((l) => l.trim() && l.trim() !== "submit_forecast").length;
    } catch {
      // first call
    }
    if (job.budget && used >= job.budget) throw new ToolError(`Tool budget of ${job.budget} calls is used up. Submit your forecast now.`);
    appendFileSync(join(jobDir, "calls.log"), tool + "\n");
  } finally {
    if (held) rmdirSync(lock);
  }
}

// ---------- the simulator ----------
/** Every simulator call has a time limit; its failure reaches the agent as a short reason. */
async function call(what, fn, ms = 60_000) {
  let timer;
  try {
    return await Promise.race([fn(), new Promise((_, fail) => (timer = setTimeout(() => fail(new ToolError(`The app did not answer within ${ms / 1000} s (${what}). Try again.`)), ms)))]);
  } catch (e) {
    if (e instanceof SimError) throw new ToolError(e.message);
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new ToolError(`The app did not answer (${what}). Try again.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
let connected = false;
let resumeNote = "";
let last = null;
/** Connect on the first tool call (never before answering tools/list), report the runtime, resume. */
async function connect() {
  if (connected) return;
  const id = await call("start the simulator", () => sim.connect(), 600_000);
  connected = true;
  // Mono only: the simulator shows one view, not a left/right pair.
  trace({ type: "runtime", engine: id.engine, engineVersion: id.engineVersion, backend: id.backend, deviceProfile: id.deviceProfile, observation: "mono", capabilities: id.capabilities, pid: process.pid, device: id.device });
  const c = currentCase();
  if (c) {
    // Started again in the middle of a task: the app's state is gone; that task starts again from its first trial.
    await launch(state.stage);
    trace({ type: "phase", phaseId: c.phaseId });
    trace({ type: "case-start", caseId: c.caseId, phaseId: c.phaseId });
    resumeNote = `The app was restarted: the ${state.stage === "practice" ? "practice task" : "scored task"} of ${design().label} starts again. `;
  }
}
/** The app on the current design, calibrated, its task started (at practice, or at the scored trials). */
async function launch(from) {
  await call("open the design", () => sim.launch({ quality: state.design, participant }), 180_000);
  await call("calibrate the view", () => sim.calibrate(), 90_000);
  await call("start the task", () => sim.rpc("start", from === "main" ? { phase: "main" } : {}));
  state.openedAt = Date.now();
  save();
  last = await rawState();
}
async function rawState() {
  const s = await call("read the app", () => sim.rpc("getState"));
  return s && typeof s === "object" ? s : {};
}

// ---------- cases in the trace ----------
function enter(stage) {
  state.stage = stage;
  save();
  const c = currentCase();
  if (!c) return;
  trace({ type: "phase", phaseId: c.phaseId });
  trace({ type: "case-start", caseId: c.caseId, phaseId: c.phaseId });
}
function endCase(submitted) {
  const c = currentCase();
  if (c) trace({ type: "case-end", caseId: c.caseId, phaseId: c.phaseId, submitted });
}
function action(name, f) {
  const c = currentCase();
  if (c) trace({ type: "action", caseId: c.caseId, phaseId: c.phaseId, action: name, completed: f.completed ?? true, scored: f.scored, ...(f.result !== undefined ? { result: f.result } : {}), ...(f.args ? { args: f.args } : {}) });
}
/** Practice → main when the app leaves the practice phase; main → done when it reports done (as the WebXR runtime does). */
async function track(now) {
  const before = last;
  last = now;
  if (!before) return;
  if (state.stage === "practice" && ((before.phase === "practice" && typeof now.phase === "string" && now.phase !== "practice") || now.done === true)) {
    action("complete-task", { scored: false });
    endCase(true);
    enter(design().main ? "main" : "done");
  }
  if (state.stage === "main" && now.done === true) {
    action("complete-task", { scored: false });
    endCase(true);
    state.stage = "done";
    save();
    await saveAppLog();
  }
}
/** The app's own log, kept in the job folder (never shown to the agent), as the WebXR runtime keeps it. */
async function saveAppLog() {
  try {
    const entries = await sim.rpc("log", {}, 10_000);
    const name = `${String(state.opened).padStart(2, "0")}-${String(state.design).replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
    mkdirSync(join(jobDir, "app-logs"), { recursive: true });
    writeFileSync(join(jobDir, "app-logs", name), JSON.stringify({ design: state.design, opened: state.opened, savedAt: new Date().toISOString(), entries }) + "\n");
  } catch (e) {
    say("app log not saved:", e.message);
  }
}

// ---------- what reaches the agent ----------
function publicState(s) {
  const out = {};
  if (!s) return out;
  if (typeof s.phase === "string") out.phase = s.phase.slice(0, 200);
  if (Number.isFinite(s.trial)) out.trial = s.trial;
  if (typeof s.done === "boolean") out.done = s.done;
  if (typeof s.instruction === "string") out.instruction = s.instruction.slice(0, 2000);
  if (s.public && typeof s.public === "object" && JSON.stringify(s.public).length <= 4000) out.public = s.public;
  return out;
}
const appToShown = () => Object.fromEntries(Object.entries(state.shownToApp).map(([s, a]) => [a, s]));
/** Neutral object IDs, drawn afresh for every design (obj-1 … obj-N in random order), logged for the audit. */
async function drawIds() {
  const ids = (await call("list objects", () => sim.rpc("objects"))).map((o) => String(o.id));
  const shown = ids.map((_, i) => `obj-${i + 1}`);
  for (let i = shown.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shown[i], shown[j]] = [shown[j], shown[i]];
  }
  state.shownToApp = Object.fromEntries(ids.map((id, i) => [shown[i], id]));
  save();
  appendFileSync(join(jobDir, "object-ids.jsonl"), JSON.stringify({ t: Date.now(), design: state.design, shownToApp: state.shownToApp }) + "\n");
}
function requireOpen() {
  if (!state.design || !connected) throw new ToolError(state.next < app.designs.length ? `Open a design first with open_design (${app.designs[state.next].id}).` : "Every design is done. Submit your forecast.");
}
function requireActive() {
  requireOpen();
  if (currentCase()) return;
  throw new ToolError(`The task of ${design().label} is finished. ${state.next < app.designs.length ? `Open the next design with open_design (${app.designs[state.next].id}).` : "That was the last design: submit your forecast."}`);
}
const text = (t) => [{ type: "text", text: t }];

// ---------- participant tools (the WebXR runtime's tools, for a fair comparison) ----------
const order = app.designs.map((d) => d.id);
const tools = [
  {
    name: "open_design",
    description: `Open one design of the study in the running app and start its first task (the practice task, if there is one). Visit the designs in this order: ${order.join(", ")}. Opening the next design before the app finished this one leaves its task unfinished.`,
    inputSchema: { type: "object", properties: { design: { type: "string", enum: order } }, required: ["design"] },
    async run({ design: id }) {
      if (!order.includes(id)) throw new ToolError(`Unknown design ${id}. Your order: ${order.join(", ")}.`);
      if (order.indexOf(id) < state.next) throw new ToolError(`${id} is done. ${state.next < order.length ? `The next one is ${order[state.next]}.` : "Submit your forecast."}`);
      if (order.indexOf(id) > state.next) throw new ToolError(`Not yet: the next design is ${order[state.next]}.`);
      await connect();
      if (currentCase()) {
        await saveAppLog();
        endCase(false); // a task left unfinished
      }
      resumeNote = "";
      state.design = id;
      state.stage = null;
      state.next++;
      state.opened++;
      save();
      const d = design();
      await launch("practice");
      enter(d.practice ? "practice" : "main");
      await drawIds();
      return text(`Opened ${d.label}. ${JSON.stringify(publicState(last))}`);
    },
  },
  {
    name: "screenshot",
    description: "See the current view (a single image, as a participant in the headset would see it with one eye).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      await connect();
      requireOpen();
      await track(await rawState());
      const jpg = await call("take a screenshot", () => sim.screenshot());
      state.frames++;
      save();
      mkdirSync(shotsDir, { recursive: true });
      writeFileSync(join(shotsDir, `${String(state.frames).padStart(4, "0")}-${state.design}.jpg`), jpg);
      const c = currentCase();
      const appTime = Number.isFinite(last?.timeMs) ? Number(last.timeMs) : null;
      if (c)
        trace({
          type: "observation",
          caseId: c.caseId,
          phaseId: c.phaseId,
          captures: [{ eye: "mono", sha256: createHash("sha256").update(jpg).digest("hex"), frameId: `${job.jobId}-f${state.frames}`, simulationTimeMs: Math.max(0, Math.round(appTime ?? Date.now() - state.openedAt)), clock: appTime !== null ? "app" : "wall" }],
        });
      return [{ type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" }];
    },
  },
  {
    name: "app_state",
    description: "What the app shows the participant now: the phase, the instruction, whether this design's task is done, and the progress the app displays.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      await connect();
      requireOpen();
      await track(await rawState());
      return text(JSON.stringify(publicState(last)));
    },
  },
  {
    name: "look",
    description:
      "Turn the viewpoint the way a participant turns their head: azimuth in degrees around the vertical axis (0 = the starting direction, positive turns right), polar in degrees down from straight up (0 = up, 90 = level, 180 = straight down). The app may limit the view; the reply says so.",
    inputSchema: { type: "object", properties: { azimuth: { type: "number" }, polar: { type: "number" } }, required: ["azimuth", "polar"] },
    async run(a) {
      await connect();
      requireOpen();
      const azimuth = Number(a.azimuth),
        asked = Number(a.polar);
      if (!Number.isFinite(azimuth) || !Number.isFinite(asked)) throw new ToolError("azimuth and polar are numbers in degrees.");
      const polar = Math.min(180, Math.max(0, asked));
      const reply = await call("turn the view", () => sim.rpc("look", { azimuth, polar }));
      const applied = reply && Number.isFinite(reply.azimuth) && Number.isFinite(reply.polar) ? { azimuth: Number(reply.azimuth), polar: Number(reply.polar) } : { azimuth, polar };
      const turned = (x, y) => Math.abs((((x - y) % 360) + 540) % 360 - 180) > 0.01;
      const limited = turned(applied.azimuth, azimuth) || Math.abs(applied.polar - asked) > 0.01;
      action("look-around", { scored: false, args: { azimuth, polar: asked } });
      return text(
        limited
          ? `The view is limited: you asked for azimuth ${azimuth}°, polar ${asked}°; the view is now azimuth ${Math.round(applied.azimuth * 10) / 10}°, polar ${Math.round(applied.polar * 10) / 10}°. Take a screenshot to see it.`
          : "View changed. Take a screenshot to see it.",
      );
    },
  },
  {
    name: "list_objects",
    description:
      "Objects you can select: neutral IDs (obj-1 …), whether each is on screen and visible, and screen positions of visible ones (x, y from 0 to 1 from the top-left corner). Names and materials are not given; look at a screenshot. The IDs are drawn afresh for every design.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      await connect();
      requireOpen();
      const toShown = appToShown();
      const rows = (await call("list objects", () => sim.objects())).map((o) => ({
        id: toShown[o.id] ?? "unknown",
        visible: o.visible,
        onScreen: o.onScreen,
        ...(o.visible ? { x: Math.round(o.x * 10_000) / 10_000, y: Math.round(o.y * 10_000) / 10_000 } : {}),
      }));
      rows.sort((x, y) => Number(String(x.id).slice(4)) - Number(String(y.id).slice(4)));
      return text(JSON.stringify(rows));
    },
  },
  {
    name: "select",
    description: "Select an object by its ID from list_objects, as a participant pinches it. The app decides whether it was right; wrong selections count as errors.",
    inputSchema: { type: "object", properties: { object: { type: "string" } }, required: ["object"] },
    async run(a) {
      await connect();
      requireOpen();
      await track(await rawState());
      requireActive();
      const shown = String(a.object);
      const appId = state.shownToApp[shown];
      if (!appId) throw new ToolError(`Unknown object "${shown}". Use an ID from list_objects for this design; IDs change with every design.`);
      const r = await call("select", () => sim.rpc("select", { id: appId }));
      const result = {};
      for (const k of ["accepted", "correct"]) if (typeof r?.[k] === "boolean") result[k] = r[k];
      if (typeof r?.reason === "string") result.reason = r.reason.slice(0, 300);
      const accepted = result.accepted !== false;
      // Logged before the task's end: the study server judges the trace as it is when the forecast arrives.
      action("select-target", { scored: accepted, completed: accepted, result, args: { object: shown } });
      await track(await rawState());
      return text(JSON.stringify({ result, state: publicState(last) }));
    },
  },
];

// ---------- MCP over stdio (JSON-RPC 2.0, one message per line) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let chain = Promise.resolve();
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "visionos-study-bridge", version: "1" } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (method !== "tools/call") return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  const tool = tools.find((t) => t.name === params?.name);
  if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
  const runIt = async () => {
    try {
      checkBudgets(tool.name);
      const content = await tool.run(params.arguments ?? {});
      if (resumeNote) {
        if (content[0]?.type === "text") content[0] = { type: "text", text: resumeNote + content[0].text };
        else content.unshift({ type: "text", text: resumeNote.trim() });
        resumeNote = "";
      }
      send({ jsonrpc: "2.0", id, result: { content } });
    } catch (e) {
      if (!(e instanceof ToolError)) say("unexpected:", e.stack);
      send({ jsonrpc: "2.0", id, result: { content: text(e instanceof ToolError ? e.message : `The app did not respond as expected (${e.message}). Try again.`), isError: true } });
    }
  };
  chain = chain.then(runIt, runIt);
  return chain;
}
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      say("not JSON:", line.slice(0, 200));
    }
  }
});

// ---------- end of the session ----------
// The task still open is closed as not submitted, the app is ended; the simulator stays booted for
// the next session (shut it down with: xcrun simctl shutdown "XR Study Sim (Apple Vision Pro)").
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await chain.catch(() => undefined);
  if (connected && currentCase()) {
    await saveAppLog();
    endCase(false);
  }
  await Promise.race([sim.terminate(), new Promise((ok) => setTimeout(ok, 10_000))]).catch((e) => say("close failed:", e.message));
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
