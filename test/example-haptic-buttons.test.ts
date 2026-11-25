// Suite 5 (examples/haptic-buttons): a synthetic, app-free within-subjects study with participant
// background and practice-only movement. Run from the repository root (npm test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, tokenBudgetWarning, withDefaultRuns } from "../src/core/planner.js";
import { checkNewConfigurations, MIN_TOKEN_BUDGET, validateAgents, validateComparisons, validateHumanData, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { fairnessWarnings } from "../src/core/fairness.js";
import type { AgentProtocol, Comparison, HumanData } from "../src/core/types.js";

const id = "examples/haptic-buttons";
const dir = resolve(id);
const read = async <T>(p: string) => JSON.parse(await readFile(join(dir, p), "utf8")) as T;
const csv = async (p: string) => {
  const [head, ...rows] = (await readFile(join(dir, p), "utf8")).trimEnd().split("\n").map((l) => l.split(","));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};
async function load() {
  const study = validateStudy(await read("study.json"));
  const agents = validateAgents(study, await read<AgentProtocol[]>("agents.json"));
  const human = await read<HumanData>("human.json");
  const comparisons = validateComparisons(await read<Comparison[]>("comparisons.json"), study, agents);
  return { study, agents, human, comparisons };
}
const DESIGNS = ["visual", "buzz", "pulse"];

test("suite 5: valid files, a balanced Latin square, app-free configurations, no fairness or leak warnings", async () => {
  const { study, agents, human, comparisons } = await load();
  validateHumanData(study, human);
  checkNewConfigurations(study, agents);
  assert.equal(study.synthetic, true);
  assert.equal(human.synthetic, true);
  assert.equal(study.design, "within-subjects");
  assert.deepEqual(study.conditions.map((c) => c.id), DESIGNS);
  assert.equal(study.participants.length, 18);
  assert.equal(human.measurements.length, 18 * 3 * study.outcomes.length);
  assert.ok(study.outcomes.length >= 5 && study.outcomes.length <= 7);
  // Balanced Latin square: all six orders, three people each; every design in every position and
  // every ordered pair of neighbours equally often.
  const orders = new Map<string, number>();
  for (const p of study.participants) orders.set(p.conditionOrder.join(">"), (orders.get(p.conditionOrder.join(">")) ?? 0) + 1);
  assert.deepEqual([...orders.values()], [3, 3, 3, 3, 3, 3]);
  for (let pos = 0; pos < 3; pos++) for (const d of DESIGNS) assert.equal(study.participants.filter((p) => p.conditionOrder[pos] === d).length, 6);
  const pairs = new Map<string, number>();
  for (const p of study.participants) for (let i = 0; i < 2; i++) pairs.set(`${p.conditionOrder[i]}>${p.conditionOrder[i + 1]}`, (pairs.get(`${p.conditionOrder[i]}>${p.conditionOrder[i + 1]}`) ?? 0) + 1);
  assert.equal(pairs.size, 6);
  assert.ok([...pairs.values()].every((n) => n === 6));
  // Measures: ranges where the unit implies one; workload is a mean of six 0-100 TLX items.
  assert.ok(study.outcomes.filter((o) => o.scale !== "rank").every((o) => o.range), "every non-rank measure declares its range");
  const workload = study.outcomes.find((o) => o.id === "workload")!;
  assert.equal(workload.componentRule, "mean");
  assert.deepEqual(workload.range, [0, 100]);
  assert.equal(workload.components!.length, 6);
  assert.equal(study.outcomes.find((o) => o.id === "completion-time")!.aggregation, "geometric");
  // Movement is limited to practice; every scored objective measure is measured in the main phase.
  assert.deepEqual(study.sources.find((s) => s.kind === "trajectory")!.phases, ["practice"]);
  assert.ok(study.outcomes.filter((o) => o.domain === "objective").every((o) => !o.phaseIds.includes("practice")));
  // Configurations: app-free, one model and effort, token budgets, one with measured inputs.
  assert.ok(agents.length >= 5 && agents.length <= 7);
  for (const a of agents) {
    assert.equal(a.runtime, "none", a.id);
    assert.ok(!a.tools.includes("xr-interact") && a.observation === "none", a.id);
    assert.deepEqual(a.model, { provider: "claude-code", model: "claude-opus-5-5", reasoning: "default" }, a.id);
    assert.ok((a.maxTokens ?? 0) >= MIN_TOKEN_BUDGET, a.id);
    assert.equal(tokenBudgetWarning(study, a), null, a.id);
  }
  const level = (a: AgentProtocol) => a.level ?? study.predictionLevel;
  assert.ok(agents.some((a) => level(a) === "population" && a.sourceIds.includes("demographics")), "a population configuration with the cohort background");
  assert.ok(agents.filter((a) => a.sourceIds.includes("trajectory")).every((a) => level(a) === "individual"));
  const measured = agents.filter((a) => a.inputs?.length);
  assert.equal(measured.length, 1);
  const domainOf = (o: string) => study.outcomes.find((x) => x.id === o)!.domain;
  assert.ok(measured[0].inputs!.every((o) => domainOf(o) === "objective") && measured[0].targets!.every((o) => domainOf(o) === "subjective"));
  assert.equal(study.predictionTiming, "after-experience");
  // Comparisons: 2-3, each within one level.
  assert.ok(comparisons.length >= 2 && comparisons.length <= 3);
  const byId = new Map(agents.map((a) => [a.id, a]));
  for (const c of comparisons) assert.equal(level(byId.get(c.candidate)!), level(byId.get(c.baseline)!));
  // study-check's fairness warnings (research question, stand-ins, model confounds): none.
  assert.deepEqual(fairnessWarnings(study, agents, comparisons), []);
  // Every source resolves inside the study folder; the evidence note passes the outcome-blind check.
  const { missingSources, readWorkspace } = await import("../src/workspace.js");
  const ws = await readWorkspace(id);
  assert.deepEqual(missingSources(dir, study, ws.manifest, study.sources.map((s) => s.id)), []);
  assert.match(String((ws.manifest as { suite?: string }).suite), /^Suite 5 · /);
  const { leakCheck } = await import("../src/sources.js");
  const evidence = await readFile(join(dir, ws.manifest.sources!.evidence), "utf8");
  assert.deepEqual(await leakCheck(id, study, evidence), { participantIds: 0, humanMeanMatches: 0, checkedAgainstHuman: true, predictions: [] });
  const { predictionSentences } = await import("../src/core/fairness.js");
  assert.deepEqual(predictionSentences(study, await readFile(join(dir, "agent-brief.md"), "utf8")), []);
});

test("suite 5: the generator and converter reproduce the committed files byte for byte", async (t) => {
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.error || python.status !== 0) {
    t.skip("python3 is not available");
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), "xr-haptic-"));
  try {
    await mkdir(join(tmp, "data"));
    for (const f of ["generate_synthetic.py", "convert_to_human.py"]) await cp(join(dir, "data", f), join(tmp, "data", f));
    await cp(join(dir, "study.json"), join(tmp, "study.json"));
    for (const f of ["generate_synthetic.py", "convert_to_human.py"]) {
      const run = spawnSync("python3", [join(tmp, "data", f)], { encoding: "utf8" });
      assert.equal(run.status, 0, `${f}: ${run.stderr}`);
    }
    const committed = (await readdir(join(dir, "data/raw"))).sort();
    assert.deepEqual((await readdir(join(tmp, "data/raw"))).sort(), committed);
    assert.ok(committed.includes("demographics.csv") && committed.includes("movement_practice.csv"));
    for (const f of committed) assert.ok((await readFile(join(tmp, "data/raw", f))).equals(await readFile(join(dir, "data/raw", f))), `data/raw/${f} differs`);
    assert.ok((await readFile(join(tmp, "human.json"))).equals(await readFile(join(dir, "human.json"))), "human.json differs");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("suite 5: complete background and practice movement for everyone; movement reaches individual jobs as practice rows only", async () => {
  const { study, agents } = await load();
  const { participantProblems } = await import("../src/participant-knowledge.js");
  const { participantKnowledgeOverview } = await import("../src/sources.js");
  const { trajectory } = await import("../src/executor/runner.js");
  const { readWorkspace } = await import("../src/workspace.js");
  const ws = await readWorkspace(id);
  const people = study.participants.map((p) => p.id);
  const dem = study.sources.find((s) => s.kind === "demographics")!;
  const mov = study.sources.find((s) => s.kind === "trajectory")!;
  const demPath = join(dir, ws.manifest.sources![dem.id]);
  const movPath = join(dir, ws.manifest.sources![mov.id]);
  assert.deepEqual(participantProblems(study, "demographics", demPath, dem.fields!), []);
  assert.deepEqual(participantProblems(study, "trajectory", movPath, mov.fields!, mov.phases), []);
  for (const k of await participantKnowledgeOverview(id, agents)) {
    assert.deepEqual(k.problems, [], k.id);
    assert.deepEqual(k.warnings, [], k.id);
  }
  // Background: one complete row per person, and varied.
  const background = await csv(ws.manifest.sources![dem.id]);
  assert.deepEqual(background.map((r) => r.participant), people);
  for (const r of background) for (const f of dem.fields!) assert.ok(r[f] !== undefined && r[f].trim() !== "", `${r.participant} ${f}`);
  assert.ok(background.some((r) => r.handedness === "left"));
  assert.deepEqual(new Set(background.map((r) => r.vr_experience)), new Set(["none", "occasional", "regular"]));
  for (const f of ["age", "hand_length_cm", "tactile_sensitivity_2pd_mm", "gaming_hours_per_week"]) assert.ok(new Set(background.map((r) => r[f])).size >= 6, f);
  // Movement: three practice rows per person and design, and nothing of the scored phase.
  const movement = await csv(ws.manifest.sources![mov.id]);
  for (const p of people) for (const d of DESIGNS) assert.equal(movement.filter((r) => r.participant === p && r.design === d && r.phase === "practice").length, 3, `${p} ${d}`);
  assert.ok(movement.every((r) => r.phase === "practice"));
  // What an individual session gets (the runner's own function): the person's practice rows, allowed fields only.
  for (const p of people) {
    const text = await trajectory(movPath, p, mov.fields!, mov.phases);
    const [head, ...lines] = text.split("\n");
    assert.equal(head, ["participant", ...mov.fields!].join(","));
    assert.equal(lines.length, 9, p);
    assert.ok(lines.every((l) => l.startsWith(`${p},`) && l.split(",")[2] === "practice"), p);
  }
  assert.match(await trajectory(movPath, undefined, mov.fields!, mov.phases), /none for population/);
  // A main-phase row added to the recording would still never be delivered.
  const { trajectoryText } = await import("../src/participant-knowledge.js");
  const tmp = await mkdtemp(join(tmpdir(), "xr-haptic-mov-"));
  try {
    const withMain = join(tmp, "movement.csv");
    await writeFile(withMain, (await readFile(movPath, "utf8")) + "P01,visual,main,1,40.0,9.0,11.0\n");
    assert.doesNotMatch(trajectoryText(withMain, "P01", mov.fields!, mov.phases), /,main,/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("suite 5: the invented background drives the invented outcomes as the README says", async () => {
  const { human } = await load();
  const background = new Map((await csv("data/raw/demographics.csv")).map((r) => [r.participant, r]));
  const value = (p: string, d: string, o: string) => {
    const m = human.measurements.find((x) => x.participantId === p && x.conditionId === d && x.outcomeId === o)!;
    return m.components ? Object.values(m.components).reduce((s, v) => s + v, 0) / Object.values(m.components).length : m.value!;
  };
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const people = [...background.keys()];
  // Less tactile sensitivity (a larger two-point threshold) → a smaller overshoot reduction with the pulse.
  const cut = (p: string) => 1 - value(p, "pulse", "overshoot") / value(p, "visual", "overshoot");
  const tpd = (p: string) => Number(background.get(p)!.tactile_sensitivity_2pd_mm);
  assert.ok(mean(people.filter((p) => tpd(p) <= 2.2).map(cut)) > mean(people.filter((p) => tpd(p) >= 3.5).map(cut)) + 0.1);
  // Longer hands overshoot more (visual feedback).
  const hand = (p: string) => Number(background.get(p)!.hand_length_cm);
  const long = people.filter((p) => hand(p) >= 19), short = people.filter((p) => hand(p) <= 17.5);
  assert.ok(mean(long.map((p) => value(p, "visual", "overshoot"))) > mean(short.map((p) => value(p, "visual", "overshoot"))));
  // No VR experience → slower than regular VR users.
  const time = (p: string) => Math.exp(mean(DESIGNS.map((d) => Math.log(value(p, d, "completion-time")))));
  const xp = (level: string) => mean(people.filter((p) => background.get(p)!.vr_experience === level).map(time));
  assert.ok(xp("none") > xp("regular") * 1.15, `${xp("none")} vs ${xp("regular")}`);
});

test("suite 5: a frozen simulated campaign analyses without errors and every figure builds, including the participants view", async () => {
  const { study, agents, human, comparisons } = await load();
  const plan = freezePlan(study, withDefaultRuns(study, agents, 1), 1, new Date(Date.now() - 1000).toISOString());
  assert.equal(plan.jobs.length, 6 * 18);
  const c = campaignFromPlan(plan, undefined, "haptic-buttons", new Date(Date.now() - 1000).toISOString());
  const run = syntheticCampaignExecution(c);
  assert.ok(run.results.runs.every((r) => r.status === "completed"));
  const { report } = analyzeCampaign(c, human, [run.results], comparisons);
  assert.ok(report.audits.every((a) => a.scoreable), JSON.stringify(report.audits.filter((a) => !a.scoreable)));
  assert.deepEqual([...new Set(report.summaries.map((s) => s.level))].sort(), ["individual", "population"]);
  assert.deepEqual([...new Set(report.summaries.filter((s) => s.agentId === "knows-participant-and-task-data").map((s) => s.domain))], ["subjective"]);
  assert.equal(report.contrasts.length, comparisons.length);
  assert.ok(!report.notes.some((n) => /Skipped/.test(n)), JSON.stringify(report.notes));
  assert.equal(report.pairRule, "means");
  assert.ok(report.significantOnly!.humanPairs.some((p) => !p.significant), "at least one design difference is not significant");

  const figures = await import("../src/core/figures.js");
  const plots = await import("../src/web/plots.js");
  const ids = agents.map((a) => a.id);
  const labels = Object.fromEntries(agents.map((a) => [a.id, a.label]));
  const individual = agents.filter((a) => a.level === "individual").map((a) => a.id);
  for (const domain of ["objective", "subjective"] as const) {
    const fig = figures.agreementFigure(report, ids, domain, labels);
    assert.ok(fig.groups.length > 0, domain);
    assert.match(plots.agreementPlot(fig, "t", ids), /^<svg/);
    const pvi = figures.populationVsIndividualFigure(study, report, ids, domain, labels);
    assert.match(plots.agreementPlot(pvi, "t", ids), /^<svg/);
    // Participants view: one line per participant across the individual configurations.
    const lines = figures.trajectoryFigure(report, ids, domain, labels);
    assert.ok(!(lines as { empty?: boolean }).empty, lines.note);
    assert.deepEqual(lines.configs.map((x) => x.id).sort(), [...individual].sort());
    assert.equal(lines.participants.length, 18);
    // The measured-inputs configuration predicts no objective measure, so it has no objective line points.
    const given = lines.configs.findIndex((x) => x.id === "knows-participant-and-task-data");
    assert.equal(lines.participants.every((p) => p.values[given] === null), domain === "objective");
    assert.match(plots.trajectoryPlot(lines, "t"), /^<svg/);
  }
  for (const o of study.outcomes) {
    const vs = figures.agentVsHumanFigure(study, report, ids, o.id, labels);
    assert.match(plots.agentVsHumanPlot(vs, "t", ids), /^<svg/);
    const h = figures.humanFigure(study, human, o.id);
    assert.equal(h.groups.length, 3);
    assert.match(plots.humanPlot(h, "t"), /^<svg/);
  }
  assert.match(plots.correlationPlot(figures.correlationFigure(study, report, ids, labels), "t", ids), /^<svg/);
});

test("suite 5: every file is written with LF line endings and no carriage returns", async () => {
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }))
      if (e.isDirectory()) {
        if (!["campaigns", "runs", "deleted"].includes(e.name)) await walk(join(d, e.name));
      } else files.push(join(d, e.name));
  };
  await walk(dir);
  assert.ok(files.length >= 14, `found only ${files.length} files`);
  const withCr: string[] = [];
  for (const f of files) if ((await readFile(f)).includes(13)) withCr.push(f);
  assert.deepEqual(withCr, []);
  const generator = await readFile(join(dir, "data/generate_synthetic.py"), "utf8");
  assert.match(generator, /lineterminator="\\n"/);
  const converter = await readFile(join(dir, "data/convert_to_human.py"), "utf8");
  for (const line of converter.split("\n").filter((l) => /\bopen\(/.test(l))) assert.match(line, /encoding="utf-8"/, line.trim());
});
