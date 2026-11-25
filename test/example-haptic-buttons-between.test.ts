// Suite 6 (examples/haptic-buttons-between): the workbench's between-subjects example.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, withDefaultRuns } from "../src/core/planner.js";
import { validateAgents, validateComparisons, validateHumanData, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { agentVsHumanFigure, agreementFigure, correlationFigure, humanFigure } from "../src/core/figures.js";
import { explainStudy, studyWarnings } from "../src/core/explain.js";
import { fairnessWarnings } from "../src/core/fairness.js";
import { parseCsv, participantProblems } from "../src/participant-knowledge.js";
import { missingSources } from "../src/workspace.js";
import { leakCheck } from "../src/sources.js";
import type { AgentProtocol, Comparison, HumanData } from "../src/core/types.js";

// Run from the repository root (npm test).
const id = "examples/haptic-buttons-between";
const folder = resolve(id);
const file = (p: string) => join(folder, p);
const json = async <T>(p: string) => JSON.parse(await readFile(file(p), "utf8")) as T;
const DESIGNS = ["visual", "buzz", "pulse"];
const FIELDS = ["age", "vr_experience", "prior_haptic_devices", "motion_sickness_susceptibility", "dominant_hand"];
const python = ["python3", "python"].find((p) => spawnSync(p, ["--version"]).status === 0);
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

async function load() {
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const human = await json<HumanData>("human.json");
  validateHumanData(study, human);
  const comparisons = validateComparisons(await json<Comparison[]>("comparisons.json"), study, agents);
  return { study, agents, human, comparisons };
}

test("haptic buttons (between): study, configurations, human data and comparisons are valid, with groups of 12", async () => {
  const { study, agents, human, comparisons } = await load();
  assert.equal(study.design, "between-subjects");
  assert.equal(study.synthetic, true);
  assert.equal(human.synthetic, true);
  assert.equal(study.predictionTiming, "after-experience");
  assert.doesNotMatch(study.researchQuestion, /agent|forecast|configuration/i);
  assert.ok(study.agentQuestions);
  // Measures: 4–6, every one with a range, none a ranking.
  assert.ok(study.outcomes.length >= 4 && study.outcomes.length <= 6);
  assert.ok(study.outcomes.every((o) => o.scale !== "rank" && o.range));
  assert.equal(study.outcomes.find((o) => o.id === "completion-time")!.aggregation, "geometric");
  // 36 people, one design each, 12 per design; the stratum is the group.
  assert.equal(study.participants.length, 36);
  assert.ok(study.participants.every((p) => p.conditionOrder.length === 1 && p.stratum === `group-${p.conditionOrder[0]}`));
  for (const d of DESIGNS) assert.equal(study.participants.filter((p) => p.conditionOrder[0] === d).length, 12, d);
  // No small-sample warning, and no fairness warning.
  assert.deepEqual(studyWarnings(study), []);
  assert.deepEqual(fairnessWarnings(study, agents, comparisons), []);
  assert.match(explainStudy(study, agents), /between-subjects/);
  // One record per person × measure, for the person's own design only.
  const assigned = new Map(study.participants.map((p) => [p.id, p.conditionOrder[0]]));
  assert.equal(human.measurements.length, 36 * study.outcomes.length);
  assert.ok(human.measurements.every((m) => assigned.get(m.participantId!) === m.conditionId));
  // Population configurations only, one model and the same budgets, each naming the ingredient it adds.
  assert.ok(agents.length >= 4 && agents.length <= 6);
  for (const a of agents) {
    assert.equal(a.level ?? study.predictionLevel, "population", a.id);
    assert.equal(a.runtime, "none", a.id);
    assert.deepEqual(a.model, { provider: "claude-code", model: "claude-opus-5-5", reasoning: "default" }, a.id);
    assert.ok(a.maxTokens! >= 20_000, a.id);
    assert.ok(!a.tools.includes("xr-interact") && !a.tools.includes("read-files"), a.id);
    if (a.id !== "text-only") assert.match(a.rationale, /Compared with Text only, one ingredient/, a.id);
  }
  assert.equal(new Set(agents.map((a) => `${a.maxToolCalls}/${a.maxOutputTokens}/${a.maxTokens}`)).size, 1);
  assert.deepEqual(agents.map((a) => a.id).sort(), ["knows-cohort", "measured-inputs", "reads-evidence", "text-only"]);
  const inputs = agents.find((a) => a.id === "measured-inputs")!;
  assert.deepEqual(inputs.inputs, ["completion-time", "error-rate"]);
  assert.ok(inputs.targets!.every((t) => study.outcomes.find((o) => o.id === t)!.domain === "subjective"));
  // A between-subjects study refuses individual configurations and rankings.
  assert.throws(() => validateAgents(study, [{ ...agents[0], id: "x", level: "individual" }]), /individual level/);
  assert.throws(() => validateStudy({ ...study, outcomes: [...study.outcomes, { ...study.outcomes[2], id: "preference", label: "Preference", scale: "rank", range: undefined }] }), /ranking of the designs/);
  assert.equal(comparisons.length, 2);
});

test("haptic buttons (between): background is complete for all 36, varied, and the groups differ on it a little", async () => {
  const { study, agents } = await load();
  const manifest = await json<{ suite: string; sources: Record<string, string> }>("workspace.json");
  assert.match(manifest.suite, /^Suite 6 · /);
  // Every source every configuration reads is in the study folder; nothing points at the project or human data.
  assert.deepEqual(missingSources(folder, study, manifest, [...new Set(agents.flatMap((a) => a.sourceIds))]), []);
  assert.ok(Object.values(manifest.sources).every((p) => !/human|campaigns|runs/.test(p)));
  const src = study.sources.find((s) => s.kind === "demographics")!;
  assert.deepEqual(src.fields, FIELDS);
  assert.deepEqual(participantProblems(study, src.kind, file(manifest.sources[src.id]), src.fields!), []);
  const table = parseCsv(await readFile(file(manifest.sources[src.id]), "utf8"));
  assert.deepEqual(table.head, ["participant", ...FIELDS]);
  assert.deepEqual(table.rows.map((r) => r[0]).sort(), study.participants.map((p) => p.id).sort());
  const allowed: Record<string, string[]> = {
    vr_experience: ["none", "occasional", "regular"],
    prior_haptic_devices: ["none", "controller rumble", "haptic gloves"],
    motion_sickness_susceptibility: ["low", "medium", "high"],
    dominant_hand: ["right", "left"],
  };
  const col = (f: string) => table.head.indexOf(f);
  for (const r of table.rows) {
    assert.ok(Number.isInteger(Number(r[col("age")])) && Number(r[col("age")]) >= 18, r.join());
    for (const [f, values] of Object.entries(allowed)) assert.ok(values.includes(r[col(f)]), `${r[0]} ${f}=${r[col(f)]}`);
  }
  // Varied: every value of every categorical field occurs.
  for (const [f, values] of Object.entries(allowed)) assert.deepEqual([...new Set(table.rows.map((r) => r[col(f)]))].sort(), [...values].sort(), f);
  // Roughly balanced but not identical: each group has every VR experience level, and the group profiles differ.
  const group = new Map(study.participants.map((p) => [p.id, p.conditionOrder[0]]));
  const profile = (d: string, f: string) => JSON.stringify(allowed[f].map((v) => table.rows.filter((r) => group.get(r[0]) === d && r[col(f)] === v).length));
  for (const d of DESIGNS) assert.ok(allowed.vr_experience.every((v) => table.rows.some((r) => group.get(r[0]) === d && r[col("vr_experience")] === v)), d);
  for (const f of ["vr_experience", "prior_haptic_devices"]) assert.ok(new Set(DESIGNS.map((d) => profile(d, f))).size > 1, f);
  // The background never names a measure.
  assert.ok(FIELDS.every((f) => !study.outcomes.some((o) => o.id === f || o.label.toLowerCase() === f)));
});

test("haptic buttons (between): the evidence note and the brief pass the outcome-blind leak check", async () => {
  const { study } = await load();
  for (const name of ["evidence/tactile-feedback-note.md", "agent-brief.md"]) {
    const check = await leakCheck(id, study, await readFile(file(name), "utf8"));
    assert.equal(check.checkedAgainstHuman, true);
    assert.deepEqual({ ids: check.participantIds, matches: check.humanMeanMatches, predictions: check.predictions }, { ids: 0, matches: 0, predictions: [] }, name);
  }
});

test("haptic buttons (between): rerunning the generator and the converter reproduces the committed files byte for byte", { skip: !python && "Python not found" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "xr-haptic-between-"));
  try {
    await mkdir(join(dir, "data"));
    await copyFile(file("study.json"), join(dir, "study.json"));
    for (const s of ["generate_synthetic.py", "convert_to_human.py"]) {
      await copyFile(file(join("data", s)), join(dir, "data", s));
      const run = spawnSync(python!, [join(dir, "data", s)], { encoding: "utf8" });
      assert.equal(run.status, 0, `${s}: ${run.stderr}`);
    }
    const raw = (await readdir(file("data/raw"))).sort();
    assert.deepEqual(raw, ["background.csv", "participants.csv", "questionnaire.csv", "trials.csv"]);
    assert.deepEqual((await readdir(join(dir, "data", "raw"))).sort(), raw);
    for (const f of [...raw.map((r) => join("data", "raw", r)), "human.json"])
      assert.ok((await readFile(join(dir, f))).equals(await readFile(file(f))), `${f} differs after rerunning the scripts`);
  } finally {
    await removeDir(dir);
  }
});

test("haptic buttons (between): a frozen simulated campaign is analysed with independent-samples tests and scores significant group differences only", async () => {
  const { study, agents, human, comparisons } = await load();
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "haptic-between", new Date(Date.now() - 1000).toISOString());
  // Default runs: participants × 1 for every population configuration.
  assert.equal(c.jobs.length, agents.length * 36);
  const { report } = analyzeCampaign(c, human, [syntheticCampaignExecution(c).results], comparisons);
  assert.ok(report.audits.length === c.jobs.length && report.audits.every((a) => a.scoreable));
  assert.equal(report.pairRule, "significant");
  assert.equal(report.significantOnly, undefined);
  assert.ok(report.notes.some((n) => /Mann–Whitney U between the independent groups/.test(n)));
  const pairs = report.humanPairs!;
  assert.equal(pairs.length, study.outcomes.length * 3);
  assert.ok(pairs.every((p) => p.test === "Mann–Whitney U"));
  assert.ok(pairs.every((p) => p.used === (p.significant && p.meanA !== p.meanB)));
  const pair = (o: string, a: string, b: string) => pairs.find((p) => p.outcomeId === o && p.a === a && p.b === b)!;
  // At least one significant and one non-significant human group difference (the invented effects).
  assert.ok(pairs.some((p) => p.significant) && pairs.some((p) => !p.significant));
  assert.ok(pair("completion-time", "visual", "pulse").significant && pair("presence", "visual", "pulse").significant);
  assert.ok(!pair("completion-time", "buzz", "pulse").significant && !pair("presence", "buzz", "pulse").significant);
  // A measure without a significant pair is excluded for every configuration.
  for (const o of study.outcomes)
    if (!pairs.some((p) => p.outcomeId === o.id && p.used)) assert.ok(report.exclusions.some((e) => e.startsWith(`${o.label}:`)), o.id);
  // Absolute values against each group's 95% interval (n = 12), for every configuration × predicted measure × design.
  const fit = report.absoluteFit!;
  const predicted = agents.reduce((n, a) => n + (a.targets ?? study.outcomes.map((o) => o.id)).filter((t) => !a.inputs?.includes(t)).length, 0);
  assert.equal(fit.length, predicted * DESIGNS.length);
  for (const f of fit) {
    assert.equal(f.n, 12);
    assert.ok(f.low <= f.human && f.human <= f.high);
    assert.equal(f.inside, f.agent >= f.low - 1e-9 && f.agent <= f.high + 1e-9);
  }
  // The measured-data configuration is scored on subjective measures only; both planned comparisons are reported.
  assert.deepEqual([...new Set(report.summaries.filter((s) => s.agentId === "measured-inputs").map((s) => s.domain))], ["subjective"]);
  assert.equal(report.contrasts.length, 2);
  // Figures build on the between-subjects report and the human data.
  const ids = agents.map((a) => a.id);
  const labels = Object.fromEntries(agents.map((a) => [a.id, a.label]));
  assert.ok(agreementFigure(report, ids, "objective", labels));
  assert.ok(agreementFigure(report, ids, "subjective", labels));
  for (const o of study.outcomes) assert.ok(agentVsHumanFigure(study, report, ids, o.id, labels), o.id);
  assert.ok(correlationFigure(study, report, ids, labels));
  for (const o of study.outcomes) {
    const h = humanFigure(study, human, o.id);
    assert.ok(h.brackets.length === 3 && h.brackets.every((b) => b.test === "Mann–Whitney U"), o.id);
    assert.ok(h.groups.every((g) => g.stats.n === 12), o.id);
  }
});

test("haptic buttons (between): the invented background effects show in the invented data", async () => {
  const { human } = await load();
  const table = parseCsv(await readFile(file("data/raw/background.csv"), "utf8"));
  const vr = new Map(table.rows.map((r) => [r[0], r[table.head.indexOf("vr_experience")]]));
  const time = human.measurements.filter((m) => m.outcomeId === "completion-time");
  const geo = (level: string) => {
    const v = time.filter((m) => vr.get(m.participantId!) === level).map((m) => Math.log(m.value!));
    return Math.exp(v.reduce((s, x) => s + x, 0) / v.length);
  };
  assert.ok(geo("none") > geo("regular") * 1.3, `${geo("none")} vs ${geo("regular")}`);
});

test("haptic buttons (between): every file is UTF-8 with LF line ends, and the scripts write them that way", async () => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }))
      if (e.isDirectory()) await walk(join(dir, e.name));
      else files.push(join(dir, e.name));
  };
  await walk(folder);
  assert.ok(files.length >= 14, `found only ${files.length} files`);
  for (const f of files) {
    const bytes = await readFile(f);
    assert.ok(!bytes.includes(13), `${f} contains a carriage return`);
    assert.ok(!bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), `${f} starts with a BOM`);
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes), f);
  }
  const generator = await readFile(file("data/generate_synthetic.py"), "utf8");
  assert.match(generator, /lineterminator="\\n"/);
  assert.match(generator, /random\.Random\(\d+\)/);
  const converter = await readFile(file("data/convert_to_human.py"), "utf8");
  const opens = [...generator.split("\n"), ...converter.split("\n")].filter((line) => /\bopen\(/.test(line));
  assert.ok(opens.length >= 3);
  for (const line of opens) assert.match(line, /encoding="utf-8"/, line.trim());
});
