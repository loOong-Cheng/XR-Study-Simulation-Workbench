// Study bridges (docs/runtime-adapters.md, "Study bridge contract"): the template bridge through the
// executor and the audit, the shared tool-call cap, the forecast gate, restarts, a bridge that never
// starts, and the shipped Unity bridge (bridge.py) against a stand-in Unity. No real Claude Code
// session is started: claudePath points at test/fixtures/fake-claude-bridge.cjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { freezePlan } from "../src/core/planner.js";
import { validateAgents, validateComparisons, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import type { AgentProtocol, Audit, Study, TraceEvent } from "../src/core/types.js";
import { until } from "./until.js";

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
const template = resolve("examples/bridge-template/bridge.mjs");
const fakeClaude = resolve("test/fixtures/fake-claude-bridge.cjs");
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = existsSync(join(from, "workspace.json")) ? JSON.parse(await readFile(join(from, "workspace.json"), "utf8")) : {};
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}

const MONO = { engine: "unreal", engineVersion: "5.7-fake", backend: "editor", deviceProfile: "webxr-desktop-browser-1280x720", capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"] };
const STEREO = { engine: "unity", engineVersion: "6000-fake", backend: "editor", deviceProfile: "quest-3", capabilities: ["head-pose", "hand-poses", "controller-input", "stereo-capture", "phase-events"] };

/**
 * One real (fake-CLI) session of a study's "uses-app" configuration with the template bridge as the
 * runtime, then the audit of its result. env sets FAKE_PLAN and the stand-in engine.
 */
async function session(
  example: "graphics-quality" | "selection",
  opts: { runtime: string; env: Record<string, string>; bridge?: string[]; settings?: Record<string, unknown>; agent?: Partial<AgentProtocol>; until?: "done" | "failed" },
) {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readHuman, readResults, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples", example));
  const bin = await mkdtemp(join(tmpdir(), "xr-bridge-"));
  const caps = opts.runtime === "unity" ? STEREO.capabilities : MONO.capabilities;
  await writeFile(
    join(bin, "settings.json"),
    JSON.stringify({ claudePath: fakeClaude, runtimes: { [opts.runtime]: { command: process.execPath, args: opts.bridge ?? [template, "{jobFile}"], capabilities: caps, ...opts.settings } } }),
  );
  const env = { XR_STUDY_SETTINGS: join(bin, "settings.json"), FAKE_OUT: join(bin, "out.jsonl"), FAKE_ENGINE_TRIALS: "2,8", ...opts.env };
  Object.assign(process.env, env);
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!.filter((x) => x.id === "uses-app").map((x) => ({ ...x, repetitions: 1, runtime: opts.runtime, ...opts.agent }));
    // Only this configuration is frozen, so the study's planned contrasts (with others) are left out.
    const study = { ...ws.study, analysis: { ...ws.study.analysis, contrasts: [] } };
    const c = campaignFromPlan(freezePlan(study, agents, 1), undefined, "bridge-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent");
    await until(() => !!ex.snapshot().counts.done || !!ex.snapshot().counts.failed, "the session to end", { executor: ex });
    const job = ex.snapshot().jobs[0];
    assert.equal(job.status, opts.until ?? "done", JSON.stringify(job));
    const jobDir = join(runDir(a.id, c.id), "jobs", c.jobs[0].id, "a1");
    const results = await readResults(a.id, ws.study, [c.id]);
    const audit: Audit | null = results.length && results[0].runs.length ? analyzeCampaign(c, (await readHuman(a.id))!, results).report.audits[0] : null;
    const out = existsSync(env.FAKE_OUT) ? (await readFile(env.FAKE_OUT, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { what: string; text: string }) : [];
    const read = async (f: string) => (existsSync(join(jobDir, f)) ? (await readFile(join(jobDir, f), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    return { job, jobDir, run: results[0]?.runs[0], audit, out, trace: (await read("trace.jsonl")).filter((l) => l.event).map((l) => l.event as TraceEvent), bridgeLog: await read("bridge.jsonl"), calls: existsSync(join(jobDir, "calls.log")) ? (await readFile(join(jobDir, "calls.log"), "utf8")).split("\n").filter((l) => l && l !== "submit_forecast") : [], cleanup: async () => (await removeDir(a.dir), await removeDir(bin)) };
  } catch (e) {
    await removeDir(a.dir);
    await removeDir(bin);
    throw e;
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

test("bridge template: mono and stereo sessions through the executor pass the audit", async () => {
  for (const [example, runtime, identity] of [["graphics-quality", "unreal", MONO], ["selection", "unity", STEREO]] as const) {
    const s = await session(example, { runtime, env: { FAKE_PLAN: "play", FAKE_ENGINE_IDENTITY: JSON.stringify(identity) } });
    try {
      assert.ok(s.audit?.scoreable && s.audit.compliant, `${example}: ${JSON.stringify(s.audit?.issues)}`);
      assert.equal(s.job.warning, null, s.job.warning ?? "");
      // What the runtime reported, its starts, the simulated time its captures report.
      assert.equal(s.run!.execution.engine, identity.engine);
      assert.equal(s.run!.execution.observation, runtime === "unity" ? "stereo-pair" : "mono");
      assert.equal(s.run!.execution.runtimeStarts, 1);
      assert.ok(s.run!.execution.simulationTimeMs > 0);
      assert.deepEqual(s.bridgeLog.map((x) => x.type).slice(0, 2), ["start", "ready"]);
      // Stereo captures in the audited shape; one screenshot file per capture.
      const caps = s.trace.flatMap((e) => (e.type === "observation" ? e.captures : []));
      if (runtime === "unity") assert.ok(caps.every((c) => c.eyeSeparationM === 0.063 && c.viewMatrix?.length === 16));
      assert.equal((await readdir(join(s.jobDir, "screenshots"))).length, caps.length);
      assert.equal(s.run!.execution.toolCalls, s.calls.length);
    } finally {
      await s.cleanup();
    }
  }
});

test("bridge restart: resumes its state, frames stay unique, the engine it started ends; executor and audit say so", async () => {
  const pids = join(await mkdtemp(join(tmpdir(), "xr-engine-")), "pids.txt");
  const s = await session("graphics-quality", { runtime: "unreal", env: { FAKE_PLAN: "crash", FAKE_ENGINE_IDENTITY: JSON.stringify(MONO), FAKE_ENGINE_PROCESS: pids } });
  try {
    assert.match(s.job.warning ?? "", /the Unreal bridge restarted during the session/);
    assert.equal(s.run!.execution.runtimeStarts, 2);
    assert.ok(s.audit!.scoreable);
    assert.ok(s.audit!.issues.some((i) => /The runtime restarted during the session \(2 starts\)/.test(i)), JSON.stringify(s.audit!.issues));
    // Only the restart is a deviation: order, frames and the forecast boundary are intact.
    assert.equal(s.audit!.issues.length, 1, JSON.stringify(s.audit!.issues));
    assert.match(s.out.find((o) => o.what === "after-restart")!.text, /The app was restarted: the practice task of/);
    const caps = s.trace.flatMap((e) => (e.type === "observation" ? e.captures : []));
    assert.equal(new Set(caps.map((c) => c.frameId)).size, caps.length);
    assert.equal((await readdir(join(s.jobDir, "screenshots"))).length, caps.length);
    // The engine process of the crashed bridge was ended with it; the second one at the end of the session.
    const engines = (await readFile(pids, "utf8")).trim().split("\n").map(Number);
    assert.equal(engines.length, 2);
    // Windows may keep a killed process listed for a moment; only POSIX is asserted below.
    await until(() => !engines.some(alive), "the engine processes to end", { limitMs: 30_000 }).catch(() => undefined);
    if (process.platform !== "win32") assert.deepEqual(engines.filter(alive), []);
  } finally {
    await s.cleanup();
    await removeDir(resolve(pids, ".."));
  }
});

test("a bridge that never answers tools/list fails the session after startupSeconds", async () => {
  const bin = await mkdtemp(join(tmpdir(), "xr-hang-"));
  const hang = join(bin, "hang.cjs");
  // Answers initialize, never tools/list; logs to stderr.
  await writeFile(
    hang,
    `require("readline").createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l); console.error("hang bridge got " + m.method);
  if (m.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hang", version: "1" } } }) + "\\n"); });`,
  );
  const started = Date.now();
  const s = await session("selection", { runtime: "unity", bridge: [hang, "{jobFile}"], settings: { startupSeconds: 1 }, env: { FAKE_PLAN: "hang" }, until: "failed" });
  try {
    assert.match(s.job.error ?? "", /^The Unity bridge did not start \(no answer to tools\/list within 1 s\)\. Its last output: .*hang bridge got tools\/list/);
    assert.ok(Date.now() - started < 20_000);
    assert.deepEqual(s.bridgeLog.map((x) => x.type).slice(0, 1), ["start"]);
    assert.ok(!s.bridgeLog.some((x) => x.type === "ready"));
  } finally {
    await s.cleanup();
    await removeDir(bin);
  }
});

test("forecast gate: no forecast before the required cases, unless the budget is nearly used up; the row says so", async () => {
  const s = await session("graphics-quality", { runtime: "unreal", env: { FAKE_PLAN: "gate", FAKE_ENGINE_IDENTITY: JSON.stringify(MONO) }, agent: { maxTokens: 20_000 } });
  try {
    assert.match(s.out.find((o) => o.what === "first-submit")!.text, /^Forecast not accepted yet: experience the app first\. Not done yet: the practice task of design Low quality \(low-practice\); the main task of design Low quality \(low-main\);/);
    assert.match(s.out.find((o) => o.what === "second-submit")!.text, /Forecast accepted/);
    assert.match(s.job.warning ?? "", /submitted without required exposure \(6 of 6 required tasks not finished/);
    assert.ok(s.audit!.scoreable && !s.audit!.compliant);
    assert.ok(s.audit!.issues.some((i) => /No valid observation for required case low-practice/.test(i)));
    // Without a runtime report nothing is copied from study.json or Settings.
    assert.equal(s.run!.execution.engine, "not reported");
    assert.deepEqual(s.run!.execution.capabilities, []);
    assert.ok(s.audit!.issues.some((i) => /did not report itself/.test(i)));
  } finally {
    await s.cleanup();
  }
});

// ---------- the study server alone ----------

async function studyServer(jobDir: string) {
  const child = spawn(process.execPath, [resolve("dist/runtimes/study-mcp.js"), jobDir], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok) => {
      const id = ++seq;
      waiting.set(id, ok);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize");
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await rpc("tools/call", { name, arguments: args })).result as { content: { text: string }[]; isError?: boolean };
  return { tool, close: () => new Promise<void>((ok) => (child.on("exit", () => ok()), child.stdin!.end())) };
}

test("tool-call cap: refused calls are not counted, also in parallel; submit_forecast waits for the required cases", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xr-cap-"));
  try {
    await mkdir(join(dir, "project"));
    await writeFile(join(dir, "project", "a.txt"), "a");
    const job = (budget: number) =>
      writeFile(
        join(dir, "job.json"),
        JSON.stringify({
          jobId: "j",
          budget,
          tokenBudget: 50_000,
          projectDir: join(dir, "project"),
          participantId: null,
          designs: [{ id: "d", label: "D" }],
          targets: [{ id: "m", label: "M", unit: "", scale: "likert", aggregation: "arithmetic" }],
          app: { designs: [{ id: "d" }], cases: [{ caseId: "d-practice", conditionId: "d" }, { caseId: "d-main", conditionId: "d" }] },
        }),
      );
    // Ten calls at once against a cap of 5: exactly 5 run and 5 are written; the refused ones are not.
    await job(5);
    let s = await studyServer(dir);
    const replies = await Promise.all(Array.from({ length: 10 }, () => s.tool("list_files")));
    assert.equal(replies.filter((r) => !r.isError).length, 5);
    assert.ok(replies.filter((r) => r.isError).every((r) => /Tool budget of 5 calls is used up/.test(r.content[0].text)));
    assert.equal((await readFile(join(dir, "calls.log"), "utf8")).trim().split("\n").length, 5);
    // No tool budget left: the forecast is accepted without the cases, and the trace says so.
    const forecast = { predictions: [{ design: "d", outcome: "m", value: 3 }] };
    assert.match((await s.tool("submit_forecast", forecast)).content[0].text, /Forecast accepted/);
    assert.match(await readFile(join(dir, "trace.jsonl"), "utf8"), /accepted without required exposure.*"missingCases":\["d-practice","d-main"\]/);
    await s.close();

    // With budget left, the forecast waits until both cases were started and ended.
    await rm(join(dir, "calls.log"));
    await rm(join(dir, "trace.jsonl"));
    await rm(join(dir, "forecast.json"));
    await job(50);
    s = await studyServer(dir);
    const early = await s.tool("submit_forecast", forecast);
    assert.ok(early.isError);
    assert.match(early.content[0].text, /Not done yet: the task of design D \(d-practice\); the task of design D \(d-main\)\./);
    const ev = (event: Record<string, unknown>) => appendFile(join(dir, "trace.jsonl"), JSON.stringify({ t: Date.now(), server: "unity", event }) + "\n");
    await ev({ type: "case-start", caseId: "d-practice", phaseId: "practice" });
    await ev({ type: "case-end", caseId: "d-practice", phaseId: "practice", submitted: true });
    await ev({ type: "case-start", caseId: "d-main", phaseId: "main" });
    assert.match((await s.tool("submit_forecast", forecast)).content[0].text, /Not done yet: the task of design D \(d-main\)\./);
    await ev({ type: "case-end", caseId: "d-main", phaseId: "main", submitted: false });
    assert.match((await s.tool("submit_forecast", forecast)).content[0].text, /Forecast accepted/);
    // Submitting is never counted.
    assert.equal((await readFile(join(dir, "calls.log"), "utf8")).split("\n").filter((l) => l && l !== "submit_forecast").length, 0);
    await s.close();
  } finally {
    await removeDir(dir);
  }
});

// ---------- the audit ----------

test("audit: a closing case-end after the forecast is allowed; other late events and restarts are deviations", async () => {
  const { auditRun } = await import("../src/core/protocol.js");
  const { campaignPlan } = await import("../src/core/campaign.js");
  const dir = resolve("examples/selection");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const c = campaignFromPlan(freezePlan(study, agents, 1), undefined, "boundary", new Date(Date.now() - 1000).toISOString());
  const plan = campaignPlan(c);
  const run = syntheticCampaignExecution(c).results.runs.find((r) => c.jobs.find((j) => j.id === r.jobId)!.conditionId === "uses-app")!;
  const job = plan.jobs.find((j) => j.id === run.jobId)!;
  assert.ok(auditRun(plan, job, run).compliant);
  // The last case is still open when the session ends: its case-end (submitted false) comes after the forecast.
  const late = structuredClone(run);
  const end = late.trace.map((e) => e.type).lastIndexOf("case-end");
  const [closing] = late.trace.splice(end, 1) as Extract<TraceEvent, { type: "case-end" }>[];
  late.trace.push({ ...closing, submitted: false });
  const a = auditRun(plan, job, late);
  assert.ok(!a.issues.some((i) => /after the forecast boundary/.test(i)), JSON.stringify(a.issues));
  assert.deepEqual(a.issues, [`No submission for required case ${closing.caseId}.`]);
  // Anything else after the forecast is a deviation.
  const other = structuredClone(late);
  other.trace.push({ type: "action", caseId: closing.caseId, phaseId: closing.phaseId, action: "select", completed: true });
  assert.ok(auditRun(plan, job, other).issues.some((i) => /after the forecast boundary/.test(i)));
  // A second runtime report (a restarted bridge), even an identical one, is a deviation; so is a recorded second start.
  const twice = structuredClone(run);
  const report = twice.trace.find((e) => e.type === "runtime")!;
  twice.trace.splice(twice.trace.length - 2, 0, { ...report, pid: 2 } as TraceEvent);
  assert.deepEqual(auditRun(plan, job, twice).issues, ["The runtime restarted during the session (2 starts): what the agent experienced before the restart may be lost or repeated."]);
  const started = structuredClone(run);
  started.execution.runtimeStarts = 3;
  assert.ok(auditRun(plan, job, started).issues.some((i) => /restarted during the session \(3 starts\)/.test(i)));
});

test("comparisons across levels: refused at save and by study-check, skipped with a note at analysis", async () => {
  const { saveWorkspace } = await import("../src/workspace.js");
  const dir = resolve("examples/selection");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8"))) as Study;
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const mixed = { candidate: "uses-app", baseline: "knows-participant", domain: "subjective" };
  const message = /Comparison uses-app − knows-participant mixes population and individual configs; use the population-vs-individual view instead\.$/;
  assert.throws(() => validateComparisons([mixed], study, agents), message);
  assert.doesNotThrow(() => validateComparisons([mixed])); // without the configurations, only the shape is checked
  const a = await tempWorkspace(dir);
  try {
    await assert.rejects(saveWorkspace(a.id, { comparisons: [mixed] as never }), message);
    await writeFile(join(a.dir, "comparisons.json"), JSON.stringify([mixed]));
    const r = spawnSync(process.execPath, [resolve("dist/cli.js"), "study-check", join(a.dir, "study.json")], { encoding: "utf8" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /- comparisons\.json: Comparison uses-app − knows-participant mixes population and individual configs/);
  } finally {
    await removeDir(a.dir);
  }
});

// ---------- the shipped Unity bridge (examples/selection/runtime/bridge.py) ----------

const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);

/** A stand-in for the Unity project's Editor endpoint and Play-mode study API (what bridge.py calls). */
async function fakeUnity() {
  const st = { playing: false, design: "", phase: "practice", task: 1, frame: 0, stops: 0, plays: 0 };
  const json = (res: any, body: unknown) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const state = () => ({ ok: true, phase: st.phase, task: st.task, tasks: 2, techniqueLabel: st.design, instruction: "Pick up the glowing object.", holding: null, wrongSelections: 0, teleports: 0 });
  const listen = (handler: (path: string, body: any, res: any) => void) =>
    new Promise<number>((ok) => {
      const server = createServer((req, res) => {
        let b = "";
        req.on("data", (d) => (b += d));
        req.on("end", () => handler(req.url ?? "/", b ? JSON.parse(b) : {}, res));
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => ok((server.address() as { port: number }).port));
    });
  const servers: ReturnType<typeof createServer>[] = [];
  const editor = await listen((path, _b, res) => {
    if (path === "/status") return json(res, { project: "/fake/unity", playing: st.playing, unity: "6000.0-fake" });
    if (path === "/play") (st.playing = true), st.plays++;
    if (path === "/stop") (st.playing = false), st.stops++;
    json(res, { ok: true });
  });
  const api = await listen((path, body, res) => {
    if (!st.playing) return json(res, { ok: false, error: "not playing" });
    if (path === "/state") return json(res, state());
    if (path === "/start") return (Object.assign(st, { design: body.design, phase: body.phase, task: 1 }), json(res, state()));
    if (path === "/capture") {
      st.frame++;
      const eye = (e: string, x: number) => ({ eye: e, jpegBase64: Buffer.from(`${st.frame}-${e}`).toString("base64"), eyeSeparationM: 0.063, viewMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, -1.6, 0, 1], projectionMatrix: Array.from({ length: 16 }, (_, i) => (i % 5 ? 0 : 1)) });
      return json(res, { ok: true, frameId: st.frame, simulationTimeMs: st.frame * 100, eyes: [eye("left", 0.0315), eye("right", -0.0315)] });
    }
    if (path === "/look") return json(res, { ok: true });
    if (path === "/select") return json(res, { ok: true, result: "picked-up", selected: body.id, via: "ray" });
    if (path === "/place") {
      const blockDone = st.task >= 2;
      st.task++;
      return json(res, { ok: true, placed: true, blockDone });
    }
    json(res, { ok: false, error: `unknown ${path}` });
  });
  return { st, editor, api, close: () => servers.forEach((s) => s.close()) };
}

test("bridge.py: refused calls are not counted, it resumes after a crash, and a closing case-end is all it writes after the forecast", { skip: !python && "Python not found" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "xr-bridge-py-"));
  const unity = await fakeUnity();
  try {
    const designs = ["ray", "direct"].map((id) => ({ id, label: id, practice: { caseId: `${id}-practice`, phaseId: "practice" }, main: { caseId: `${id}-main`, phaseId: "main" } }));
    await writeFile(
      join(dir, "job.json"),
      JSON.stringify({ jobId: "job7", budget: 20, tokenBudget: null, app: { runtime: "unity", observation: "stereo-pair", trace: join(dir, "trace.jsonl"), screenshots: join(dir, "screenshots"), designs, cases: [] } }),
    );
    const start = () => {
      const child = spawn(python!, [resolve("examples/selection/runtime/bridge.py"), join(dir, "job.json"), "--project", "/fake/unity", "--editor-port", String(unity.editor), "--api-port", String(unity.api)], { stdio: ["pipe", "pipe", "ignore"] });
      const waiting = new Map<number, (m: any) => void>();
      createInterface({ input: child.stdout! }).on("line", (l) => {
        const m = JSON.parse(l);
        waiting.get(m.id)?.(m);
      });
      let seq = 0;
      const call = (name: string, args: Record<string, unknown> = {}) =>
        new Promise<{ text: string; error: boolean }>((ok) => {
          const id = ++seq;
          waiting.set(id, (m) => ok({ text: (m.result.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join(" "), error: !!m.result.isError }));
          child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) + "\n");
        });
      return { child, call, exited: new Promise((ok) => child.on("exit", ok)) };
    };
    let b = start();
    assert.match((await b.call("open_design", { design: "ray" })).text, /You now use ray/);
    await b.call("select", { object: "o1" });
    await b.call("place"); // practice task 1 of 2
    // A hard crash: Claude Code starts the bridge again and calls on.
    b.child.kill("SIGKILL");
    await b.exited;
    b = start();
    const resumed = await b.call("screenshot");
    assert.match(resumed.text, /^The app was restarted: the practice task starts again with ray\./);
    assert.match((await b.call("open_design", { design: "ray" })).text, /You already used ray/);
    for (const step of ["select", "place", "select", "place"]) await b.call(step, { object: "o1" }); // practice done
    await b.call("select", { object: "o1" }); // main, open
    // Fill the cap: the 20th accepted call is the last; the refused ones are not written.
    const used = () => readFile(join(dir, "calls.log"), "utf8").then((t) => t.split("\n").filter((l) => l.trim()).length);
    while ((await used()) < 20) await b.call("task_state");
    const refused = await b.call("task_state");
    assert.ok(refused.error && /Tool budget of 20 calls is used up/.test(refused.text));
    assert.equal(await used(), 20);
    // The study server accepts the forecast; then the session ends.
    await appendFile(join(dir, "trace.jsonl"), JSON.stringify({ t: Date.now(), server: "study", event: { type: "forecast" } }) + "\n");
    const stops = unity.st.stops;
    b.child.stdin!.end();
    await b.exited;
    assert.equal(unity.st.stops, stops + 1, "Play mode stopped when stdin closed");
    const events = (await readFile(join(dir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event).map((l) => l.event);
    const after = events.slice(events.findIndex((e) => e.type === "forecast") + 1);
    assert.deepEqual(after, [{ type: "case-end", caseId: "ray-main", phaseId: "main", submitted: false }]);
    assert.equal(events.filter((e) => e.type === "runtime").length, 2);
    const frames = events.filter((e) => e.type === "observation").map((e) => e.captures[0].frameId);
    assert.equal(new Set(frames).size, frames.length);
    assert.equal((await readdir(join(dir, "screenshots"))).length, frames.length * 2);
    // SIGTERM also stops Play mode (a new budget, so the calls run).
    const spec = JSON.parse(await readFile(join(dir, "job.json"), "utf8"));
    await writeFile(join(dir, "job.json"), JSON.stringify({ ...spec, budget: 100 }));
    b = start();
    await b.call("task_state");
    await b.call("screenshot"); // connects (resumes the open main task)
    const before = unity.st.stops;
    b.child.kill("SIGTERM");
    await b.exited;
    assert.equal(unity.st.stops, before + 1);
  } finally {
    unity.close();
    await removeDir(dir);
  }
});
