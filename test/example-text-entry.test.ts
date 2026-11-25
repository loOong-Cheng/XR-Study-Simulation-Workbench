// Suite 7 (examples/text-entry): mid-air text entry with four virtual keyboards, forecast before the
// study. Synthetic: 24 invented people in a balanced Latin square whose background drives the
// invented outcomes; app-free configurations only, none with measured inputs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, tokenBudgetWarning, withDefaultRuns } from "../src/core/planner.js";
import { checkNewConfigurations, validateAgents, validateHumanData, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { agentVsHumanFigure, agreementFigure, correlationFigure, humanFigure, populationVsIndividualFigure, trajectoryFigure } from "../src/core/figures.js";
import { fairnessWarnings } from "../src/core/fairness.js";
import { participantProblems } from "../src/participant-knowledge.js";
import { leakCheck } from "../src/sources.js";
import type { AgentProtocol, Comparison, HumanData, Study } from "../src/core/types.js";

// Run from the repository root (npm test).
const dir = resolve("examples/text-entry");
const read = async <T>(p: string) => JSON.parse(await readFile(join(dir, p), "utf8")) as T;
const AT = "2026-11-25T10:00:00.000Z";
const KEYBOARDS = ["raycast", "drum", "swipe", "split"];
const FIELDS = ["age_band", "desktop_typing_wpm", "smartphone_swipe_use", "first_language_english", "wears_glasses", "handedness", "arm_length_cm"];

async function suite() {
  const study = validateStudy(await read("study.json"));
  const agents = validateAgents(study, await read<AgentProtocol[]>("agents.json"));
  const human = await read<HumanData>("human.json");
  const comparisons = await read<Comparison[]>("comparisons.json");
  return { study, agents, human, comparisons };
}
/** The background table as rows keyed by participant. */
async function background() {
  const [head, ...lines] = (await readFile(join(dir, "data/raw/background.csv"), "utf8")).trimEnd().split("\n").map((l) => l.split(","));
  return new Map(lines.map((r) => [r[0], Object.fromEntries(head.map((h, i) => [h, r[i]]))]));
}
const value = (human: HumanData, p: string, c: string, o: string) => {
  const m = human.measurements.find((x) => x.participantId === p && x.conditionId === c && x.outcomeId === o)!;
  return m.value ?? Object.values(m.components!).reduce((s, x) => s + x, 0) / Object.values(m.components!).length;
};
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
function pearson(x: number[], y: number[]) {
  const mx = mean(x),
    my = mean(y);
  const sxy = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  return sxy / Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0) * y.reduce((s, v) => s + (v - my) ** 2, 0));
}

test("suite 7: valid files, forecasts before the study, app-free configurations without warnings, outcome-blind sources", async () => {
  const { study, agents, human, comparisons } = await suite();
  assert.equal(study.synthetic, true);
  assert.equal(study.predictionTiming, "before-experience");
  assert.equal(study.design, "within-subjects");
  assert.deepEqual(study.conditions.map((c) => c.id), KEYBOARDS);
  assert.equal(study.participants.length, 24);
  assert.ok(study.outcomes.length >= 5 && study.outcomes.length <= 7);
  assert.ok(study.outcomes.every((o) => (o.scale === "rank" ? o.range === undefined : Array.isArray(o.range))), "every measure but the ranking declares a range");
  const tlx = study.outcomes.find((o) => o.id === "tlx")!;
  assert.equal(tlx.components!.length, 6);
  assert.equal(tlx.componentRule, "mean");
  assert.equal(study.outcomes.find((o) => o.id === "entry-time")!.aggregation, "geometric");
  // Human data: complete and synthetic.
  validateHumanData(study, human);
  assert.equal(human.synthetic, true);
  assert.equal(human.measurements.length, 24 * 4 * study.outcomes.length);
  // Configurations: 5–7, app-free, no measured inputs, budgets of at least 20,000 tokens.
  assert.ok(agents.length >= 5 && agents.length <= 7);
  checkNewConfigurations(study, agents);
  for (const a of agents) {
    assert.ok(!a.inputs?.length, `${a.id} has measured inputs`);
    assert.equal(a.runtime, "none");
    assert.ok(!a.tools.includes("xr-interact") && !a.tools.includes("read-files"), `${a.id} uses an app or project`);
    assert.ok((a.maxTokens ?? 0) >= 20_000, `${a.id}: token budget`);
    assert.equal(tokenBudgetWarning(study, a), null);
  }
  const levels = new Map(agents.map((a) => [a.id, a.level ?? study.predictionLevel]));
  assert.deepEqual([...levels].filter(([, l]) => l === "individual").map(([id]) => id).sort(), ["knows-participant", "knows-participant-evidence"]);
  // The model arm has Text only's ingredients on another model; every other configuration uses one model.
  const byId = new Map(agents.map((a) => [a.id, a]));
  const arm = byId.get("text-only-sonnet")!;
  const base = byId.get("text-only")!;
  assert.deepEqual([arm.sourceIds, arm.tools, arm.level], [base.sourceIds, base.tools, base.level]);
  assert.notEqual(arm.model.model, base.model.model);
  assert.ok(agents.filter((a) => a !== arm).every((a) => a.model.model === "claude-opus-5-5" && a.model.reasoning === "default"));
  // Planned comparisons: 2–3, each within one level, stored with the study too; no fairness warnings.
  assert.ok(comparisons.length >= 2 && comparisons.length <= 3);
  for (const c of comparisons) assert.equal(levels.get(c.candidate), levels.get(c.baseline), `${c.candidate} − ${c.baseline}`);
  assert.deepEqual(
    comparisons.map((c) => [c.candidate, c.baseline, c.domain]),
    study.analysis.contrasts.map((c) => [c.candidate, c.baseline, c.domain]),
  );
  assert.deepEqual(fairnessWarnings(study, agents, comparisons), []);
  // Sources exist inside the folder; the brief and the evidence note pass the outcome-blind check.
  const workspace = await read<{ suite: string; sources: Record<string, string> }>("workspace.json");
  assert.match(workspace.suite, /^Suite 7 · /);
  assert.deepEqual(Object.keys(workspace.sources).sort(), study.sources.map((s) => s.id).sort());
  for (const rel of Object.values(workspace.sources)) assert.ok(existsSync(join(dir, rel)), rel);
  for (const id of ["brief", "evidence"]) {
    const check = await leakCheck("examples/text-entry", study, await readFile(join(dir, workspace.sources[id]), "utf8"));
    assert.deepEqual(check, { participantIds: 0, humanMeanMatches: 0, checkedAgainstHuman: true, predictions: [] }, id);
  }
});

test("suite 7: the keyboard orders form a balanced 4 × 4 Latin square, each order used by six people", async () => {
  const { study } = await suite();
  const orders = new Map<string, number>();
  for (const p of study.participants) orders.set(p.conditionOrder.join(" "), (orders.get(p.conditionOrder.join(" ")) ?? 0) + 1);
  assert.equal(orders.size, 4);
  assert.ok([...orders.values()].every((n) => n === 6), JSON.stringify([...orders]));
  const square = [...orders.keys()].map((o) => o.split(" "));
  for (const row of square) assert.deepEqual([...row].sort(), [...KEYBOARDS].sort());
  // Every keyboard once in every position.
  for (let pos = 0; pos < 4; pos++) assert.equal(new Set(square.map((r) => r[pos])).size, 4, `position ${pos + 1}`);
  // Balanced for first-order carryover: every keyboard directly follows every other keyboard exactly once.
  const pairs = square.flatMap((r) => r.slice(1).map((k, i) => `${r[i]}>${k}`));
  assert.equal(pairs.length, 12);
  assert.equal(new Set(pairs).size, 12);
  // The raw log has the same orders.
  const logged = (await readFile(join(dir, "data/raw/participants.csv"), "utf8")).trimEnd().split("\n").slice(1).map((l) => l.split(","));
  assert.deepEqual(logged.map(([id, order]) => [id, order.split(" ")]), study.participants.map((p) => [p.id, p.conditionOrder]));
});

test("suite 7: the participant background is complete for everyone, and drives the invented outcomes", async () => {
  const { study, human } = await suite();
  const source = study.sources.find((s) => s.kind === "demographics")!;
  assert.deepEqual(source.fields, FIELDS);
  assert.deepEqual(participantProblems(study, "demographics", join(dir, "data/raw/background.csv"), source.fields!), []);
  const bg = await background();
  assert.deepEqual([...bg.keys()], study.participants.map((p) => p.id));
  for (const [id, row] of bg) for (const f of FIELDS) assert.ok(row[f] && row[f].trim() !== "", `${id}: ${f}`);
  // Varied: every category of each categorical field occurs.
  const values = (f: string) => new Set([...bg.values()].map((r) => r[f]));
  assert.deepEqual([...values("smartphone_swipe_use")].sort(), ["daily", "never", "sometimes"]);
  assert.deepEqual([...values("age_band")].sort(), ["18-24", "25-34", "35-44", "45+"]);
  for (const f of ["first_language_english", "wears_glasses"]) assert.deepEqual([...values(f)].sort(), ["no", "yes"]);
  assert.deepEqual([...values("handedness")].sort(), ["left", "right"]);
  // Invented effects: daily swipe users are much faster with swipe than people who never swipe;
  // desktop typing speed goes with raycast and split speed; longer arms with comfort on the drum keyboard.
  const people = study.participants.map((p) => p.id);
  const swipe = (use: string) => mean(people.filter((p) => bg.get(p)!.smartphone_swipe_use === use).map((p) => value(human, p, "swipe", "wpm")));
  assert.ok(swipe("daily") > swipe("never") * 1.5, `${swipe("daily")} vs ${swipe("never")}`);
  const desktop = people.map((p) => Number(bg.get(p)!.desktop_typing_wpm));
  for (const k of ["raycast", "split"]) assert.ok(pearson(desktop, people.map((p) => value(human, p, k, "wpm"))) > 0.5, k);
  const arm = people.map((p) => Number(bg.get(p)!.arm_length_cm));
  assert.ok(pearson(arm, people.map((p) => value(human, p, "drum", "arm-comfort"))) > 0.3);
});

test("suite 7: configurations with measured inputs or recordings from the study are refused before the study", async () => {
  const { study, agents } = await suite();
  const base = agents.find((a) => a.id === "text-only")!;
  const others = study.outcomes.map((o) => o.id).filter((id) => id !== "wpm");
  const withSpeed = { ...base, id: "with-speed", label: "Text + measured speed", targets: others, inputs: ["wpm"] };
  assert.throws(() => validateAgents(study, [...agents, withSpeed]), /requires an after-experience forecast/);
  // The same configuration is accepted once the study is declared an after-experience forecast.
  assert.doesNotThrow(() => validateAgents({ ...study, predictionTiming: "after-experience" } as Study, [...agents, withSpeed]));
  // Records made during the study are refused too; the participant background, recorded before, is not.
  const withLogs = validateStudy({ ...study, sources: [...study.sources, { id: "logs", label: "Keystroke logs", kind: "objective-records", description: "Per-phrase keystroke logs.", fields: ["keystrokes"] }] } as Study);
  const withRecords = { ...base, id: "with-logs", label: "Text + keystroke logs", sourceIds: ["brief", "logs"], requiredSourceIds: ["brief", "logs"], tools: ["read-participant-data" as const] };
  assert.throws(() => validateAgents(withLogs, [...agents, withRecords]), /before-experience forecast cannot use/);
  assert.ok(agents.some((a) => a.sourceIds.includes("background")));
});

test("suite 7: a frozen simulated campaign analyses without errors, and every figure builds, participant lines too", async () => {
  const { study, agents, human, comparisons } = await suite();
  const plan = freezePlan(study, withDefaultRuns(study, agents, 1), 1, AT);
  const population = agents.filter((a) => (a.level ?? study.predictionLevel) === "population");
  const individual = agents.filter((a) => a.level === "individual");
  assert.equal(plan.jobs.length, population.length * 24 + individual.length * 24);
  const c = campaignFromPlan(plan, undefined, "text-entry", AT);
  const run = syntheticCampaignExecution(c);
  const { report } = analyzeCampaign(c, human, [run.results], comparisons);
  assert.ok(report.audits.every((a) => a.scoreable));
  assert.deepEqual([...new Set(report.summaries.map((s) => s.level))].sort(), ["individual", "population"]);
  // The planned comparisons are the ones stored with the plan.
  assert.equal(report.contrasts.length, comparisons.length);
  assert.ok(report.contrasts.every((x) => x.declared === "in plan"));
  assert.ok(!report.notes.some((n) => /Skipped/.test(n)), JSON.stringify(report.notes));
  // Within subjects: some human differences are significant, some not.
  const pairs = report.significantOnly!.humanPairs;
  assert.ok(pairs.some((p) => p.significant) && pairs.some((p) => !p.significant));
  // Figures: agreement, agent vs human, correlation, population vs individual, participant lines, human data.
  const ids = agents.map((a) => a.id);
  const labels = Object.fromEntries(agents.map((a) => [a.id, a.label]));
  for (const domain of ["objective", "subjective"] as const) {
    assert.equal(agreementFigure(report, ids, domain, labels).groups.length, ids.length);
    assert.ok(populationVsIndividualFigure(study, report, ids, domain, labels).groups.length > 0);
    const lines = trajectoryFigure(report, ids, domain, labels);
    assert.ok(!("empty" in lines && lines.empty));
    assert.deepEqual(lines.configs.map((x) => x.id).sort(), individual.map((a) => a.id).sort());
    assert.equal(lines.participants.length, 24);
  }
  for (const o of study.outcomes) {
    assert.ok(agentVsHumanFigure(study, report, ids, o.id, labels));
    assert.equal(humanFigure(study, human, o.id).brackets.length, 6);
  }
  assert.ok(correlationFigure(study, report, ids, labels));
});

test("suite 7: rerunning the generator and the converter reproduces the committed files byte for byte", async (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) {
    t.skip("python3 is not available");
    return;
  }
  const tmp = await mkdtemp(join(tmpdir(), "xr-text-entry-"));
  try {
    await mkdir(join(tmp, "data"));
    await cp(join(dir, "study.json"), join(tmp, "study.json"));
    for (const f of ["generate_synthetic.py", "convert_to_human.py"]) await cp(join(dir, "data", f), join(tmp, "data", f));
    for (const f of ["generate_synthetic.py", "convert_to_human.py"]) {
      const r = spawnSync("python3", [join(tmp, "data", f)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    const committed = (await readdir(join(dir, "data/raw"))).sort();
    assert.deepEqual((await readdir(join(tmp, "data/raw"))).sort(), committed);
    for (const f of committed) assert.ok((await readFile(join(tmp, "data/raw", f))).equals(await readFile(join(dir, "data/raw", f))), f);
    assert.ok((await readFile(join(tmp, "human.json"))).equals(await readFile(join(dir, "human.json"))), "human.json");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("suite 7: every file uses LF line endings; the scripts write LF and UTF-8", async () => {
  // Folders the workbench writes when the suite is tried (not committed).
  const skip = new Set(["campaigns", "runs", "deleted"]);
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }))
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(join(d, e.name));
      } else files.push(join(d, e.name));
  };
  await walk(dir);
  assert.ok(files.length >= 14, `found only ${files.length} files`);
  const withCr: string[] = [];
  for (const f of files) if ((await readFile(f)).includes(13)) withCr.push(f);
  assert.deepEqual(withCr, []);
  const generator = await readFile(join(dir, "data/generate_synthetic.py"), "utf8");
  assert.match(generator, /lineterminator="\\n"/);
  for (const name of ["generate_synthetic.py", "convert_to_human.py"]) {
    const opens = (await readFile(join(dir, "data", name), "utf8")).split("\n").filter((line) => /\bopen\(/.test(line));
    assert.ok(opens.length >= 1, name);
    for (const line of opens) assert.match(line, /encoding="utf-8"/, `${name}: ${line.trim()}`);
  }
});
