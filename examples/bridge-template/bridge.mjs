#!/usr/bin/env node
// Study bridge template: a complete stdio MCP server that follows the bridge contract in
// docs/runtime-adapters.md ("Study bridge contract") and passes the audit. Copy this folder to
// private/studies/<name>/runtime/, replace engine.mjs with the connection to your engine, rename
// the tools to the participant's words, and set it in Settings → Runtimes:
//   command  node
//   args     private/studies/<name>/runtime/bridge.mjs {jobFile}
// Node 22 or later, standard library only. Tested in test/bridge.test.ts with the stand-in engine.
import { createHash, randomInt } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Engine } from "./engine.mjs";

// stdout is the MCP channel: anything else written there breaks the session. Log to stderr.
const say = (...a) => process.stderr.write(`[bridge] ${a.join(" ")}\n`);

// ---------- the session to play: job.json → app ----------
const jobFile = process.argv[2] ?? process.env.XR_STUDY_JOB_FILE;
const job = JSON.parse(readFileSync(jobFile, "utf8"));
const app = job.app; // runtime, observation, trace, screenshots, designs (in this job's order), cases
if (!app) throw new Error("job.json has no app section: this configuration does not use the app.");
const jobDir = process.env.XR_STUDY_JOB_DIR ?? dirname(jobFile);
const tracePath = process.env.XR_STUDY_TRACE ?? app.trace ?? join(jobDir, "trace.jsonl");
const shotsDir = app.screenshots ?? join(jobDir, "screenshots");
const SERVER = app.runtime;
const ENGINE_TIMEOUT_MS = 30_000;
const caseInfo = new Map(app.cases.map((c) => [c.caseId, c]));

// ---------- audit trace: one JSON line per event ----------
const trace = (event) => appendFileSync(tracePath, JSON.stringify({ t: Date.now(), server: SERVER, event }) + "\n");

// ---------- state in the job folder ----------
// Claude Code may start the bridge again within the session after it crashed (without a new
// tools/list). Keep everything the session needs here and resume from it.
const statePath = join(jobDir, "bridge-state.json");
const state = existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : { next: 0, design: null, stage: null, frames: 0, shownToEngine: {} };
const save = () => {
  writeFileSync(statePath + ".tmp", JSON.stringify(state));
  renameSync(statePath + ".tmp", statePath);
};
const design = () => app.designs.find((d) => d.id === state.design) ?? null;
const currentCase = () => (state.stage === "practice" || state.stage === "main" ? design()?.[state.stage] ?? null : null);

class ToolError extends Error {}

// ---------- budgets ----------
function checkBudgets(tool) {
  // Token budget: the executor keeps usage.json current; refuse every call once submitNow is set or 90% is used.
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
  // Tool-call cap shared with the study server: calls.log holds one line per ACCEPTED call. Check
  // first, append only when accepted; the lock folder keeps parallel calls on two servers apart.
  const lock = join(jobDir, "calls.lock");
  let held = false;
  for (let i = 0; i < 400 && !held; i++) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (e) {
      if (e.code !== "EEXIST") break;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 2000) rmdirSync(lock); // left by a crashed holder
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

// ---------- the engine ----------
const engine = new Engine();
let connected = false;
let observation = "mono";
let resumeNote = "";
/** Every engine call has a time limit, and the reply says so instead of hanging. */
async function call(what, fn) {
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, fail) => (timer = setTimeout(() => fail(new ToolError(`The app did not answer within ${ENGINE_TIMEOUT_MS / 1000} s (${what}). Try again.`)), ENGINE_TIMEOUT_MS))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** Connect on the first tool call (never before answering tools/list), report the runtime, resume. */
async function connect() {
  if (connected) return;
  const id = await call("connect", () => engine.connect());
  connected = true;
  const caps = Array.isArray(id.capabilities) ? id.capabilities : [];
  // Stereo only when the configuration asks for it and the engine really captures two eyes.
  observation = app.observation === "stereo-pair" && caps.includes("stereo-capture") ? "stereo-pair" : "mono";
  // Once per start of this process: a second runtime event in one session tells the audit that the
  // bridge was started again. pid helps to read the trace.
  trace({ type: "runtime", engine: id.engine, engineVersion: id.engineVersion, backend: id.backend, deviceProfile: id.deviceProfile, observation, capabilities: caps, pid: process.pid });
  const c = currentCase();
  if (c) {
    // Started again in the middle of a task: the engine lost it; start that task again.
    await call("load", () => engine.load({ design: state.design, phase: state.stage, actions: caseInfo.get(c.caseId)?.requiredActions ?? [] }));
    trace({ type: "phase", phaseId: c.phaseId });
    trace({ type: "case-start", caseId: c.caseId, phaseId: c.phaseId });
    resumeNote = `The app was restarted: the ${state.stage === "practice" ? "practice task" : "scored task"} of ${design().label} starts again. `;
  }
}
async function enter(stage) {
  state.stage = stage;
  save();
  const c = currentCase();
  if (!c) return;
  await call("load", () => engine.load({ design: state.design, phase: stage, actions: caseInfo.get(c.caseId)?.requiredActions ?? [] }));
  trace({ type: "phase", phaseId: c.phaseId });
  trace({ type: "case-start", caseId: c.caseId, phaseId: c.phaseId });
}
function endCase(submitted) {
  const c = currentCase();
  if (c) trace({ type: "case-end", caseId: c.caseId, phaseId: c.phaseId, submitted });
}
/** Neutral object IDs, drawn afresh for every design (obj-1 … obj-N in random order), logged for the audit. */
async function drawIds() {
  const ids = (await call("objects", () => engine.objects())).map((o) => o.id);
  const shown = ids.map((_, i) => `obj-${i + 1}`);
  for (let i = shown.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [shown[i], shown[j]] = [shown[j], shown[i]];
  }
  state.shownToEngine = Object.fromEntries(ids.map((id, i) => [shown[i], id]));
  save();
  appendFileSync(join(jobDir, "object-ids.jsonl"), JSON.stringify({ t: Date.now(), design: state.design, shownToEngine: state.shownToEngine }) + "\n");
}
/** One view: a mono image or a synchronized left/right pair, logged as one observation. */
async function view() {
  const c = currentCase();
  state.frames++;
  save();
  // Unique within the job, also across restarts (the counter is in the state file); the job ID
  // keeps it unique across jobs.
  const frameId = `${job.jobId}-f${state.frames}`;
  const eyes = observation === "stereo-pair" ? ["left", "right"] : ["mono"];
  const shots = [];
  for (const eye of eyes) shots.push({ eye, ...(await call("capture", () => engine.capture(eye))) });
  mkdirSync(shotsDir, { recursive: true });
  const captures = shots.map((s) => {
    writeFileSync(join(shotsDir, `${String(state.frames).padStart(4, "0")}-${state.design}-${s.eye}.png`), s.png);
    const capture = { eye: s.eye, sha256: createHash("sha256").update(s.png).digest("hex"), frameId, simulationTimeMs: Math.round(shots[0].simulationTimeMs) };
    // Stereo: per-eye geometry in the shape the audit checks (same separation for both eyes, flat 16-number matrices).
    return observation === "stereo-pair" ? { ...capture, eyeSeparationM: shots[0].eyeSeparationM, viewMatrix: s.viewMatrix, projectionMatrix: s.projectionMatrix } : capture;
  });
  if (c) trace({ type: "observation", caseId: c.caseId, phaseId: c.phaseId, captures });
  return shots.flatMap((s) => [
    ...(eyes.length > 1 ? [{ type: "text", text: `${s.eye === "left" ? "Left" : "Right"} eye:` }] : []),
    { type: "image", data: s.png.toString("base64"), mimeType: "image/png" },
  ]);
}
function needTask() {
  if (!currentCase()) throw new ToolError(state.next < app.designs.length ? `Open the next design first: ${app.designs[state.next].id}.` : "Every design is done. Submit your forecast.");
}
const text = (t) => [{ type: "text", text: t }];

// ---------- participant tools ----------
const order = app.designs.map((d) => d.id);
const tools = [
  {
    name: "open_design",
    description: `Start the next design, in this order: ${order.join(", ")}. It loads in a fresh state and its practice task begins.`,
    inputSchema: { type: "object", properties: { design: { type: "string", enum: order } }, required: ["design"] },
    async run({ design: id }) {
      // Designs only in this job's order; never one twice.
      if (!order.includes(id)) throw new ToolError(`Unknown design ${id}. Your order: ${order.join(", ")}.`);
      if (order.indexOf(id) < state.next) throw new ToolError(`${id} is done. ${state.next < order.length ? `The next one is ${order[state.next]}.` : "Submit your forecast."}`);
      if (order.indexOf(id) > state.next) throw new ToolError(`Not yet: the next design is ${order[state.next]}.`);
      await connect();
      endCase(false); // a task left unfinished
      resumeNote = "";
      state.design = id;
      state.next++;
      const d = design();
      await enter(d.practice ? "practice" : "main");
      await drawIds();
      return [...text(`You now use ${d.label}. ${JSON.stringify(await call("state", () => engine.state()))} Your view:`), ...(await view())];
    },
  },
  {
    name: "look",
    description: "Turn your head: yaw in degrees (0 = ahead, + right), pitch in degrees (+ up). Returns your new view.",
    inputSchema: { type: "object", properties: { yaw: { type: "number" }, pitch: { type: "number" } }, required: ["yaw", "pitch"] },
    async run({ yaw, pitch }) {
      await connect();
      needTask();
      await call("look", () => engine.look(Number(yaw) || 0, Number(pitch) || 0));
      const c = currentCase();
      // Looking is not a task answer: scored false (minActions and observeBeforeEachAction count scored actions).
      trace({ type: "action", caseId: c.caseId, phaseId: c.phaseId, action: "look-around", completed: true, scored: false });
      return [...text("You turned your head. Your view:"), ...(await view())];
    },
  },
  {
    name: "screenshot",
    description: "See your current view (a left/right pair in stereo sessions).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      await connect();
      needTask();
      return view();
    },
  },
  {
    name: "list_objects",
    description: "Objects with neutral IDs (obj-…) and their position in the image (0–1). IDs change with every design; look at the images to tell them apart.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      await connect();
      needTask();
      const toShown = Object.fromEntries(Object.entries(state.shownToEngine).map(([s, e]) => [e, s]));
      const rows = (await call("objects", () => engine.objects())).map((o) => ({ id: toShown[o.id] ?? "unknown", x: o.x, y: o.y }));
      return text(JSON.stringify(rows.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }))));
    },
  },
  {
    name: "act",
    description: `Do one of the task's actions (${[...new Set(app.cases.flatMap((c) => c.requiredActions))].join(", ")}), on an object (obj-…) where it needs one. Wrong actions count as errors.`,
    inputSchema: { type: "object", properties: { action: { type: "string" }, object: { type: "string" } }, required: ["action"] },
    async run({ action, object }) {
      await connect();
      needTask();
      const c = currentCase();
      const target = object === undefined ? undefined : state.shownToEngine[String(object)];
      if (object !== undefined && !target) throw new ToolError(`Unknown object ${object}. Use an ID from list_objects for this design.`);
      const r = await call("act", () => engine.act(String(action), target));
      // Completed only when the engine confirms it; one scored action per answer. `result` holds only
      // what the participant perceives; `args` the neutral object ID.
      trace({
        type: "action",
        caseId: c.caseId,
        phaseId: c.phaseId,
        action: String(action),
        completed: !!r.completed,
        scored: true,
        result: { accepted: !!r.completed },
        ...(object !== undefined ? { args: { object: String(object) } } : {}),
      });
      if (!r.taskDone) return text(r.message);
      endCase(true);
      if (state.stage === "practice" && design().main) {
        await enter("main");
        return text(`${r.message} Task finished: practice is over, the scored task starts now. ${JSON.stringify(await call("state", () => engine.state()))}`);
      }
      state.stage = "done";
      save();
      return text(`${r.message} Task finished: that was the last task of ${design().label}. ${state.next < order.length ? `Open the next design: ${order[state.next]}.` : "Every design is done: submit your forecast."}`);
    },
  },
  {
    name: "task_state",
    description: "What the task panel shows, and which designs are left.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const panel = connected && currentCase() ? await call("state", () => engine.state()) : null;
      return text(JSON.stringify({ design: state.design, part: state.stage, panel, designsLeft: order.slice(state.next) }));
    },
  },
];

// ---------- MCP over stdio (JSON-RPC 2.0, one message per line) ----------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
let chain = Promise.resolve(); // the agent may call tools in parallel: one at a time here
async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "study-bridge", version: "1" } } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  // Answered at once, before any engine connection.
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  if (method !== "tools/call") return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  const tool = tools.find((t) => t.name === params?.name);
  if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool ${params?.name}` } });
  const run = async () => {
    try {
      checkBudgets(tool.name);
      const content = await tool.run(params.arguments ?? {});
      // After a restart, the first reply says that the task starts again.
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
  chain = chain.then(run, run);
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
// stdin closes when the session ends, usually after the forecast. Then only a task still open is
// closed (case-end with submitted false, which the audit allows after the forecast); nothing else
// is written. Close what this bridge started in the engine.
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await chain.catch(() => undefined);
  if (connected) endCase(false);
  await Promise.race([engine.close(), new Promise((ok) => setTimeout(ok, 5000))]).catch((e) => say("close failed:", e.message));
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
