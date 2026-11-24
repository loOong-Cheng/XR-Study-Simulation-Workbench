import type {
  HumanData,
  Measurement,
  Plan,
  ResultBundle,
  Study,
  TraceEvent,
} from "./types.js";
import { random } from "./analyzer.js";
import { agentTargets, hash, protocolForJob } from "./planner.js";

/** Invented selection/manipulation study; no participant records are imported. */
export function exampleStudy(): Study {
  const orders = [
    ["ray", "direct", "hybrid"],
    ["direct", "hybrid", "ray"],
    ["hybrid", "ray", "direct"],
    ["ray", "hybrid", "direct"],
    ["hybrid", "direct", "ray"],
    ["direct", "ray", "hybrid"],
  ];
  return {
    schemaVersion: "1.0",
    id: "synthetic-selection",
    title: "Selecting and placing objects in XR",
    researchQuestion:
      "How do selection techniques differ in task performance and subjective experience, and which agent workflows reproduce those differences?",
    synthetic: true,
    design: "within-subjects",
    predictionLevel: "population",
    predictionTiming: "after-experience",
    conditions: [
      { id: "ray", label: "Ray selection" },
      { id: "direct", label: "Direct touch" },
      { id: "hybrid", label: "Hybrid selection" },
    ],
    phases: [
      { id: "practice", label: "Guided practice", kind: "practice" },
      { id: "main", label: "Scored tasks", kind: "main" },
      { id: "questionnaire", label: "Questionnaires", kind: "questionnaire" },
      { id: "break", label: "Session break", kind: "break" },
    ],
    cases: ["ray", "direct", "hybrid"].flatMap((conditionId) => [
      {
        id: `${conditionId}-practice`,
        conditionId,
        phaseId: "practice",
        label: "Practice a selection and placement",
        requiredActions: ["select", "place"],
      },
      {
        id: `${conditionId}-main`,
        conditionId,
        phaseId: "main",
        label: "Select and place the target",
        requiredActions: ["select", "place"],
      },
    ]),
    participants: Array.from({ length: 12 }, (_, i) => ({
      id: `synthetic-${i + 1}`,
      stratum: `order-${(i % 6) + 1}`,
      conditionOrder: orders[i % 6],
    })),
    sources: [
      {
        id: "brief",
        label: "Study instructions",
        kind: "brief",
        description:
          "Task instructions and controls, without measured participant outcomes.",
      },
      {
        id: "project",
        label: "Approved project snapshot",
        kind: "project",
        description:
          "Scene layout and interaction implementation; supplied on the worker.",
      },
      {
        id: "evidence",
        label: "Computational evidence",
        kind: "evidence",
        description:
          "Independently specified models; no fitted target answers.",
      },
    ],
    runtime: {
      engine: "unreal",
      backend: "meta-xr-simulator",
      deviceProfile: "quest-3",
      observation: "stereo-pair",
      requiredCapabilities: [
        "head-pose",
        "hand-poses",
        "controller-input",
        "stereo-capture",
        "phase-events",
      ],
    },
    outcomes: [
      {
        id: "completion-time",
        label: "Completion time",
        domain: "objective",
        unit: "seconds",
        scale: "continuous",
        aggregation: "geometric",
        family: "task-time",
        weight: 1,
        phaseIds: ["main"],
        description:
          "Positive time from target onset to submit; questionnaire and break periods excluded.",
      },
      {
        id: "accuracy",
        label: "Selection accuracy",
        domain: "objective",
        unit: "proportion correct",
        scale: "proportion",
        aggregation: "arithmetic",
        family: "task-accuracy",
        weight: 1,
        phaseIds: ["main"],
        description: "Correct selections / scored selections; include errors.",
      },
      {
        id: "teleports",
        label: "Teleport count",
        domain: "objective",
        unit: "completed teleports / task",
        scale: "continuous",
        aggregation: "arithmetic",
        family: "navigation",
        weight: 1,
        phaseIds: ["main"],
        description: "Completed events only, within scored task windows.",
      },
      {
        id: "workload",
        label: "Modified five-item workload",
        domain: "subjective",
        unit: "1–7 item mean",
        scale: "ordinal",
        aggregation: "arithmetic",
        family: "workload",
        weight: 1,
        phaseIds: ["practice", "main"],
        components: ["mental", "physical", "temporal", "effort", "frustration"],
        description:
          "Mean of these five retained items, without Performance. A six-item total scaled by 5/6 is not this outcome.",
      },
      {
        id: "appeal",
        label: "Visual appeal",
        domain: "subjective",
        unit: "1–7 mean",
        scale: "ordinal",
        aggregation: "arithmetic",
        family: "aesthetics",
        weight: 1,
        phaseIds: ["practice", "main"],
        description: "Declared aesthetic composite after experience.",
      },
      {
        id: "interaction-preference",
        label: "Interaction preference",
        domain: "subjective",
        unit: "mean rank; 1 = first",
        scale: "rank",
        aggregation: "arithmetic",
        family: "interaction-preference",
        weight: 1,
        phaseIds: ["practice", "main"],
        description:
          "Which technique is preferred to interact with? Keep separate from overall preference.",
      },
      {
        id: "overall-preference",
        label: "Overall preference",
        domain: "subjective",
        unit: "mean rank; 1 = first",
        scale: "rank",
        aggregation: "arithmetic",
        family: "overall-preference",
        weight: 1,
        phaseIds: ["practice", "main"],
        description: "Overall design preference after the full session.",
      },
    ],
    analysis: {
      mode: "both",
      familyWeights: {
        "task-time": 0.4,
        "task-accuracy": 0.4,
        navigation: 0.2,
        workload: 0.4,
        aesthetics: 0.2,
        "interaction-preference": 0.2,
        "overall-preference": 0.2,
      },
      bootstrapDraws: 1000,
      seed: 2147,
      tieTolerance: 1e-8,
      contrasts: [
        {
          id: "uses-app-vs-reads-project-objective",
          baseline: "reads-project",
          candidate: "uses-app",
          domain: "objective",
        },
        {
          id: "uses-app-vs-reads-project-subjective",
          baseline: "reads-project",
          candidate: "uses-app",
          domain: "subjective",
        },
      ],
    },
  };
}
function record(
  outcomeId: string,
  conditionId: string,
  value: number,
  participantId?: string,
): Measurement {
  // Items are produced by the callers from the outcome's own definition; a plain outcome gets a plain value.
  return { outcomeId, conditionId, participantId, value };
}
export function syntheticHumanData(study: Study): HumanData {
  if (!study.synthetic)
    throw new Error("Synthetic generators cannot populate a real study.");
  const rng = random(1907),
    measurements: Measurement[] = [];
  const defaults: Record<string, number[]> = {
    "completion-time": [12, 16, 10],
    accuracy: [0.9, 0.96, 0.94],
    teleports: [2, 1, 1.4],
    workload: [3, 4, 2.7],
    appeal: [5.6, 5, 5.9],
  };
  for (const p of study.participants) {
    const shift = (rng() - 0.5) * 0.6;
    for (const o of study.outcomes) {
      const offset = Math.floor(rng() * study.conditions.length);
      for (let ci = 0; ci < study.conditions.length; ci++) {
        const c = study.conditions[ci];
        if (!p.conditionOrder.includes(c.id)) continue;
        let value: number;
        if (o.scale === "rank")
          value = ((ci + offset) % study.conditions.length) + 1;
        else
          value =
            (defaults[o.id]?.[ci % 3] ?? ci + 2) +
            shift +
            (rng() - 0.5) * (o.scale === "proportion" ? 0.05 : 0.8);
        if (o.scale === "proportion") value = Math.max(0, Math.min(1, value));
        if (o.aggregation === "geometric") value = Math.max(0.01, value);
        measurements.push(
          o.components
            ? {
                outcomeId: o.id,
                conditionId: c.id,
                participantId: p.id,
                components: Object.fromEntries(
                  o.components.map((id, i) => [
                    id,
                    value + (i - (o.components!.length - 1) / 2) * 0.08,
                  ]),
                ),
              }
            : record(o.id, c.id, value, p.id),
        );
      }
    }
  }
  return {
    schemaVersion: "1.0",
    studyId: study.id,
    synthetic: true,
    measurements,
  };
}
/**
 * The range a measure's values lie in, from its scale and unit: a unit such as "1-7", "1–7 item
 * mean", "0 to 100" or "score (0–100)" names its own range, a proportion is 0–1 and "%" is 0–100.
 * Null when nothing says (for example "seconds", or a rank).
 */
export function measureRange(outcome: Study["outcomes"][number]): [number, number] | null {
  if (outcome.scale === "rank") return null;
  const m = /(-?\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(-?\d+(?:\.\d+)?)/i.exec(outcome.unit ?? "");
  if (m && Number(m[2]) > Number(m[1])) return [Number(m[1]), Number(m[2])];
  if (outcome.scale === "proportion") return [0, 1];
  if (/%|percent/i.test(outcome.unit ?? "")) return [0, 100];
  return null;
}
export function syntheticResults(
  plan: Plan,
  includeViolation = false,
  seed = 7801,
): ResultBundle {
  if (!plan.study.synthetic)
    throw new Error("Synthetic results cannot be labeled as real execution.");
  return inventedResults(plan, includeViolation, seed);
}
/**
 * Simulated runs for trying the pipeline on any study, research studies included. Every run is
 * labelled synthetic (execution.synthetic), so it is never presented as a real execution, and the
 * analyzer never scores it against a research study's human data.
 */
export function simulatedResults(plan: Plan, seed = 7801): ResultBundle {
  return inventedResults(plan, false, seed);
}
function inventedResults(plan: Plan, includeViolation: boolean, seed: number): ResultBundle {
  const rng = random(seed);
  const runs = plan.jobs.map((job, ji) => {
    const agent = protocolForJob(plan, job);
    const trace: TraceEvent[] = agent.requiredSourceIds.map((sourceId) => ({
      type: "source",
      sourceId,
      delivery: "injected",
      sha256: hash({ sourceId, synthetic: true }),
    }));
    // A simulated runtime reports the frozen recipe as its identity (it is invented, like the run).
    if (agent.tools.includes("xr-interact") && agent.observation !== "none")
      trace.push({
        type: "runtime",
        engine: plan.study.runtime.engine,
        engineVersion: "simulated",
        backend: plan.study.runtime.backend,
        deviceProfile: plan.study.runtime.deviceProfile,
        observation: agent.observation,
        capabilities: [...new Set([...plan.study.runtime.requiredCapabilities, ...(agent.observation === "stereo-pair" ? ["stereo-capture"] : [])])],
      });
    for (const caseId of agent.requiredCaseIds) {
      const c = plan.study.cases.find((c) => c.id === caseId)!;
      trace.push(
        { type: "phase", phaseId: c.phaseId },
        { type: "case-start", caseId, phaseId: c.phaseId },
      );
      trace.push({
        type: "observation",
        caseId,
        phaseId: c.phaseId,
        captures:
          agent.observation === "stereo-pair"
            ? ["left", "right"].map((eye) => ({
                eye: eye as "left" | "right",
                sha256: hash({ job: job.id, caseId, eye }),
                frameId: `${job.id}-${caseId}`,
                simulationTimeMs: 1000,
                eyeSeparationM: 0.064,
                viewMatrix: [
                  1,
                  0,
                  0,
                  0,
                  0,
                  1,
                  0,
                  0,
                  0,
                  0,
                  1,
                  0,
                  eye === "left" ? -0.032 : 0.032,
                  0,
                  0,
                  1,
                ],
                projectionMatrix: [
                  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0,
                ],
              }))
            : [
                {
                  eye: "mono",
                  sha256: hash({ job: job.id, caseId }),
                  frameId: `${job.id}-${caseId}`,
                  simulationTimeMs: 1000,
                },
              ],
      });
      for (const action of c.requiredActions)
        trace.push({
          type: "action",
          caseId,
          phaseId: c.phaseId,
          action,
          completed: true,
        });
      trace.push({
        type: "case-end",
        caseId,
        phaseId: c.phaseId,
        submitted: true,
      });
    }
    trace.push({ type: "forecast" });
    if (
      includeViolation &&
      agent.tools.includes("xr-interact") &&
      job.repetition === 1
    ) {
      const index = trace.findIndex((e) => e.type === "case-end");
      if (index >= 0) trace.splice(index, 1);
    }
    const values: Record<string, number[]> = {
      "completion-time": [14, 17, 12],
      accuracy: [0.84, 0.93, 0.9],
      teleports: [1.8, 1.2, 1.5],
      workload: [3.2, 3.8, 2.9],
      appeal: [5.8, 5.3, 5.6],
    };
    const preferences = new Map<string, number[]>();
    for (const o of plan.study.outcomes)
      if (o.scale === "rank") {
        const order = plan.study.conditions.map((_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
          const j = Math.floor(rng() * (i + 1));
          [order[i], order[j]] = [order[j], order[i]];
        }
        preferences.set(
          o.id,
          plan.study.conditions.map((_, i) => order.indexOf(i) + 1),
        );
      }
    const targets = agentTargets(plan.study, agent);
    const measurements = plan.study.outcomes.filter((o) => targets.includes(o.id)).flatMap((o) =>
      plan.study.conditions.map((c, ci) => {
        // Invented values lie on the measure's own range (e.g. 0–100 for a TLX score, 1–7 for a rating).
        const range = values[o.id] || preferences.has(o.id) ? null : measureRange(o);
        let v =
          preferences.get(o.id)?.[ci] ??
          (range
            ? range[0] + (range[1] - range[0]) * (0.35 + 0.3 * ((ci * 0.618) % 1) + (rng() - 0.5) * 0.15)
            : (values[o.id]?.[ci % 3] ?? ci + 2) +
              (rng() - 0.5) * (o.scale === "proportion" ? 0.1 : 1.3));
        if (range) v = Math.max(range[0], Math.min(range[1], v));
        if (o.scale === "proportion") v = Math.max(0, Math.min(1, v));
        if (o.aggregation === "geometric") v = Math.max(0.01, v);
        return o.components
          ? {
              outcomeId: o.id,
              conditionId: c.id,
              participantId: job.participantId,
              components: Object.fromEntries(
                o.components.map((id, i) => [
                  id,
                  v + (i - (o.components!.length - 1) / 2) * 0.08,
                ]),
              ),
            }
          : record(o.id, c.id, v, job.participantId);
      }),
    );
    return {
      jobId: job.id,
      planDigest: plan.digest,
      status: "completed" as const,
      sessionId: `synthetic-session-${ji + 1}`,
      execution: {
        synthetic: true,
        engine: plan.study.runtime.engine,
        backend: plan.study.runtime.backend,
        deviceProfile: plan.study.runtime.deviceProfile,
        observation: agent.observation,
        provider: agent.model.provider,
        model: agent.model.model,
        reasoning: agent.model.reasoning,
        // The same capabilities as the simulated runtime event above (a stereo pair when observed).
        capabilities: [...new Set([...plan.study.runtime.requiredCapabilities, ...(agent.observation === "stereo-pair" ? ["stereo-capture"] : [])])],
        versions: {
          engine: "synthetic",
          runtime: "synthetic",
          connector: "synthetic-0.1",
          provider: "synthetic",
        },
        startedAt: new Date(
          Date.parse(plan.frozenAt) + ji * 1000,
        ).toISOString(),
        toolCalls: Math.min(
          agent.maxToolCalls,
          agent.requiredCaseIds.length * 4 + agent.tools.length,
        ),
        outputTokens: 500,
        inputTokens: 1000,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        inferenceWallTimeMs: 3000,
        simulationTimeMs: agent.requiredCaseIds.length * 1000,
        humanTimeEstimateMs: null,
        technicalRetries: 0,
      },
      measurements,
      trace,
    };
  });
  return { schemaVersion: "1.0", studyId: plan.study.id, runs };
}
