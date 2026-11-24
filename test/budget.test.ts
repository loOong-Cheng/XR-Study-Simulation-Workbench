// What a verification run with real sessions found: token budgets and the forecast submission,
// effective models, live and final counts, the executor after a restart, Resume after Stop,
// continuations from changed sources or with new configurations, and saves. Real Claude Code is
// replaced by a scripted stand-in; throw-away studies live under private/studies/__test-*.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan, verifyContinuation, type Campaign, type CampaignCondition } from "../src/core/campaign.js";
import { answerLines, checkForecast, submitDescription } from "../src/core/forecast-format.js";
import { validateStudy } from "../src/core/validation.js";
import { until as waitFor } from "./until.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readJson = async <T>(p: string) => JSON.parse(await readFile(p, "utf8")) as T;
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
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
/** Waits for `done` (the assertions after it say what is wrong); the limit only keeps a broken test from hanging. */
const until = (done: () => boolean, ms = 180_000) => waitFor(done, "the condition", { limitMs: ms }).catch(() => undefined);

/**
 * A stand-in for `claude -p` that plays FAKE_STEPS: turns of a given input size that call a study
 * tool (list_files, submit_forecast with a good or a bad forecast), another server's tool, or end
 * with text; {"sleep": ms} waits. Each turn is reported like Claude Code with
 * --include-partial-messages, and each tool result as a user message. The study server's answers
 * go to FAKE_LOG. The model claude-sonet-5-5 is refused like Claude Code does: a "<synthetic>"
 * assistant message with zero usage.
 */
async function scriptedClaude(bin: string) {
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2); const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const model = args[args.indexOf("--model") + 1];
const out = (m) => console.log(JSON.stringify(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zero = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
if (model === "claude-sonet-5-5") {
  out({ type: "system", subtype: "init", session_id: "fake-session", model, claude_code_version: "fake", mcp_servers: [] });
  out({ type: "assistant", message: { id: "syn", model: "<synthetic>", usage: zero, content: [{ type: "text", text: "There's an issue with the selected model (claude-sonet-5-5)." }] } });
  out({ type: "result", subtype: "success", is_error: true, result: "There's an issue with the selected model (claude-sonet-5-5).", usage: zero, total_cost_usd: 0 });
  process.stderr.write("API Error: [claude-code:unrecognized_model]\\n");
  process.exit(1);
}
const steps = JSON.parse(process.env.FAKE_STEPS || "[]");
const s = cfg.mcpServers.study; const p = spawn(s.command, s.args); let buf = ""; const waiting = {}; let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting[m.id] && waiting[m.id](m); } });
const call = (method, params) => new Promise((r) => { const n = ++id; waiting[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); });
let turns = 0; const total = { input: 0, output: 0 };
const usage = (input, output) => ({ input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: input - 10, output_tokens: output });
const turn = async (input, output, content) => {
  const mid = "m" + ++turns;
  out({ type: "stream_event", event: { type: "message_start", message: { id: mid, usage: usage(input, 2) } } });
  await sleep(150);
  out({ type: "assistant", message: { id: mid, model, usage: usage(input, 2), content } });
  out({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: output } } });
  total.input += input; total.output += output;
  await sleep(150);
};
(async () => {
  out({ type: "system", subtype: "init", session_id: "fake-session", model, claude_code_version: "fake", mcp_servers: [{ name: "study", status: "connected" }] });
  await call("initialize", {});
  const job = JSON.parse(fs.readFileSync(s.args[1] + "/job.json", "utf8"));
  // A bad forecast gives a value where a measure needs items (what real sessions did first).
  const forecast = (good) => job.designs.flatMap((d) => job.targets.map((t) => {
    const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
    return t.components && good ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value };
  }));
  for (const step of steps) {
    if (step.sleep) { await sleep(step.sleep); continue; }
    if (!step.tool) { await turn(step.input, step.output || 50, [{ type: "text", text: "Done." }]); continue; }
    const tid = "toolu_" + (turns + 1);
    const study = step.tool === "submit_forecast" || step.tool === "list_files";
    const input = step.tool === "submit_forecast" ? { predictions: forecast(step.good), uncertainty: "test" } : {};
    await turn(step.input, step.output || 100, [{ type: "tool_use", id: tid, name: (study ? "mcp__study__" : "mcp__other__") + step.tool, input }]);
    const r = study ? (await call("tools/call", { name: step.tool, arguments: input })).result : { content: [{ type: "text", text: "unavailable" }], isError: true };
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: r.content, is_error: !!r.isError }] } });
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ tool: step.tool, error: !!r.isError, text: r.content.map((c) => c.text).join("") }) + "\\n");
  }
  out({ type: "result", subtype: "success", usage: { input_tokens: 10 * turns, cache_creation_input_tokens: 0, cache_read_input_tokens: total.input - 10 * turns, output_tokens: total.output }, total_cost_usd: 0.01, num_turns: turns });
  p.stdin.end(); process.exit(0);
})();`,
  );
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
}

test("forecast format: every measure says what it needs; a refused forecast lists everything to fix at once", async () => {
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const targets = study.outcomes.map((o) => ({ id: o.id, label: o.label, unit: o.unit, scale: o.scale, aggregation: o.aggregation, ...(o.components ? { components: o.components } : {}) }));
  const designs = study.conditions.map((c) => c.id);
  const lines = answerLines(targets, designs.length);
  assert.ok(lines.includes('presence: give "items" general, spatial, involvement, realness, each on 1–7 (an object {"general": number, "spatial": number, "involvement": number, "realness": number}, no "value"); only the mean of the items is scored; give your best estimate for each item (they may differ)'), lines.join("\n"));
  assert.ok(lines.includes('preference: give "value", a rank from 1 to 3 (rank; 1 = best)'), lines.join("\n"));
  assert.ok(lines.includes('search-time: give "value", a positive number (seconds per main trial)'), lines.join("\n"));
  const description = submitDescription(designs, targets);
  assert.match(description, /one row per design × outcome \(3 × 7 = 21 rows\)/);
  assert.match(description, /Design IDs: low, medium, high\./);
  assert.match(description, /- presence: give "items" general, spatial, involvement, realness, each on 1–7/);
  // Values where items are needed, a missing row, a missing item, and designs put inside "items": all named at once.
  const rows: Record<string, unknown>[] = designs.flatMap((d) => targets.map((t) => (t.components ? { design: d, outcome: t.id, value: 4 } : { design: d, outcome: t.id, value: t.scale === "rank" ? 1 : 3 })));
  rows.splice(rows.findIndex((r) => r.outcome === "appeal" && r.design === "high"), 1);
  rows[rows.findIndex((r) => r.outcome === "presence" && r.design === "low")] = { design: "low", outcome: "presence", items: { general: 4, spatial: 4 } };
  rows.push({ outcome: "realism", items: { low: 2, medium: 3, high: 4 } });
  const { problems } = checkForecast(rows, designs, targets, null);
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.match(problems[0], /^Rows not understood .*row 21 \(realism\) puts the designs inside "items": give one row per design instead, e\.g\. \{"design": "low", "outcome": "realism", "value": …\}\.$/);
  assert.match(problems[1], /^presence needs "items" general, spatial, involvement, realness, each on 1–7 .* for every design: items missing for low \(missing involvement, realness\); medium \(no items\); high \(no items\)\.$/);
  assert.match(problems[2], /^appeal needs "value" on 1–7 \(1-7\) for every design: no row for high\.$/);
  const good = checkForecast(designs.flatMap((d) => targets.map((t) => (t.components ? { design: d, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d, outcome: t.id, value: t.scale === "rank" ? 1 : 3 }))), designs, targets, "p01");
  assert.deepEqual(good.problems, []);
  assert.equal(good.measurements.length, 21);
  assert.deepEqual(good.measurements.find((m) => m.outcomeId === "presence"), { conditionId: "low", outcomeId: "presence", participantId: "p01", components: { general: 4, spatial: 4, involvement: 4, realness: 4 } });
});

test("usage meter and reserve: Claude Code's own messages are no model; the reserve covers the turns still needed", async () => {
  const { UsageMeter, submitNow } = await import("../src/executor/runner.js");
  const meter = new UsageMeter();
  meter.add({ type: "assistant", message: { id: "x", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 }, content: [] } });
  meter.add({ type: "stream_event", event: { type: "message_start", message: { id: "y", usage: { input_tokens: 0, output_tokens: 0 } } } });
  assert.equal(meter.modelRan, false);
  meter.add({ type: "stream_event", event: { type: "message_start", message: { id: "z", usage: { input_tokens: 5, output_tokens: 1 } } } });
  assert.equal(meter.modelRan, true);
  // Left 18,300 of 30,000 after two turns, the last of which read 5,871: the submission, a second
  // one and the closing turn need about 3.5 × that, so the tools stop now (1.5 × would wait).
  assert.equal(submitNow(30_000, 11_700, 5_871), true);
  assert.equal(submitNow(60_000, 21_000, 7_718), false);
  assert.equal(submitNow(60_000, 30_000, 9_598), true);
});

test("budget: a submitting session is never stopped for its budget but gets 3 attempts; one still calling tools far over it is stopped; counts and warnings survive a restart; unknown models record none", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, runDir, readReceipts } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await scriptedClaude(bin);
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  const log = join(bin, "log.jsonl");
  process.env.FAKE_LOG = log;
  try {
    const ws = await readWorkspace(a.id);
    const pick = ws.agents!.filter((x) => ["text-only", "reads-project"].includes(x.id)).map((x) => ({ ...x, repetitions: 2, maxTokens: 20_000 }));
    const c = campaignFromPlan(freezePlan(ws.study, pick, 1), undefined, "budget", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    // The largest tool count shown while a session ran.
    const liveMax = new Map<string, number>();
    ex.listeners.add((e) => e.job && liveMax.set(e.job.jobId, Math.max(liveMax.get(e.job.jobId) ?? 0, e.job.toolCalls)));
    const run = async (jobId: string, steps: unknown[]) => {
      process.env.FAKE_STEPS = JSON.stringify(steps);
      await ex.start("agent", [jobId]);
      await until(() => ["done", "failed"].includes(ex.jobs.get(jobId)!.status));
      return ex.jobs.get(jobId)!;
    };
    const [text1] = c.jobs.filter((j) => j.conditionId === "text-only").map((j) => j.id);
    const [proj1, proj2] = c.jobs.filter((j) => j.conditionId === "reads-project").map((j) => j.id);

    // Refused from the first turn; three refused submissions, the last one far over 1.5 × the
    // budget: never stopped for the budget while submitting, but stopped after the third attempt.
    const tooMany = await run(text1, [
      { input: 6_000, tool: "submit_forecast", good: false },
      { input: 12_000, tool: "submit_forecast", good: false },
      { input: 16_000, tool: "submit_forecast", good: false },
      { sleep: 5_000 },
      { input: 18_000, tool: "submit_forecast", good: true },
    ]);
    assert.equal(tooMany.status, "failed");
    assert.equal(tooMany.error, "Stopped: the forecast was not accepted in 3 attempts after the token budget of 20,000 tokens was used up.");
    const answers = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { tool: string; error: boolean; text: string });
    assert.equal(answers.length, 3, "the fourth submission never happened");
    assert.match(answers[0].text, /^Forecast not accepted\. Fix everything below and submit all rows again in one call:\n- presence needs "items" general, spatial, involvement, realness, each on 1–7 .*: items missing for low \(no items\); medium \(no items\); high \(no items\)\.\nThe token budget is used up: 2 more attempts\.$/);
    assert.match(answers[2].text, /this was the last attempt\.$/);

    // Tools refused from the second turn (not counted, live or final); the second submission is
    // accepted although the session is then over 1.5 × its budget.
    await rm(log, { force: true });
    const accepted = await run(proj1, [
      { input: 3_000, tool: "list_files" },
      { input: 6_000, tool: "list_files" },
      { input: 9_000, tool: "submit_forecast", good: false },
      { input: 15_000, tool: "submit_forecast", good: true },
      { input: 16_000 },
    ]);
    assert.equal(accepted.status, "done", accepted.error ?? "");
    assert.equal(accepted.warning, "over budget: 49,450 of 20,000 tokens (33,400 when the forecast was accepted)");
    const refusedCall = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { tool: string; error: boolean; text: string })[1];
    assert.match(refusedCall.text, /Token budget of 20000 tokens is nearly used up/);
    assert.equal(accepted.toolCalls, 1);
    assert.equal(liveMax.get(proj1), 1, "the live count leaves refused calls out, as the final one does");

    // Still calling other tools far over 1.5 × the budget: stopped.
    const runaway = await run(proj2, [
      { input: 3_000, tool: "list_files" },
      { input: 6_000, tool: "list_files" },
      { input: 22_000, tool: "list_files" },
      { sleep: 5_000 },
      { input: 23_000, tool: "submit_forecast", good: true },
    ]);
    assert.equal(runaway.status, "failed");
    assert.equal(runaway.error, "Stopped: the session used more than 1.5 × its token budget of 20,000 tokens and was still calling other tools instead of submitting its forecast.");
    assert.match(runaway.warning ?? "", /^over budget: 31,(202|300) of 20,000 tokens$/);
    assert.equal(runaway.toolCalls, 1);
    assert.equal(liveMax.get(proj2), 1);

    // After a restart the executor shows the same.
    const before = [text1, proj1, proj2].map((id) => ({ ...ex.jobs.get(id)!, lastTool: null, startedAt: null, endedAt: null }));
    closeExecutor(a.id, c.id);
    const again = await Executor.open(a.id, c.id);
    for (const b of before) {
      const s = again.jobs.get(b.jobId)!;
      assert.deepEqual(
        [s.status, s.attempts, s.toolCalls, s.tokensIn, s.tokensOut, s.warning, s.error, s.simulated],
        [b.status, b.attempts, b.toolCalls, b.tokensIn, b.tokensOut, b.warning, b.error, b.simulated],
        b.jobId,
      );
    }
    closeExecutor(a.id, c.id);

    // An unknown model: Claude Code answers itself ("<synthetic>", no tokens), so no model ran.
    const typo = pick.map((x) => (x.id === "text-only" ? { ...x, model: { ...x.model, model: "claude-sonet-5-5" } } : x));
    const c2 = campaignFromPlan(freezePlan(ws.study, typo, 1), undefined, "typo", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c2);
    const ex2 = await Executor.open(a.id, c2.id);
    const job = c2.jobs.find((j) => j.conditionId === "text-only")!.id;
    await ex2.start("agent", [job]);
    await until(() => ex2.jobs.get(job)!.status === "failed");
    assert.equal(ex2.jobs.get(job)!.error, 'Claude Code does not know the model "claude-sonet-5-5". Check the model ID on Agent configurations.');
    assert.equal((await readReceipts(a.id, [c2.id])).find((r) => r.jobId === job)!.actualModel, null);
    const manifest = await readJson<Record<string, unknown>>(join(runDir(a.id, c2.id), "jobs", job, "a1", "execution-manifest.json"));
    assert.equal(manifest.actualModel, null);
    closeExecutor(a.id, c2.id);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_STEPS;
    delete process.env.FAKE_LOG;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("executor: Resume continues only sessions waiting after Pause; stopped sessions stay stopped, also after a restart", async () => {
  const { Executor, closeExecutor, STOPPED } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!.filter((x) => x.id === "uses-app").map((x) => ({ ...x, repetitions: 18 })), 1), undefined, "resume", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const ids = [...ex.jobs.keys()];
    // Simulated sessions run eight at a time: four wait, and Pause keeps them waiting.
    await ex.start("simulate", ids.slice(0, 12));
    await until(() => ids.filter((id) => ex.jobs.get(id)!.status === "running").length === 8);
    ex.pause();
    const waiting = ids.slice(0, 12).filter((id) => ex.jobs.get(id)!.status === "queued");
    assert.equal(waiting.length, 4);
    await until(() => ex.running.size === 0);
    assert.deepEqual([ex.snapshot().queued, ex.snapshot().counts.queued], [4, 4]);
    ex.resume();
    await until(() => ids.slice(0, 12).every((id) => ex.jobs.get(id)!.status === "done"));
    assert.ok(ids.slice(0, 12).every((id) => ex.jobs.get(id)!.status === "done"));
    // Stop: running sessions stop; Resume does not start them again (that is Rerun failed or Start).
    const stopped = ids.slice(12, 15);
    await ex.start("simulate", stopped);
    await until(() => stopped.every((id) => ex.jobs.get(id)!.status === "running"));
    ex.stop();
    assert.throws(() => ex.resume(), /Nothing to resume: no sessions are waiting\. Stopped or failed sessions run again with Rerun failed/);
    await wait(1500);
    const snap = ex.snapshot();
    assert.deepEqual([snap.counts.stopped, snap.counts.queued ?? 0, snap.queued, snap.running], [3, 0, 0, 0]);
    // A restart: the stopped simulated sessions come back stopped (not "not started"), with their
    // attempt and the receipt Stop wrote for it.
    closeExecutor(a.id, c.id);
    const again = await Executor.open(a.id, c.id);
    for (const id of stopped) {
      const s = again.jobs.get(id)!;
      assert.deepEqual([s.status, s.attempts, s.simulated, s.error], ["stopped", 1, true, STOPPED], id);
    }
    assert.equal(again.snapshot().counts.done, 12);
    // Run again: a new attempt folder, never the stopped one.
    await again.start("simulate", stopped);
    await until(() => stopped.every((id) => again.jobs.get(id)!.status === "done"));
    assert.ok(stopped.every((id) => again.jobs.get(id)!.attempts === 2 && existsSync(join(runDir(a.id, c.id), "jobs", id, "a2", "result.json"))));
    closeExecutor(a.id, c.id);
  } finally {
    await removeDir(a.dir);
  }
});

test("continue: configurations whose sources changed run again; added or changed configurations are checked; in the website and the CLI", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, saveSourceFingerprints, readCampaign, workspaceDir } = await import("../src/workspace.js");
  const { handlePost } = await import("../src/routes.js");
  const a = await tempWorkspace(gq);
  const out = await mkdtemp(join(tmpdir(), "xr-continue-"));
  try {
    const ws = await readWorkspace(a.id);
    const pick = ws.agents!.filter((x) => ["text-only", "knows-participant"].includes(x.id)).map((x) => ({ ...x, repetitions: x.id === "text-only" ? 2 : 1 }));
    const c1 = campaignFromPlan(freezePlan(ws.study, pick, 1), undefined, "sources", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c1);
    await saveSourceFingerprints(a.id, c1);
    const person = c1.jobs.find((j) => j.conditionId === "knows-participant")!.id;
    const texts = c1.jobs.filter((j) => j.conditionId === "text-only").map((j) => j.id);
    const ex = await Executor.open(a.id, c1.id);
    await ex.start("simulate", [person, ...texts]);
    await until(() => [person, ...texts].every((id) => ex.jobs.get(id)!.status === "done"));
    closeExecutor(a.id, c1.id);
    // The participant background changes after p01's run.
    const csv = join(a.dir, ws.manifest.sources!.demographics);
    await writeFile(csv, (await readFile(csv, "utf8")) + "\n");
    let preview: Record<string, any> = {};
    await handlePost("/api/workspace/continue", { id: a.id, campaignId: c1.id, changes: { note: "more", repetitions: { "text-only": 2 } }, keepSimulated: true, preview: true }, (v) => (preview = v as Record<string, any>));
    const label = pick.find((p) => p.id === "knows-participant")!.label;
    assert.deepEqual(preview.sourceChanges, [`Participant demographics changed since this campaign was frozen: ${label} runs again (its finished runs used the old version).`]);
    const next = preview.campaign as Campaign;
    assert.equal(next.jobs.filter((j) => j.conditionId === "knows-participant" && j.inheritedFrom).length, 0, "p01's run used the old file");
    assert.equal(next.jobs.filter((j) => j.conditionId === "text-only" && j.inheritedFrom).length, 2);
    let made: Record<string, any> = {};
    await handlePost("/api/workspace/continue", { id: a.id, campaignId: c1.id, changes: { repetitions: { "text-only": 2 }, note: "more" }, keepSimulated: true }, (v) => (made = v as Record<string, any>));
    const c2 = await readCampaign(a.id, made.campaignId);
    assert.deepEqual(c2.continuation?.rerunConditions, ["knows-participant"]);
    verifyContinuation(c1, c2);

    // Added or changed configurations meet today's rules, in the website …
    const base = c1.suite.conditions.find((x) => x.id === "text-only")!;
    const added = (change: Record<string, unknown>): CampaignCondition => {
      const copy = structuredClone(base);
      copy.id = "tiny";
      copy.label = "Tiny budget";
      copy.jobs = copy.jobs.map((j, i) => ({ ...j, id: `tiny-r${i + 1}` }));
      copy.recipe.protocol = { ...copy.recipe.protocol!, id: "tiny", label: "Tiny budget", ...change };
      return copy;
    };
    const continueWith = (changes: Record<string, unknown>) => handlePost("/api/workspace/continue", { id: a.id, campaignId: c1.id, changes, preview: true }, () => undefined);
    await assert.rejects(continueWith({ addConditions: [added({ maxTokens: 1000 })] }), /The token budget of Tiny budget must be at least 20,000 tokens/);
    await assert.rejects(continueWith({ addConditions: [added({ model: { provider: "claude-code", model: "claude-opus-5-5", reasoning: "effort=bogus" } })] }), /Reasoning setting "effort=bogus" of Tiny budget is not understood by Claude Code/);
    await assert.rejects(continueWith({ addConditions: [added({ runtime: "webxr" })] }), /Tiny budget has the runtime "webxr" but does not use the running app/);
    await continueWith({ addConditions: [added({})] });

    // … and on the command line (campaign-continue), which also runs changed sources again.
    const changes = join(out, "changes.json");
    await writeFile(changes, JSON.stringify({ conditionModels: { "text-only": { provider: "claude-code", model: "claude-opus-5-5", reasoning: "effort=bogus" } } }));
    const campaignFile = join(workspaceDir(a.id), "campaigns", c1.id, "campaign.json");
    const cli = (...args: string[]) =>
      new Promise<{ code: number; out: string; err: string }>((done) =>
        execFile(process.execPath, [resolve("dist/cli.js"), ...args], { env: { ...process.env, XR_STUDY_SETTINGS: join(out, "none.json") } }, (e, o, err) => done({ code: e ? Number(e.code) || 1 : 0, out: o, err })),
      );
    const refused = await cli("campaign-continue", campaignFile, changes, join(out, "c2"));
    assert.notEqual(refused.code, 0);
    assert.match(refused.err, /Reasoning setting "effort=bogus" of .* is not understood by Claude Code/);
    await writeFile(changes, JSON.stringify({ repetitions: { "text-only": 3 } }));
    const ok = await cli("campaign-continue", campaignFile, changes, join(out, "c3"));
    assert.equal(ok.code, 0, ok.err);
    const printed = JSON.parse(ok.out) as { sourceChanges?: string[] };
    assert.equal(printed.sourceChanges?.length, 1);
    const c3 = await readJson<Campaign>(join(out, "c3", "campaign.json"));
    assert.deepEqual(c3.continuation?.rerunConditions, ["knows-participant"]);
  } finally {
    await removeDir(a.dir);
    await removeDir(out);
  }
});

test("save: a participant field named like a measure and comparisons of unknown configurations are refused as everywhere else", async () => {
  const { readWorkspace, saveWorkspace, saveCampaign } = await import("../src/workspace.js");
  const { saveKnowledge } = await import("../src/sources.js");
  const { continueCampaign } = await import("../src/core/campaign.js");
  const a = await tempWorkspace(gq);
  try {
    const ws = await readWorkspace(a.id);
    const realism = structuredClone(ws.study);
    realism.sources.find((s) => s.kind === "demographics")!.fields = ["age_band", "Realism"];
    const message = /Realism is named like a measure, so it cannot be a field of Participant demographics: results are never participant knowledge\.$/;
    await assert.rejects(saveKnowledge(a.id, { study: realism, agents: ws.agents }), message);
    await assert.rejects(saveWorkspace(a.id, { study: realism, agents: ws.agents! }), message);
    await assert.rejects(saveWorkspace(a.id, { study: realism }), message);
    // Comparisons name configurations of agents.json or of a campaign (an added model arm).
    await assert.rejects(
      saveWorkspace(a.id, { comparisons: [{ candidate: "text-only", baseline: "nope", domain: "subjective" }] }),
      /Comparison 1 \(text-only − nope\): nope is not a configuration here \(configurations: text-only, /,
    );
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "arms", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const arm = continueCampaign(c, { cloneConditions: [{ from: "text-only", id: "text-only-haiku", model: { provider: "claude-code", model: "claude-haiku-5-5", reasoning: "default" } }] });
    await saveCampaign(a.id, arm);
    await saveWorkspace(a.id, { comparisons: [{ candidate: "text-only-haiku", baseline: "text-only", domain: "subjective" }] });
    assert.deepEqual(await readJson(join(a.dir, "comparisons.json")), [{ candidate: "text-only-haiku", baseline: "text-only", domain: "subjective" }]);
  } finally {
    await removeDir(a.dir);
  }
});
