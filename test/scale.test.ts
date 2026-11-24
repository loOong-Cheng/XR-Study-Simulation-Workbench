// Large studies: the speed-ups found by the scale test (120 people, 30 measures, 12 configurations,
// thousands of sessions) keep every result as it was. Each test checks the result and guards the
// speed-up with a call count (timing bounds only where they are generous).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { freezePlan, withDefaultRuns, defaultRuns, MAX_POPULATION_RUNS } from "../src/core/planner.js";
import { campaignFromPlan, type Campaign, type CampaignReceipt } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { analysisStats, pairTestStats, type AnalysisMemo } from "../src/core/analyzer.js";
import { correlationFigure, figureStats, populationVsIndividualFigure, agentVsHumanFigure } from "../src/core/figures.js";
import { validateAgents, validateStudy } from "../src/core/validation.js";
import type { AgentProtocol, AnalysisReport, Comparison, HumanData, Study } from "../src/core/types.js";
import { until } from "./until.js";

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
const read = async <T>(p: string) => JSON.parse(await readFile(p, "utf8")) as T;
const gq = resolve("examples/graphics-quality");
const ecolar = resolve("examples/ecolar");
const AT = "2026-11-23T10:00:00.000Z";
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
async function frozen(id: string, pick: (a: AgentProtocol) => AgentProtocol | null, label: string) {
  const { readWorkspace, saveCampaign, saveSourceFingerprints } = await import("../src/workspace.js");
  const ws = await readWorkspace(id);
  const agents = ws.agents!.map(pick).filter((x): x is AgentProtocol => !!x);
  const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, agents, 1), 1), undefined, label, new Date(Date.now() - 1000).toISOString());
  await saveCampaign(id, c);
  await saveSourceFingerprints(id, c);
  return c;
}
function fakeResponse() {
  const chunks: string[] = [];
  const closers: (() => void)[] = [];
  const res = {
    writeHead: () => res,
    write: (c: string) => (chunks.push(String(c)), true),
    end: () => undefined,
    on: (event: string, fn: () => void) => (event === "close" && closers.push(fn), res),
  };
  return {
    res: res as unknown as ServerResponse,
    bytes: () => chunks.join("").length,
    events: () => chunks.join("").split("\n\n").filter((b) => b.startsWith("data: ")).map((b) => JSON.parse(b.slice(6))),
    close: () => closers.forEach((f) => f()),
  };
}

// ---------- the analysis: same statistics, computed faster ----------

/** The statistics of a report (no texts): what the pinned digests below cover. */
const statistics = (r: AnalysisReport) =>
  createHash("sha256")
    .update(JSON.stringify([r.summaries, r.contrasts, r.metrics, r.runScores, r.values, r.humanValues, r.humanPairs, r.absoluteFit, r.significantOnly?.summaries ?? null, r.significantOnly?.humanPairs ?? null]))
    .digest("hex")
    .slice(0, 16);
async function example(name: string) {
  const dir = resolve("examples", name);
  const study = validateStudy(await read(join(dir, "study.json")));
  const agents = validateAgents(study, await read<AgentProtocol[]>(join(dir, "agents.json")));
  const human = await read<HumanData>(join(dir, "human.json"));
  const comparisons = await read<Comparison[]>(join(dir, "comparisons.json"));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 2), 2, AT), undefined, `pinned-${name}`, AT);
  return { c, human, comparisons, bundle: syntheticCampaignExecution(c).results };
}

test("analysis: the statistics on the three examples are exactly those computed before the speed-ups", async () => {
  // Digests of every score, interval, contrast, per-run score, value and human pair test, computed
  // with the implementation that scored every run in every bootstrap draw (before this change).
  // The faster one must give the same numbers, bit for bit.
  const pinned: Record<string, string> = {
    "graphics-quality": "99ba95c4b6646f76",
    "graphics-quality without comparisons": "894bacf68cfee54d",
    ecolar: "1329288000484d95",
    "ecolar without comparisons": "a1bb1fcd25763697",
    selection: "748d652f2452a610",
    "selection without comparisons": "c995e25b3570175d",
  };
  for (const name of ["graphics-quality", "ecolar", "selection"]) {
    const { c, human, comparisons, bundle } = await example(name);
    assert.equal(statistics(analyzeCampaign(c, human, [bundle], comparisons).report), pinned[name], name);
    assert.equal(statistics(analyzeCampaign(c, human, [bundle]).report), pinned[`${name} without comparisons`], `${name} without comparisons`);
    // Kept scores (AnalysisMemo): other comparisons reuse them and give exactly the same analysis.
    const memo: AnalysisMemo = new Map();
    const plain = analyzeCampaign(c, human, [bundle]);
    assert.deepEqual(analyzeCampaign(c, human, [bundle], undefined, undefined, memo), plain);
    const full = analyzeCampaign(c, human, [bundle], comparisons);
    const scored = analysisStats.fullScores,
      tested = pairTestStats.computed;
    assert.deepEqual(analyzeCampaign(c, human, [bundle], comparisons, undefined, memo), full, `${name}: with comparisons, from kept scores`);
    assert.deepEqual(analyzeCampaign(c, human, [bundle], undefined, undefined, memo), plain, `${name}: the kept scores are not changed by their use`);
    assert.equal(analysisStats.fullScores, scored, "kept scores: nothing is scored again");
    assert.equal(pairTestStats.computed, tested, "the human pair tests of the same values are computed once");
  }
});

test("analysis: bootstrap draws never re-score every run; failure reasons are added once to kept scores", async () => {
  const { c, human, bundle } = await example("graphics-quality");
  const before = analysisStats.fullScores;
  const a = analyzeCampaign(c, human, [bundle]);
  const configs = c.suite.conditions.length;
  // Point estimates and the adherence sensitivity: at most a few per configuration (and the
  // significant-only view), never one per bootstrap draw (the study has 1000 draws).
  assert.ok(analysisStats.fullScores - before <= configs * 6, `${analysisStats.fullScores - before} full scorings for ${configs} configurations`);
  assert.ok(a.report.summaries.every((s) => s.ci95 === null || s.ci95.low <= s.ci95.high));
  // A failed session's reason goes into its audit once, also when the scores are kept and reused.
  const failedJob = c.jobs.find((j) => j.kind === "llm")!;
  const receipts = [{ campaignDigest: c.digest, jobId: failedJob.id, attempt: 1, status: "failed", error: "Broke." }] as unknown as CampaignReceipt[];
  const without = { ...bundle, runs: bundle.runs.filter((r) => r.jobId !== failedJob.id) };
  const memo: AnalysisMemo = new Map();
  const first = analyzeCampaign(c, human, [without], undefined, receipts, memo);
  const second = analyzeCampaign(c, human, [without], undefined, receipts, memo);
  const issues = (x: typeof first) => x.report.audits.find((r) => r.jobId === failedJob.id)!.issues;
  assert.deepEqual(issues(second), issues(first));
  assert.equal(issues(second).filter((i) => i.startsWith("Failed (attempt 1)")).length, 1);
  assert.deepEqual(second.report.exclusions, first.report.exclusions);
  assert.deepEqual(analyzeCampaign(c, human, [without], undefined, receipts), first, "the same as without kept scores");
});

test("figures: a report's values are indexed once; large reports draw fast, with the same numbers", async () => {
  // Many population runs: thousands of values (the scale test had 756,000).
  const study = validateStudy(await read(join(gq, "study.json")));
  const agents = validateAgents(study, await read<AgentProtocol[]>(join(gq, "agents.json")));
  const human = await read<HumanData>(join(gq, "human.json"));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 20), 20, AT), undefined, "figures", AT);
  const { report } = analyzeCampaign(c, human, [syntheticCampaignExecution(c).results]);
  const ids = c.suite.conditions.map((x) => x.id);
  const builds = figureStats.indexBuilds;
  const started = performance.now();
  const correlation = correlationFigure(c.suite.study!, report, ids);
  const pvi = populationVsIndividualFigure(c.suite.study!, report, ids, "subjective");
  for (const o of c.suite.study!.outcomes) agentVsHumanFigure(c.suite.study!, report, ids.filter((id) => report.metrics.some((m) => m.agentId === id && m.outcomeId === o.id)), o.id);
  const ms = performance.now() - started;
  assert.equal(figureStats.indexBuilds - builds, 1, "one index for every figure of the report");
  assert.ok(ms < 5000, `figures took ${Math.round(ms)} ms`);
  // The same numbers as filtering the report's lists (the way the figures read them before).
  const s = correlation.series[0];
  const o = c.suite.study!.outcomes.find((x) => x.id === s.points[0].outcomeId)!;
  const filtered = report.values!.filter((v) => v.agentId === s.id && v.outcomeId === o.id && (v.level === "population" || v.repetition === 1));
  assert.ok(filtered.length > 0);
  // A population run's value in the population-vs-individual figure equals its per-run score.
  for (const g of pvi.groups.filter((x) => x.level === "population"))
    g.units.forEach((u, k) => {
      const r = report.runScores!.find((x) => x.agentId === g.id && x.unit === u && x.domain === "subjective")!;
      assert.ok(Math.abs(r.agreement! - g.values[k]) < 1e-12);
    });
});

// ---------- executor and summaries ----------

test("blockers: each configuration is checked once, participant files are read once per version", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { participantChecks } = await import("../src/participant-knowledge.js");
  const a = await tempWorkspace(ecolar);
  try {
    const c = await frozen(a.id, (x) => x, "blockers");
    const ex = await Executor.open(a.id, c.id);
    const all = [...ex.jobs.keys()];
    assert.ok(all.length > 100);
    const reads = participantChecks.reads;
    const first = await ex.blockers(all);
    const firstReads = participantChecks.reads - reads;
    // Ecolar has three participant sources (background, movement, full movement).
    assert.ok(firstReads <= 3, `${firstReads} reads for ${all.length} sessions`);
    // Again (as Start does after the page asked): nothing is read again, the answer is the same.
    assert.deepEqual(await ex.blockers(all), first);
    assert.equal(participantChecks.reads - reads, firstReads);
    // One session of each configuration says the same as all of them.
    const one = [...new Map([...ex.jobs.values()].map((j) => [j.agentId, j.jobId])).values()];
    assert.deepEqual(await ex.blockers(one), first);
    // A changed file is read again.
    const movement = join(a.dir, "data/raw/trajectories_main.csv");
    await appendFile(movement, "\n");
    await ex.blockers(all);
    assert.ok(participantChecks.reads - reads > firstReads, "a changed file is checked again");
    closeExecutor(a.id, c.id);
  } finally {
    await removeDir(a.dir);
  }
});

test("blockers: an incomplete movement folder is still refused after the cache saw it complete", async () => {
  const { participantProblems } = await import("../src/participant-knowledge.js");
  const tmp = await mkdtemp(join(tmpdir(), "xr-movement-"));
  try {
    const study = {
      participants: [{ id: "p1" }, { id: "p2" }],
      outcomes: [{ id: "time", label: "Time" }],
    } as unknown as Study;
    await writeFile(join(tmp, "p1_main.csv"), "design,x\nA,1\n");
    await writeFile(join(tmp, "p2_main.csv"), "design,x\nA,2\n");
    assert.deepEqual(participantProblems(study, "trajectory", tmp, ["x"]), []);
    assert.deepEqual(participantProblems(study, "trajectory", tmp, ["x"]), []);
    await writeFile(join(tmp, "p2_main.csv"), "design,x\nA,\n");
    assert.match(participantProblems(study, "trajectory", tmp, ["x"]).join(" "), /empty values for x in p2_main.csv/);
    await rm(join(tmp, "p2_main.csv"));
    assert.match(participantProblems(study, "trajectory", tmp, ["x"]).join(" "), /no recording for p2/);
  } finally {
    await removeDir(tmp);
  }
});

test("campaign summaries: counted incrementally and one at a time, the same as counting afresh", async () => {
  const { Executor, closeExecutor, liveStatuses } = await import("../src/executor/runner.js");
  const { campaignSummaries, forgetSummaries, summaryReads } = await import("../src/history.js");
  const a = await tempWorkspace(gq);
  try {
    const c = await frozen(a.id, (x) => (["text-only", "reads-project"].includes(x.id) ? { ...x, repetitions: 6 } : null), "summaries");
    const ex = await Executor.open(a.id, c.id);
    const jobs = [...ex.jobs.keys()];
    await ex.start("simulate", jobs.slice(0, 5));
    await until(() => jobs.slice(0, 5).every((j) => ex.jobs.get(j)!.status === "done"), "five sessions", { executor: ex });
    await until(() => ex.running.size === 0, "receipts written", { executor: ex });
    const live = (cid: string) => liveStatuses(a.id, cid);
    const first = await campaignSummaries(a.id, live);
    assert.equal(first[0].done, 5);
    assert.equal(first[0].simulated, 5);
    // More sessions end: only the new receipt lines are read.
    await ex.start("simulate", jobs.slice(5, 8));
    await until(() => jobs.slice(5, 8).every((j) => ex.jobs.get(j)!.status === "done"), "three more", { executor: ex });
    await until(() => ex.running.size === 0, "receipts written", { executor: ex });
    const lines = summaryReads.receiptLines,
      results = summaryReads.results;
    const later = await campaignSummaries(a.id, live);
    assert.equal(summaryReads.receiptLines - lines, 3);
    assert.equal(summaryReads.results - results, 3);
    assert.equal(later[0].done, 8);
    // Nothing new: nothing is read.
    await campaignSummaries(a.id, live);
    assert.equal(summaryReads.receiptLines - lines, 3);
    // Many requests at once: at most two computations (the one running and one for all the rest).
    const computations = summaryReads.computations;
    const many = await Promise.all(Array.from({ length: 12 }, () => campaignSummaries(a.id, live)));
    assert.ok(summaryReads.computations - computations <= 2, `${summaryReads.computations - computations} computations for 12 requests`);
    many.forEach((m) => assert.deepEqual(m, later));
    // Counting afresh (as after loading a runs zip) gives the same.
    await until(() => ex.running.size === 0, "receipts written", { executor: ex });
    closeExecutor(a.id, c.id);
    const kept = await campaignSummaries(a.id);
    forgetSummaries(a.id);
    assert.deepEqual(await campaignSummaries(a.id), kept);
  } finally {
    await removeDir(a.dir);
  }
});

test("event stream: session changes are sent in batches with the changed fields; state events carry the counts", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { handleGet } = await import("../src/routes.js");
  const a = await tempWorkspace(gq);
  const stream = fakeResponse();
  try {
    const c = await frozen(a.id, (x) => (x.id === "text-only" ? { ...x, repetitions: 12 } : null), "stream");
    await handleGet("/api/executor/events", new URL(`http://127.0.0.1/api/executor/events?id=${encodeURIComponent(a.id)}&campaign=${c.id}`), stream.res, () => undefined);
    const ex = await Executor.open(a.id, c.id);
    let changes = 0;
    const count = () => changes++;
    ex.listeners.add(count);
    const jobs = [...ex.jobs.keys()];
    await ex.start("simulate", jobs);
    await until(() => ex.snapshot().counts.done === jobs.length, "every session", { executor: ex });
    await until(() => stream.events().some((e) => e.type === "state" && e.state?.counts?.done === jobs.length), "the final state event");
    ex.listeners.delete(count);
    const events = stream.events();
    assert.equal(events.filter((e) => e.type === "job").length, 0, "no whole-session events");
    const batches = events.filter((e) => e.type === "jobs");
    const entries = batches.flatMap((b) => b.jobs as Record<string, unknown>[]);
    assert.ok(batches.length < changes, `${batches.length} batches for ${changes} executor events`);
    // Every entry names its session and only what changed (never the whole session again).
    assert.ok(entries.every((j) => typeof j.jobId === "string" && Object.keys(j).length > 1 && Object.keys(j).length < Object.keys(ex.jobs.get(j.jobId as string)!).length));
    // Applying the batches to the first snapshot gives the executor's sessions.
    const snapshot = events[0].snapshot as { jobs: Record<string, unknown>[] };
    const byId = new Map(snapshot.jobs.map((j) => [j.jobId as string, j]));
    for (const j of entries) Object.assign(byId.get(j.jobId as string)!, j);
    for (const j of ex.jobs.values()) assert.deepEqual(byId.get(j.jobId), { ...j });
    await until(() => ex.running.size === 0, "receipts written", { executor: ex });
    closeExecutor(a.id, c.id);
  } finally {
    stream.close();
    await removeDir(a.dir);
  }
});

// ---------- freezing and continuing large studies ----------

test("freeze: the automatic population run count stops at the most a population configuration may have", async () => {
  const study = validateStudy(await read(join(gq, "study.json")));
  const agents = validateAgents(study, await read<AgentProtocol[]>(join(gq, "agents.json")));
  // 120 people × 10 runs per participant would be 1,200 runs, more than allowed.
  const big = { ...study, participants: Array.from({ length: 120 }, (_, i) => ({ ...study.participants[i % study.participants.length], id: `P${i + 1}` })) } as Study;
  const population = agents.find((a) => (a.level ?? big.predictionLevel) === "population")!;
  assert.equal(defaultRuns(big, { ...population, repetitions: undefined } as AgentProtocol, 10), MAX_POPULATION_RUNS);
  assert.equal(defaultRuns(big, { ...population, repetitions: undefined } as AgentProtocol, 2), 240);
  const runs = withDefaultRuns(big, [{ ...population, repetitions: undefined } as AgentProtocol], 10);
  assert.equal(runs[0].repetitions, 1000);
});

test("continuation preview: counts per configuration; the whole campaign only on request", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { handlePost } = await import("../src/routes.js");
  const a = await tempWorkspace(gq);
  try {
    const c = await frozen(a.id, (x) => (x.id === "text-only" ? { ...x, repetitions: 3 } : null), "preview");
    const ex = await Executor.open(a.id, c.id);
    const jobs = [...ex.jobs.keys()];
    await ex.start("simulate", jobs.slice(0, 2));
    await until(() => jobs.slice(0, 2).every((j) => ex.jobs.get(j)!.status === "done"), "two sessions", { executor: ex });
    await until(() => ex.running.size === 0, "receipts written", { executor: ex });
    closeExecutor(a.id, c.id);
    const ask = async (full: boolean) => {
      let answer: Record<string, any> = {};
      await handlePost("/api/workspace/continue", { id: a.id, campaignId: c.id, changes: { repetitions: { "text-only": 5 } }, keepSimulated: true, preview: true, ...(full ? { full: true } : {}) }, (v) => (answer = v as Record<string, any>));
      return answer;
    };
    const slim = await ask(false);
    assert.equal(slim.campaign, undefined);
    const full = await ask(true);
    const next = full.campaign as Campaign;
    assert.deepEqual(slim.sessions, { total: next.jobs.filter((j) => j.kind === "llm").length, new: next.jobs.filter((j) => j.kind === "llm" && !j.inheritedFrom).length, reused: 2 });
    assert.deepEqual(slim.conditions, [{ id: "text-only", label: next.suite.conditions[0].label, model: next.model, sessions: 5, reused: 2 }]);
    assert.deepEqual(slim.continuation, next.continuation);
    assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length / 3);
  } finally {
    await removeDir(a.dir);
  }
});
