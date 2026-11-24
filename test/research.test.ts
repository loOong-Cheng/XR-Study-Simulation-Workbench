import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyze,
  directionalAgreement,
  holmAdjust,
} from "../src/core/analyzer.js";
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
import { measurementValue, validateStudy } from "../src/core/validation.js";
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
    /retained item/,
  );
  assert.throws(() => measurementValue(s, { ...r, value: 3.5 }), /disagrees/);
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
