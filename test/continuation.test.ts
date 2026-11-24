import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze } from "../src/core/analyzer.js";
import {
  campaignFiles,
  campaignFromPlan,
  campaignPlan,
  campaignStatus,
  campaignSummary,
  continueCampaign,
  continueFromStatus,
  freezeCampaign,
  verifyCampaign,
  verifyContinuation,
  type Campaign,
  type CampaignReceipt,
} from "../src/core/campaign.js";
import {
  analyzeCampaign,
  syntheticCampaignExecution,
} from "../src/core/campaign-study.js";
import { compareCampaignScores } from "../src/core/campaign-comparison.js";
import { syntheticCampaignSuite } from "../src/core/campaign-presets.js";
import {
  exampleStudy,
  syntheticHumanData,
  syntheticResults,
} from "../src/core/example.js";
import { freezePlan, hash, proposeAgents } from "../src/core/planner.js";

const modelA = { provider: "mock", model: "model-a", reasoning: "high" };
const modelB = { provider: "mock", model: "model-b", reasoning: "high" };
const t0 = "2026-11-23T10:00:00.000Z";
const t1 = "2026-11-24T10:00:00.000Z";
const t2 = "2026-11-25T10:00:00.000Z";
async function planned(repetitions = 2) {
  const study = exampleStudy();
  return freezePlan(study, await proposeAgents(study), repetitions, t0);
}

test("planner output becomes a campaign with the same protocols, jobs and analyzer scores", async () => {
  const plan = await planned(3);
  const c = campaignFromPlan(plan, modelA, "base", t0);
  verifyCampaign(c);
  assert.equal(c.jobs.length, plan.jobs.length);
  assert.deepEqual(
    c.suite.conditions.map((x) => x.id),
    plan.agents.map((a) => a.id),
  );
  const files = campaignFiles(c);
  assert.equal(
    Object.keys(files).filter((f) => f.startsWith("jobs/")).length,
    plan.jobs.length,
  );
  const packet = JSON.parse(files[`jobs/${c.jobs[0].id}.json`]);
  assert.equal(packet.planDigest, c.digest);
  assert.deepEqual(packet.protocol.model, modelA);
  // Same synthetic forecasts through both paths give identical scores.
  const human = syntheticHumanData(plan.study);
  const samePlan = freezePlan(
    plan.study,
    plan.agents.map((a) => ({ ...a, model: modelA })),
    3,
    t0,
  );
  const direct = analyze(samePlan, human, syntheticResults(samePlan));
  const viaCampaign = analyzeCampaign(c, human, [
    syntheticResults(campaignPlan(c)),
  ]);
  assert.deepEqual(
    viaCampaign.report.summaries.map((s) => [s.agentId, s.domain, s.agreement]),
    direct.summaries.map((s) => [s.agentId, s.domain, s.agreement]),
  );
});

test("continuation adds a new model arm and repetitions while reusing every unchanged run", async () => {
  const base = campaignFromPlan(await planned(), modelA, "base", t0);
  const next = continueCampaign(
    base,
    {
      cloneConditions: [{ from: "uses-app", id: "uses-app-b", model: modelB }],
      repetitions: { "reads-project": 4 },
      addContrasts: [
        {
          id: "experience-model-b-vs-a",
          baseline: "uses-app",
          candidate: "uses-app-b",
          domain: "subjective",
        },
      ],
    },
    "step2",
    t1,
  );
  verifyContinuation(base, next);
  const summary = campaignSummary(next);
  assert.equal(summary.reusedJobs, base.jobs.length);
  assert.equal(summary.newLlmSessions, 2 + 2); // uses-app-b r1–r2, reads-project r3–r4
  assert.deepEqual(next.conditionModels, { "uses-app-b": modelB });
  assert.ok(
    next.jobs
      .filter((j) => j.inheritedFrom)
      .every((j) => j.inheritedFrom!.campaignDigest === base.digest),
  );
  const files = campaignFiles(next);
  assert.equal(files["run-queue.jsonl"].trim().split("\n").length, 4);
  assert.ok(files["worker/CONTINUATION.md"].includes("model-b"));
  assert.ok(!files[`jobs/${next.jobs.find((j) => j.inheritedFrom)!.id}.json`]);
});

test("a changed default model reruns model jobs only; deterministic references are reused", () => {
  const old = freezeCampaign(syntheticCampaignSuite(), modelA, null, "eco1", t0);
  const next = continueCampaign(old, { model: modelB }, "eco2", t1);
  const reused = next.jobs.filter((j) => j.inheritedFrom);
  assert.deepEqual(
    [...new Set(reused.map((j) => j.conditionId))].sort(),
    ["E", "E0"],
  );
  // U0 depends on the new D, so it is not reused.
  assert.ok(next.jobs.filter((j) => j.conditionId === "U0").every((j) => !j.inheritedFrom));
  // Keeping D on the old model reuses D and therefore its derived U0 profiles.
  const mixed = continueCampaign(
    old,
    { model: modelB, conditionModels: { D: modelA } },
    "eco3",
    t1,
  );
  assert.ok(
    mixed.jobs
      .filter((j) => ["D", "U0"].includes(j.conditionId))
      .every((j) => j.inheritedFrom),
  );
  assert.throws(() => continueCampaign(old, { dropConditions: ["D"] }), /U0/);
  assert.throws(
    () => continueCampaign(old, { repetitions: { A: 3 } }),
    /cannot be removed/,
  );
  assert.throws(() => continueCampaign(old, { note: "nothing" }), /at least one change/);
});

test("lineage status accepts ancestor receipts for reused jobs and retries failures", async () => {
  const base = campaignFromPlan(await planned(), modelA, "base", t0);
  const failed = base.jobs.find((j) => j.conditionId === "reads-project")!.id;
  const run1 = syntheticCampaignExecution(base, { failJobIds: [failed] });
  const s1 = campaignStatus(base, run1.receipts);
  assert.deepEqual(s1.runnable, [failed]);
  const next = continueFromStatus(
    base,
    run1.receipts,
    { cloneConditions: [{ from: "text-only", id: "text-only-b", model: modelB }] },
    "step2",
    t1,
  );
  verifyContinuation(base, next);
  const retried = next.jobs.find((j) => j.templateJobId === failed.split("--")[1])!;
  assert.equal(retried.inheritedFrom, undefined);
  const run2 = syntheticCampaignExecution(next);
  assert.equal(run2.results.runs.length, 1 + 2);
  const s2 = campaignStatus(next, [...run1.receipts, ...run2.receipts]);
  assert.deepEqual(s2.counts, { completed: next.jobs.length });
  assert.equal(s2.ignoredAncestorReceipts, 1); // the superseded failed attempt
  // Without the ancestor receipts, reused jobs are visibly unresolved, not runnable.
  const partial = campaignStatus(next, run2.receipts);
  assert.equal(partial.runnable.length, 0);
  assert.ok(partial.counts["inherited-missing-receipt"] > 0);
  // Unrelated campaigns are still rejected.
  const other = campaignFromPlan(await planned(), modelA, "other", t0);
  assert.throws(
    () => campaignStatus(next, syntheticCampaignExecution(other).receipts),
    /another campaign/,
  );
});

test("three-step lineage analyzes once over all bundles and points reuse at the executing campaign", async () => {
  const plan = await planned();
  const human = syntheticHumanData(plan.study);
  const c1 = campaignFromPlan(plan, modelA, "c1", t0);
  const r1 = syntheticCampaignExecution(c1);
  const c2 = continueCampaign(c1, { cloneConditions: [{ from: "uses-app", id: "uses-app-b", model: modelB }] }, "c2", t1);
  const r2 = syntheticCampaignExecution(c2);
  const c3 = continueCampaign(c2, { repetitions: { "uses-app-b": 3, "uses-app": 3 } }, "c3", t2);
  const r3 = syntheticCampaignExecution(c3);
  assert.equal(r3.results.runs.length, 2);
  assert.ok(
    c3.jobs
      .filter((j) => j.conditionId === "uses-app" && j.repetition < 3)
      .every((j) => j.inheritedFrom?.campaignId === "c1"),
  );
  const status = campaignStatus(c3, [...r1.receipts, ...r2.receipts, ...r3.receipts]);
  assert.deepEqual(status.counts, { completed: c3.jobs.length });
  const result = analyzeCampaign(c3, human, [r1.results, r2.results, r3.results]);
  assert.equal(result.reused.length, c3.jobs.length - 2);
  assert.ok(result.report.audits.every((a) => a.scoreable && a.compliant));
  const eb = result.report.summaries.find(
    (s) => s.agentId === "uses-app-b" && s.domain === "subjective",
  )!;
  assert.equal(eb.scoreable, 3);
  // Missing an ancestor bundle leaves its jobs unreturned rather than silently dropped.
  const partial = analyzeCampaign(c3, human, [r3.results]);
  assert.ok(partial.report.audits.filter((a) => !a.completed).length > 0);
  assert.throws(() => analyzeCampaign(c3, human, [r3.results, r3.results]), /Duplicate/);
});

test("scorecards compare reused, changed and added conditions without fabricating deltas", async () => {
  const plan = await planned();
  const human = syntheticHumanData(plan.study);
  const c1 = campaignFromPlan(plan, modelA, "c1", t0);
  const r1 = syntheticCampaignExecution(c1);
  const c2 = continueCampaign(
    c1,
    {
      conditionModels: { "uses-app": modelB },
      cloneConditions: [{ from: "reads-project", id: "reads-project-b", model: modelB }],
    },
    "c2",
    t1,
  );
  const r2 = syntheticCampaignExecution(c2);
  const a1 = analyzeCampaign(c1, human, [r1.results]);
  const a2 = analyzeCampaign(c2, human, [r1.results, r2.results]);
  const cmp = compareCampaignScores(c1, a1.scorecard, c2, a2.scorecard);
  const row = (id: string, d = "subjective") =>
    cmp.rows.find((r) => r.conditionId === id && r.domain === d)!;
  assert.equal(row("text-only").status, "comparable");
  assert.equal(row("text-only").changePercentagePoints, 0); // fully reused
  assert.equal(row("uses-app").modelChanged, true);
  assert.deepEqual(row("uses-app").modelChanges, ["model"]);
  assert.equal(row("uses-app").afterModel, "model-b, effort high");
  assert.equal(row("reads-project-b").status, "added");
  assert.equal(row("reads-project-b").changePercentagePoints, null);
  // A different human reference cannot be compared.
  const otherHuman = structuredClone(human);
  otherHuman.measurements[0].value = (otherHuman.measurements[0].value ?? 0) + 1;
  const a3 = analyzeCampaign(c2, otherHuman, [r1.results, r2.results]);
  assert.throws(
    () => compareCampaignScores(c1, a1.scorecard, c2, a3.scorecard),
    /Human reference/,
  );
});

test("forged reuse and stale runs are detected", async () => {
  const c1 = campaignFromPlan(await planned(), modelA, "c1", t0);
  const c2 = continueCampaign(c1, { model: modelB }, "c2", t1);
  assert.equal(c2.jobs.filter((j) => j.inheritedFrom).length, 0);
  // Claiming reuse of a job whose model changed: internally consistent, but not derivable from the parent.
  const forged = structuredClone(c2) as Campaign;
  forged.jobs[0].inheritedFrom = {
    campaignDigest: c1.digest,
    campaignId: c1.id,
    createdAt: c1.createdAt,
    jobId: c1.jobs[0].id,
  };
  const { digest: _d, ...body } = forged;
  forged.digest = hash(body);
  verifyCampaign(forged);
  assert.throws(() => verifyContinuation(c1, forged), /does not follow/);
  // Results from the parent cannot stand in for the new model's fresh jobs.
  const human = syntheticHumanData(c1.suite.study!);
  const r1 = syntheticCampaignExecution(c1);
  const report = analyzeCampaign(c2, human, [r1.results]);
  assert.equal(report.ignoredRuns, r1.results.runs.length);
  assert.ok(report.report.audits.every((a) => !a.completed));
});

test("receipts satisfy the effective per-condition model, not only the campaign default", async () => {
  const c1 = campaignFromPlan(await planned(), modelA, "c1", t0);
  const c2 = continueCampaign(c1, { cloneConditions: [{ from: "text-only", id: "text-only-b", model: modelB }] }, "c2", t1);
  const r = syntheticCampaignExecution(c2).receipts;
  const wrong: CampaignReceipt = { ...r[0], actualModel: modelA };
  const s = campaignStatus(c2, [wrong]);
  assert.equal(s.jobs.find((j) => j.jobId === wrong.jobId)!.state, "audit-required");
});

test("model arms: labels name the model and effort, stay unique, and follow a model change", async () => {
  const base = campaignFromPlan(await planned(), modelA, "base", t0);
  const label = base.suite.conditions.find((c) => c.id === "text-only")!.label;
  const sonnet = (reasoning: string, model = "claude-sonnet-5-5") => ({ provider: "claude-code", model, reasoning });
  const c2 = continueCampaign(
    base,
    {
      cloneConditions: [
        { from: "text-only", id: "text-only-high", model: sonnet("effort=high") },
        { from: "text-only", id: "text-only-max", model: sonnet("effort=max") },
        { from: "text-only", id: "text-only-again", model: sonnet("high") },
        { from: "text-only", id: "text-only-typo", model: sonnet("default", "claude-sonet-5-5") },
        { from: "text-only", id: "text-only-mine", label: "  My sonnet arm ", model: sonnet("effort=low") },
      ],
    },
    "c2",
    t1,
  );
  const labelOf = (c: Campaign, id: string) => c.suite.conditions.find((x) => x.id === id)!.label;
  assert.equal(labelOf(c2, "text-only-high"), `${label} — claude-sonnet-5-5, effort high`);
  assert.equal(labelOf(c2, "text-only-max"), `${label} — claude-sonnet-5-5, effort max`);
  assert.equal(labelOf(c2, "text-only-again"), `${label} — claude-sonnet-5-5, effort high (2)`, "unique within the campaign");
  assert.equal(labelOf(c2, "text-only-typo"), `${label} — claude-sonet-5-5`, "default effort is not named");
  assert.equal(labelOf(c2, "text-only-mine"), "My sonnet arm");
  // The protocol carries the same label, and the generated labels are recorded in the change set.
  assert.equal(c2.suite.conditions.find((x) => x.id === "text-only-max")!.recipe.protocol!.label, labelOf(c2, "text-only-max"));
  assert.equal(c2.continuation!.cloneConditions![0].label, labelOf(c2, "text-only-high"));
  verifyContinuation(base, c2);
  // A typed label that another configuration already has is refused.
  assert.throws(
    () => continueCampaign(base, { cloneConditions: [{ from: "text-only", id: "dup", label: label.toUpperCase(), model: modelB }] }),
    /already used by text-only/,
  );
  // Fixing the typo'd model updates its generated label; a typed label stays; other runs are still reused.
  const c3 = continueCampaign(
    c2,
    { conditionModels: { "text-only-typo": sonnet("effort=high"), "text-only-mine": sonnet("effort=max") } },
    "c3",
    t2,
  );
  assert.equal(labelOf(c3, "text-only-typo"), `${label} — claude-sonnet-5-5, effort high (3)`);
  assert.equal(labelOf(c3, "text-only-mine"), "My sonnet arm");
  assert.deepEqual(c3.continuation!.labels, { "text-only-typo": labelOf(c3, "text-only-typo") });
  assert.ok(c3.jobs.filter((j) => j.conditionId === "text-only-typo").every((j) => !j.inheritedFrom));
  assert.ok(c3.jobs.filter((j) => j.conditionId === "text-only-high").every((j) => j.inheritedFrom));
  verifyContinuation(c2, c3);
  // A rename keeps the configuration's runs: a label is a name, not part of the setup.
  const renamed = continueCampaign(c3, { labels: { "text-only-max": "Sonnet, max effort" } }, "c4", t2);
  assert.equal(labelOf(renamed, "text-only-max"), "Sonnet, max effort");
  assert.ok(renamed.jobs.every((j) => j.inheritedFrom));
  assert.throws(() => continueCampaign(c3, { labels: { "text-only-max": label } }), /already used/);
});

test("continuations made before labels were recorded still verify", async () => {
  const base = campaignFromPlan(await planned(), modelA, "base", t0);
  const label = base.suite.conditions.find((c) => c.id === "uses-app")!.label;
  // What an earlier version wrote: the label named only the model, and the change set had no label.
  const made = continueCampaign(
    base,
    { cloneConditions: [{ from: "uses-app", id: "uses-app-b", label: `${label} — model-b`, model: modelB }] },
    "old-child",
    t1,
  );
  const legacy = structuredClone(made) as Campaign;
  delete legacy.continuation!.cloneConditions![0].label;
  const { digest: _d, ...body } = legacy;
  legacy.digest = hash(body);
  verifyCampaign(legacy);
  verifyContinuation(base, legacy);
});

test("continuing from receipts: only accepted forecasts are reused; simulated runs run again unless kept", async () => {
  const base = campaignFromPlan(await planned(), modelA, "base", t0);
  const llm = base.jobs.filter((j) => j.kind === "llm");
  const [failed, neverRun, simulated] = [llm[0].id, llm[1].id, llm[2].id];
  const run = syntheticCampaignExecution(base, { failJobIds: [failed] });
  const receipts = run.receipts.filter((r) => r.jobId !== neverRun);
  const template = (jobId: string) => base.jobs.find((j) => j.id === jobId)!.templateJobId;
  const fresh = (c: Campaign) => c.jobs.filter((j) => !j.inheritedFrom).map((j) => j.templateJobId).sort();
  const changes = { repetitions: { "text-only": 3 } };
  const extra = (c: Campaign) => c.jobs.filter((j) => j.conditionId === "text-only" && j.repetition === 3).map((j) => j.templateJobId);
  const plain = continueFromStatus(base, receipts, changes, "c2", t1);
  assert.deepEqual(fresh(plain), [template(failed), template(neverRun), ...extra(plain)].sort());
  // Simulated runs are treated like sessions that never ran, unless they are kept.
  const replaced = continueFromStatus(base, receipts, changes, "c2", t1, { simulatedJobIds: [simulated] });
  assert.deepEqual(fresh(replaced), [template(failed), template(neverRun), template(simulated), ...extra(replaced)].sort());
  verifyContinuation(base, replaced);
  const kept = continueFromStatus(base, receipts, changes, "c2", t1, { simulatedJobIds: [simulated], keepSimulated: true });
  assert.deepEqual(fresh(kept), fresh(plain));
  // A continuation that reused never-run jobs (no receipt anywhere): with the whole lineage's
  // receipts in hand they run again instead of refusing.
  const blind = continueCampaign(base, changes, "blind", t1);
  assert.ok(blind.jobs.find((j) => j.templateJobId === template(neverRun))!.inheritedFrom);
  assert.throws(() => continueFromStatus(blind, receipts, { repetitions: { "text-only": 4 } }), /Supply the receipts/);
  const repaired = continueFromStatus(blind, receipts, { repetitions: { "text-only": 4 } }, "c3", t2, { receiptsComplete: true });
  assert.equal(repaired.jobs.find((j) => j.templateJobId === template(neverRun))!.inheritedFrom, undefined);
  assert.equal(repaired.jobs.find((j) => j.templateJobId === template(failed))!.inheritedFrom, undefined);
  assert.ok(repaired.jobs.find((j) => j.templateJobId === template(simulated))!.inheritedFrom, "a completed run is still reused");
});

test("campaign comparison: real runs are never set against simulated ones; effort is shown and compared by meaning", async () => {
  const plan = await planned();
  const human = syntheticHumanData(plan.study);
  const c1 = campaignFromPlan(plan, modelA, "c1", t0);
  const r1 = syntheticCampaignExecution(c1);
  // The text-only runs of c1 were real sessions (the study is synthetic, so they are scored).
  const realIds = new Set(c1.jobs.filter((j) => j.conditionId === "text-only").map((j) => j.id));
  r1.results.runs.forEach((r) => {
    if (realIds.has(r.jobId)) r.execution.synthetic = false;
  });
  const c2 = continueCampaign(
    c1,
    {
      rerunConditions: ["text-only"],
      conditionModels: {
        "uses-app": { ...modelA, reasoning: "max" },
        "reads-project": { ...modelA, reasoning: "effort=high" },
      },
    },
    "c2",
    t1,
  );
  const r2 = syntheticCampaignExecution(c2);
  const a1 = analyzeCampaign(c1, human, [r1.results]);
  const a2 = analyzeCampaign(c2, human, [r1.results, r2.results]);
  const cmp = compareCampaignScores(c1, a1.scorecard, c2, a2.scorecard);
  const row = (id: string) => cmp.rows.find((r) => r.conditionId === id && r.domain === "subjective")!;
  const text = row("text-only");
  assert.equal(text.status, "real-vs-simulated");
  assert.equal(text.comparable, false);
  assert.equal(text.changePercentagePoints, null);
  assert.equal(text.beforeRunKind, "real");
  assert.equal(text.afterRunKind, "simulated");
  assert.match(text.note!, /Not comparable: real runs before, simulated runs after/);
  const app = row("uses-app");
  assert.equal(app.status, "comparable");
  assert.deepEqual(app.modelChanges, ["effort"]);
  assert.equal(app.beforeModel, "model-a, effort high");
  assert.equal(app.afterModel, "model-a, effort max");
  assert.match(app.note!, /Changed effort: model-a, effort high → model-a, effort max/);
  assert.match(app.note!, /Simulated \(invented\) runs on both sides/);
  // "high" and "effort=high" are the same effort.
  assert.equal(row("reads-project").modelChanged, false);
  // One model per campaign only when every configuration uses it.
  assert.equal(cmp.beforeModel, "model-a, effort high");
  assert.equal(cmp.afterModel, null);
  assert.ok(cmp.notes.some((n) => /different models/.test(n)));
});
