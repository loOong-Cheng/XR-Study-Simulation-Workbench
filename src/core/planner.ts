import { createHash } from "node:crypto";
import type { AgentProtocol, Job, Plan, Study } from "./types.js";
import { checkNewConfigurations, requireThat, validateAgents, validateStudy } from "./validation.js";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (k) =>
            JSON.stringify(k) +
            ":" +
            canonical((value as Record<string, unknown>)[k]),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Prediction level of a config (its own, else the study's). */
export function agentLevel(study: Study, a: AgentProtocol): "population" | "individual" {
  return a.level ?? study.predictionLevel;
}
/** Outcome IDs a config predicts: its targets, else every outcome it is not given as input. */
export function agentTargets(study: Study, a: AgentProtocol): string[] {
  return (a.targets ?? study.outcomes.map((o) => o.id)).filter((id) => !a.inputs?.includes(id));
}
/**
 * Default run count when a configuration sets none. `perParticipant` is the number of
 * runs per participant: an individual configuration runs that often for every person,
 * and a population configuration gets participants × perParticipant runs, so both levels
 * produce the same number of forecasts by default. A configuration may set fewer.
 */
export function defaultRuns(study: Study, a: AgentProtocol, perParticipant: number): number {
  return agentLevel(study, a) === "individual" ? perParticipant : Math.max(1, study.participants.length) * perParticipant;
}
/** Configurations with their default run count written in, so the frozen plan states every count explicitly. */
export function withDefaultRuns(study: Study, agents: AgentProtocol[], perParticipant: number): AgentProtocol[] {
  requireThat(Number.isInteger(perParticipant) && perParticipant >= 1 && perParticipant <= 50, "Use 1–50 runs per participant.");
  return agents.map((a) => (a.repetitions ? a : { ...a, repetitions: defaultRuns(study, a, perParticipant) }));
}
export function expectedJobs(
  study: Study,
  agents: AgentProtocol[],
  repetitions: number,
): Job[] {
  return agents.flatMap((a) =>
    Array.from({ length: a.repetitions ?? repetitions }, (_, i) => {
      const base = { agentId: a.id, repetition: i + 1 };
      return agentLevel(study, a) === "population"
        ? [{ ...base, id: `${a.id}-r${i + 1}` }]
        : study.participants.map((p) => ({
            ...base,
            id: `${a.id}-${p.id}-r${i + 1}`,
            participantId: p.id,
          }));
    }).flat(),
  );
}
export function freezePlan(
  study: unknown,
  protocols: AgentProtocol[],
  repetitions = 3,
  frozenAt = new Date().toISOString(),
): Plan {
  const s = validateStudy(study);
  const agents = validateAgents(s, protocols);
  checkNewConfigurations(s, agents);
  requireThat(
    s.synthetic ||
      agents.every(
        (a) =>
          ![a.model.provider, a.model.model, a.model.reasoning].some(
            (v) =>
              v === "configure-on-worker" || v === "record-effective-setting",
          ),
      ),
    "Replace placeholder model settings before freezing a real study.",
  );
  requireThat(
    Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 50,
    "Use 1–50 repetitions.",
  );
  requireThat(Number.isFinite(Date.parse(frozenAt)), "Invalid freeze date.");
  const body = {
    schemaVersion: "1.0" as const,
    study: s,
    agents,
    repetitions,
    jobs: expectedJobs(s, agents, repetitions),
    frozenAt,
  };
  requireThat(
    body.jobs.length <= 10000,
    "This small workbench supports at most 10,000 scheduled jobs.",
  );
  return { ...body, digest: hash(body) };
}
export function verifyPlan(plan: Plan): void {
  requireThat(plan && plan.schemaVersion === "1.0", "Unsupported plan.");
  const { digest, ...body } = plan;
  requireThat(
    hash(body) === digest,
    "Plan integrity check failed. Freeze a new version rather than editing a frozen plan.",
  );
  validateStudy(plan.study);
  validateAgents(plan.study, plan.agents);
  requireThat(
    Number.isInteger(plan.repetitions) &&
      plan.repetitions >= 1 &&
      plan.repetitions <= 50 &&
      Number.isFinite(Date.parse(plan.frozenAt)),
    "Invalid frozen repetition count or date.",
  );
  requireThat(
    canonical(expectedJobs(plan.study, plan.agents, plan.repetitions)) ===
      canonical(plan.jobs),
    "Frozen job schedule is inconsistent.",
  );
}
export function protocolForJob(plan: Plan, job: Job): AgentProtocol {
  const protocol = structuredClone(
    plan.agents.find((a) => a.id === job.agentId)!,
  );
  if (job.participantId && protocol.caseOrder === "as-listed") {
    const person = plan.study.participants.find(
      (p) => p.id === job.participantId,
    )!;
    protocol.requiredCaseIds.sort((a, b) => {
      const ca = plan.study.cases.find((c) => c.id === a)!,
        cb = plan.study.cases.find((c) => c.id === b)!;
      return (
        person.conditionOrder.indexOf(ca.conditionId) -
          person.conditionOrder.indexOf(cb.conditionId) ||
        plan.study.phases.findIndex((p) => p.id === ca.phaseId) -
          plan.study.phases.findIndex((p) => p.id === cb.phaseId)
      );
    });
  }
  return protocol;
}

export interface PlanningAgent {
  id: string;
  propose(study: Study): Promise<AgentProtocol[]>;
}
const forecastInstruction =
  "Predict the declared human outcomes for every design under the planned order and measurement windows. Keep measured agent behavior, simulation time and predicted human time separate. Use only supplied sources. Do not inspect target human answers. Return every requested numeric outcome, including the named retained items for composites. Report uncertainty and limitations separately; do not change the output definitions.";
function recipe(
  study: Study,
  id: string,
  label: string,
  rationale: string,
  kinds: string[],
  tools: AgentProtocol["tools"],
  dynamic = false,
): AgentProtocol {
  const sourceIds = study.sources
    .filter((s) => s.kind === "brief" || kinds.includes(s.kind))
    .map((s) => s.id);
  return {
    id,
    label,
    rationale,
    model: {
      provider: "configure-on-worker",
      model: "configure-on-worker",
      reasoning: "record-effective-setting",
    },
    autonomy: "standardized-exposure",
    caseOrder: "as-listed",
    sourceIds,
    tools,
    observation: dynamic ? study.runtime.observation : "none",
    requiredCaseIds: dynamic
      ? study.cases
          .filter((c) =>
            ["practice", "exploration", "main"].includes(
              study.phases.find((p) => p.id === c.phaseId)!.kind,
            ),
          )
          .map((c) => c.id)
      : [],
    requiredSourceIds: [...sourceIds],
    maxToolCalls: dynamic ? 150 : tools.length ? 50 : 0,
    maxOutputTokens: 12000,
    // Token budget per session (input incl. cache + output). Using the app re-reads a growing
    // context with every action, so it needs far more than reading files or the brief alone.
    maxTokens: dynamic ? 2_000_000 : tools.length ? 400_000 : 100_000,
    forecastInstruction,
  };
}
// Built-in method templates. Each adds one kind of information to the previous
// one, so neighbouring methods can be compared. IDs and labels say what the
// agent gets; the rationale says which question the method answers.
export class BaselineDesigner implements PlanningAgent {
  id = "baseline-designer";
  async propose(s: Study): Promise<AgentProtocol[]> {
    const result = [
      recipe(
        s,
        "text-only",
        "Text only",
        "Baseline: how well can people's results be predicted from the written description alone, without seeing the app?",
        [],
        [],
      ),
    ];
    if (s.sources.some((x) => x.kind === "project"))
      result.push(
        recipe(
          s,
          "reads-project",
          "Reads the project files",
          "Does inspecting the app's files (code, scenes, materials) without running it beat the description alone?",
          ["project"],
          ["read-files"],
        ),
      );
    return result;
  }
}
export class ExperienceDesigner implements PlanningAgent {
  id = "experience-designer";
  async propose(s: Study): Promise<AgentProtocol[]> {
    if (!s.cases.length) return [];
    return [
      recipe(
        s,
        "uses-app",
        "Uses the app",
        "Does experiencing the app like a participant (looking around and doing the practice and main tasks) beat only reading its files?",
        ["project"],
        ["read-files", "xr-interact"],
        true,
      ),
    ];
  }
}
export class EvidenceDesigner implements PlanningAgent {
  id = "evidence-designer";
  async propose(s: Study): Promise<AgentProtocol[]> {
    if (!s.sources.some((x) => x.kind === "evidence")) return [];
    return [
      recipe(
        s,
        "reads-evidence",
        "Reads the project + your evidence",
        "Does your evidence document (published findings, a computational model) add anything beyond reading the files?",
        ["project", "evidence"],
        ["read-files", "read-evidence"],
      ),
    ];
  }
}
export class ParticipantDesigner implements PlanningAgent {
  id = "participant-designer";
  async propose(s: Study): Promise<AgentProtocol[]> {
    const kinds =
      s.predictionTiming === "after-experience"
        ? ["demographics", "objective-records", "trajectory"]
        : ["demographics"];
    if (!s.sources.some((x) => kinds.includes(x.kind))) return [];
    return [
      recipe(
        s,
        "uses-app-people",
        "Uses the app + knows the participants",
        "Does knowing who took part (only the allowed background, never their answers) improve on using the app alone?",
        ["project", ...kinds],
        ["read-files", "xr-interact", "read-participant-data"],
        true,
      ),
    ];
  }
}
/** Plain-language list of what a method's agent receives. */
export function methodGets(agent: AgentProtocol, study: Study): string[] {
  const kindText: Record<string, string> = {
    brief: "the study description",
    project: "the project files",
    evidence: "your evidence document",
    demographics: "participant background",
    "objective-records": "participants' measured task data",
    trajectory: "participants' movement recordings",
  };
  const gets = agent.sourceIds.map((id) => {
    const src = study.sources.find((x) => x.id === id);
    const base = src ? kindText[src.kind] ?? src.label : id;
    return src?.fields ? `${base} (${src.fields.join(", ")})` : base;
  });
  if (agent.tools.includes("xr-interact"))
    gets.push(
      `the running app (${agent.observation === "stereo-pair" ? "left/right eye" : "single"} screenshots, can do the tasks)`,
    );
  // Measured outcomes given as predictors: the framework attaches them from the human data.
  const inputs = (agent.inputs ?? []).map((id) => study.outcomes.find((o) => o.id === id)?.label ?? id);
  if (inputs.length)
    gets.push(
      `measured ${inputs.join(", ")} ${(agent.level ?? study.predictionLevel) === "individual" ? "of this person" : "as the cohort means"}, from the human data`,
    );
  return gets;
}
export async function proposeAgents(
  study: unknown,
  designers: PlanningAgent[] = [
    new BaselineDesigner(),
    new ExperienceDesigner(),
    new EvidenceDesigner(),
    new ParticipantDesigner(),
  ],
): Promise<AgentProtocol[]> {
  const s = validateStudy(study);
  // Designers operate on the public protocol only, never on the reference answers.
  const proposals = (
    await Promise.all(designers.map((d) => d.propose(structuredClone(s))))
  ).flat();
  return validateAgents(s, proposals);
}
export function planningBrief(study: Study): object {
  return {
    schemaVersion: "1.0",
    role: "HCI simulation-method designer",
    study,
    instructions: [
      "Return an array of AgentProtocol objects, not executable code.",
      "Vary one intended factor at a time and justify it against the research question.",
      "Specify permitted sources, tools, mandatory exposure, autonomy, resource limits and outputs.",
      "Do not invent human outcomes, use target answers, or tune designs against evaluation scores.",
      "Required familiarization should not add actions to scored measurement windows.",
      "Proposals are untrusted input: validate and freeze them before execution.",
    ],
    outputExample: recipe(
      study,
      "candidate",
      "Short plain name of what the agent gets",
      "What the agent gets, and which question this method answers compared with another method.",
      [],
      [],
    ),
    optionalPlannerAdapter:
      "Implement PlanningAgent.propose(study) for a hosted or local LLM. No provider calls are made by the built-in deterministic designers.",
  };
}
/** Scoped execution packet for one job. Shared by plan handoffs and campaign packages. */
export function jobPacket(plan: Plan, job: Job): object {
  const a = protocolForJob(plan, job);
  const orderCounts = new Map<
    string,
    { conditionOrder: string[]; count: number }
  >();
  for (const p of plan.study.participants) {
    const k = p.conditionOrder.join("|");
    const row = orderCounts.get(k) ?? {
      conditionOrder: p.conditionOrder,
      count: 0,
    };
    row.count++;
    orderCounts.set(k, row);
  }
  const packet = {
    planDigest: plan.digest,
    job,
    protocol: a,
    task: {
      studyId: plan.study.id,
      title: plan.study.title,
      researchQuestion: plan.study.researchQuestion,
      synthetic: plan.study.synthetic,
      predictionLevel: plan.study.predictionLevel,
      predictionTiming: plan.study.predictionTiming,
      conditions: plan.study.conditions,
      phases: plan.study.phases,
      cases: plan.study.cases,
      // Only this config's targets; inputs are named here and their values attached by the executor.
      outcomes: plan.study.outcomes.filter((o) => agentTargets(plan.study, a).includes(o.id)),
      level: agentLevel(plan.study, a),
      inputs: (a.inputs ?? []).map((id) => {
        const o = plan.study.outcomes.find((x) => x.id === id)!;
        return { id, label: o.label, unit: o.unit };
      }),
      runtime: plan.study.runtime,
      orderContext: job.participantId
        ? plan.study.participants.find((p) => p.id === job.participantId)
        : {
            cohortSize: plan.study.participants.length,
            orders: [...orderCounts.values()],
          },
      sources: plan.study.sources.filter((s) => a.sourceIds.includes(s.id)),
    },
  };
  return packet;
}
export function handoffFiles(plan: Plan): Record<string, string> {
  verifyPlan(plan);
  const files: Record<string, string> = {
    "plan.json": JSON.stringify(plan, null, 2) + "\n",
  };
  for (const job of plan.jobs)
    files[`jobs/${job.id}.json`] =
      JSON.stringify(jobPacket(plan, job), null, 2) + "\n";
  files["WORKER_README.txt"] =
    [
      "XR Study Sim — external execution contract",
      `Frozen plan digest: ${plan.digest}`,
      "In the workbench, the executor (website: Run agents) runs a campaign's jobs through the built-in WebXR runtime or a study bridge set in Settings (docs/runtime-adapters.md); freeze a campaign from this plan with campaign-from-plan. An external worker that runs these packets elsewhere should give agents the same participant tools and audit trace (the bridge contract); RuntimeAdapter in src/core/protocol.ts is an optional library contract for such a worker.",
      "Preflight engine/runtime versions, model settings, source content hashes, capabilities, per-eye observations and study-specific controls before forecasting.",
      "Give each forecaster only its job packet and approved sources, never the global plan, other forecasts, analysis reports or target human answers.",
      "Missing sources or required capabilities are explicit failures. Never silently replace stereo with mono.",
      "Use fresh contexts, environment resets and fresh captures for each job. Identical case plans do not permit capture reuse.",
      "Record source delivery, phases, completed actions, observations and task submissions. Internal evidence use is not proven by these receipts.",
      "Complete mandatory familiarization before forecasting. Keep practice, main, questionnaire and break windows distinct.",
      "Store model wall time, environment simulation time and estimated human time separately. No scientific per-case time limit is imposed by this framework.",
      "Save the first complete valid output. Keep interrupted attempts and their usage, never regenerate a valid output based on its score.",
      "Return one ResultBundle containing completed AND failed jobs. Preserve every scheduled job ID, plan digest, declared model/runtime settings and synthetic label.",
      "The human reference dataset stays with the analyzer and is not part of this handoff.",
    ].join("\n") + "\n";
  files["manifest.json"] =
    JSON.stringify(
      {
        schemaVersion: "1.0",
        planDigest: plan.digest,
        files: Object.fromEntries(
          Object.entries(files).map(([name, contents]) => [
            name,
            createHash("sha256").update(contents).digest("hex"),
          ]),
        ),
      },
      null,
      2,
    ) + "\n";
  return files;
}

/**
 * The fewest tool calls a configuration's protocol can be completed with: for app configurations,
 * opening each design, each required task's actions (its minActions, at least one per required
 * action) and one view per task; and one call per project source to read. Submitting the forecast
 * is not part of the budget. A budget below this cannot finish the protocol; one close to it
 * leaves no room to explore.
 */
export function minToolCalls(study: Study, a: AgentProtocol): { min: number; parts: string[] } {
  const parts: string[] = [];
  let min = 0;
  if (a.tools.includes("read-files")) {
    const files = a.sourceIds.filter((id) => study.sources.find((s) => s.id === id)?.kind === "project").length;
    if (files) {
      min += files;
      parts.push(`${files} file read${files === 1 ? "" : "s"}`);
    }
  }
  if (a.tools.includes("xr-interact")) {
    const cases = a.requiredCaseIds.map((id) => study.cases.find((c) => c.id === id)!).filter(Boolean);
    const designs = new Set(cases.map((c) => c.conditionId)).size;
    const actions = cases.reduce((n, c) => n + Math.max(c.minActions ?? 0, c.requiredActions.length), 0);
    min += designs + actions + cases.length;
    parts.push(`${designs} design${designs === 1 ? "" : "s"} to open`, `${actions} task action${actions === 1 ? "" : "s"}`, `${cases.length} view${cases.length === 1 ? "" : "s"}`);
  }
  return { min, parts };
}
