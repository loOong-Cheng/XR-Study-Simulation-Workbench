// Suite 4 (examples/material-cues): a synthetic WebXR study of material cues at two rendering
// qualities. Checks that its files stay valid and fair, that every participant's background is
// complete, that the seeded generator and the converter reproduce the committed data byte for byte,
// that the background drives the invented outcomes as the README says, and that a frozen simulated
// campaign analyses and draws its figures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { freezePlan, minToolCalls, tokenBudgetWarning, withDefaultRuns } from "../src/core/planner.js";
import { mixedLevels, validateAgents, validateHumanData, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { fairnessWarnings } from "../src/core/fairness.js";
import { agentVsHumanFigure, agreementFigure, correlationFigure, humanFigure, populationVsIndividualFigure } from "../src/core/figures.js";
import { webxrActionWarnings, webxrCapabilities } from "../src/executor/runtimes.js";
import { parseCsv, participantProblems } from "../src/participant-knowledge.js";
import type { AgentProtocol, Comparison, HumanData, Study } from "../src/core/types.js";
import type { WorkspaceManifest } from "../src/workspace.js";

// Run from the repository root (npm test).
const ID = "examples/material-cues";
const dir = resolve(ID);
const json = async <T>(p: string) => JSON.parse(await readFile(join(dir, p), "utf8")) as T;
const load = async () => {
  const study = validateStudy(await json<Study>("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const human = await json<HumanData>("human.json");
  return { study, agents, human };
};
const BACKGROUND = ["age_band", "vision_correction", "color_vision", "art_or_design_training", "vr_hours_total"];
const background = async () => {
  const table = parseCsv(await readFile(join(dir, "data/raw/background.csv"), "utf8"));
  const at = (name: string) => table.head.indexOf(name);
  return new Map(table.rows.map((r) => [r[at("participant")], Object.fromEntries(BACKGROUND.map((f) => [f, r[at(f)]]))]));
};
/** Per participant and design, the value of a measure (composites as the mean of their items). */
const values = (human: HumanData, outcomeId: string) =>
  new Map(
    human.measurements
      .filter((m) => m.outcomeId === outcomeId)
      .map((m) => [`${m.participantId}|${m.conditionId}`, m.value ?? Object.values(m.components!).reduce((s, x) => s + x, 0) / Object.keys(m.components!).length]),
  );
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

test("suite 4: study, configurations and human data are valid, fair and within budget", async () => {
  const { study, agents, human } = await load();
  validateHumanData(study, human);
  assert.equal(study.synthetic, true);
  assert.equal(human.synthetic, true);
  assert.equal(study.design, "within-subjects");
  assert.deepEqual(study.conditions.map((c) => c.id), ["low", "high"]);
  // 16 people, counterbalanced: 8 low → high and 8 high → low.
  assert.equal(study.participants.length, 16);
  const orders = study.participants.map((p) => p.conditionOrder.join("|"));
  assert.equal(orders.filter((o) => o === "low|high").length, 8);
  assert.equal(orders.filter((o) => o === "high|low").length, 8);
  // One record per participant × design × measure, nothing missing.
  assert.equal(human.measurements.length, 16 * 2 * study.outcomes.length);
  assert.ok(study.outcomes.length >= 5 && study.outcomes.length <= 7);
  // Ranges where the unit implies them; the wrong selections are a whole-number count.
  for (const id of ["search-time", "identification-accuracy", "presence", "appeal"]) assert.ok(study.outcomes.find((o) => o.id === id)!.range, id);
  assert.equal(study.outcomes.find((o) => o.id === "wrong-selections")!.scale, "count");
  assert.equal(study.outcomes.find((o) => o.id === "search-time")!.aggregation, "geometric");
  // Configurations: one model and effort for all, token budgets at least the minimum and above the planner's estimate.
  assert.ok(agents.length >= 5 && agents.length <= 7);
  for (const a of agents) {
    assert.deepEqual(a.model, { provider: "claude-code", model: "claude-opus-5-5", reasoning: "default" }, a.id);
    assert.ok((a.maxTokens ?? 0) >= 20_000, a.id);
    assert.equal(tokenBudgetWarning(study, a), null, a.id);
  }
  assert.ok(minToolCalls(study, agents.find((a) => a.id === "app-only")!).min > 0);
  assert.deepEqual(agents.filter((a) => a.level === "individual").map((a) => a.id).sort(), ["knows-participant", "knows-participant-evidence"]);
  assert.ok(agents.filter((a) => a.sourceIds.includes("background")).every((a) => a.level === "individual"));
  assert.deepEqual(agents.find((a) => a.id === "app-only")!.sourceIds, ["brief"], "app-only gets the brief and the app, not the files");
  const measured = agents.find((a) => a.id === "text-with-task-data")!;
  assert.ok(measured.inputs!.every((id) => study.outcomes.find((o) => o.id === id)!.domain === "objective"));
  assert.ok(measured.targets!.every((id) => study.outcomes.find((o) => o.id === id)!.domain === "subjective"));
  // Comparisons: known configurations, one level each; no fairness warning (research question, model confounds).
  const comparisons = await json<Comparison[]>("comparisons.json");
  assert.ok(comparisons.length >= 2 && comparisons.length <= 3);
  for (const c of comparisons) {
    assert.ok(agents.some((a) => a.id === c.candidate) && agents.some((a) => a.id === c.baseline), JSON.stringify(c));
    assert.equal(mixedLevels(study, agents, c), null);
  }
  assert.deepEqual(fairnessWarnings(study, agents, comparisons), []);
  // The app declares what the study requires, and every required action is one the runtime records.
  const manifest = await json<WorkspaceManifest>("workspace.json");
  const caps = webxrCapabilities(manifest);
  for (const c of study.runtime.requiredCapabilities) assert.ok(caps.includes(c), c);
  assert.deepEqual(webxrActionWarnings(study, agents, manifest), []);
  // Every source exists inside the suite; none is the human data.
  for (const [id, path] of Object.entries(manifest.sources ?? {})) {
    assert.ok(study.sources.some((s) => s.id === id), id);
    assert.ok(existsSync(join(dir, path)) && !/human\.json/i.test(path), path);
  }
});

test("suite 4: every participant has a complete, varied background", async () => {
  const { study } = await load();
  const src = study.sources.find((s) => s.kind === "demographics")!;
  assert.deepEqual(src.fields, BACKGROUND);
  // The framework's own completeness check (configurations that get it would be blocked otherwise).
  assert.deepEqual(participantProblems(study, "demographics", join(dir, "data/raw/background.csv"), src.fields!), []);
  const people = await background();
  assert.deepEqual([...people.keys()].sort(), study.participants.map((p) => p.id).sort());
  for (const [id, row] of people) {
    for (const f of BACKGROUND) assert.ok(row[f] && !/^(na|n\/a|nan|null|\?)$/i.test(row[f].trim()), `${id} ${f}`);
    assert.ok(Number.isFinite(Number(row.vr_hours_total)) && Number(row.vr_hours_total) >= 0, `${id} vr_hours_total`);
  }
  const kinds = (f: string) => new Set([...people.values()].map((r) => r[f]));
  assert.deepEqual([...kinds("vision_correction")].sort(), ["contacts", "glasses", "none"]);
  assert.deepEqual([...kinds("art_or_design_training")].sort(), ["none", "professional", "some"]);
  assert.ok(kinds("age_band").size >= 3);
  assert.equal([...people.values()].filter((r) => r.color_vision === "deficient").length, 2);
});

test("suite 4: the seeded generator and the converter reproduce the committed files byte for byte", async (t) => {
  if (spawnSync("python3", ["--version"]).status !== 0) return t.skip("python3 is not available");
  const tmp = await mkdtemp(join(tmpdir(), "xr-material-cues-"));
  try {
    await mkdir(join(tmp, "data"));
    await copyFile(join(dir, "study.json"), join(tmp, "study.json"));
    for (const f of ["generate_synthetic.py", "convert_to_human.py"]) await copyFile(join(dir, "data", f), join(tmp, "data", f));
    for (const f of ["generate_synthetic.py", "convert_to_human.py"]) {
      const run = spawnSync("python3", [join("data", f)], { cwd: tmp, encoding: "utf8" });
      assert.equal(run.status, 0, `${f}: ${run.stderr}`);
    }
    const committed = (await readdir(join(dir, "data/raw"))).sort();
    assert.deepEqual((await readdir(join(tmp, "data/raw"))).sort(), committed);
    assert.ok(committed.includes("background.csv"));
    for (const f of committed) assert.ok((await readFile(join(tmp, "data/raw", f))).equals(await readFile(join(dir, "data/raw", f))), `data/raw/${f} differs`);
    assert.ok((await readFile(join(tmp, "human.json"))).equals(await readFile(join(dir, "human.json"))), "human.json differs");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("suite 4: the background drives the invented outcomes, and some design differences are not significant", async () => {
  const { study, agents, human } = await load();
  const people = await background();
  const group = (outcomeId: string, design: string, field: string, value: string) => {
    const v = values(human, outcomeId);
    return mean([...people].filter(([, r]) => r[field] === value).map(([id]) => v.get(`${id}|${design}`)!));
  };
  // Colour-vision deficiency: the slight tint is the only cue at low quality.
  assert.ok(group("wrong-selections", "low", "color_vision", "deficient") > group("wrong-selections", "low", "color_vision", "normal") + 1);
  assert.ok(group("identification-accuracy", "low", "color_vision", "deficient") < group("identification-accuracy", "low", "color_vision", "normal"));
  // Art or design training: better identification at high quality; professionals like the flat look more.
  assert.ok(group("identification-accuracy", "high", "art_or_design_training", "professional") > group("identification-accuracy", "high", "art_or_design_training", "none"));
  assert.ok(group("appeal", "low", "art_or_design_training", "professional") > group("appeal", "low", "art_or_design_training", "none"));
  // The human data's paired tests (as the analyzer runs them): material measures differ, search time and presence do not.
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents.filter((a) => a.id === "text-only"), 1), 1, "2026-11-25T10:00:00.000Z"), undefined, "suite4-pairs", "2026-11-25T10:00:00.000Z");
  const { report } = analyzeCampaign(c, human, [syntheticCampaignExecution(c).results]);
  const pairs = new Map(report.significantOnly!.humanPairs.map((p) => [p.outcomeId, p]));
  for (const id of ["wrong-selections", "identification-accuracy", "appeal"]) assert.equal(pairs.get(id)!.significant, true, id);
  for (const id of ["search-time", "presence"]) assert.equal(pairs.get(id)!.significant, false, id);
});

test("suite 4: a frozen simulated campaign analyses without errors and its figures build", async () => {
  const { study, agents, human } = await load();
  const comparisons = await json<Comparison[]>("comparisons.json");
  const plan = freezePlan(study, withDefaultRuns(study, agents, 1), 1, "2026-11-25T10:00:00.000Z");
  // 5 population configurations × 16 runs, 2 individual configurations × 16 people.
  assert.equal(plan.jobs.length, 5 * 16 + 2 * 16);
  const c = campaignFromPlan(plan, undefined, "suite4", "2026-11-25T10:00:00.000Z");
  const run = syntheticCampaignExecution(c);
  assert.ok(run.results.runs.every((r) => r.status === "completed" && r.execution.synthetic));
  const { report } = analyzeCampaign(c, human, [run.results], comparisons);
  assert.ok(report.audits.every((a) => a.scoreable), JSON.stringify(report.audits.filter((a) => !a.scoreable)).slice(0, 500));
  assert.equal(report.contrasts.length, comparisons.length);
  assert.ok(!report.notes.some((n) => /Skipped \d+ comparison/.test(n)), report.notes.join("\n"));
  assert.deepEqual([...new Set(report.summaries.map((s) => s.level))].sort(), ["individual", "population"]);
  // The measured-inputs configuration is scored on its subjective targets only.
  assert.deepEqual([...new Set(report.summaries.filter((s) => s.agentId === "text-with-task-data").map((s) => s.domain))], ["subjective"]);
  // Figures: agreement, agent vs human per measure, correlation, population vs individual, human data alone.
  const ids = agents.map((a) => a.id);
  const labels = Object.fromEntries(agents.map((a) => [a.id, a.label]));
  for (const domain of ["objective", "subjective"] as const) {
    assert.ok(agreementFigure(report, ids, domain, labels));
    assert.ok(populationVsIndividualFigure(study, report, ids, domain, labels));
  }
  for (const o of study.outcomes) {
    assert.ok(agentVsHumanFigure(study, report, ids, o.id, labels), o.id);
    assert.ok(humanFigure(study, human, o.id), o.id);
  }
  assert.ok(correlationFigure(study, report, ids, labels));
});

test("suite 4: files use LF line endings and the app runs offline", async () => {
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }))
      if (e.isDirectory()) {
        if (!["vendor", "campaigns", "runs", "deleted"].includes(e.name)) await walk(join(d, e.name));
      } else if ([".json", ".csv", ".md", ".py", ".js", ".html"].includes(extname(e.name))) files.push(join(d, e.name));
  };
  await walk(dir);
  assert.ok(files.length >= 15, `found only ${files.length} files`);
  const withCr = [];
  for (const f of files) if ((await readFile(f)).includes(13)) withCr.push(f);
  assert.deepEqual(withCr, [], "these files contain carriage returns; write them with LF");
  const generator = await readFile(join(dir, "data/generate_synthetic.py"), "utf8");
  assert.match(generator, /lineterminator="\\n"/);
  for (const name of ["generate_synthetic.py", "convert_to_human.py"])
    for (const line of (await readFile(join(dir, "data", name), "utf8")).split("\n").filter((l) => /\bopen\(/.test(l))) assert.match(line, /encoding="utf-8"/, `${name}: ${line.trim()}`);
  // three.js is vendored; nothing is loaded from the network.
  const html = await readFile(join(dir, "webxr-app/index.html"), "utf8");
  assert.doesNotMatch(html, /https?:\/\//);
  for (const f of ["build/three.module.js", "examples/jsm/controls/OrbitControls.js", "examples/jsm/webxr/VRButton.js", "examples/jsm/environments/RoomEnvironment.js", "LICENSE"])
    assert.ok(existsSync(join(dir, "webxr-app/vendor/three", f)), f);
  const main = await readFile(join(dir, "webxr-app/main.js"), "utf8");
  for (const [, from] of main.matchAll(/^import .* from "([^"]+)";$/gm)) assert.match(from, /^(three|three\/addons\/.+|\.\/[\w.-]+)$/, from);
  // The window.xrStudy contract for the declared capabilities: look, pointer-select, actions, phase-events.
  for (const fn of ["getState", "start", "listObjects", "select", "act", "look"]) assert.match(main, new RegExp(`\\b${fn}[:,]`), fn);
});
