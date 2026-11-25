import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyze,
  analyzeVerifiedPlan,
  directionalAgreement,
  holmAdjust,
  meanInterval,
} from "../src/core/analyzer.js";
import {
  holm,
  mannWhitney,
  ranks,
  smallestMannWhitneyP,
  smallestWilcoxonP,
  studentTQuantile,
  t975,
  wilcoxonSignedRank,
} from "../src/core/rank-tests.js";
import { agreementBetween, directional } from "../src/core/agent-comparison.js";
import {
  exampleStudy,
  syntheticHumanData,
  syntheticResults,
} from "../src/core/example.js";
import {
  freezePlan,
  handoffFiles,
  proposeAgents,
  protocolForJob,
  verifyPlan,
} from "../src/core/planner.js";
import {
  auditRun,
  ProtocolGate,
  UnavailableRuntime,
} from "../src/core/protocol.js";
import { measurementValue, validateHumanData, validateStudy } from "../src/core/validation.js";
import { explainStudy, studyWarnings } from "../src/core/explain.js";
import { reportCSV, reportHTML } from "../src/core/report.js";
import type {
  AgentProtocol,
  ContrastScore,
  HumanData,
  Plan,
  ResultBundle,
  Study,
} from "../src/core/types.js";

const freezeDate = "2026-11-22T00:00:00.000Z";
async function example(
  reps = 2,
): Promise<{ plan: Plan; human: HumanData; results: ResultBundle }> {
  const s = exampleStudy();
  s.analysis.bootstrapDraws = 100;
  const plan = freezePlan(s, await proposeAgents(s), reps, freezeDate);
  return {
    plan,
    human: syntheticHumanData(s),
    results: syntheticResults(plan),
  };
}
async function known(
  n = 3,
  individual = false,
): Promise<{ plan: Plan; human: HumanData; results: ResultBundle }> {
  const s = exampleStudy();
  s.id = "known-order";
  s.predictionLevel = individual ? "individual" : "population";
  s.conditions = Array.from({ length: n }, (_, i) => ({
    id: "design-" + i,
    label: "Design " + i,
  }));
  s.cases = [];
  s.sources = s.sources.filter((x) => x.kind === "brief");
  s.participants = Array.from({ length: 4 }, (_, i) => ({
    id: "person-" + i,
    stratum: "one-order",
    conditionOrder: s.conditions.map((c) => c.id),
  }));
  s.outcomes = [
    {
      id: "duration",
      label: "Duration",
      domain: "objective",
      unit: "seconds",
      scale: "continuous",
      aggregation: "arithmetic",
      family: "performance",
      weight: 1,
      phaseIds: ["main"],
      description: "Completed task duration.",
    },
  ];
  s.analysis = {
    mode: "both",
    familyWeights: { performance: 1 },
    bootstrapDraws: 100,
    seed: 17,
    tieTolerance: 1e-8,
    contrasts: [],
  };
  const a = (await proposeAgents(s))[0],
    b: AgentProtocol = {
      ...structuredClone(a),
      id: "reverse",
      label: "Reversed ordering",
    };
  s.analysis.contrasts = [
    {
      id: "reverse-direct",
      baseline: a.id,
      candidate: b.id,
      domain: "objective",
    },
  ];
  const plan = freezePlan(s, [a, b], 2, freezeDate);
  const human: HumanData = {
    schemaVersion: "1.0",
    studyId: s.id,
    synthetic: true,
    measurements: s.participants.flatMap((p, pi) =>
      s.conditions.map((c, ci) => ({
        participantId: p.id,
        conditionId: c.id,
        outcomeId: "duration",
        value: individual && pi % 2 ? n - ci : ci + 1,
      })),
    ),
  };
  const results = syntheticResults(plan);
  for (const run of results.runs) {
    const job = plan.jobs.find((j) => j.id === run.jobId)!;
    const person = s.participants.findIndex((p) => p.id === job.participantId);
    run.measurements.forEach((r, ci) => {
      const v = individual && person % 2 ? n - ci : ci + 1;
      r.value = job.agentId === "reverse" ? n + 1 - v : v;
    });
  }
  return { plan, human, results };
}

test("directional scoring excludes human ties and treats forecast ties neutrally", () => {
  assert.deepEqual(directionalAgreement([1, 1, 2], [1, 2, 3]), {
    score: 1,
    pairs: 2,
  });
  assert.equal(directionalAgreement([1, 2, 3], [1, 1, 1]).score, 0.5);
  assert.equal(directionalAgreement([1, 1, 1], [1, 2, 3]).score, null);
  assert.equal(
    directionalAgreement([1, 1, 1], [1, 2, 3], 1e-8, [true, true, true]).score,
    0.5,
  );
});
test("random rankings have exactly 50% expected agreement over every 3-design permutation", () => {
  const p = [
    [1, 2, 3],
    [1, 3, 2],
    [2, 1, 3],
    [2, 3, 1],
    [3, 1, 2],
    [3, 2, 1],
  ];
  assert.ok(
    Math.abs(
      p.reduce((a, b) => a + directionalAgreement([1, 2, 3], b).score!, 0) /
        p.length -
        0.5,
    ) < 1e-12,
  );
});
test("five designs, perfect/reversed predictions, fixed-seed uncertainty and degenerate inference", async () => {
  const { plan, human, results } = await known(5);
  const r = analyze(plan, human, results);
  assert.equal(r.summaries[0].agreement, 1);
  assert.equal(r.summaries[1].agreement, 0);
  assert.deepEqual(r, analyze(plan, human, results));
  assert.equal(r.metrics[0].informativePairs, 10);
  assert.equal(r.contrasts[0].p, null);
  assert.match(r.contrasts[0].status, /degenerate/);
});
test("two designs work without a four-design assumption", async () => {
  const x = await known(2);
  const r = analyze(x.plan, x.human, x.results);
  assert.equal(r.metrics[0].informativePairs, 1);
  assert.equal(r.summaries[0].agreement, 1);
});
test("individual evaluation preserves person matching even when population means tie", async () => {
  const x = await known(3, true);
  const r = analyze(x.plan, x.human, x.results);
  assert.equal(r.summaries[0].agreement, 1);
  assert.equal(r.summaries[1].agreement, 0);
  assert.equal(r.metrics[0].informativeUnits, 4);
});
test("diagnostic repeats never replace an individual failed primary", async () => {
  const x = await known(3, true);
  x.results.runs = x.results.runs.filter(
    (r) => r.jobId !== "text-only-person-0-r1",
  );
  const r = analyze(x.plan, x.human, x.results);
  assert.equal(
    r.summaries.find((s) => s.agentId === "text-only")!.agreement,
    null,
  );
  assert.equal(r.summaries.find((s) => s.agentId === "text-only")!.assigned, 4);
});
test("between-subject population bootstrap preserves each condition group", async () => {
  const x = await known(3);
  const s = structuredClone(x.plan.study);
  s.design = "between-subjects";
  // Six people per group: enough for Mann–Whitney U to support each design difference after Holm.
  s.participants = Array.from({ length: 18 }, (_, i) => ({
    id: "p" + i,
    stratum: "condition-" + (i % 3),
    conditionOrder: [s.conditions[i % 3].id],
  }));
  const plan = freezePlan(s, x.plan.agents, 2, freezeDate);
  const human: HumanData = {
    schemaVersion: "1.0",
    studyId: s.id,
    synthetic: true,
    measurements: s.participants.map((p, i) => ({
      participantId: p.id,
      conditionId: p.conditionOrder[0],
      outcomeId: "duration",
      value: (i % 3) + 1,
    })),
  };
  const results = syntheticResults(plan);
  for (const run of results.runs)
    run.measurements.forEach((r, i) => {
      r.value = run.jobId.startsWith("text-only-") ? i + 1 : 3 - i;
    });
  const r = analyze(plan, human, results);
  assert.equal(r.summaries[0].agreement, 1);
  assert.deepEqual(r.summaries[0].ci95, { low: 1, high: 1 });
  assert.equal(r.pairRule, "significant");
  assert.ok(r.humanPairs!.every((p) => p.test === "Mann–Whitney U" && p.significant));
  // Two people per group cannot show a reliable difference (smallest two-sided p = 1/3): nothing is scored.
  const small = structuredClone(s);
  small.participants = s.participants.slice(0, 6);
  const smallPlan = freezePlan(small, x.plan.agents, 2, freezeDate);
  const smallHuman = { ...human, measurements: human.measurements.filter((m) => small.participants.some((p) => p.id === m.participantId)) };
  const rs = analyze(smallPlan, smallHuman, syntheticResults(smallPlan));
  assert.equal(rs.summaries[0].agreement, null);
  assert.ok(rs.exclusions.some((e) => /no design pair differs significantly/.test(e)));
  s.predictionLevel = "individual";
  assert.throws(() => validateStudy(s), /within-person/);
});
test("exact retained-item workload ignores Performance and rejects 5/6 proxies", () => {
  const s = exampleStudy(),
    r = {
      outcomeId: "workload",
      conditionId: "ray",
      components: {
        mental: 1,
        physical: 2,
        temporal: 3,
        effort: 4,
        frustration: 5,
        performance: 7,
      },
    };
  assert.equal(measurementValue(s, r), 3);
  assert.throws(
    () =>
      measurementValue(s, {
        outcomeId: "workload",
        conditionId: "ray",
        value: 3,
      }),
    /computed from its items .*every item needs a value/,
  );
  assert.throws(() => measurementValue(s, { ...r, value: 3.5 }), /does not match the mean of its items \(3\)/);
});
test("composites: item mean (default) or sum, with optional item weights, e.g. an SSQ total", () => {
  const s = exampleStudy();
  const base = s.outcomes.find((o) => o.id === "workload")!;
  const items = { nausea: 2, oculomotor: 3, disorientation: 1 };
  const ssq = { ...base, id: "ssq", label: "SSQ total", unit: "0–235.62", scale: "continuous" as const, range: [0, 235.62] as [number, number], components: Object.keys(items), componentRule: "sum" as const, componentWeights: { nausea: 3.74, oculomotor: 3.74, disorientation: 3.74 } };
  s.outcomes.push(ssq);
  s.analysis.familyWeights[ssq.family] ??= 1;
  const study = validateStudy(s);
  // The real SSQ total is (N + O + D) × 3.74 of the raw subscale sums.
  assert.ok(Math.abs(measurementValue(study, { outcomeId: "ssq", conditionId: "ray", components: items }) - 6 * 3.74) < 1e-12);
  assert.ok(Math.abs(measurementValue(study, { outcomeId: "ssq", conditionId: "ray", components: items, value: 22.44 }) - 22.44) < 1e-12);
  assert.throws(() => measurementValue(study, { outcomeId: "ssq", conditionId: "ray", components: items, value: 6 }), /does not match the weighted sum of its items/);
  assert.throws(() => measurementValue(study, { outcomeId: "ssq", conditionId: "ray", components: { nausea: 50, oculomotor: 10, disorientation: 10 } }), /outside its range 0–235\.62/);
  // A weighted mean divides by the sum of the weights.
  const mean = structuredClone(study);
  delete mean.outcomes.at(-1)!.componentRule;
  mean.outcomes.at(-1)!.componentWeights = { nausea: 1, oculomotor: 3, disorientation: 1 };
  assert.equal(measurementValue(validateStudy(mean), { outcomeId: "ssq", conditionId: "ray", components: items }), (2 + 9 + 1) / 5);
  // Plain messages for a wrong rule or wrong weights.
  const bad = (change: (o: Study["outcomes"][number]) => void) => {
    const x = structuredClone(study);
    change(x.outcomes.at(-1)!);
    return () => validateStudy(x);
  };
  assert.throws(bad((o) => ((o as { componentRule: string }).componentRule = "total")), /componentRule is "mean" \(the default\) or "sum"/);
  assert.throws(bad((o) => (o.componentWeights = { nausea: 3.74 })), /componentWeights needs a positive number for every item/);
  assert.throws(bad((o) => (o.componentWeights = { nausea: 1, oculomotor: 1, disorientation: 0 })), /componentWeights needs a positive number/);
  assert.throws(bad((o) => (delete o.components, delete o.componentWeights)), /has no items, so it needs no componentRule/);
});
test("target-only ties do not become directional success and absolute diagnostics survive", async () => {
  const x = await known(3);
  x.human.measurements.forEach((r) => {
    r.value = 2;
  });
  const r = analyze(x.plan, x.human, x.results);
  assert.equal(r.summaries[0].agreement, null);
  assert.equal(r.metrics[0].agreement, null);
  assert.ok(r.metrics[0].absoluteMAE! > 0);
  assert.ok(r.exclusions.length > 0);
});
test("protocol gate blocks premature forecasting, then closes irreversibly", async () => {
  const x = await example();
  const job = x.plan.jobs.find((j) => j.agentId === "uses-app")!;
  const run = x.results.runs.find((r) => r.jobId === job.id)!;
  const gate = new ProtocolGate(x.plan, job);
  assert.throws(() => gate.beginForecast(), /incomplete/);
  for (const e of run.trace.filter((e) => e.type !== "forecast"))
    gate.record(e);
  gate.beginForecast();
  assert.throws(
    () => gate.record({ type: "phase", phaseId: "main" }),
    /closed/,
  );
  assert.equal(gate.trace.at(-1)!.type, "forecast");
});
test("missing exposure remains in the main score and is disclosed separately", async () => {
  const x = await example();
  const damaged = syntheticResults(x.plan, true);
  const r = analyze(x.plan, x.human, damaged);
  const s = r.summaries.find((s) => s.agentId === "uses-app")!;
  assert.equal(s.scoreable, 2);
  assert.equal(s.compliant, 1);
  assert.notEqual(s.agreement, null);
  assert.ok(
    r.audits.some((a) => a.issues.some((t) => t.includes("No submission"))),
  );
});
test("stereo requires synchronized per-eye geometry, not two labels on a mono capture", async () => {
  const x = await example();
  const job = x.plan.jobs.find((j) => j.agentId === "uses-app")!;
  const run = structuredClone(x.results.runs.find((r) => r.jobId === job.id)!);
  const obs = run.trace.find((e) => e.type === "observation")!;
  if (obs.type !== "observation")
    throw new Error("Missing fixture observation");
  obs.captures[1].viewMatrix = obs.captures[0].viewMatrix;
  assert.equal(auditRun(x.plan, job, run).compliant, false);
  const original = structuredClone(
    x.results.runs.find((r) => r.jobId === job.id)!,
  );
  const second = original.trace.find((e) => e.type === "observation")!;
  if (second.type === "observation")
    second.captures[1].sha256 = second.captures[0].sha256;
  assert.equal(
    auditRun(x.plan, job, original).compliant,
    true,
    "Identical pixels can occur in a genuinely stereo scene; hashes are not a depth test.",
  );
});
test("source permissions, measurement identity and reused sessions are audited", async () => {
  const x = await example();
  const run = x.results.runs[0];
  run.trace.unshift({
    type: "source",
    sourceId: "hidden-human-answers",
    delivery: "read",
    sha256: "a".repeat(64),
  });
  const j = x.plan.jobs[0];
  assert.equal(auditRun(x.plan, j, run).compliant, false);
  x.results.runs[1].sessionId = run.sessionId;
  const r = analyze(x.plan, x.human, x.results);
  assert.ok(
    r.audits.filter((a) => a.issues.some((i) => i.includes("reused"))).length >=
      2,
  );
  x.results.runs[0].measurements[0].participantId = "someone-else";
  assert.equal(auditRun(x.plan, j, x.results.runs[0]).scoreable, false);
});
test("individual case packets follow each participant order", async () => {
  const s = exampleStudy();
  s.predictionLevel = "individual";
  s.analysis.bootstrapDraws = 100;
  const plan = freezePlan(s, await proposeAgents(s), 1, freezeDate);
  const job = plan.jobs.find(
    (j) =>
      j.agentId === "uses-app" && j.participantId === s.participants[1].id,
  )!;
  const ids = protocolForJob(plan, job).requiredCaseIds;
  const condition = s.cases.find((c) => c.id === ids[0])!.conditionId;
  assert.equal(condition, s.participants[1].conditionOrder[0]);
  const run = syntheticResults(plan).runs.find((r) => r.jobId === job.id)!;
  assert.equal(auditRun(plan, job, run).compliant, true);
});
test("frozen-plan tampering and duplicate selected outputs are rejected", async () => {
  const x = await example();
  const changed = structuredClone(x.plan);
  changed.study.title = "Changed after freeze";
  assert.throws(() => verifyPlan(changed), /integrity/);
  x.results.runs.push(x.results.runs[0]);
  assert.throws(() => analyze(x.plan, x.human, x.results), /Duplicate job/);
});
test("scope-limited job packets omit reference data and other agent recipes", async () => {
  const x = await example();
  const files = handoffFiles(x.plan);
  const packet = JSON.parse(files["jobs/text-only-r1.json"]);
  assert.equal(packet.task.analysis, undefined);
  assert.equal(packet.agents, undefined);
  assert.equal(packet.task.participants, undefined);
  assert.deepEqual(
    packet.task.sources.map((x: { id: string }) => x.id),
    ["brief"],
  );
  assert.equal(packet.task.orderContext.cohortSize, 12);
  assert.ok(!Object.keys(files).some((n) => n.includes("human")));
  const bad = exampleStudy() as Study & { humanData?: unknown };
  bad.humanData = x.human;
  assert.throws(() => validateStudy(bad), /separate/);
  const nested = exampleStudy();
  Object.assign(nested.participants[0], { answers: { rating: 7 } });
  assert.throws(() => validateStudy(nested), /Unknown participant/);
});
test("future target-experience inputs cannot be used for prospective forecasts", async () => {
  const s = exampleStudy();
  s.sources.push({
    id: "motion",
    kind: "trajectory",
    label: "Motion",
    description: "Target experience traces",
    fields: ["headPose", "leftHandPose", "rightHandPose"],
  });
  s.predictionTiming = "before-experience";
  const a = (await proposeAgents(exampleStudy()))[0];
  a.tools = ["read-participant-data"];
  a.sourceIds.push("motion");
  a.requiredSourceIds.push("motion");
  assert.throws(() => freezePlan(s, [a], 1, freezeDate), /before-experience/);
});
test("Holm correction includes the full declared family, including untestable contrasts", () => {
  const row = (p: number | null): ContrastScore => ({
    id: String(p),
    baseline: "a",
    candidate: "b",
    domain: "objective",
    declared: "in plan",
    difference: 0,
    ci95: null,
    p,
    holmP: null,
    status: "",
  });
  const rows = [row(0.01), row(0.04), row(null)];
  holmAdjust(rows);
  assert.equal(rows[0].holmP, 0.03);
  assert.equal(rows[1].holmP, 0.08);
  assert.equal(rows[2].holmP, null);
});
test("unavailable runtimes fail explicitly; reports escape labels", async () => {
  await assert.rejects(
    () => new UnavailableRuntime("Unity").describe(),
    /external adapter/,
  );
  const x = await known(2);
  const r = analyze(x.plan, x.human, x.results);
  r.title = "<script>alert(1)</script>";
  assert.ok(!reportHTML(r).includes("<script>"));
  r.summaries[0].agentId = "=1+1";
  assert.ok(reportCSV(r).includes("'=1+1"));
});
test("real-study drafts can be proposed, but freezing requires explicit model settings", async () => {
  const s = exampleStudy();
  s.synthetic = false;
  const agents = await proposeAgents(s);
  assert.ok(agents.length > 0);
  assert.throws(() => freezePlan(s, agents, 1, freezeDate), /placeholder/);
  agents.forEach((a) => {
    a.model = {
      provider: "research-provider",
      model: "pinned-model-version",
      reasoning: "high",
    };
  });
  const plan = freezePlan(s, agents, 1, freezeDate);
  assert.equal(plan.study.synthetic, false);
  assert.throws(() => syntheticResults(plan), /real execution/);
});
test("malformed trace metadata produces an audit deviation instead of dropping a numeric forecast", async () => {
  const x = await example();
  (x.results.runs[0] as unknown as { trace: unknown }).trace = {
    invalid: true,
  };
  const r = analyze(x.plan, x.human, x.results);
  assert.equal(r.audits[0].scoreable, true);
  assert.equal(r.audits[0].compliant, false);
});

// ---------- statistics: exact rank tests, near-ties, Holm, t quantile, intervals, bootstrap streams ----------
// Reference p-values: full enumeration of the conditional permutation distribution in R (midranks
// for ties, two-sided p = min(1, 2 × smaller tail)); R's exact wilcox.test where there are no ties.
const close = (actual: number | null, expected: number, tol = 1e-12) =>
  assert.ok(actual !== null && Math.abs(actual - expected) <= tol, `${actual} vs ${expected}`);
test("Mann–Whitney: exact conditional p-values with ties match a full permutation enumeration", () => {
  const cases: [number[], number[], number][] = [
    // Normal approximation gave .047, .013 and .137 here (anti-conservative).
    [[1, 1, 1], [2, 2, 2], 0.1],
    [[2, 2, 2, 2], [3, 3, 3, 3], 0.0285714285714286],
    [[1, 2, 2, 3], [2, 3, 4, 5], 0.2],
    [[4, 5, 5, 6, 7, 7], [2, 3, 3, 4, 4, 5], 0.0216450216450216],
    [[1, 2, 3, 3, 4, 5, 5, 5], [3, 4, 5, 6, 6, 7], 0.0832500832500832],
    [[5, 4, 3, 5, 5, 1, 5], [2, 1, 5, 1, 2], 0.133838383838384],
    [[1, 1, 1, 4], [5, 4, 2, 3, 5, 3, 2, 2, 2, 4, 4, 3, 4, 2], 0.077124183006536],
    [[5, 5], [5, 6], 1],
    [[1, 2, 3, 4, 5, 6], [7, 8, 9, 10, 11, 12], 2 / 924],
  ];
  for (const [a, b, p] of cases) {
    const r = mannWhitney(a, b);
    assert.equal(r.exact, true);
    close(r.p, p);
    close(mannWhitney(b, a).p, p);
  }
  // 21 + 20 untied values: R's exact wilcox.test.
  const x = [0.8, 0.83, 1.89, 1.04, 1.45, 1.38, 1.91, 1.64, 0.73, 1.46, 2.2, 2.31, 0.15, 3.3, 1.12, 0.47, 2.9, 1.7, 0.95, 1.51, 2.62],
    y = [1.15, 0.88, 0.9, 0.74, 1.21, 0.31, 0.62, 1.33, 1.02, 0.55, 0.68, 1.42, 0.12, 0.99, 0.27, 1.27, 0.41, 0.835, 1.77, 0.21];
  close(mannWhitney(x, y).p, 0.00220256083245124, 1e-14);
  // Every value tied: no test.
  assert.equal(mannWhitney([3, 3, 3], [3, 3, 3]).p, null);
  // Above the cutoff (n1 + n2 > 80): normal approximation with tie and continuity correction.
  const big = mannWhitney(Array.from({ length: 41 }, (_, i) => i % 7), Array.from({ length: 41 }, (_, i) => (i % 7) + 1));
  assert.equal(big.exact, false);
  assert.ok(big.p! > 0 && big.p! < 1);
});
test("Wilcoxon signed-rank: exact conditional p-values with ties, zeros dropped", () => {
  const cases: [number[], number][] = [
    // Normal approximation gave .037, .037, .073 and .020 for the first four.
    [[1, 1, 1, 1, 1], 0.0625],
    [[1, 1, 1, 1, 1, 0, 0], 0.0625],
    [[1, 2, 2, 3, -1, 4], 0.09375],
    [[1, 1, 1, 1, 1, 1], 0.03125],
    // n = 4: the smallest possible two-sided p is 2/16 = .125 (the approximation gave .072–.098).
    [[1, 2, 3, 4], 0.125],
    [[1, 1, 1, 1], 0.125],
    [[2, 3, -1, 4, 5, 0, 0], 0.125],
    [[1, 2, 4, 4, 4, 1, 3, -2, -1, 1, 4, 2, -2, -1, 3, 3, 3], 0.00604248046875],
    [[3, 2, 1, 3, 1, -2, -1, 4, 4, 4, 2, -1], 0.0302734375],
    // 31 untied differences: R's exact wilcox.test.
    [[-1, ...Array.from({ length: 29 }, (_, i) => i + 2), -31], 2.57417559623718e-6],
  ];
  for (const [d, p] of cases) {
    const r = wilcoxonSignedRank(d);
    assert.equal(r.exact, true);
    close(r.p, p, Math.max(1e-12, p * 1e-10));
  }
  assert.equal(wilcoxonSignedRank([0, 0, 0]).p, null);
  assert.equal(wilcoxonSignedRank([2]).p, null);
});
test("near-ties from floating-point noise are ties in the rank tests and in agent comparison", () => {
  // 3.4 − 2.6, 4.2 − 3.4, ... are all 0.8 up to 4e-16: five tied positive differences.
  const a = [3.4, 4.2, 2.6, 5.0, 3.8],
    b = [2.6, 3.4, 1.8, 4.2, 3.0];
  const d = a.map((x, i) => x - b[i]);
  assert.ok(new Set(d).size > 1, "the fixture has floating-point noise");
  assert.equal(wilcoxonSignedRank(d).p, wilcoxonSignedRank([1, 1, 1, 1, 1]).p);
  assert.equal(wilcoxonSignedRank(d, 1e-8).p, 0.0625);
  // |1/3 − 0.5| and |2/3 − 0.5| differ by 6e-17; agreement scores against chance.
  const agreement = [1 / 3, 2 / 3, 2 / 3, 2 / 3, 1, 1, 1 / 3, 2 / 3].map((v) => v - 0.5);
  close(wilcoxonSignedRank(agreement).p, 0.171875);
  assert.deepEqual(ranks([0.1 + 0.2, 0.3, 1]).tieGroups, [2]);
  assert.equal(mannWhitney([0.1 + 0.2, 0.3, 0.3], [0.6, 0.6, 0.1 * 6]).p, mannWhitney([1, 1, 1], [2, 2, 2]).p);
  // The study's tolerance: a difference of 1e-10 is zero (dropped) at tieTolerance 1e-8.
  assert.equal(wilcoxonSignedRank([1e-10, 2, 3], 1e-8).n, 2);
  // Agent comparison uses the tie tolerance too (it used 1e-12): both tied on a pair = agreement.
  assert.equal(directional([0, 1e-10, 1], [1e-10, 0, 1], 1e-8), 1);
  assert.equal(directional([0, 1e-10, 1], [1e-10, 0, 1], 1e-12), 2 / 3);
});
test("Holm: one function; untestable comparisons count in the family size", () => {
  const ps = [0.01, 0.04, 0.03, null, 0.005];
  const adjusted = holm(ps);
  [0.04, 0.09, 0.09, null, 0.025].forEach((p, i) => (p === null ? assert.equal(adjusted[i], null) : close(adjusted[i], p)));
  const rows = ps.map((p) => ({ p, holmP: null as number | null })) as unknown as ContrastScore[];
  holmAdjust(rows);
  assert.deepEqual(rows.map((r) => r.holmP), adjusted);
});
test("t quantile matches R's qt(0.975, df) for any df", () => {
  const r: [number, number][] = [
    [1, 12.706204736174692], [2, 4.302652729749462], [5, 2.570581835636314], [17, 2.109815577833317],
    [29, 2.045229642132703], [30, 2.042272456301238], [31, 2.039513446396408], [45, 2.014103388880847],
    [60, 2.00029782201426], [61, 1.999623584994939], [100, 1.983971518523552], [200, 1.971896223633908],
    [1000, 1.962339080826408],
  ];
  for (const [df, q] of r) close(t975(df), q, 1e-12);
  close(studentTQuantile(0.025, 10), -t975(10), 1e-14);
  assert.ok(Number.isNaN(t975(0)));
});
test("human intervals: bounded scales are clipped; identical values give a flagged zero-width interval", async () => {
  const s = exampleStudy();
  const accuracy = s.outcomes.find((o) => o.scale === "proportion")!;
  const time = s.outcomes.find((o) => o.scale === "continuous" && o.aggregation === "arithmetic")!;
  // R: t.test(c(0, 0, 0, .1, .05)) -> mean .03, 95% CI [-0.02553, 0.08553].
  const p = meanInterval(s, accuracy, [0, 0, 0, 0.1, 0.05])!;
  close(p.mean, 0.03, 1e-15);
  assert.equal(p.low, 0, "a proportion cannot be negative");
  close(p.high, 0.0855289021039559, 1e-12);
  close(meanInterval(s, time, [0, 0, 0, 0.1, 0.05])!.low, -0.0255289021039559, 1e-12);
  const rank = s.outcomes.find((o) => o.scale === "rank")!;
  assert.equal(meanInterval(s, rank, [1, 1, 1, 2])!.low, 1);
  const same = meanInterval(s, s.outcomes.find((o) => o.scale === "ordinal")!, [4, 4, 4, 4])!;
  assert.deepEqual([same.low, same.high, same.degenerate], [4, 4, true]);
  // In the analyzer: every person gave 2, so "inside" is an exact match and the row says so.
  const x = await known(3);
  x.human.measurements.forEach((r) => (r.value = 2));
  const fit = analyze(x.plan, x.human, x.results).absoluteFit!;
  assert.ok(fit.length > 0 && fit.every((f) => f.degenerate && f.low === 2 && f.high === 2 && /same value/.test(f.note!)));
  assert.ok(fit.every((f) => f.inside === (Math.abs(f.agent - 2) <= 1e-8)));
  assert.ok(fit.some((f) => f.inside) && fit.some((f) => !f.inside));
});
test("declared ranges and counts: validated, values outside refused, intervals clipped; old studies unchanged", () => {
  const s = exampleStudy();
  const appeal = s.outcomes.find((o) => o.id === "appeal")!;
  const before = meanInterval(s, appeal, [6, 7, 7, 7, 6])!;
  assert.ok(before.high > 7, "without a range nothing bounds the interval (as before)");
  appeal.range = [1, 7];
  const study = validateStudy(s);
  const o = study.outcomes.find((x) => x.id === "appeal")!;
  const after = meanInterval(study, o, [6, 7, 7, 7, 6])!;
  assert.equal(after.high, 7, "a 1–7 rating's interval is clipped at 7");
  close(after.low, before.low, 1e-15);
  assert.equal(measurementValue(study, { outcomeId: "appeal", conditionId: "ray", participantId: "p1", value: 7 }), 7);
  assert.throws(() => measurementValue(study, { outcomeId: "appeal", conditionId: "ray", participantId: "p1", value: 8 }), /\(participant p1, design ray\): 8 is outside its range 1–7/);
  assert.throws(() => measurementValue(study, { outcomeId: "appeal", conditionId: "ray", participantId: "p1", value: 0 }), /outside its range 1–7/);
  // Plain messages for ranges that cannot be.
  const refused = (change: (x: Study) => void) => {
    const x = exampleStudy();
    change(x);
    return () => validateStudy(x);
  };
  assert.throws(refused((x) => (x.outcomes.find((y) => y.id === "appeal")!.range = [7, 1])), /must be \[lowest, highest\]/);
  assert.throws(refused((x) => ((x.outcomes.find((y) => y.id === "appeal") as { range: unknown }).range = [1, "7"])), /must be \[lowest, highest\]/);
  assert.throws(refused((x) => (x.outcomes.find((y) => y.scale === "rank")!.range = [1, 3])), /ranking: its range is always 1 to the number of designs/);
  assert.throws(refused((x) => (x.outcomes.find((y) => y.scale === "proportion")!.range = [0, 100])), /proportion, so its range lies within 0–1/);
  // Counts: non-negative, whole numbers per person, averaged arithmetically, intervals clipped at 0.
  const c = exampleStudy();
  const teleports = c.outcomes.find((x) => x.id === "teleports")!;
  teleports.scale = "count";
  const counted = validateStudy(c);
  const t = counted.outcomes.find((x) => x.id === "teleports")!;
  assert.equal(meanInterval(counted, t, [0, 0, 0, 1, 0])!.low, 0, "a count interval does not go below 0");
  assert.throws(() => measurementValue(counted, { outcomeId: "teleports", conditionId: "ray", value: -1 }), /count and cannot be negative/);
  assert.equal(measurementValue(counted, { outcomeId: "teleports", conditionId: "ray", value: 1.5 }), 1.5, "a forecast may be an expected count");
  const people = counted.participants.slice(0, 1);
  const human: HumanData = { schemaVersion: "1.0", studyId: counted.id, synthetic: counted.synthetic, measurements: [{ participantId: people[0].id, conditionId: people[0].conditionOrder[0], outcomeId: "teleports", value: 1.5 }] };
  assert.throws(() => validateHumanData(counted, human), /count, so each person's value is a whole number/);
  human.measurements[0].value = 2;
  validateHumanData(counted, human);
  assert.throws(refused((x) => {
    const y = x.outcomes.find((z) => z.id === "teleports")!;
    y.scale = "count";
    y.aggregation = "geometric";
  }), /count: counts are averaged arithmetically/);
});
test("study warnings: too few people for any design difference to reach p < .05", () => {
  // Smallest exact two-sided p: Wilcoxon 2/2^n, Mann–Whitney 2/C(n1+n2, n1).
  assert.equal(smallestWilcoxonP(3), 0.25);
  assert.equal(smallestWilcoxonP(6), 0.03125);
  assert.equal(smallestWilcoxonP(1), 1);
  assert.equal(smallestMannWhitneyP(2, 2), 2 / 6);
  assert.equal(smallestMannWhitneyP(4, 4), 2 / 70);
  assert.equal(smallestMannWhitneyP(3, 5), 2 / 56);
  // They are reached: all differences on one side, complete separation.
  assert.equal(wilcoxonSignedRank([1, 2, 3]).p, 0.25);
  assert.ok(Math.abs(mannWhitney([1, 2, 3, 4], [5, 6, 7, 8]).p! - 2 / 70) < 1e-12);
  const s = exampleStudy();
  const pairs = (s.conditions.length * (s.conditions.length - 1)) / 2;
  const within = (n: number) => {
    const x = structuredClone(s);
    x.participants = Array.from({ length: n }, (_, i) => ({ ...s.participants[i % s.participants.length], id: `p${i}` }));
    return studyWarnings(x);
  };
  assert.match(within(3).join(" "), /With 3 people, no design difference can reach p < \.05: the smallest p the Wilcoxon signed-rank test can give is 0\.25.*significant-only view will be empty/);
  // With k design pairs, Holm needs pairs × 2/2^n < .05.
  let need = 2;
  while (pairs * 2 / 2 ** need >= 0.05) need++;
  assert.equal(within(need - 1).length, 1);
  assert.match(within(need - 1)[0], new RegExp(`At least ${need} people`));
  assert.deepEqual(within(need), []);
  // Between subjects: per group.
  const between = (perGroup: number) => {
    const x = structuredClone(s);
    x.design = "between-subjects";
    x.outcomes = x.outcomes.filter((o) => o.scale !== "rank");
    x.participants = Array.from({ length: perGroup * x.conditions.length }, (_, i) => ({ id: `p${i}`, stratum: `g${i % x.conditions.length}`, conditionOrder: [x.conditions[i % x.conditions.length].id] }));
    return studyWarnings(x);
  };
  assert.match(between(2).join(" "), /With 2 people per design, no difference between the groups can reach p < \.05.*nothing can be scored/);
  assert.deepEqual(between(6), []);
  const three = structuredClone(s);
  three.participants = three.participants.slice(0, 3);
  assert.match(explainStudy(three), /## Warnings\n\n- With 3 people/);
  assert.doesNotMatch(explainStudy(s), /## Warnings/);
});
test("bootstrap: each configuration resamples from its own stream", async () => {
  const x = await example();
  const full = analyzeVerifiedPlan(x.plan, x.human, x.results, []);
  const drop = "text-only";
  const kept = new Set(x.plan.jobs.filter((j) => j.agentId !== drop).map((j) => j.id));
  const without = analyzeVerifiedPlan(
    { ...x.plan, agents: x.plan.agents.filter((a) => a.id !== drop), jobs: x.plan.jobs.filter((j) => kept.has(j.id)) },
    x.human,
    { ...x.results, runs: x.results.runs.filter((r) => kept.has(r.jobId)) },
    [],
  );
  const reversed = analyzeVerifiedPlan({ ...x.plan, agents: [...x.plan.agents].reverse() }, x.human, x.results, []);
  const ci = (r: typeof full, id: string, d: string) => r.summaries.find((s) => s.agentId === id && s.domain === d)!.ci95;
  for (const id of ["reads-project", "uses-app", "reads-evidence"])
    for (const d of ["objective", "subjective"]) {
      assert.ok(ci(full, id, d), `${id} ${d} has an interval`);
      assert.deepEqual(ci(without, id, d), ci(full, id, d), `${id} ${d} without ${drop}`);
      assert.deepEqual(ci(reversed, id, d), ci(full, id, d), `${id} ${d} reordered`);
    }
  assert.deepEqual(analyzeVerifiedPlan(x.plan, x.human, x.results, []).summaries, full.summaries);
});
test("agent comparison weights outcomes with the study's family and outcome weights", () => {
  const study = {
    outcomes: [
      { id: "o1", domain: "subjective", family: "F1", weight: 1 },
      { id: "o2", domain: "subjective", family: "F1", weight: 3 },
      { id: "o3", domain: "subjective", family: "F2", weight: 1 },
    ],
    analysis: { tieTolerance: 1e-8, familyWeights: { F1: 1, F2: 3 } },
  } as unknown as Study;
  const p = new Map([["o1", [1, 2]], ["o2", [1, 2]], ["o3", [1, 2]]]);
  const q = new Map([["o1", [1, 2]], ["o2", [2, 1]], ["o3", [1, 2]]]);
  // F1 gets 1/4 (o1 1/16, o2 3/16), F2 3/4: 1/16 + 0 + 3/4 (the unweighted mean was 2/3).
  assert.deepEqual(agreementBetween(study, p, q, "subjective"), { score: 13 / 16, outcomes: 3 });
  assert.deepEqual(agreementBetween(study, p, q, "objective"), { score: null, outcomes: 0 });
});
