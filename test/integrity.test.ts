// What researchers found by using the running workbench: knowledge files, saving, frozen campaigns,
// the executor's controls and counts, configuration checks and figures. Throw-away studies live
// under private/studies/__test-* and are removed again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, methodGets, withDefaultRuns } from "../src/core/planner.js";
import { checkNewConfigurations, validateAgents, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import type { AgentProtocol, HumanData, Study } from "../src/core/types.js";
import { until } from "./until.js";

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
/** A study with three people, for the table readers (only participants and measures matter there). */
async function threePeople(): Promise<Study> {
  const s = validateStudy(await readJson(join(gq, "study.json")));
  return { ...s, participants: s.participants.slice(0, 3).map((p, i) => ({ ...p, id: `p0${i + 1}` })) };
}

/**
 * A stand-in for `claude -p`: starts the study MCP server, reports usage like Claude Code with
 * --include-partial-messages (message_start with a few output tokens, message_delta with the
 * final count), submits a forecast, and can hang (FAKE_HANG), add a large closing turn after the
 * forecast (FAKE_CLOSING) or refuse an unknown model.
 */
async function fakeClaude(bin: string) {
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2);
if (args[0] === "--help") { if (process.env.FAKE_HELP) process.stdout.write(process.env.FAKE_HELP); process.exit(process.env.FAKE_HELP ? 0 : 1); }
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const model = args[args.indexOf("--model") + 1];
const out = (m) => console.log(JSON.stringify(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (model === "claude-sonet-5-5") { process.stderr.write("API Error: [claude-code:unrecognized_model] there is no such model\\n"); process.exit(1); }
const s = cfg.mcpServers.study; const p = spawn(s.command, s.args); let buf = ""; const wait = {}; let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id] && wait[m.id](m); } });
const call = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); });
const message = (mid, usage, final, content) => {
  out({ type: "stream_event", event: { type: "message_start", message: { id: mid, usage } } });
  out({ type: "assistant", message: { id: mid, usage, content } });
  out({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: final } } });
};
(async () => {
  // What the session got: the prompt on stdin, the command line, the system prompt file, the job marker.
  let stdin = ""; process.stdin.setEncoding("utf8"); for await (const d of process.stdin) stdin += d;
  const sp = args.indexOf("--system-prompt-file");
  fs.writeFileSync("seen.json", JSON.stringify({ args, stdin, job: process.env.XR_STUDY_JOB || null, systemFile: sp >= 0 ? fs.readFileSync(args[sp + 1], "utf8") : null }));
  out({ type: "system", subtype: "init", session_id: "fake-session", model, claude_code_version: "fake", mcp_servers: [{ name: "study", status: "connected" }] });
  await call("initialize", {});
  message("m1", { input_tokens: 10, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 3 }, 400, [{ type: "text", text: "Reading the brief." }]);
  if (process.env.FAKE_HANG) await sleep(20000);
  const job = JSON.parse(fs.readFileSync(s.args[1] + "/job.json", "utf8"));
  const predictions = [];
  for (const d of job.designs) for (const t of job.targets) {
    const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
    predictions.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value });
  }
  const u2 = { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 2 };
  const submitting = [{ type: "tool_use", id: "t2", name: "mcp__study__submit_forecast", input: {} }];
  // FAKE_REAL_ORDER: as real Claude Code prints it, the tool runs and its result is printed before
  // the submitting message's final usage (message_delta).
  if (!process.env.FAKE_REAL_ORDER) message("m2", u2, 200, submitting);
  else { out({ type: "stream_event", event: { type: "message_start", message: { id: "m2", usage: u2 } } }); out({ type: "assistant", message: { id: "m2", usage: u2, content: submitting } }); }
  const r = await call("tools/call", { name: "submit_forecast", arguments: { predictions, uncertainty: "test" } });
  if (process.env.FAKE_REAL_ORDER) { out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "Forecast accepted." }] } }); await sleep(100); out({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 200 } } }); }
  const closing = Number(process.env.FAKE_CLOSING || 0);
  if (closing) { message("m3", { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: closing, output_tokens: 1 }, 50, [{ type: "text", text: "Done." }]); await sleep(300); }
  out({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: closing ? 25 : 20, cache_creation_input_tokens: 2000, cache_read_input_tokens: 8000 + closing, output_tokens: closing ? 650 : 600 }, total_cost_usd: 0.01, num_turns: 2 });
  p.stdin.end(); process.exit(0);
})();`,
  );
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
}

test("knowledge tables: semicolons and tabs are read; duplicates, repeated columns and open quotes are named plainly", async () => {
  const { parseCsv, participantProblemsText } = await import("../src/participant-knowledge.js");
  const study = await threePeople();
  const semi = parseCsv("participant;age_band;xr_experience\np01;18-24;none\n");
  assert.equal(semi.delimiter, ";");
  assert.deepEqual(semi.head, ["participant", "age_band", "xr_experience"]);
  assert.deepEqual(parseCsv("participant\tage_band\np01\t18-24\n").rows, [["p01", "18-24"]]);
  // A comma-separated file stays comma-separated even with a semicolon in a value.
  assert.equal(parseCsv('participant,note\np01,"a; b"\n').delimiter, ",");
  assert.deepEqual(participantProblemsText(study, "demographics", "participant;age\np01;20\np02;30\np03;40\n", ["age"]), []);
  const doubled = participantProblemsText(study, "demographics", "participant,age\np01,20\np01,21\np02,30\np02,31\np03,40\n", ["age"]);
  assert.deepEqual(doubled, ["has more than one row for p01, p02"]);
  const twice = participantProblemsText(study, "demographics", "participant,age,age\np01,,20\np02,,30\np03,,40\n", ["age"]);
  assert.ok(twice.some((p) => /^has the column age more than once/.test(p)), JSON.stringify(twice));
  const open = participantProblemsText(study, "demographics", 'participant,age\np01,20\np02,"30\np03,40\n', ["age"]);
  assert.ok(open.some((p) => /quote \(".*opened on line 3 that is never closed/.test(p)), JSON.stringify(open));
  assert.ok(participantProblemsText(study, "demographics", "participant,realism\np01,1\np02,2\np03,3\n", ["realism"]).some((p) => /^has the field realism, named like a measure/.test(p)));
});

test("cohort summary: only this study's people, categories counted in any case, values with commas quoted", async () => {
  const { backgroundText, strangerNote, strangers } = await import("../src/participant-knowledge.js");
  const study = await threePeople();
  const people = study.participants.map((p) => p.id);
  const text = 'participant,age_band,xr,vision\np01,18-24,none,"contacts, both eyes"\np02,18-24,None,none\np03,25-34,NONE,none\np99,65+,none,none\n';
  const summary = backgroundText(text, ["age_band", "xr", "vision"], undefined, people);
  assert.match(summary, /^age_band: 18-24 2, 25-34 1 \(n=3\)$/m);
  assert.doesNotMatch(summary, /65\+/);
  assert.match(summary, /^xr: none 3 \(n=3\)$/m);
  assert.match(summary, /^vision: "contacts, both eyes" 1, none 2 \(n=3\)$/m);
  assert.deepEqual(strangers(study, text), ["p99"]);
  assert.equal(strangerNote(["p99"]), "Rows for people not in this study are ignored: p99.");
});

test("movement recordings: every file of the person, only the declared fields; empty files count as missing", async () => {
  const { participantProblems, trajectoryText } = await import("../src/participant-knowledge.js");
  const study = await threePeople();
  const dir = await mkdtemp(join(tmpdir(), "xr-movement-"));
  try {
    for (const level of ["low", "medium", "high"]) await writeFile(join(dir, `p01_${level}.csv`), `t,x,operator_note\n0,1,${level} went fine\n1,2,ok\n`);
    await writeFile(join(dir, "p02.csv"), "t,x,operator_note\n");
    await writeFile(join(dir, "p03.csv"), "");
    const text = trajectoryText(dir, "p01", ["t", "x"]);
    assert.deepEqual([...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]), ["p01_high.csv", "p01_low.csv", "p01_medium.csv"]);
    assert.doesNotMatch(text, /operator_note|went fine/);
    const problems = participantProblems(study, "trajectory", dir, ["t", "x"]);
    assert.ok(problems.some((p) => /empty recordings .*p02\.csv, p03\.csv/.test(p)), JSON.stringify(problems));
    // One CSV for everyone: only the ID column and the declared fields reach the agent.
    const one = join(dir, "all.csv");
    await writeFile(one, "participant,t,x,operator_note\np01,0,1,secret\np02,0,2,secret\n");
    assert.equal(trajectoryText(one, "p01", ["t"]), "participant,t\np01,0");
  } finally {
    await removeDir(dir);
  }
});

test("knowledge save: results-named columns refused, other files never overwritten, foreign tables named", async () => {
  const { knowledgeDraft, saveKnowledge } = await import("../src/sources.js");
  const { readWorkspace } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  try {
    let ws = await readWorkspace(a.id);
    const ids = ws.study.participants.map((p) => p.id);
    const withSource = (id: string, kind: "trajectory" | "demographics" | "evidence", fields?: string[]) => {
      const s = structuredClone(ws.study);
      s.sources.push({ id, label: `Source ${id}`, kind, description: "test", ...(fields ? { fields } : {}) });
      return s;
    };
    // A movement table holding measures is refused as a whole, not only its declared fields.
    const leaky = `participant,t,realism,presence\n${ids.map((p) => `${p},1,5,4`).join("\n")}\n`;
    await assert.rejects(
      saveKnowledge(a.id, { study: withSource("moves", "trajectory", ["t"]), agents: ws.agents, write: [{ sourceId: "moves", path: "data/moves.csv", text: leaky }] }),
      /has columns named like measures \(realism, presence\)/,
    );
    await assert.rejects(saveKnowledge(a.id, { study: withSource("moves", "trajectory", ["Realism"]), agents: ws.agents }), /Realism is named like a measure, so it cannot be a field/);
    // A semicolon-separated table with this study's IDs is read and kept comma-separated.
    const draft = await knowledgeDraft(a.id, "bg.csv", Buffer.from(`participant;handedness\n${ids.map((p) => `${p};right`).join("\n")}\n`));
    assert.equal(draft.kind, "participant");
    assert.deepEqual(draft.columns!.map((c) => c.name), ["handedness"]);
    assert.match(draft.text, /^participant,handedness\n/);
    await saveKnowledge(a.id, { study: withSource(draft.sourceId, "demographics", ["handedness"]), agents: ws.agents, write: [{ sourceId: draft.sourceId, path: draft.path, text: draft.text }] });
    ws = await readWorkspace(a.id);
    const kept = ws.manifest.sources![draft.sourceId];
    // Deleted: the file stays, and a new draft never proposes that file again.
    const s2 = structuredClone(ws.study);
    s2.sources = s2.sources.filter((x) => x.id !== draft.sourceId);
    await saveKnowledge(a.id, { study: s2, agents: ws.agents, unmap: [draft.sourceId] });
    ws = await readWorkspace(a.id);
    const again = await knowledgeDraft(a.id, "bg.csv", Buffer.from(`participant,handedness\n${ids.map((p) => `${p},left`).join("\n")}\n`));
    assert.notEqual(again.path, kept);
    // A write aimed at another source's file or a kept file goes to a free name instead.
    const before = await readFile(join(a.dir, kept), "utf8");
    const r = await saveKnowledge(a.id, { study: withSource("notes", "evidence"), agents: ws.agents, write: [{ sourceId: "notes", path: kept, text: "# Notes\n" }] });
    assert.notEqual(r.written[0], kept);
    assert.equal(await readFile(join(a.dir, kept), "utf8"), before);
    assert.equal((await readWorkspace(a.id)).manifest.sources!.notes, r.written[0]);
    // A table about people none of whom are in this study is named, not sent to the assistant.
    await assert.rejects(knowledgeDraft(a.id, "other.csv", Buffer.from("participant,age\nx01,20\nx02,30\n")), /none of its IDs \(x01, x02\) is a participant of this study/);
  } finally {
    await removeDir(a.dir);
  }
});

test("workspace save is all or nothing, and a study whose files disagree still opens with the problem", async () => {
  const { readWorkspace, saveWorkspace } = await import("../src/workspace.js");
  const { handleGet } = await import("../src/routes.js");
  const a = await tempWorkspace(gq);
  try {
    const ws = await readWorkspace(a.id);
    const studyText = await readFile(join(a.dir, "study.json"), "utf8");
    // Inputs need an after-experience forecast: refused, and study.json is not touched.
    await assert.rejects(saveWorkspace(a.id, { study: { ...ws.study, predictionTiming: "before-experience" }, agents: ws.agents! }), /after-experience/);
    assert.equal(await readFile(join(a.dir, "study.json"), "utf8"), studyText);
    // Only the study: checked against the saved configurations, which are named.
    const noEvidence = { ...ws.study, sources: ws.study.sources.filter((s) => s.kind !== "evidence") };
    await assert.rejects(saveWorkspace(a.id, { study: noEvidence }), /does not fit the saved agent configurations: .*reads-evidence/);
    assert.equal(await readFile(join(a.dir, "study.json"), "utf8"), studyText);
    // Comparisons are checked too.
    await assert.rejects(saveWorkspace(a.id, { comparisons: [{ evil: "<script>" }] as never }), /unknown properties/);
    // Files that disagree (edited outside the website): the study opens, with the problem to fix.
    await writeFile(join(a.dir, "study.json"), JSON.stringify({ ...ws.study, predictionTiming: "before-experience" }, null, 2));
    await assert.rejects(readWorkspace(a.id));
    let view: Record<string, any> = {};
    await handleGet("/api/workspace", new URL(`http://x/api/workspace?id=${encodeURIComponent(a.id)}`), null as never, (v) => (view = v as Record<string, any>));
    assert.match(view.problem, /do not fit the saved study .*Fix this on Agent configurations/);
    assert.equal(view.agents.length, ws.agents!.length);
    let evidence: Record<string, any> = {};
    await handleGet("/api/workspace/evidence", new URL(`http://x/api/workspace/evidence?id=${encodeURIComponent(a.id)}`), null as never, (v) => (evidence = v as Record<string, any>));
    assert.ok(Array.isArray(evidence.participants));
  } finally {
    await removeDir(a.dir);
  }
});

test("configurations: wrong combinations, token budgets and effort are refused in plain words; inputs are listed", async () => {
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const agents = validateAgents(study, await readJson<AgentProtocol[]>(join(gq, "agents.json")));
  const one = (id: string, change: Partial<AgentProtocol>) => agents.map((a) => (a.id === id ? ({ ...a, ...change } as AgentProtocol) : a));
  assert.throws(() => checkNewConfigurations(study, one("uses-app", { runtime: "none" })), /uses the running app, but its runtime is "none"/);
  assert.throws(() => checkNewConfigurations(study, one("text-only", { runtime: "webxr" })), /has the runtime "webxr" but does not use the running app/);
  const ecolar = validateStudy(await readJson(resolve("examples/ecolar/study.json")));
  const udot = validateAgents(ecolar, await readJson<AgentProtocol[]>(resolve("examples/ecolar/agents.json"))).find((a) => a.id === "UDOT")!;
  assert.throws(() => checkNewConfigurations(ecolar, [{ ...udot, level: "population", inputs: [] }]), /movement recordings are per participant/);
  // Budgets: whole numbers, at least 20,000 and at most 50,000,000; empty is no limit.
  assert.throws(() => validateAgents(study, one("text-only", { maxTokens: 45000.5 })), /must be a whole number of tokens/);
  assert.throws(() => validateAgents(study, one("text-only", { maxTokens: "45000" as never })), /must be a whole number of tokens/);
  assert.throws(() => validateAgents(study, one("text-only", { maxTokens: 1e12 })), /at most 50,000,000 tokens/);
  assert.throws(() => freezePlan(study, withDefaultRuns(study, one("text-only", { maxTokens: 1000 }), 1), 1), /at least 20,000 tokens/);
  assert.equal(validateAgents(study, one("text-only", { maxTokens: null as never })).find((a) => a.id === "text-only")!.maxTokens, undefined);
  // Effort Claude Code would refuse is refused when freezing, not only when running.
  const ultra = one("text-only", { model: { provider: "claude-code", model: "claude-opus-5-5", reasoning: "effort=ultra" } });
  assert.throws(() => freezePlan(study, withDefaultRuns(study, ultra, 1), 1), /"effort=ultra" of .* is not understood by Claude Code/);
  // What the agent gets names the measured inputs.
  assert.match(methodGets(agents.find((a) => a.id === "text-with-task-data")!, study).join("; "), /measured Search time, Wrong selections as the cohort means, from the human data/);
});

test("figures follow the summaries: unscored partial configurations and measures given as inputs are left out", async () => {
  const { figureSelection } = await import("../src/core/figures.js");
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const agents = validateAgents(study, await readJson<AgentProtocol[]>(join(gq, "agents.json")));
  const human = await readJson<HumanData>(join(gq, "human.json"));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "figures", new Date(Date.now() - 1000).toISOString());
  const run = syntheticCampaignExecution(c).results;
  // knows-participant: forecasts for only 2 people so far.
  const partial = new Set(c.jobs.filter((j) => j.conditionId === "knows-participant").slice(2).map((j) => j.id));
  const { report } = analyzeCampaign(c, human, [{ ...run, runs: run.runs.filter((r) => !partial.has(r.jobId)) }]);
  const configs = Object.fromEntries(agents.map((a) => [a.id, { level: (a.level ?? study.predictionLevel) as "population" | "individual", targets: (a.targets ?? study.outcomes.map((o) => o.id)).filter((o) => !a.inputs?.includes(o)) }]));
  const agreement = figureSelection(study, report, ["knows-participant", "uses-app-people", "text-only"], configs, {}, { domain: "subjective" });
  assert.deepEqual(agreement.ids, ["uses-app-people", "text-only"]);
  assert.match(agreement.omitted[0], /knows-participant is left out until every participant has a forecast \(2 of 18 so far\)/);
  const vsHuman = figureSelection(study, report, ["text-with-task-data", "text-only"], configs, { "text-with-task-data": "Text + task data" }, { outcomeId: "search-time" });
  assert.deepEqual(vsHuman.ids, ["text-only"]);
  assert.match(vsHuman.omitted[0], /Text \+ task data is left out: it does not predict Search time/);
});

test("executor: Stop ends simulated sessions for good; a second Start adds to the queue", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "stop-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    // Sessions that use the app: seven simulated steps, so they are still running when stopped.
    const app = [...ex.jobs.values()].filter((j) => j.agentId === "uses-app").slice(0, 3).map((j) => j.jobId);
    const ids = [...ex.jobs.keys()].filter((id) => !app.includes(id));
    await ex.start("simulate", app);
    await until(() => app.every((id) => ex.jobs.get(id)!.status === "running"), "the three sessions to run", { executor: ex });
    ex.stop();
    assert.deepEqual(app.map((id) => ex.jobs.get(id)!.status), ["stopped", "stopped", "stopped"]);
    // A window in which a stopped session would have finished; nothing may change in it.
    await wait(2500);
    assert.deepEqual(app.map((id) => ex.jobs.get(id)!.status), ["stopped", "stopped", "stopped"], "stopped sessions never turn done");
    // Rerunning them right away runs them.
    await ex.start("simulate", app);
    await until(() => app.every((id) => ex.jobs.get(id)!.status === "done"), "the rerun sessions to finish", { executor: ex });
    assert.deepEqual(app.map((id) => ex.jobs.get(id)!.status), ["done", "done", "done"]);
    // A second Start while the first queue runs adds to it.
    const first = ids.slice(0, 20),
      second = ids.slice(20, 25);
    await ex.start("simulate", first);
    await ex.start("simulate", second);
    await assert.rejects(ex.start("agent", ids.slice(25, 26)), /Simulated sessions are still queued or running/);
    await until(() => [...first, ...second].every((id) => ex.jobs.get(id)!.status === "done"), "both queues to finish", { executor: ex });
    assert.ok([...first, ...second].every((id) => ex.jobs.get(id)!.status === "done"), JSON.stringify(ex.snapshot().counts));
    assert.equal(ex.snapshot().counts.queued ?? 0, 0);
    // Tool calls exclude the forecast submission, in the executor and in the attempts alike.
    const { sessionAttempts } = await import("../src/history.js");
    const job = ex.jobs.get(first[0])!;
    assert.equal((await sessionAttempts(a.id, c, job.jobId)).attempts.at(-1)!.toolCalls, job.toolCalls);
    // Estimates count only sessions that would run.
    assert.deepEqual(await ex.estimate(first), []);
  } finally {
    await removeDir(a.dir);
  }
});

test("usage while streaming: each message's final output counts; the tools ask for the forecast in time", async () => {
  const { UsageMeter, submitNow, budgetWarning } = await import("../src/executor/runner.js");
  const meter = new UsageMeter();
  const usage = { input_tokens: 2, cache_creation_input_tokens: 3363, cache_read_input_tokens: 1391, output_tokens: 6 };
  meter.add({ type: "stream_event", event: { type: "message_start", message: { id: "a", usage } } });
  for (let i = 0; i < 3; i++) meter.add({ type: "assistant", message: { id: "a", usage, content: [] } });
  meter.add({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 676 } } });
  const t = meter.totals();
  assert.equal(t.output, 676, "the final output, not the 6 of message_start, and once per message");
  assert.equal(t.total, 2 + 3363 + 1391 + 676);
  assert.equal(t.lastTurnInput, 2 + 3363 + 1391);
  // Left 3,500 of 40,000: under 10% → submit. Left 20,000, but the last turn read 15,000 → submit too.
  assert.equal(submitNow(40_000, 36_500, 1_000), true);
  assert.equal(submitNow(40_000, 20_000, 15_000), true);
  assert.equal(submitNow(40_000, 20_000, 5_000), false);
  assert.equal(budgetWarning(97_712, 60_000), "over budget: 97,712 of 60,000 tokens");
  assert.equal(budgetWarning(50_000, 60_000), null);
});

test("executor: frozen knowledge is what agents get; a changed source blocks; stop keeps the tokens; unknown models and over-budget sessions are named", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, saveSourceFingerprints, runDir, readReceipts } = await import("../src/workspace.js");
  const { saveKnowledge } = await import("../src/sources.js");
  const { sessionAttempts } = await import("../src/history.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await fakeClaude(bin);
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    let ws = await readWorkspace(a.id);
    const pick = ws.agents!.filter((x) => ["knows-participant", "text-only"].includes(x.id)).map((x) => ({ ...x, repetitions: 1, ...(x.id === "text-only" ? { maxTokens: 20_000 } : {}) }));
    const c = campaignFromPlan(freezePlan(ws.study, pick, 1), undefined, "frozen-knowledge", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    await saveSourceFingerprints(a.id, c);
    // After freezing, the background is narrowed to one field in the workspace: the campaign keeps its three.
    const narrowed = structuredClone(ws.study);
    narrowed.sources.find((s) => s.kind === "demographics")!.fields = ["age_band"];
    await saveKnowledge(a.id, { study: narrowed, agents: ws.agents });
    const ex = await Executor.open(a.id, c.id);
    const person = c.jobs.find((j) => j.conditionId === "knows-participant")!.id;
    await ex.start("agent", [person]);
    await until(() => ["done", "failed"].includes(ex.jobs.get(person)!.status), "the session to end", { executor: ex });
    assert.equal(ex.jobs.get(person)!.status, "done", ex.jobs.get(person)!.error ?? "");
    const prompt = await readFile(join(runDir(a.id, c.id), "jobs", person, "a1", "prompt.md"), "utf8");
    assert.match(prompt, /^xr_experience: /m, "the frozen fields, not the workspace's current ones");
    // Final counts: the session's own totals; tool calls exclude the forecast (0 here, in both places).
    assert.deepEqual([ex.jobs.get(person)!.tokensIn, ex.jobs.get(person)!.tokensOut, ex.jobs.get(person)!.toolCalls], [10_020, 600, 0]);
    assert.equal((await sessionAttempts(a.id, c, person)).attempts[0].toolCalls, 0);

    // Over budget after the forecast was accepted: never killed, and shown as over budget. The stream
    // comes in real Claude Code's order (the tool result before the submitting message's final
    // usage): the tokens at the forecast still include all of that message's output.
    const budgeted = c.jobs.find((j) => j.conditionId === "text-only")!.id;
    process.env.FAKE_CLOSING = "30000";
    process.env.FAKE_REAL_ORDER = "1";
    await ex.start("agent", [budgeted]);
    await until(() => ["done", "failed"].includes(ex.jobs.get(budgeted)!.status), "the session to end", { executor: ex });
    delete process.env.FAKE_CLOSING;
    delete process.env.FAKE_REAL_ORDER;
    const over = ex.jobs.get(budgeted)!;
    assert.equal(over.status, "done", over.error ?? "");
    assert.equal(over.warning, "over budget: 40,675 of 20,000 tokens (10,620 when the forecast was accepted)");
    const manifest = await readJson<Record<string, any>>(join(runDir(a.id, c.id), "jobs", budgeted, "a1", "execution-manifest.json"));
    assert.equal(manifest.tokensAtSubmit, 10_620);
    assert.equal(manifest.tokensAfterSubmit, 40_675 - 10_620);
    const result = await readJson<Record<string, any>>(join(runDir(a.id, c.id), "results", `${budgeted}.json`));
    assert.equal(result.execution.tokensAtSubmit, 10_620, "the audit reads the tokens up to the forecast from the result");

    // Stop a real session: it stays stopped, keeps its tokens, its cost is unknown, and it reruns at once.
    const other = c.jobs.filter((j) => j.conditionId === "knows-participant")[1].id;
    process.env.FAKE_HANG = "1";
    await ex.start("agent", [other]);
    await until(() => ex.jobs.get(other)!.tokensIn != null, "live token counts", { executor: ex });
    delete process.env.FAKE_HANG;
    ex.stop();
    await until(async () => (await readReceipts(a.id, [c.id])).some((r) => r.jobId === other), "the stopped session's receipt", { executor: ex });
    assert.equal(ex.jobs.get(other)!.status, "stopped");
    assert.deepEqual([ex.jobs.get(other)!.tokensIn, ex.jobs.get(other)!.tokensOut], [5_010, 400]);
    const receipt = (await readReceipts(a.id, [c.id])).find((r) => r.jobId === other)! as unknown as { error: string; usage: Record<string, unknown> };
    assert.equal(receipt.error, "Stopped by you.");
    assert.deepEqual([receipt.usage.cacheReadTokens, receipt.usage.cacheWriteTokens, receipt.usage.source], [3000, 2000, "live"]);
    const stopped = (await sessionAttempts(a.id, c, other)).attempts[0];
    assert.deepEqual([stopped.status, stopped.cost, stopped.tokensIn], ["stopped", "unknown (stopped before the end)", 5_010]);
    await ex.start("agent", [other]);
    await until(() => ex.jobs.get(other)!.status === "done", "the rerun to finish", { executor: ex });
    assert.equal(ex.jobs.get(other)!.status, "done");

    // A source file changed after the freeze blocks the configurations that read it.
    const src = ws.study.sources.find((s) => s.kind === "demographics")!;
    ws = await readWorkspace(a.id);
    await writeFile(join(a.dir, ws.manifest.sources![src.id]), (await readFile(join(a.dir, ws.manifest.sources![src.id]), "utf8")) + "\n");
    const third = c.jobs.filter((j) => j.conditionId === "knows-participant")[2].id;
    const blocked = await ex.blockers([third]);
    assert.match(blocked[0]?.message ?? "", new RegExp(`${src.label} \\(data/raw/demographics.csv\\) changed after this campaign was frozen. Freeze a new campaign, or Continue / rerun to use the new version.`));
    await assert.rejects(ex.start("agent", [third]), /changed after this campaign was frozen/);
    closeExecutor(a.id, c.id);

    // An unknown model: named plainly, and no effective model is recorded.
    const typo = pick.map((x) => (x.id === "text-only" ? { ...x, model: { ...x.model, model: "claude-sonet-5-5" } } : x));
    const c2 = campaignFromPlan(freezePlan(ws.study, typo, 1), undefined, "typo", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c2);
    const ex2 = await Executor.open(a.id, c2.id);
    const job = c2.jobs.find((j) => j.conditionId === "text-only")!.id;
    const fine = c2.jobs.find((j) => j.conditionId === "knows-participant")!.id;
    await ex2.start("agent", [job, fine]);
    await until(() => ex2.jobs.get(job)!.status === "failed" && ex2.jobs.get(fine)!.status === "done", "one failed and one finished session", { executor: ex2 });
    assert.equal(ex2.jobs.get(job)!.error, 'Claude Code does not know the model "claude-sonet-5-5". Check the model ID on Agent configurations.');
    assert.equal((await readReceipts(a.id, [c2.id])).find((r) => r.jobId === job)!.actualModel, null);
    // The analysis says why a session failed, not only that it was not returned.
    const { handlePost } = await import("../src/routes.js");
    let analysis: Record<string, any> = {};
    await handlePost("/api/workspace/analyze", { id: a.id, campaignId: c2.id }, (v) => (analysis = v as Record<string, any>));
    const audit = analysis.audits.find((x: { jobId: string }) => x.jobId === job);
    assert.match(audit.issues.join(" "), /Failed \(attempt 1\): Claude Code does not know the model "claude-sonet-5-5"/);
    // The report itself (also the CLI's campaign-analyze) names the failed session and its error.
    assert.ok(
      analysis.exclusions.some((e: string) => e.includes(`session ${job}: no accepted forecast, so it is not scored (failed, attempt 1: Claude Code does not know the model "claude-sonet-5-5"`)),
      JSON.stringify(analysis.exclusions),
    );
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_HANG;
    delete process.env.FAKE_CLOSING;
    delete process.env.FAKE_REAL_ORDER;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("audit: too few actions, actions without a fresh view, and a project never opened are deviations", async () => {
  const { exposureIssues } = await import("../src/core/protocol.js");
  const { protocolForJob } = await import("../src/core/planner.js");
  const { simulatedResults } = await import("../src/core/example.js");
  const study = validateStudy(await readJson(join(gq, "study.json")));
  study.cases.find((c) => c.id === "low-main")!.observeBeforeEachAction = true;
  const agents = validateAgents(study, await readJson(join(gq, "agents.json")));
  const plan = freezePlan(study, agents.filter((x) => x.id === "uses-app").map((x) => ({ ...x, repetitions: 1 })), 1);
  const agent = protocolForJob(plan, plan.jobs[0]);
  type E = Record<string, any>;
  const trace = simulatedResults(plan).runs[0].trace as E[];
  const issues = (t: E[]) => exposureIssues(plan, agent, t as never);
  assert.deepEqual(issues(trace), [], "simulated runs follow the protocol: least actions, views before actions, a project file read");
  assert.ok(trace.filter((e) => e.type === "action").every((e) => e.checked === false), "simulated actions are marked as not checked by a runtime");
  // low-main needs 12 actions (minActions): one fewer is a deviation.
  const lastAnswer = trace.map((e) => e.type === "action" && e.caseId === "low-main" && e.action === "select-target").lastIndexOf(true);
  const fewer = trace.filter((_, i) => i !== lastAnswer);
  assert.ok(issues(fewer).includes("Too few actions in low-main: 11 scored actions, at least 12 required."), issues(fewer).join(" "));
  // Clicking from memory: only the first view of low-main is kept.
  const blind = trace.filter((e, i) => !(e.type === "observation" && e.caseId === "low-main" && trace[i - 1]?.type === "action"));
  assert.ok(issues(blind).includes("11 of 12 scored actions in low-main came without an observation since the previous one (the task requires one before each action)."), issues(blind).join(" "));
  // A runtime that marks its scored actions: only those count (looking around is not an answer).
  const marked = trace.map((e) => (e.type === "action" ? { ...e, scored: e.caseId !== "low-main" || e.action === "look-around" } : e));
  assert.ok(issues(marked).includes("Too few actions in low-main: 1 scored action, at least 12 required."), issues(marked).join(" "));
  // A refused action is no answer, also when a runtime marked it scored (the template once did).
  const answers = trace.filter((e) => e.type === "action" && e.caseId === "low-main" && e.action === "select-target").length;
  const firstAnswer = trace.findIndex((e) => e.type === "action" && e.caseId === "low-main" && e.action === "select-target");
  const refused = trace.map((e, i) => (e.type === "action" ? { ...e, scored: e.action === "select-target", ...(i === firstAnswer ? { completed: false } : {}) } : e));
  assert.ok(issues(refused).includes(`Too few actions in low-main: ${answers - 1} scored actions, at least 12 required.`), issues(refused).join(" "));
  // For an app configuration the project is extra material: not opening a file is information, not a deviation.
  const unread = trace.filter((e) => !(e.type === "source" && e.delivery === "read"));
  assert.ok(!issues(unread).some((i) => /Did not open any project file/.test(i)), issues(unread).join(" "));
  // A configuration whose ingredient is reading the project must open one of its files, not only get the list injected.
  const reader = freezePlan(study, agents.filter((x) => x.id === "reads-project").map((x) => ({ ...x, repetitions: 1 })), 1);
  const readerAgent = protocolForJob(reader, reader.jobs[0]);
  const readerTrace = simulatedResults(reader).runs[0].trace as E[];
  assert.deepEqual(exposureIssues(reader, readerAgent, readerTrace as never), []);
  assert.ok(
    exposureIssues(reader, readerAgent, readerTrace.filter((e) => !(e.type === "source" && e.delivery === "read")) as never).includes("Did not open any project file (no read_file call), although this configuration reads the project."),
  );
});

test("folder fingerprints: paths become / before sorting (same on Windows and POSIX); OS clutter is left out", async () => {
  const { portableOrder, sourceHash } = await import("../src/workspace.js");
  const { ignoredName } = await import("../src/runtimes/guard.js");
  const { win32 } = await import("node:path");
  const { createHash } = await import("node:crypto");
  // With "\" (0x5C > "0") Windows would sort p10\a.csv before p1\a.csv; mapped first, both systems agree.
  assert.deepEqual(portableOrder(["p10\\a.csv", "p1\\b.csv", "p1\\a.csv"], win32.sep), ["p1/a.csv", "p1/b.csv", "p10/a.csv"]);
  assert.deepEqual(portableOrder(["p10/a.csv", "p1/b.csv", "p1/a.csv"], "/"), ["p1/a.csv", "p1/b.csv", "p10/a.csv"]);
  assert.deepEqual(["desktop.ini", "THUMBS.DB", "~$notes.docx", ".DS_Store", ".git", "a.csv", "data~$.csv"].map(ignoredName), [true, true, true, true, true, false, false]);
  const dir = await mkdtemp(join(tmpdir(), "xr-hash-"));
  try {
    await mkdir(join(dir, "p1"));
    await mkdir(join(dir, "p10"));
    await writeFile(join(dir, "p1", "a.csv"), "1");
    await writeFile(join(dir, "p10", "a.csv"), "10");
    const h = (x: string) => createHash("sha256").update(x).digest("hex");
    const expected = createHash("sha256").update("p1/a.csv").update("\0").update(h("1")).update("\n").update("p10/a.csv").update("\0").update(h("10")).update("\n").digest("hex");
    assert.equal(sourceHash(dir), expected, "relative path with /, content hash, in byte order");
    for (const junk of ["desktop.ini", "Thumbs.db", ".DS_Store", "~$notes.docx", join("p1", "._a.csv")]) await writeFile(join(dir, junk), "x");
    assert.equal(sourceHash(dir), expected, "OS clutter does not change the fingerprint");
    await writeFile(join(dir, "p1", "b.csv"), "2");
    assert.notEqual(sourceHash(dir), expected);
    // Agents see the same files: the shared listing and reading leave the clutter out.
    const { agentFileList, agentPath } = await import("../src/runtimes/guard.js");
    assert.deepEqual((await agentFileList(dir)).sort(), ["p1/a.csv", "p1/b.csv", "p10/a.csv"]);
    assert.deepEqual(["Thumbs.db", "desktop.ini", "~$notes.docx", join("p1", "._a.csv")].map((f) => agentPath(dir, join(dir, f))), [null, null, null, null]);
    assert.ok(agentPath(dir, join(dir, "p1", "a.csv")));
  } finally {
    await removeDir(dir);
  }
});

test("executor: a WebXR app changed after freezing blocks app sessions; the app's capabilities come from workspace.json", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, saveSourceFingerprints } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-settings-"));
  // Any existing file stands in for Chrome: blockers() only checks that it is there.
  await writeFile(join(bin, "settings.json"), JSON.stringify({ chromePath: process.execPath }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    const ws = await readWorkspace(a.id);
    const pick = ws.agents!.filter((x) => ["uses-app", "text-only"].includes(x.id)).map((x) => ({ ...x, repetitions: 1 }));
    const c = campaignFromPlan(freezePlan(ws.study, pick, 1), undefined, "app-freeze", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    await saveSourceFingerprints(a.id, c);
    const jobs = ["uses-app", "text-only"].map((id) => c.jobs.find((j) => j.conditionId === id)!.id);
    const usesApp = pick.find((x) => x.id === "uses-app")!.label;
    // Reopened each time: the executor reads workspace.json when it opens.
    const blocked = async () => {
      closeExecutor(a.id, c.id);
      return (await (await Executor.open(a.id, c.id)).blockers(jobs)).map((b) => (assert.deepEqual(b.configs, [usesApp]), b.message));
    };
    assert.deepEqual(await blocked(), []);
    const main = join(a.dir, "webxr-app", "main.js");
    const original = await readFile(main, "utf8");
    // Files the app never serves do not count: OS clutter in the app folder.
    await writeFile(join(a.dir, "webxr-app", "Thumbs.db"), "x");
    await writeFile(join(a.dir, "webxr-app", ".DS_Store"), "x");
    assert.deepEqual(await blocked(), []);
    const frozenAs = "changed after this campaign was frozen. Freeze a new campaign, or Continue / rerun to use the new version.";
    await writeFile(main, original + "\n// changed\n");
    assert.deepEqual(await blocked(), [`The WebXR app (webxr-app) ${frozenAs}`]);
    // A continuation runs the app configurations again (their runs played the old app), not the others.
    const { handlePost } = await import("../src/routes.js");
    let preview: Record<string, any> = {};
    await handlePost("/api/workspace/continue", { id: a.id, campaignId: c.id, changes: { note: "new app" }, preview: true, full: true }, (v) => (preview = v as Record<string, any>));
    assert.deepEqual(preview.sourceChanges, [`The WebXR app changed since this campaign was frozen: ${usesApp} runs again (its finished runs played the old version).`]);
    assert.deepEqual(preview.campaign.continuation.rerunConditions, ["uses-app"]);
    await writeFile(main, original);
    assert.deepEqual(await blocked(), []);
    // The query and what workspace.json declares about the app are frozen too.
    const wsFile = join(a.dir, "workspace.json");
    const manifest = JSON.parse(await readFile(wsFile, "utf8"));
    await writeFile(wsFile, JSON.stringify({ ...manifest, app: { ...manifest.app, query: "?quality={condition}" } }));
    assert.deepEqual(await blocked(), [`The WebXR app's query (?quality={condition}&study=1&participant={participant}, now ?quality={condition}) ${frozenAs}`]);
    // Without quality-lock the app no longer provides what the study requires.
    await writeFile(wsFile, JSON.stringify({ ...manifest, app: { ...manifest.app, capabilities: ["look", "pointer-select", "phase-events"] } }));
    const messages = await blocked();
    assert.ok(messages.includes(`The WebXR app's capabilities, actions or instructions (workspace.json → app) ${frozenAs}`), messages.join("\n"));
    assert.ok(messages.some((m) => /^The WebXR app does not declare the capabilities this study requires: quality-lock\. Declare them in workspace\.json → app\.capabilities/.test(m)), messages.join("\n"));
    closeExecutor(a.id, c.id);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("executor: the prompt goes on stdin and the system prompt in a file; an older Claude Code runs without partial messages, said once", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, saveSourceFingerprints, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await fakeClaude(bin);
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  // The help of an older Claude Code: print mode and a system prompt file, no partial messages.
  process.env.FAKE_HELP = "Usage: claude [options] [command] [prompt]\n  -p, --print  Print response and exit\n  --output-format <format>  text, json or stream-json\n  --system-prompt-file <file>  System prompt from a file\n";
  try {
    // A brief of about 60,000 characters (with non-ASCII text): more than a Windows command line holds (32,767).
    await writeFile(join(a.dir, "agent-brief.md"), "# Study brief\n" + "Participants rated each design – Präsenz, réalisme. ".repeat(1200));
    const ws = await readWorkspace(a.id);
    const pick = ws.agents!.filter((x) => x.id === "text-only").map((x) => ({ ...x, repetitions: 2 }));
    const c = campaignFromPlan(freezePlan(ws.study, pick, 1), undefined, "stdin-prompt", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    await saveSourceFingerprints(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const logs: string[] = [];
    ex.listeners.add((e) => void (e.type === "log" && e.text && logs.push(e.text)));
    await ex.start("agent");
    await until(() => [...ex.jobs.values()].every((j) => j.status === "done" || j.status === "failed"), "both sessions to end", { executor: ex });
    assert.equal(c.jobs.length, 2);
    for (const j of c.jobs) {
      assert.equal(ex.jobs.get(j.id)!.status, "done", ex.jobs.get(j.id)!.error ?? "");
      const dir = join(runDir(a.id, c.id), "jobs", j.id, "a1");
      const seen = await readJson<{ args: string[]; stdin: string; job: string | null; systemFile: string | null }>(join(dir, "session", "seen.json"));
      assert.ok(seen.stdin.length > 60_000, `prompt on stdin: ${seen.stdin.length} characters`);
      assert.ok((await readFile(join(dir, "prompt.md"), "utf8")).endsWith(`## Prompt\n${seen.stdin}\n`), "the prompt as written to prompt.md, characters intact");
      assert.ok(Math.max(...seen.args.map((x) => x.length)) < 1000, "nothing long on the command line");
      assert.ok(!seen.args.includes("--include-partial-messages") && !seen.args.includes("--system-prompt"), seen.args.join(" "));
      assert.match(seen.systemFile ?? "", /^You are an AI agent forecasting the results of a completed XR user study/);
      assert.equal(seen.job, j.id, "every process of the session carries XR_STUDY_JOB");
      // Usage still counts, from each message as it ends.
      assert.equal(ex.jobs.get(j.id)!.tokensOut, 600);
    }
    assert.equal(logs.filter((l) => /older version without --include-partial-messages/.test(l)).length, 1, "said once");
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_HELP;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("executor: a study bridge that cannot start, or ends before the forecast and is not started again, stops its session with its own words; a Claude Code that cannot start fails plainly", async () => {
  const { Executor, closeExecutor, timing } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-bridge-"));
  // Like the Windows Store stub that stands in for a missing Python: it ends before it ever answers.
  await writeFile(join(bin, "bridge.cjs"), `process.stderr.write("Python was not found; run without arguments to install from the Microsoft Store\\n"); process.exit(3);`);
  // A bridge that answers initialize and tools/list, then loses its engine and ends.
  await writeFile(
    join(bin, "late.cjs"),
    `require("readline").createInterface({ input: process.stdin }).on("line", (l) => { const m = JSON.parse(l);
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: m.method === "tools/list" ? { tools: [] } : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "late", version: "1" } } }) + "\\n");
  if (m.method === "tools/list") setTimeout(() => { process.stderr.write("Lost the connection to the engine\\n"); process.exit(4); }, 200); });`,
  );
  // A session that starts its MCP servers, asks the runtime for its tools, then waits (it would
  // spend tokens without the app).
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2); if (args[0] === "--help") process.exit(1);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
for (const [name, s] of Object.entries(cfg.mcpServers)) {
  const p = spawn(s.command, s.args, { env: { ...process.env, ...(s.env || {}) }, stdio: ["pipe", "pipe", "pipe"] });
  p.stdin.on("error", () => undefined);
  if (name !== "study") for (const [id, method] of [[1, "initialize"], [2, "tools/list"]]) p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: {} }) + "\\n");
}
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "s", model: "m", claude_code_version: "fake", mcp_servers: [] }));
setTimeout(() => process.exit(0), 60000);`,
  );
  let bridgeFile = "bridge.cjs";
  const runtimes = () => ({ unreal: { command: process.execPath, args: [join(bin, bridgeFile), "{jobFile}"], capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"] } });
  // Each change of settings is a new file: an executor that just ended may still be reading the last one.
  let n = 0;
  const settings = async (extra: Record<string, unknown>) => {
    const file = join(bin, `settings-${++n}.json`);
    await writeFile(file, JSON.stringify({ claudePath: join(bin, "claude.cjs"), runtimes: runtimes(), ...extra }));
    process.env.XR_STUDY_SETTINGS = file;
  };
  await settings({});
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!.filter((x) => x.id === "uses-app").map((x) => ({ ...x, repetitions: 1, runtime: "unreal" }));
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "bridge-fails", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const job = c.jobs[0].id;
    const started = Date.now();
    await ex.start("agent", [job]);
    await until(() => ["done", "failed"].includes(ex.jobs.get(job)!.status), "the session to end", { executor: ex });
    assert.ok(Date.now() - started < 30_000, "stopped when the bridge ended, not at the session's end");
    assert.match(
      ex.jobs.get(job)!.error ?? "",
      /^The Unreal bridge could not start \(exit code 3\): .*bridge\.cjs .*job\.json\. It said: Python was not found; run without arguments to install from the Microsoft Store\. The session was stopped; check Settings → Runtimes → unreal\.$/,
    );
    await until(() => ex.running.size === 0, "the executor to be idle", { executor: ex });
    closeExecutor(a.id, c.id);

    // A bridge that answered and then ended: Claude Code may start it again (a restart, flagged on
    // the row), so the session stops only when no new start follows within the grace.
    const grace = timing.bridgeRestartGraceMs;
    timing.bridgeRestartGraceMs = 300;
    try {
      bridgeFile = "late.cjs";
      await settings({});
      const exLate = await Executor.open(a.id, c.id);
      await exLate.start("agent", [job]);
      await until(() => ["done", "failed"].includes(exLate.jobs.get(job)!.status), "the session to end", { executor: exLate });
      assert.match(
        exLate.jobs.get(job)!.error ?? "",
        /^The Unreal bridge ended before the forecast \(exit code 4\): .*late\.cjs .*job\.json\. It said: Lost the connection to the engine\. The session was stopped; check Settings → Runtimes → unreal\.$/,
      );
      await until(() => exLate.running.size === 0, "the executor to be idle", { executor: exLate });
      closeExecutor(a.id, c.id);
    } finally {
      timing.bridgeRestartGraceMs = grace;
      bridgeFile = "bridge.cjs";
    }

    // A .cmd file as Claude Code is refused before anything starts; a missing program fails its session only.
    await settings({ claudePath: "C:\\Tools\\npm\\claude.cmd" });
    const ex2 = await Executor.open(a.id, c.id);
    assert.match((await ex2.blockers([job]))[0]?.message ?? "", /a \.cmd\/\.bat script that agent sessions cannot start/);
    closeExecutor(a.id, c.id);
    await settings({ claudePath: "xr-no-such-claude-program" });
    const ex3 = await Executor.open(a.id, c.id);
    await ex3.start("agent", [job]);
    await until(() => ex3.jobs.get(job)!.status === "failed", "the session to fail", { executor: ex3 });
    assert.match(ex3.jobs.get(job)!.error ?? "", /^Claude Code could not be started \(xr-no-such-claude-program: .*ENOENT.*\)\. Install Claude Code/);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("processes: a session's whole process tree ends; the help text tells the flags; old WebXR profiles go", async () => {
  const { spawnTree, killTree, removeStaleProfiles, featuresFromHelp } = await import("../src/executor/processes.js");
  const { claudeProblem } = await import("../src/settings.js");
  // A session that started a server which ignores SIGTERM (it ends only by force).
  const grandchild = `process.on("SIGTERM", () => undefined); setInterval(() => undefined, 1000);`;
  const parent = spawnTree(process.execPath, ["-e", `const c = require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" }); console.log(c.pid); setInterval(() => undefined, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
  const pid = Number(await new Promise<string>((ok) => parent.stdout!.once("data", (d) => ok(String(d)))));
  const alive = (p: number) => {
    try {
      process.kill(p, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.ok(pid > 0 && alive(pid));
  killTree(parent, 300);
  await until(() => !alive(pid), "the server the session started to end", { limitMs: 30_000 });

  const current = "  --include-partial-messages  Include partial message chunks\n  --output-format <format>\n  --bare  provide context via: --system-prompt[-file], --append-system-prompt[-file]\n";
  assert.deepEqual(featuresFromHelp(current), { known: true, partialMessages: true, systemPromptFile: true });
  assert.deepEqual(featuresFromHelp("  --output-format <format>\n  --system-prompt <prompt>\n"), { known: true, partialMessages: false, systemPromptFile: false });
  assert.equal(featuresFromHelp("node: bad option: --help"), null);
  assert.match(claudeProblem({ claudePath: "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.CMD" }) ?? "", /\.cmd\/\.bat script/);
  assert.match(claudeProblem({ claudePath: join(tmpdir(), "no-such-folder", "claude") }) ?? "", /was not found at/);
  assert.equal(claudeProblem({ claudePath: process.execPath }), null);
  assert.equal(claudeProblem({}), null);

  const { utimes } = await import("node:fs/promises");
  const old = await mkdtemp(join(tmpdir(), "xr-webxr-unit-old-"));
  const fresh = await mkdtemp(join(tmpdir(), "xr-webxr-unit-fresh-"));
  try {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    assert.ok((await removeStaleProfiles()) >= 1);
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(fresh), true, "a running session's profile stays");
  } finally {
    await removeDir(old);
    await removeDir(fresh);
  }
});

test("assistant: a long document goes to Claude Code on stdin, not on the command line", async () => {
  const { understandStudy } = await import("../src/assistant.js");
  const { extractProposal } = await import("../src/core/proposal.js");
  const bin = await mkdtemp(join(tmpdir(), "fake-assistant-"));
  const seenFile = join(bin, "seen.json");
  await writeFile(
    join(bin, "claude.cjs"),
    `const fs = require("fs"); let stdin = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ args: process.argv.slice(2), stdin }));
  console.log(JSON.stringify({ result: "{}" }));
});`,
  );
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    // About 100,000 characters: a 30-page manuscript.
    const doc = await extractProposal("long.md", Buffer.from("Material cues in VR\n" + "Participants compared matte and glossy materials – très réaliste. ".repeat(1500) + "\nThe end of the document.\n"));
    await understandStudy(doc, null, null).catch(() => undefined); // the empty draft does not matter here
    const seen = await readJson<{ args: string[]; stdin: string }>(seenFile);
    assert.ok(seen.stdin.length > 90_000, `prompt on stdin: ${seen.stdin.length} characters`);
    assert.ok(seen.stdin.includes("très réaliste") && seen.stdin.includes("The end of the document."));
    assert.ok(Math.max(...seen.args.map((x) => x.length)) < 2000, "only options on the command line");
    assert.equal(seen.args[seen.args.indexOf("-p") + 1], "--output-format");
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(bin);
  }
});
