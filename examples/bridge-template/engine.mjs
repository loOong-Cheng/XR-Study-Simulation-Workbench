// Stand-in engine for the study bridge template (bridge.mjs). Replace this file with the connection
// to your engine: its MCP server, an endpoint inside the project, a socket. Everything here is
// invented: a tiny scene with three objects whose task is done after a number of trials, each trial
// being every required action of the task once.
//
// The bridge needs these methods (all may be async):
//   connect()                   -> { engine, engineVersion, backend, deviceProfile, capabilities }  (ask the engine)
//   load({ design, phase, actions }) a fresh state for one design's task (practice or main)
//   objects()                   -> [{ id, x, y }]  the engine's own object IDs (the bridge shows neutral ones)
//   look(yaw, pitch)            turn the head
//   capture(eye)                -> { png: Buffer, simulationTimeMs, eyeSeparationM, viewMatrix[16], projectionMatrix[16] }
//                                  eye is "mono", "left" or "right"; both eyes of one frame share simulationTimeMs
//   act(action, objectId)       -> { completed, taskDone, message }
//   state()                     -> what the participant's task panel shows
//   close()                     end the session in the engine
// FAKE_ENGINE_IDENTITY (JSON) overrides what connect() reports; FAKE_ENGINE_TRIALS ("1,6") sets the
// trials of a practice and a main task. Both exist for tests only.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

const identity = {
  engine: "custom",
  engineVersion: "fake-1",
  backend: "custom",
  deviceProfile: "desktop",
  capabilities: ["screenshot", "phase-events", "stereo-capture"],
  ...(process.env.FAKE_ENGINE_IDENTITY ? JSON.parse(process.env.FAKE_ENGINE_IDENTITY) : {}),
};
const [practiceTrials, mainTrials] = (process.env.FAKE_ENGINE_TRIALS ?? "1,6").split(",").map(Number);

/** A small solid-colour PNG, so every capture is a real image with its own hash. */
function png(r, g, b) {
  const w = 32,
    h = 32;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: h }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export class Engine {
  started = Date.now();
  task = null;
  yaw = 0;
  pitch = 0;
  frame = 0;
  async connect() {
    // Test only: an engine process of its own (its PID is appended to the file named here), as a
    // real bridge may start the engine; close() ends it.
    if (process.env.FAKE_ENGINE_PROCESS) {
      this.child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      appendFileSync(process.env.FAKE_ENGINE_PROCESS, `${this.child.pid}\n`);
    }
    return { ...identity };
  }
  async load({ design, phase, actions }) {
    this.task = { design, phase, actions, trial: 0, trials: phase === "practice" ? practiceTrials : mainTrials, done: new Set() };
    this.yaw = this.pitch = 0;
  }
  async objects() {
    return [
      { id: "red-cube", x: 0.3, y: 0.5 },
      { id: "green-sphere", x: 0.5, y: 0.5 },
      { id: "blue-cone", x: 0.7, y: 0.5 },
    ];
  }
  async look(yaw, pitch) {
    this.yaw = yaw;
    this.pitch = pitch;
  }
  async capture(eye) {
    const ipd = 0.063;
    const x = eye === "left" ? -ipd / 2 : eye === "right" ? ipd / 2 : 0;
    // Column-major 4×4 matrices, flattened: the view moves by half the eye separation per eye.
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -1.6, 0, 1];
    const projection = [1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, -1.0002, -1, 0, 0, -0.020002, 0];
    if (eye !== "right") this.frame++;
    const shade = (this.frame * 37 + (eye === "right" ? 90 : 0)) % 256;
    return {
      png: png(shade, (this.yaw * 3) & 255, (this.pitch * 3) & 255),
      simulationTimeMs: Date.now() - this.started,
      eyeSeparationM: ipd,
      viewMatrix: view,
      projectionMatrix: projection,
    };
  }
  async act(action, objectId) {
    const t = this.task;
    if (!t) return { completed: false, taskDone: false, message: "No task is running." };
    if (!t.actions.includes(action)) return { completed: false, taskDone: false, message: `Nothing happens (${action}).` };
    if (objectId !== undefined && !["red-cube", "green-sphere", "blue-cone"].includes(objectId))
      return { completed: false, taskDone: false, message: "There is no such object." };
    t.done.add(action);
    if (t.done.size === t.actions.length) {
      t.trial++;
      t.done.clear();
    }
    const taskDone = t.trial >= t.trials;
    return { completed: true, taskDone, message: taskDone ? "Done." : `Trial ${t.trial + 1} of ${t.trials}.` };
  }
  async state() {
    const t = this.task;
    return t ? { phase: t.phase, trial: Math.min(t.trial + 1, t.trials), trials: t.trials, instruction: `Do: ${t.actions.join(", ")}.` } : { phase: "none" };
  }
  async close() {
    this.task = null;
    this.child?.kill();
  }
}
