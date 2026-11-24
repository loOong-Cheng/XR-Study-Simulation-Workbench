// Prompts and fairness (docs/methodology.md): configurations that are compared differ only in the
// intended ingredient, nothing hints at the human results or at the purpose of a run, sessions are
// counterbalanced like the humans, and the researcher is warned where a comparison mixes ingredients.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, jobPacket, proposeAgents, withDefaultRuns } from "../src/core/planner.js";
import { validateAgents, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan, campaignPlan } from "../src/core/campaign.js";
import { designOrder, fairnessWarnings, modelConfoundWarnings, predictionSentences, researchQuestionWarning, standInWarnings, NEUTRAL_TITLE } from "../src/core/fairness.js";
import type { AgentProtocol, Comparison, RunResult, Study } from "../src/core/types.js";

const readJson = async <T>(p: string) => JSON.parse(await readFile(p, "utf8")) as T;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
const gq = resolve("examples/graphics-quality");
const examples = ["graphics-quality", "ecolar", "selection"].map((x) => resolve("examples", x));
/** The research question the graphics-quality example had before agent questions had their own field. */
const OLD_GQ_RQ =
  "RQ1: How does the graphics quality of a virtual environment (low, medium, high) affect presence, perceived realism, visual appeal, visual discomfort, preference and a material-search task? RQ2: Which agent methods (text only, reading the project files, using the app, adding an evidence document, knowing the participants) reproduce these human differences?";

async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = existsSync(join(from, "workspace.json")) ? JSON.parse(await readFile(join(from, "workspace.json"), "utf8")) : {};
  for (const rel of [...Object.values<string>(manifest.sources ?? {}), ...(manifest.app?.serve ? [manifest.app.serve] : [])])
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}
/** A stand-in for `claude -p`: starts the study MCP server and submits a complete forecast at once. */
async function fakeClaude(bin: string) {
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2); const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const out = (m) => console.log(JSON.stringify(m));
const s = cfg.mcpServers.study; const p = spawn(s.command, s.args); let buf = ""; const wait = {}; let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id] && wait[m.id](m); } });
const call = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); });
(async () => {
  out({ type: "system", subtype: "init", session_id: "fake", model: args[args.indexOf("--model") + 1], claude_code_version: "fake", mcp_servers: [{ name: "study", status: "connected" }] });
  await call("initialize", {});
  const job = JSON.parse(fs.readFileSync(s.args[1] + "/job.json", "utf8"));
  const predictions = [];
  for (const d of job.designs) for (const t of job.targets) {
    const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
    predictions.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value });
  }
  out({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: "tool_use", id: "t1", name: "mcp__study__submit_forecast", input: {} }] } });
  const r = await call("tools/call", { name: "submit_forecast", arguments: { predictions, uncertainty: "test" } });
  out({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 10, output_tokens: 20 }, total_cost_usd: 0.01, num_turns: 1 });
  p.stdin.end(); process.exit(0);
})();`,
  );
  // The WebXR runtime counts as available when the Chrome path exists; these sessions never open it.
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs"), chromePath: process.execPath }));
}
/** prompt.md split into its system prompt and prompt. */
function parts(md: string) {
  const [, system, prompt] = /^## System\n([\s\S]*?)\n\n## Prompt\n([\s\S]*)$/.exec(md)!;
  return { system, prompt };
}
/** Lines of `a` that `b` lacks (as a multiset). */
function extraLines(a: string, b: string) {
  const left = b.split("\n");
  return a.split("\n").filter((l) => {
    const i = left.indexOf(l);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
}

test("prompts: paired configurations differ only in the intended ingredient; no agent questions, study title or fixed order", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, saveSourceFingerprints, runDir } = await import("../src/workspace.js");
  const { READ_FILES_LINE } = await import("../src/executor/prompt.js");
  const a = await tempWorkspace(gq);
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  await fakeClaude(bin);
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    const ws = await readWorkspace(a.id);
    // The research question as it was (with the agent RQ) is kept here only to prove agentQuestions never reach agents.
    const study: Study = { ...ws.study, agentQuestions: "SECRET-AGENT-QUESTION: which configuration wins?" };
    await writeFile(join(a.dir, "study.json"), JSON.stringify(study, null, 2));
    const templates = await proposeAgents(study);
    const model = ws.agents![0].model;
    const pick = (id: string) => ({ ...templates.find((t) => t.id === id)!, model, repetitions: 2 });
    const chosen = [pick("text-only"), pick("reads-project"), pick("app-only"), pick("uses-app"), { ...ws.agents!.find((x) => x.id === "knows-participant")!, repetitions: 1 }];
    const c = campaignFromPlan(freezePlan(study, chosen, 1), undefined, "fair-prompts", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    await saveSourceFingerprints(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const job = (cond: string, rep: number, person?: string) => c.jobs.find((j) => j.conditionId === cond && j.repetition === rep && (!person || j.participantId === person))!.id;
    const ids = [job("text-only", 1), job("reads-project", 1), job("app-only", 1), job("uses-app", 1), job("text-only", 2), job("knows-participant", 1, "p02")];
    await ex.start("agent", ids);
    for (let i = 0; i < 200 && ids.some((id) => !["done", "failed"].includes(ex.jobs.get(id)!.status)); i++) await wait(100);
    for (const id of ids) assert.equal(ex.jobs.get(id)!.status, "done", `${id}: ${ex.jobs.get(id)!.error}`);
    const folder = (id: string) => join(runDir(a.id, c.id), "jobs", id, "a1");
    const md = async (id: string) => readFile(join(folder(id), "prompt.md"), "utf8");
    const [text, files, app, both, text2, person] = await Promise.all(ids.map(md));

    // Never the agent questions, the study's own title or its purpose; a neutral title instead.
    for (const p of [text, files, app, both, text2, person]) {
      assert.doesNotMatch(p, /SECRET-AGENT-QUESTION|RQ2|agent methods|reproduce/);
      assert.ok(!p.includes(study.title), "the study's own title never reaches agents");
      assert.match(p, new RegExp(`"study": "${NEUTRAL_TITLE}"`));
    }
    // Text only → reads the project: the same system prompt; the prompt adds only the project section.
    const T = parts(text), F = parts(files), A = parts(app), B = parts(both);
    assert.equal(F.system, T.system);
    assert.deepEqual(extraLines(T.prompt, F.prompt), [], "reading the files removes nothing");
    const added = extraLines(F.prompt, T.prompt);
    assert.equal(added[0], "# Project files you can open with read_file");
    assert.equal(added[1], READ_FILES_LINE);
    assert.ok(added.slice(2).every((l) => l === "" || !/[{}"]/.test(l)), `only file names follow: ${added.join(" | ")}`);
    // Text only → uses the app only: the same prompt; the system adds only how to play the app.
    assert.equal(A.prompt, T.prompt);
    assert.deepEqual(extraLines(T.system, A.system), []);
    assert.match(extraLines(A.system, T.system).join("\n"), /^Experience the app like a participant/);
    // Reads the project → uses the app: the same prompt; the system adds the same play instructions.
    assert.equal(B.prompt, F.prompt);
    assert.equal(extraLines(B.system, F.system).join("\n"), extraLines(A.system, T.system).join("\n"));
    // Uses the app only → uses the app: the same system prompt; the prompt adds the project section (with the same line).
    assert.equal(B.system, A.system);
    assert.deepEqual(extraLines(B.prompt, A.prompt), added);
    // The same line for every configuration that can read files.
    for (const p of [files, both]) assert.equal(p.split(READ_FILES_LINE).length, 2);
    for (const p of [text, app, person]) assert.ok(!p.includes(READ_FILES_LINE));

    // Design order: repetition 1 gets p01's order, repetition 2 p02's, the same for every configuration;
    // it is recorded in job.json and the result, listed in the task and in submit_forecast, and played in.
    const p01 = study.participants[0].conditionOrder, p02 = study.participants[1].conditionOrder;
    assert.notDeepEqual(p01, p02);
    const jobFile = async (id: string) => readJson<{ designOrder: string[]; designs: { id: string }[]; app?: { designs: { id: string }[] } }>(join(folder(id), "job.json"));
    for (const id of [job("text-only", 1), job("reads-project", 1), job("app-only", 1), job("uses-app", 1)]) {
      const j = await jobFile(id);
      assert.deepEqual(j.designOrder, p01, id);
      assert.deepEqual(j.designs.map((d) => d.id), p01);
    }
    assert.deepEqual((await jobFile(job("uses-app", 1))).app!.designs.map((d) => d.id), p01);
    assert.match(B.system, new RegExp(`Visit the designs in this order: ${p01.join(", ")}\\.`));
    const second = await jobFile(job("text-only", 2));
    assert.deepEqual(second.designOrder, p02);
    const listed = (p: string) => [...p.matchAll(/"id": "(low|medium|high)"/g)].map((m) => m[1]);
    assert.deepEqual(listed(parts(text2).prompt), p02, "the task lists the designs in the session's order");
    const result = await readJson<RunResult>(join(folder(job("text-only", 2)), "result.json"));
    assert.deepEqual(result.execution.designOrder, p02);
    // An individual session: that person's own order, and a header that says it is one person.
    const person2 = study.participants.find((p) => p.id === "p02")!;
    assert.deepEqual((await jobFile(job("knows-participant", 1, "p02"))).designOrder, person2.conditionOrder);
    const P = parts(person);
    assert.match(P.prompt.split("\n")[0], /^You forecast one person: participant p02\. The study brief describes the whole study and all its participants; predict only this person's results in each design\. Give this person's expected value for every rating, time and count \(decimals allowed\)\. For a ranking, give this person's expected rank of each design \(1 = best … 3; decimals allowed as expected ranks\)\.$/);
    assert.match(P.prompt, /Predict for participant p02 only\.$/m);
    assert.match(T.prompt.split("\n")[0], /^You forecast the mean of all participants in each design\./);
    assert.match(T.prompt, /^Predict the mean of all participants\.$/m);
    // No measured inputs: the system says no answers were seen, without the exception.
    assert.match(T.system, /You have not seen any participant's answers and must not try to obtain them\./);
    // Items: how they are scored, in the answer list.
    assert.match(T.prompt, /only the mean of the items is scored; give your best estimate for each item \(they may differ\)/);
    closeExecutor(a.id, c.id);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("prompts: measured inputs change the system line; the job packet names the study neutrally", async () => {
  const { buildPrompt } = await import("../src/executor/prompt.js");
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const agents = validateAgents(study, await readJson<AgentProtocol[]>(join(gq, "agents.json")));
  const withInputs = agents.find((a) => a.id === "text-with-task-data")!;
  const designs = study.conditions.map((c) => ({ id: c.id, label: c.label }));
  const base = { study, job: {}, designs, orderContext: null, play: null, sections: [] };
  const given = buildPrompt({ ...base, agent: withInputs, inputs: "Search time (seconds per main trial), Low: 20.000" });
  assert.match(given.system, /You have not seen any participant's answers, apart from the measured data given below, and must not try to obtain them\./);
  assert.match(given.prompt, /# Measured data you may use as predictors\nSearch time/);
  const none = buildPrompt({ ...base, agent: agents.find((a) => a.id === "text-only")!, inputs: null });
  assert.doesNotMatch(none.system, /apart from/);
  // The packet an external worker hands a forecaster: a neutral title, the human question only.
  const plan = freezePlan({ ...study, agentQuestions: "Which configuration wins?", agentTitle: "Graphics in a small room" }, agents, 1);
  const packet = jobPacket(plan, plan.jobs[0]) as { task: Record<string, unknown> };
  assert.equal(packet.task.title, "Graphics in a small room");
  assert.ok(!JSON.stringify(packet).includes("Which configuration wins?"));
});

test("design order: the humans' orders in rotation for population sessions, the person's own for individual ones", () => {
  const study = { conditions: ["a", "b", "c"].map((id) => ({ id, label: id })), participants: [
    { id: "p1", stratum: "1", conditionOrder: ["a", "b", "c"] },
    { id: "p2", stratum: "2", conditionOrder: ["c", "a", "b"] },
    { id: "p3", stratum: "3", conditionOrder: ["b", "c", "a"] },
  ] };
  assert.deepEqual([1, 2, 3, 4, 5].map((r) => designOrder(study, { repetition: r }).join("")), ["abc", "cab", "bca", "abc", "cab"]);
  assert.deepEqual(designOrder(study, { repetition: 1, participantId: "p3" }), ["b", "c", "a"]);
  // Between subjects each person saw one design: it comes first, the others follow cyclically.
  const between = { ...study, participants: [{ id: "q1", stratum: "a", conditionOrder: ["b"] }, { id: "q2", stratum: "b", conditionOrder: ["c"] }] };
  assert.deepEqual([1, 2].map((r) => designOrder(between, { repetition: r }).join("")), ["bca", "cab"]);
});

test("audit: visits are checked against the order a session was given; runs without one keep the protocol's order", async () => {
  const { simulatedResults } = await import("../src/core/example.js");
  const { auditRun } = await import("../src/core/protocol.js");
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const agents = validateAgents(study, await readJson<AgentProtocol[]>(join(gq, "agents.json"))).filter((a) => a.id === "uses-app").map((a) => ({ ...a, repetitions: 1 }));
  const plan = freezePlan(study, agents, 1);
  const run = simulatedResults(plan, 7).runs[0];
  const order = (issues: string[]) => issues.some((i) => /outside their assigned order/.test(i));
  assert.equal(order(auditRun(plan, plan.jobs[0], run).issues), false, "no recorded order: the protocol's order (study order) applies");
  const visited = study.conditions.map((c) => c.id);
  assert.equal(order(auditRun(plan, plan.jobs[0], { ...run, execution: { ...run.execution, designOrder: visited } }).issues), false);
  assert.equal(order(auditRun(plan, plan.jobs[0], { ...run, execution: { ...run.execution, designOrder: [...visited].reverse() } }).issues), true, "visits in another order than assigned are a deviation");
});

test("warnings: research question about agents, recordings that stand in for a measure, models of compared configurations", async () => {
  // The examples ask only about the humans now, and their configurations compare fairly.
  for (const dir of examples) {
    const study = validateStudy(await readJson(join(dir, "study.json")));
    const agents = validateAgents(study, await readJson<AgentProtocol[]>(join(dir, "agents.json")));
    const comparisons = await readJson<Comparison[]>(join(dir, "comparisons.json"));
    assert.deepEqual(fairnessWarnings(study, agents, comparisons), [], dir);
    assert.ok(study.agentQuestions && study.agentQuestions.length > 10);
  }
  const study = validateStudy(await readJson(join(gq, "study.json")));
  assert.match(researchQuestionWarning({ researchQuestion: OLD_GQ_RQ }) ?? "", /mentions "agent methods", "text only", "project files", "using the app", "reproduce"\./);
  assert.equal(researchQuestionWarning({ researchQuestion: "Does graphics quality change presence and search time?" }), null);

  // Movement with durations of the main phase, given to a configuration that predicts search time.
  const moving: Study = validateStudy({
    ...study,
    sources: [...study.sources, { id: "moves", label: "Movement", kind: "trajectory", description: "per person", fields: ["phase", "duration_s", "head_path_m"] }],
  });
  const agents = validateAgents(moving, await readJson<AgentProtocol[]>(join(gq, "agents.json")));
  const mover = { ...agents.find((a) => a.id === "knows-participant")!, id: "mover", label: "Mover", sourceIds: ["brief", "demographics", "moves"] };
  const warned = standInWarnings(moving, [...agents, mover]);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /^Movement gives duration_s for the Scored search trials phase, where Search time \(seconds per main trial\) is measured, and Mover predicts it: the recorded durations can stand in for the measured outcome\./);
  // Practice only, or search time as an input: nothing stands in.
  const practice = validateStudy({ ...moving, sources: moving.sources.map((s) => (s.id === "moves" ? { ...s, phases: ["practice"] } : s)) });
  assert.deepEqual(standInWarnings(practice, [mover]), []);
  const asInput = validateStudy({ ...moving, predictionTiming: "after-experience" });
  assert.deepEqual(standInWarnings(asInput, [{ ...mover, inputs: ["search-time"] }]), []);
  assert.throws(() => validateStudy({ ...moving, sources: moving.sources.map((s) => (s.id === "moves" ? { ...s, phases: ["warmup"] } : s)) }), /phases of moves must list known phases/);
  assert.throws(() => validateStudy({ ...moving, sources: moving.sources.map((s) => (s.id === "brief" ? { ...s, phases: ["main"] } : s)) }), /Only movement recordings/);

  // Models: compared configurations that differ in what they get and in model or effort.
  const gqAgents = validateAgents(study, await readJson<AgentProtocol[]>(join(gq, "agents.json")));
  const sonnet = { provider: "claude-code", model: "claude-sonnet-5-5", reasoning: "default" };
  const mixed = gqAgents.map((a) => (a.id === "uses-app" ? { ...a, model: sonnet } : a));
  const saved: Comparison[] = [{ candidate: "uses-app", baseline: "text-only", domain: "subjective" }];
  const [one] = modelConfoundWarnings(study, mixed, saved);
  assert.match(one, /^Uses the app and Text only are compared, but they differ in what they get and also in model \(claude-sonnet-5-5 vs claude-opus-5-5\)/);
  // A model arm (same configuration, other model) compares models: no warning.
  const arm = { ...gqAgents.find((a) => a.id === "text-only")!, id: "text-only-sonnet", label: "Text only (sonnet)", model: sonnet };
  assert.deepEqual(modelConfoundWarnings(study, [...gqAgents, arm], [{ candidate: "text-only-sonnet", baseline: "text-only", domain: "objective" }]), []);
  // Without saved comparisons, everything is listed side by side.
  assert.match(modelConfoundWarnings(study, mixed, [])[0], /^Configurations that are compared side by side use different models or effort \(.*Uses the app: claude-sonnet-5-5\)/);
  assert.match(fairnessWarnings({ ...study, researchQuestion: OLD_GQ_RQ }, mixed, saved).join("\n"), /research question mentions[\s\S]*mixes the method with the model/);
});

test("movement limited to phases: only those rows reach the agent; a table without a phase column is incomplete", async () => {
  const { trajectoryText, participantProblemsText } = await import("../src/participant-knowledge.js");
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const dir = await mkdtemp(join(tmpdir(), "moves-"));
  try {
    const rows = study.participants.flatMap((p) => [`${p.id},practice,40.0,10.1`, `${p.id},main,48.0,20.2`]);
    await writeFile(join(dir, "moves.csv"), ["participant,phase,duration_s,head_path_m", ...rows].join("\n"));
    assert.equal(trajectoryText(join(dir, "moves.csv"), "p01", ["phase", "duration_s"], ["practice"]), "participant,phase,duration_s\np01,practice,40.0");
    assert.match(trajectoryText(join(dir, "moves.csv"), "p01", ["phase", "duration_s"]), /p01,main,48\.0/);
    assert.deepEqual(participantProblemsText(study, "trajectory", ["participant,phase,duration_s", ...rows].join("\n"), ["duration_s"], ["practice"]), []);
    assert.match(participantProblemsText(study, "trajectory", "participant,duration_s\n" + study.participants.map((p) => `${p.id},4`).join("\n"), ["duration_s"], ["practice"]).join(";"), /has no phase column, so its rows cannot be limited to the phase practice/);
  } finally {
    await removeDir(dir);
  }
});

test("knowledge that states predictions per measure is flagged; descriptions of scales are not", async () => {
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const text = [
    "Each level is shown once. Higher numbers mean more discomfort.",
    "We expect shorter times in high, around a 25 % reduction.",
    "Wrong selections should increase at low quality.",
    "Presence is asked with four items.",
  ].join("\n");
  assert.deepEqual(predictionSentences(study, text), ["We expect shorter times in high, around a 25 % reduction.", "Wrong selections should increase at low quality."]);
});

test("templates: app-only adds only the app to text only; each rationale names the one ingredient it adds", async () => {
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const t = await proposeAgents(study);
  const by = (id: string) => t.find((a) => a.id === id)!;
  assert.deepEqual(t.map((a) => a.id), ["text-only", "reads-project", "app-only", "uses-app", "reads-evidence", "uses-app-people"]);
  assert.deepEqual(by("app-only").sourceIds, by("text-only").sourceIds);
  assert.deepEqual(by("app-only").tools, ["xr-interact"]);
  assert.deepEqual([...by("uses-app").sourceIds].sort(), [...by("app-only").sourceIds, "project"].sort());
  assert.deepEqual(by("app-only").requiredCaseIds, by("uses-app").requiredCaseIds);
  assert.equal(by("app-only").maxTokens, by("uses-app").maxTokens);
  for (const id of ["reads-project", "app-only", "uses-app", "reads-evidence", "uses-app-people"]) assert.match(by(id).rationale, /one ingredient/, id);
  assert.match(by("uses-app").rationale, /Against Text only it changes both/);
});

test("compare agents: files read per configuration is a manipulation check", async () => {
  const { compareAgents } = await import("../src/core/agent-comparison.js");
  const { syntheticCampaignExecution } = await import("../src/core/campaign-study.js");
  const study = validateStudy(await readJson(join(gq, "study.json")));
  const agents = validateAgents(study, await readJson<AgentProtocol[]>(join(gq, "agents.json"))).filter((x) => ["text-only", "reads-project"].includes(x.id));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "reads-test", new Date(Date.now() - 1000).toISOString());
  const runs = syntheticCampaignExecution(c).results.runs;
  const plan = campaignPlan(c);
  const reading = runs.filter((r) => plan.jobs.find((j) => j.id === r.jobId)?.agentId === "reads-project");
  const sha = (n: number) => String(n).repeat(64).slice(0, 64);
  reading.forEach((r, i) => {
    r.trace = r.trace.filter((e) => !(e.type === "source" && e.delivery === "read"));
    if (i > 0) r.trace.unshift({ type: "source", sourceId: "project", delivery: "read", sha256: sha(1) }, { type: "source", sourceId: "project", delivery: "read", sha256: sha(2) }, { type: "source", sourceId: "project", delivery: "read", sha256: sha(1) });
  });
  const out = compareAgents(plan, runs);
  const files = out.configs.find((x) => x.id === "reads-project")!;
  assert.equal(files.runsWithoutReads, 1);
  assert.equal(files.meanFilesRead, (2 * (reading.length - 1)) / reading.length);
  assert.equal(out.configs.find((x) => x.id === "text-only")!.meanFilesRead, null);
  assert.ok(out.notes.some((n) => /^Opened no project file in some runs, although they can read the files: Reads the project files \(1 of/.test(n)));
  // Different models across compared configurations are named in the notes.
  const mixed = { ...c, conditionModels: { "reads-project": { provider: "claude-code", model: "claude-sonnet-5-5", reasoning: "default" } } };
  const notes = compareAgents({ ...plan, agents: plan.agents.map((a) => (a.id === "reads-project" ? { ...a, model: mixed.conditionModels["reads-project"] } : a)) }, runs).notes;
  assert.ok(notes.some((n) => /mixes the method with the model/.test(n)));
});
