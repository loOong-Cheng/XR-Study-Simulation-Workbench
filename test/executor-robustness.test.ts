// What a stress test of the running workbench found (N7): requests that race to open one campaign,
// a server killed mid-run, several campaigns running at once, analyses kept forever, zips saved
// while sessions end, and event lines out of order. Real sessions are a stand-in CLI (claude.cjs);
// throw-away studies live under private/studies/__test-* and are removed again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan, type CampaignReceipt } from "../src/core/campaign.js";
import type { AgentProtocol } from "../src/core/types.js";

const JSZip = createRequire(import.meta.url)("jszip") as typeof import("jszip");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
async function until(what: () => boolean | Promise<boolean>, ms = 20_000, step = 50) {
  for (let t = 0; t < ms; t += step) {
    if (await what()) return true;
    await wait(step);
  }
  return false;
}
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
const gq = resolve("examples/graphics-quality");
const selection = resolve("examples/selection");
const receiptsOf = async (dir: string): Promise<CampaignReceipt[]> =>
  existsSync(join(dir, "receipts.jsonl")) ? (await readFile(join(dir, "receipts.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
async function campaign(id: string, pick: (a: AgentProtocol) => AgentProtocol | null, label: string) {
  const { readWorkspace, saveCampaign, saveSourceFingerprints } = await import("../src/workspace.js");
  const ws = await readWorkspace(id);
  const agents = ws.agents!.map(pick).filter((x): x is AgentProtocol => !!x);
  const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, label, new Date(Date.now() - 1000).toISOString());
  await saveCampaign(id, c);
  await saveSourceFingerprints(id, c);
  return c;
}
const textOnly = (n: number) => (a: AgentProtocol) => (a.id === "text-only" ? { ...a, repetitions: n } : null);

/**
 * A stand-in for `claude -p`: starts the study MCP server, reports usage like Claude Code, submits
 * a forecast. FAKE_TIMELINE: append start/end lines; FAKE_SLEEP: ms before submitting;
 * FAKE_HANG_JOBS: these jobs hang before submitting; FAKE_LINGER_JOBS: these hang after the
 * forecast was accepted (a long closing turn).
 */
async function fakeClaude(bin: string, settings: Record<string, unknown> = {}) {
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2); const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const model = args[args.indexOf("--model") + 1];
const out = (m) => console.log(JSON.stringify(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = cfg.mcpServers.study; const dir = s.args[1];
const job = JSON.parse(fs.readFileSync(dir + "/job.json", "utf8"));
const list = (k) => (process.env[k] || "").split(",").filter(Boolean);
const line = (what) => process.env.FAKE_TIMELINE && fs.appendFileSync(process.env.FAKE_TIMELINE, JSON.stringify({ what, t: Date.now(), dir }) + "\\n");
line("start"); process.on("exit", () => line("end"));
process.on("SIGTERM", () => process.exit(143));
const p = spawn(s.command, s.args); let buf = ""; const wait = {}; let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id] && wait[m.id](m); } });
const call = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); });
const message = (mid, usage, final, content) => {
  out({ type: "stream_event", event: { type: "message_start", message: { id: mid, usage } } });
  out({ type: "assistant", message: { id: mid, usage, content } });
  out({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: final } } });
};
(async () => {
  out({ type: "system", subtype: "init", session_id: "fake-" + job.jobId.slice(-8) + "-" + Date.now(), model, claude_code_version: "fake", mcp_servers: [{ name: "study", status: "connected" }] });
  await call("initialize", {});
  message("m1", { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 3 }, 400, [{ type: "text", text: "Reading the brief." }]);
  if (list("FAKE_HANG_JOBS").includes(job.jobId)) await sleep(30000);
  if (process.env.FAKE_SLEEP) await sleep(Number(process.env.FAKE_SLEEP));
  const predictions = [];
  for (const d of job.designs) for (const t of job.targets) {
    const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
    predictions.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value });
  }
  message("m2", { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 2 }, 200, [{ type: "tool_use", id: "t1", name: "mcp__study__submit_forecast", input: {} }]);
  const r = await call("tools/call", { name: "submit_forecast", arguments: { predictions, uncertainty: "test" } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "accepted" }] } });
  if (list("FAKE_LINGER_JOBS").includes(job.jobId)) await sleep(30000);
  out({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 20, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000, output_tokens: 600 }, total_cost_usd: 0.01, num_turns: 2 });
  p.stdin.end(); process.exit(0);
})();`,
  );
  await writeSettings(bin, settings);
}
const writeSettings = (bin: string, settings: Record<string, unknown>) => writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs"), ...settings }));
/** Most sessions alive at once, from the stand-in's timeline (optionally only those whose folder matches). */
async function mostAtOnce(timeline: string, only?: (dir: string) => boolean) {
  const events = (await readFile(timeline, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { what: string; t: number; dir: string }).filter((e) => !only || only(e.dir)).sort((x, y) => x.t - y.t || (x.what === "end" ? -1 : 1));
  let now = 0,
    most = 0;
  for (const e of events) most = Math.max(most, (now += e.what === "start" ? 1 : -1));
  return { most, events };
}
/** A response object that collects what an event stream writes. */
function fakeResponse() {
  const chunks: string[] = [];
  const closers: (() => void)[] = [];
  const res = {
    writeHead: () => res,
    write: (c: string) => (chunks.push(String(c)), true),
    end: () => undefined,
    on: (event: string, fn: () => void) => (event === "close" && closers.push(fn), res),
  };
  return { res: res as unknown as ServerResponse, events: () => chunks.join("").split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6))), close: () => closers.forEach((f) => f()) };
}

test("one executor per campaign: concurrent opens, Starts and event streams share it; every session runs once; events reach every stream, in time order", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { handleGet, handlePost } = await import("../src/routes.js");
  const { runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const streams = [fakeResponse(), fakeResponse()];
  try {
    const c = await campaign(a.id, (x) => (["text-only", "text-with-task-data"].includes(x.id) ? { ...x, repetitions: 10 } : null), "race");
    const c2 = await campaign(a.id, textOnly(2), "race-open");
    // Six opens of an unopened campaign at once: one executor.
    const opened = await Promise.all(Array.from({ length: 6 }, () => Executor.open(a.id, c2.id)));
    assert.ok(opened.every((x) => x === opened[0]), "every open request gets the same executor");

    // Two Starts and two event streams in the same tick, before the campaign was ever opened.
    const url = new URL(`http://127.0.0.1/api/executor/events?id=${encodeURIComponent(a.id)}&campaign=${c.id}`);
    const answers: unknown[] = [];
    const startOnce = () => handlePost("/api/executor/start", { id: a.id, campaignId: c.id, mode: "simulate" }, (v) => answers.push(v)).catch((e: Error) => answers.push(e.message));
    await Promise.all([startOnce(), handleGet("/api/executor/events", url, streams[0].res, () => undefined), startOnce(), handleGet("/api/executor/events", url, streams[1].res, () => undefined)]);
    const ex = await Executor.open(a.id, c.id);
    const jobs = [...ex.jobs.keys()];
    assert.equal(jobs.length, 20);
    assert.ok(await until(() => ex.snapshot().counts.done === jobs.length), JSON.stringify(ex.snapshot().counts));
    await wait(200);
    const dir = runDir(a.id, c.id);
    const receipts = await receiptsOf(dir);
    assert.equal(receipts.length, jobs.length, "one receipt per session, not two");
    assert.ok(receipts.every((r) => r.attempt === 1));
    for (const j of jobs) assert.deepEqual(await readdir(join(dir, "jobs", j)), ["a1"], `${j} ran once`);
    // Both streams got the snapshot and then every session's end.
    for (const s of streams) {
      const events = s.events();
      assert.equal(events[0].type, "snapshot");
      // Session changes arrive batched ("jobs": the fields that changed since the last batch).
      const done = new Set(events.flatMap((e) => (e.type === "jobs" ? e.jobs.filter((j: { status?: string }) => j.status === "done").map((j: { jobId: string }) => j.jobId) : [])));
      assert.equal(done.size, jobs.length, "every stream sees every session finish");
    }
    // events.jsonl: written one line after another, so in the order of their times.
    const times = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l).t as number);
    assert.ok(times.length > jobs.length * 2);
    assert.ok(times.every((t, i) => i === 0 || t >= times[i - 1]), "events.jsonl lines are in time order");
  } finally {
    streams.forEach((s) => s.close());
    await removeDir(a.dir);
  }
});

test("Stop: running simulated sessions get a receipt, waiting ones are named; attempts are numbered by their folders, never reused", async () => {
  const { Executor, STOPPED } = await import("../src/executor/runner.js");
  const { runDir } = await import("../src/workspace.js");
  const { sessionAttempts } = await import("../src/history.js");
  const a = await tempWorkspace(gq);
  try {
    // Sessions that use the app take seven simulated steps, so they are still running when stopped.
    const c = await campaign(a.id, (x) => (x.id === "uses-app" ? { ...x, repetitions: 12 } : null), "stop-receipts");
    const ex = await Executor.open(a.id, c.id);
    const ids = [...ex.jobs.keys()];
    assert.ok(ids.length > 8, "more sessions than simulated slots");
    const texts: string[] = [];
    ex.listeners.add((e) => e.type === "state" && e.text && texts.push(e.text));
    await ex.start("simulate");
    assert.ok(await until(() => ex.running.size === 8));
    const waiting = ex.queue.length;
    ex.stop();
    assert.equal(texts.at(-1), `Stopped. ${waiting} waiting sessions were not started; select them and Start them again to run them.`);
    const stopped = ids.filter((id) => ex.jobs.get(id)!.status === "stopped");
    assert.equal(stopped.length, 8);
    const dir = runDir(a.id, c.id);
    assert.ok(await until(async () => (await receiptsOf(dir)).length === 8), "every stopped session gets a receipt");
    assert.ok((await receiptsOf(dir)).every((r) => r.status === "failed" && r.error === STOPPED && r.attempt === 1));
    // Run them again: a new folder each (a2), and the stopped attempt stays as it was.
    await ex.start("simulate", stopped);
    assert.ok(await until(() => stopped.every((id) => ex.jobs.get(id)!.status === "done")));
    for (const id of stopped) {
      assert.deepEqual((await readdir(join(dir, "jobs", id))).sort(), ["a1", "a2"]);
      const attempts = (await sessionAttempts(a.id, c, id)).attempts;
      assert.deepEqual(attempts.map((x) => [x.attempt, x.status]), [[1, "stopped"], [2, "completed"]]);
    }
    // The sessions Stop left waiting were never started: no folder, no receipt.
    const never = ids.filter((id) => !stopped.includes(id));
    assert.ok(never.every((id) => ex.jobs.get(id)!.status === "not-started" && !existsSync(join(dir, "jobs", id))));
  } finally {
    await removeDir(a.dir);
  }
});

test("crash: after a killed workbench, an accepted forecast is finished, the rest is interrupted, left-over processes are stopped, and a rerun gets a new folder", async () => {
  const { Executor, INTERRUPTED, RECOVERED } = await import("../src/executor/runner.js");
  const { alive, writeMarker } = await import("../src/executor/attempts.js");
  const { runDir } = await import("../src/workspace.js");
  const { sessionAttempts } = await import("../src/history.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await fakeClaude(bin, { concurrency: 3 });
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  let server: ReturnType<typeof spawn> | null = null;
  let orphan: ReturnType<typeof spawn> | null = null;
  try {
    const c = await campaign(a.id, textOnly(3), "crash");
    const [finished, cut, untouched] = c.jobs.filter((j) => j.kind === "llm").map((j) => j.id);
    // The workbench: another Node process running the executor, killed with SIGKILL mid-run.
    await writeFile(
      join(bin, "server.mjs"),
      `const { Executor } = await import(process.env.RUNNER_URL);
const ex = await Executor.open(process.env.STUDY_ID, process.env.CAMPAIGN_ID);
await ex.start("agent", JSON.parse(process.env.JOB_IDS));
setInterval(() => {}, 1 << 30);`,
    );
    server = spawn(process.execPath, [join(bin, "server.mjs")], {
      stdio: "ignore",
      env: {
        ...process.env,
        RUNNER_URL: new URL("../src/executor/runner.js", import.meta.url).href,
        STUDY_ID: a.id,
        CAMPAIGN_ID: c.id,
        JOB_IDS: JSON.stringify([finished, cut]),
        FAKE_LINGER_JOBS: finished,
        FAKE_HANG_JOBS: cut,
      },
    });
    const dir = runDir(a.id, c.id);
    const attemptDir = (job: string, n = 1) => join(dir, "jobs", job, `a${n}`);
    // A JSON file as it is now: {} while it is missing or being rewritten (usage.json changes every turn).
    const jsonNow = async (path: string) => {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        return {};
      }
    };
    const marker = (job: string) => jsonNow(join(attemptDir(job), "attempt.json"));
    assert.ok(
      await until(
        async () =>
          // The workbench noted the accepted forecast (usage.json) and the other session's first tokens.
          typeof (await jsonNow(join(attemptDir(finished), "usage.json"))).tokensAtSubmit === "number" &&
          (await jsonNow(join(attemptDir(cut), "usage.json"))).output === 400 &&
          (await marker(finished)).pid &&
          (await marker(cut)).pid,
      ),
      "both sessions started; one forecast accepted",
    );
    const pids = [(await marker(finished)).pid, (await marker(cut)).pid];
    const noted = JSON.parse(await readFile(join(attemptDir(finished), "usage.json"), "utf8")).tokensAtSubmit;
    server.kill("SIGKILL");
    await until(() => server!.exitCode !== null || server!.signalCode !== null);
    if (process.platform !== "win32") assert.ok(pids.every(alive), "the sessions outlive the killed workbench");
    // Windows: Node keeps the processes it starts in a job object that closes with it, so the claude
    // processes end with the killed workbench. What they started may not (Claude Code's MCP servers).
    else assert.ok(await until(() => !pids.some(alive), 5000), "the sessions end with the killed workbench");
    // A process of the interrupted session that outlived it (an MCP server): its command line names the attempt folder.
    orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", attemptDir(cut)], { stdio: "ignore" });
    assert.ok(await until(() => alive(orphan!.pid)));
    // A third attempt folder whose marker names a PID that is not a session of it: never stopped.
    await mkdir(attemptDir(untouched), { recursive: true });
    await writeMarker(attemptDir(untouched), { jobId: untouched, attempt: 1, mode: "agent", startedAt: new Date().toISOString(), pid: decoy.pid! });

    // The restarted workbench opens the campaign.
    const ex = await Executor.open(a.id, c.id);
    assert.ok(await until(() => !pids.some(alive) && !alive(orphan!.pid), 5000), "left-over processes are stopped");
    assert.ok(alive(decoy.pid), "a process that is not the attempt's is left alone");
    const receipts = await receiptsOf(dir);
    assert.equal(receipts.length, 3);
    const r1 = receipts.find((r) => r.jobId === finished)!;
    assert.deepEqual([r1.attempt, r1.status, r1.recovered], [1, "completed", RECOVERED]);
    const result = JSON.parse(await readFile(join(dir, "results", `${finished}.json`), "utf8"));
    assert.equal(result.execution.recovered, RECOVERED);
    assert.equal(result.execution.tokensAtSubmit, noted, "tokens up to the accepted forecast, as noted while it ran");
    assert.ok(result.measurements.length > 0);
    assert.equal(ex.jobs.get(finished)!.status, "done");
    assert.match(ex.jobs.get(finished)!.warning ?? "", /completed after a workbench restart/);
    const r2 = receipts.find((r) => r.jobId === cut)! as CampaignReceipt & { usage: Record<string, unknown> };
    assert.deepEqual([r2.attempt, r2.status, r2.error, r2.interrupted], [1, "failed", INTERRUPTED, true]);
    assert.deepEqual([r2.usage.outputTokens, r2.usage.cacheReadTokens, r2.usage.source], [400, 3000, "live"], "its usage so far");
    assert.deepEqual([ex.jobs.get(cut)!.status, ex.jobs.get(cut)!.error, ex.jobs.get(cut)!.attempts], ["failed", INTERRUPTED, 1]);
    assert.equal(receipts.find((r) => r.jobId === untouched)!.error, INTERRUPTED);
    // Opening again changes nothing (every attempt has its receipt now).
    const { closeExecutor } = await import("../src/executor/runner.js");
    closeExecutor(a.id, c.id);
    const again = await Executor.open(a.id, c.id);
    assert.equal((await receiptsOf(dir)).length, 3);
    // A rerun of the interrupted session runs in a new folder; the old one is kept as it was.
    const before = await readFile(join(attemptDir(cut), "stream.jsonl"), "utf8");
    await again.start("agent", [cut]);
    assert.ok(await until(() => again.jobs.get(cut)!.status === "done"), again.jobs.get(cut)!.error ?? "");
    assert.equal(await readFile(join(attemptDir(cut), "stream.jsonl"), "utf8"), before);
    assert.ok(existsSync(join(attemptDir(cut, 2), "forecast.json")));
    assert.deepEqual((await sessionAttempts(a.id, c, cut)).attempts.map((x) => [x.attempt, x.status, x.error]), [[1, "failed", INTERRUPTED], [2, "completed", null]]);
  } finally {
    server?.kill("SIGKILL");
    decoy.kill("SIGKILL");
    orphan?.kill("SIGKILL");
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("shutdown: running sessions are stopped and recorded as interrupted, with their usage", async () => {
  const { Executor, INTERRUPTED, shutdownExecutors, _test } = await import("../src/executor/runner.js");
  const { alive } = await import("../src/executor/attempts.js");
  const { runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await fakeClaude(bin);
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    const c = await campaign(a.id, textOnly(1), "shutdown");
    const job = c.jobs.find((j) => j.kind === "llm")!.id;
    process.env.FAKE_HANG_JOBS = job;
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent", [job]);
    const a1 = join(runDir(a.id, c.id), "jobs", job, "a1");
    assert.ok(await until(() => existsSync(join(a1, "usage.json"))));
    const pid = JSON.parse(await readFile(join(a1, "attempt.json"), "utf8")).pid;
    assert.ok(alive(pid));
    await shutdownExecutors(10_000);
    assert.ok(!alive(pid), "the session's process ended");
    await assert.rejects(ex.start("agent", [job]), /shutting down/);
    _test.afterShutdown();
    const [r] = await receiptsOf(runDir(a.id, c.id));
    assert.deepEqual([r.status, r.error, r.interrupted, (r.usage as { outputTokens: number }).outputTokens], ["failed", INTERRUPTED, true, 400]);
  } finally {
    delete process.env.FAKE_HANG_JOBS;
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("one scheduler for all campaigns: parallel sessions and a runtime's limit hold across campaigns, slots are shared, and the waiting campaign says why", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { WAITING_FOR_SLOT } = await import("../src/executor/scheduler.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  const timeline = join(bin, "timeline.jsonl");
  await fakeClaude(bin, { concurrency: 2 });
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  process.env.FAKE_TIMELINE = timeline;
  process.env.FAKE_SLEEP = "700";
  try {
    const ca = await campaign(a.id, textOnly(4), "first");
    const cb = await campaign(a.id, textOnly(2), "second");
    const [exA, exB] = [await Executor.open(a.id, ca.id), await Executor.open(a.id, cb.id)];
    await exA.start("agent");
    assert.ok(await until(() => exA.running.size === 2));
    await exB.start("agent");
    assert.ok(await until(() => exB.snapshot().waiting === WAITING_FOR_SLOT), JSON.stringify(exB.snapshot().waiting));
    assert.equal(exB.running.size, 0);
    const all = () => [...exA.jobs.values(), ...exB.jobs.values()];
    assert.ok(await until(() => all().every((j) => j.status === "done"), 30_000), JSON.stringify(all().map((j) => j.error)));
    assert.equal(exB.snapshot().waiting, null);
    const { most, events } = await mostAtOnce(timeline);
    assert.equal(most, 2, "Parallel sessions (2) holds for both campaigns together");
    // Fair: the second campaign gets a slot as soon as one is free, not after the first campaign's queue.
    // Attempt folders are native paths (backslashes on Windows).
    const starts = (cid: string) => events.filter((e) => e.what === "start" && e.dir.replace(/\\/g, "/").includes(`/runs/${cid}/`)).map((e) => e.t);
    assert.deepEqual([starts(ca.id).length, starts(cb.id).length], [4, 2]);
    assert.ok(starts(cb.id)[0] < starts(ca.id)[3], "a free slot goes to the campaign with fewer sessions running");

    // A runtime's own limit (here 1 for app-free sessions) holds across campaigns too.
    await writeSettings(bin, { concurrency: 4, runtimes: { none: { maxParallel: 1 } } });
    await rm(timeline);
    const cc = await campaign(a.id, textOnly(2), "third");
    const cd = await campaign(a.id, textOnly(2), "fourth");
    const [exC, exD] = [await Executor.open(a.id, cc.id), await Executor.open(a.id, cd.id)];
    process.env.FAKE_SLEEP = "300";
    await Promise.all([exC.start("agent"), exD.start("agent")]);
    const both = () => [...exC.jobs.values(), ...exD.jobs.values()];
    assert.ok(await until(() => both().every((j) => j.status === "done"), 30_000), JSON.stringify(both().map((j) => j.error)));
    assert.equal((await mostAtOnce(timeline)).most, 1, "one session of the runtime at a time, whichever campaign");
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_TIMELINE;
    delete process.env.FAKE_SLEEP;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("simulated sessions have their own limit for all campaigns together", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const a = await tempWorkspace(gq);
  try {
    const c1 = await campaign(a.id, textOnly(12), "sim-one");
    const c2 = await campaign(a.id, textOnly(12), "sim-two");
    const [e1, e2] = [await Executor.open(a.id, c1.id), await Executor.open(a.id, c2.id)];
    assert.ok(e1.jobs.size + e2.jobs.size > 8);
    await Promise.all([e1.start("simulate"), e2.start("simulate")]);
    let most = 0,
      bothRan = false;
    const done = () => [...e1.jobs.values(), ...e2.jobs.values()].every((j) => j.status === "done");
    while (!done()) {
      most = Math.max(most, e1.running.size + e2.running.size);
      bothRan ||= e1.running.size > 0 && e2.running.size > 0;
      await wait(20);
    }
    assert.ok(most <= 8, `at most 8 simulated sessions at once, saw ${most}`);
    assert.ok(bothRan, "both campaigns run side by side");
  } finally {
    await removeDir(a.dir);
  }
});

test("analyses: at most a few are kept, and a campaign's are dropped when its receipts change", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { handlePost, cachedAnalyses, ANALYSES_KEPT } = await import("../src/routes.js");
  const a = await tempWorkspace(gq);
  try {
    const c = await campaign(a.id, (x) => (["text-only", "reads-project"].includes(x.id) ? { ...x, repetitions: 4 } : null), "cache");
    const ex = await Executor.open(a.id, c.id);
    const [first, ...rest] = [...ex.jobs.keys()];
    await ex.start("simulate", rest);
    assert.ok(await until(() => rest.every((id) => ex.jobs.get(id)!.status === "done")));
    // Each choice of comparisons is its own analysis.
    for (let i = 0; i < ANALYSES_KEPT + 4; i++)
      await handlePost("/api/workspace/analyze", { id: a.id, campaignId: c.id, comparisons: [{ candidate: "text-only", baseline: `other-${i}`, domain: "subjective" }] }, () => undefined);
    assert.equal(cachedAnalyses(), ANALYSES_KEPT);
    // A session ends: its campaign's analyses are out of date and dropped.
    await ex.start("simulate", [first]);
    assert.ok(await until(() => ex.jobs.get(first)!.status === "done"));
    assert.equal(cachedAnalyses(), 0);
  } finally {
    await removeDir(a.dir);
  }
});

test("runs zip saved while sessions end: receipts, results and attempt folders are from one moment, and the loaded zip is consistent", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { exportRuns, importRuns } = await import("../src/executor/archive.js");
  const { saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(selection);
  const b = await tempWorkspace(selection);
  try {
    const c = await campaign(a.id, (x) => x, "zip-mid-run");
    const ex = await Executor.open(a.id, c.id);
    await ex.start("simulate");
    // Each zip is checked as it is saved; one saved mid-run is kept to load.
    const base = `runs/${c.id}/`;
    let saved = 0,
      mid: Buffer | null = null;
    const check = async (data: Buffer) => {
      const zip = await JSZip.loadAsync(data);
      const text = (await zip.file(`${base}receipts.jsonl`)?.async("string")) ?? "";
      const receipts = text.trim() ? text.trim().split("\n").map((l) => JSON.parse(l) as CampaignReceipt) : [];
      const completed = new Set(receipts.filter((r) => r.status === "completed").map((r) => r.jobId));
      const attempts = new Set(receipts.map((r) => `${r.jobId}/a${r.attempt}`));
      const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir && n.startsWith(base));
      const results = new Set(names.filter((n) => n.startsWith(`${base}results/`)).map((n) => n.slice(`${base}results/`.length, -".json".length)));
      assert.deepEqual([...results].sort(), [...completed].sort(), "a result for every completed receipt, and only for those");
      for (const n of names.filter((x) => x.startsWith(`${base}jobs/`))) assert.ok(attempts.has(n.slice(`${base}jobs/`.length).split("/").slice(0, 2).join("/")), `${n} belongs to a receipt in the zip`);
      if (!mid && receipts.length >= 3 && receipts.length < ex.jobs.size) mid = data;
    };
    const finished = () => ex.snapshot().counts.done === ex.jobs.size;
    for (let i = 0; !finished() && i < 2000; i++) {
      await check(await exportRuns(a.id, c.id));
      saved++;
      await wait(25);
    }
    assert.ok(await until(finished, 60_000), JSON.stringify(ex.snapshot().counts));
    assert.ok(saved >= 3 && mid, "zips saved during the run");
    // A mid-run zip loads into another copy of the study: every session shown done has its result.
    await saveCampaign(b.id, c);
    await importRuns(b.id, mid!);
    const loaded = await Executor.open(b.id, c.id);
    const { runDir } = await import("../src/workspace.js");
    for (const j of loaded.jobs.values()) if (j.status === "done") assert.ok(existsSync(join(runDir(b.id, c.id), "results", `${j.jobId}.json`)), j.jobId);
  } finally {
    await removeDir(a.dir);
    await removeDir(b.dir);
  }
});

test("server: at start it closes sessions a killed workbench left; on SIGTERM it records running sessions as interrupted and exits", async () => {
  const { INTERRUPTED } = await import("../src/executor/runner.js");
  const { alive } = await import("../src/executor/attempts.js");
  const { runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await fakeClaude(bin, { concurrency: 2 });
  let server: ReturnType<typeof spawn> | null = null;
  try {
    const c = await campaign(a.id, textOnly(2), "server-signals");
    const [left, running] = c.jobs.filter((j) => j.kind === "llm").map((j) => j.id);
    const dir = runDir(a.id, c.id);
    // A simulated attempt that a killed workbench (a process that has ended) left without a receipt.
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((r) => gone.on("exit", r));
    await mkdir(join(dir, "jobs", left, "a1"), { recursive: true });
    await writeFile(
      join(dir, "jobs", left, "a1", "attempt.json"),
      JSON.stringify({ schema: "xr-study-attempt/1", jobId: left, attempt: 1, mode: "simulate", startedAt: new Date().toISOString(), server: { instance: "gone", pid: gone.pid, script: "server.js" }, pid: null }),
    );
    const port = 45_000 + Math.floor(Math.random() * 4_000);
    let log = "";
    const startServer = (port: number) => {
      const p = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
        env: { ...process.env, XR_STUDY_PORT: String(port), XR_STUDY_SETTINGS: join(bin, "settings.json"), FAKE_HANG_JOBS: running },
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout!.on("data", (d) => (log += d));
      p.stderr!.on("data", (d) => (log += d));
      return p;
    };
    server = startServer(port);
    assert.ok(await until(async () => (await receiptsOf(dir)).some((r) => r.jobId === left)), `the left attempt is closed at start: ${log}`);
    assert.equal((await receiptsOf(dir)).find((r) => r.jobId === left)!.error, INTERRUPTED);
    const res = await fetch(`http://127.0.0.1:${port}/api/executor/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: a.id, campaignId: c.id, mode: "agent", jobIds: [running] }),
    });
    assert.equal(res.status, 200, await res.text());
    const a1 = join(dir, "jobs", running, "a1");
    assert.ok(await until(() => existsSync(join(a1, "usage.json"))), log);
    const pid = JSON.parse(await readFile(join(a1, "attempt.json"), "utf8")).pid;
    const exited = new Promise((r) => server!.on("exit", r));
    server.kill("SIGTERM");
    if (process.platform !== "win32") {
      assert.equal(await exited, 0, log);
      assert.ok(!alive(pid), "the session's process ended with the workbench");
    } else {
      // Windows has no stop signal between programs: kill() ends the server at once, like
      // taskkill /F, without its handlers (Ctrl+C in its console is the graceful stop there). The
      // session's process ends with it (Node's job object); the next start records it as interrupted.
      await exited;
      assert.ok(await until(() => !alive(pid), 5000), "the session's process ended with the workbench");
      assert.ok(!(await receiptsOf(dir)).some((x) => x.jobId === running), "no receipt from the killed server");
      server = startServer(port + 1);
      assert.ok(await until(async () => (await receiptsOf(dir)).some((x) => x.jobId === running)), `the session is closed at the next start: ${log}`);
    }
    const r = (await receiptsOf(dir)).find((x) => x.jobId === running)!;
    assert.deepEqual([r.status, r.error, r.interrupted], ["failed", INTERRUPTED, true]);
  } finally {
    if (server && server.exitCode === null) server.kill("SIGKILL");
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

/**
 * A stand-in for Claude Code on a local model behind ANTHROPIC_BASE_URL, with stream-json input as
 * the real CLI has it (checked against Claude Code 2.1.326): every user message on stdin is a turn
 * that begins with init and ends with a result; usage is per turn, total_cost_usd and modelUsage
 * are running totals; a model Claude Code does not know is priced at its fallback rate
 * (costBasis "unknown") and named on stderr in every session. FAKE_LOCAL: "remind" answers the
 * first turn with text and submits after the reminder; "never" answers with text twice; "unknown"
 * never runs a model (Claude Code's own error message). Each received line goes to FAKE_STDIN_LOG.
 */
async function localModelClaude(bin: string) {
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--help") { console.log("  --input-format <format>\\n  --output-format <format>\\n  --include-partial-messages\\n  --system-prompt-file <file>"); process.exit(0); }
// Messages on stdin are JSON only with --input-format stream-json; without it Claude Code reads plain text.
if (args[args.indexOf("--input-format") + 1] !== "stream-json") { process.stderr.write("stdin is not stream-json: " + args.join(" ")); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const model = args[args.indexOf("--model") + 1];
const mode = process.env.FAKE_LOCAL;
const out = (m) => console.log(JSON.stringify(m));
process.stderr.write('[claude-code:unrecognized_model] {"model":' + JSON.stringify(model) + ',"query_source":"sdk"}\\n');
const s = cfg.mcpServers.study; const dir = s.args[1];
const job = JSON.parse(fs.readFileSync(dir + "/job.json", "utf8"));
const p = spawn(s.command, s.args); let buf = ""; const wait = {}; let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id] && wait[m.id](m); } });
const call = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); });
const message = (mid, input, output, content) => {
  out({ type: "stream_event", event: { type: "message_start", message: { id: mid, usage: { input_tokens: input, output_tokens: 1 } } } });
  out({ type: "assistant", message: { id: mid, model, usage: { input_tokens: input, output_tokens: 1 }, content } });
  out({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } });
};
let turn = 0, cost = 0, inTotal = 0, outTotal = 0;
const result = (input, output) => {
  cost += input * 4e-6 + output * 2e-5; inTotal += input; outTotal += output;
  out({ type: "result", subtype: "success", num_turns: 1, usage: { input_tokens: input, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: output }, total_cost_usd: cost,
    modelUsage: { [model]: { inputTokens: inTotal, outputTokens: outTotal, costUSD: cost, costBasis: "unknown" } } });
};
const predictions = () => {
  const list = [];
  for (const d of job.designs) for (const t of job.targets) {
    const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
    list.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value });
  }
  return list;
};
let queue = Promise.resolve(); let rest = "";
const ready = call("initialize", {});
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { rest += d; let i; while ((i = rest.indexOf("\\n")) >= 0) { const line = rest.slice(0, i); rest = rest.slice(i + 1); queue = queue.then(() => handle(line)); } });
process.stdin.on("end", () => queue.then(() => { p.stdin.end(); process.exit(0); }));
async function handle(line) {
  fs.appendFileSync(process.env.FAKE_STDIN_LOG, line + "\\n");
  await ready;
  turn++;
  out({ type: "system", subtype: "init", session_id: "local-" + job.jobId.slice(-6), model, claude_code_version: "2.1.332", mcp_servers: [{ name: "study", status: "connected" }] });
  if (mode === "unknown") {
    out({ type: "assistant", message: { id: "e" + turn, model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: "text", text: "There's an issue with the selected model (" + model + "). It may not exist or you may not have access to it." }] } });
    return out({ type: "result", subtype: "success", is_error: true, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0, modelUsage: {} });
  }
  if (turn === 1 || mode === "never") {
    message("m" + turn, 1000 * turn, 10, [{ type: "text", text: "Here is my forecast as JSON: " + JSON.stringify(predictions().slice(0, 2)) }]);
    return result(1000 * turn, 10);
  }
  message("m2", 2000, 20, [{ type: "tool_use", id: "t1", name: "mcp__study__submit_forecast", input: {} }]);
  const r = await call("tools/call", { name: "submit_forecast", arguments: { predictions: predictions(), uncertainty: "test" } });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: r.result.isError ? "rejected" : "accepted" }] } });
  message("m3", 2500, 5, [{ type: "text", text: "Submitted." }]);
  result(4500, 25);
}`,
  );
  await writeSettings(bin, {});
}

test("issues 5, 6, 11: a local model's session is reminded once to submit, its fallback price is not counted, and its failure is not called an unknown model", async () => {
  const { Executor, closeExecutor, COST_UNPRICED, FORECAST_REMINDER, UNPRICED_NOTE } = await import("../src/executor/runner.js");
  const { campaignSummaries, sessionAttempts } = await import("../src/history.js");
  const { runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-local-claude-"));
  await localModelClaude(bin);
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  process.env.FAKE_STDIN_LOG = join(bin, "stdin.jsonl");
  try {
    const run = async (mode: string, label: string) => {
      process.env.FAKE_LOCAL = mode;
      await writeFile(process.env.FAKE_STDIN_LOG!, "");
      const c = await campaign(a.id, textOnly(1), label);
      const ex = await Executor.open(a.id, c.id);
      const [jobId] = [...ex.jobs.keys()];
      await ex.start("agent", [jobId]);
      assert.ok(await until(() => ["done", "failed"].includes(ex.jobs.get(jobId)!.status), 30_000), JSON.stringify(ex.jobs.get(jobId)));
      await until(() => ex.running.size === 0);
      const dir = join(runDir(a.id, c.id), "jobs", jobId, "a1");
      const manifest = JSON.parse(await readFile(join(dir, "execution-manifest.json"), "utf8"));
      const [receipt] = await receiptsOf(runDir(a.id, c.id));
      const stdin = (await readFile(process.env.FAKE_STDIN_LOG!, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      const state = { ...ex.jobs.get(jobId)! };
      closeExecutor(a.id, c.id);
      return { c, jobId, dir, manifest, receipt, stdin, state };
    };

    // The model answers with text first: one reminder in the same session, then it submits.
    const r = await run("remind", "local-remind");
    assert.equal(r.state.status, "done", r.state.error ?? "");
    assert.equal(r.stdin.length, 2, "the prompt and one reminder, as stream-json user messages");
    assert.equal(r.stdin[0].type, "user");
    assert.equal(r.stdin[1].message.content[0].text, FORECAST_REMINDER);
    const result = JSON.parse(await readFile(join(r.dir, "result.json"), "utf8"));
    assert.equal(result.execution.forecastReminders, 1);
    assert.match(r.state.warning ?? "", /forecast submitted after one reminder/);
    // Usage is per turn and is added up; the cost is Claude Code's fallback price for an unknown model: not counted.
    assert.equal(result.execution.inputTokens, 1000 + 4500);
    assert.equal(result.execution.outputTokens, 10 + 25);
    assert.equal((r.receipt.usage as { source?: string }).source, "final");
    assert.equal(r.manifest.costUsd, null);
    assert.equal(r.manifest.cost, COST_UNPRICED);
    assert.deepEqual(r.manifest.unpricedModels, ["claude-opus-5-5"]);
    assert.ok(r.manifest.fallbackCostUsd > 0, "Claude Code's figure is kept apart");
    assert.equal(r.manifest.forecastReminders, 1);
    assert.equal(r.state.costUsd, null);
    assert.equal(r.state.costNote, UNPRICED_NOTE);
    assert.deepEqual(r.state.spent, { usd: 0, unknownAttempts: 1, unknownTokens: 1000 + 4500 + 10 + 25, unpricedAttempts: 1 });
    const summary = (await campaignSummaries(a.id)).find((x) => x.id === r.c.id)!;
    assert.equal(summary.costUsd, null, "no dollars spent on a local model");
    assert.deepEqual(summary.unknownCost, { attempts: 1, tokens: 5535, unpriced: 1 });
    const attempts = await sessionAttempts(a.id, r.c, r.jobId);
    assert.equal(attempts.attempts[0].cost, COST_UNPRICED);
    assert.ok(typeof attempts.attempts[0].durationMs === "number" && attempts.attempts[0].durationMs >= 0, "the attempt's time");
    assert.ok(typeof r.state.durationMs === "number" && r.state.durationMs >= 0, "the session's time");

    // Text again after the reminder: failed, for that reason, not as an unknown model (it ran).
    const n = await run("never", "local-never");
    assert.equal(n.state.status, "failed");
    assert.equal(n.state.error, "The session ended without an accepted forecast.");
    assert.equal(n.stdin.length, 2, "one reminder only");
    assert.equal(n.receipt.actualModel?.model, "claude-opus-5-5", "the model that ran is recorded");
    assert.equal(n.manifest.cost, COST_UNPRICED);

    // No model answered at all: that is an unknown model, and no reminder is sent.
    const u = await run("unknown", "local-unknown");
    assert.equal(u.state.status, "failed");
    assert.match(u.state.error ?? "", /does not know the model "claude-opus-5-5"/);
    assert.equal(u.stdin.length, 1);
    assert.equal(u.receipt.actualModel, null);
  } finally {
    delete process.env.FAKE_LOCAL;
    delete process.env.FAKE_STDIN_LOG;
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});
