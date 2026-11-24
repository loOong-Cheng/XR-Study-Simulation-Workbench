import type {
  AgentProtocol,
  Audit,
  Job,
  Plan,
  RunResult,
  TraceEvent,
} from "./types.js";
import { measurementKey, measurementValue, requireThat } from "./validation.js";
import { agentTargets, protocolForJob, verifyPlan } from "./planner.js";

export function exposureIssues(
  plan: Plan,
  agent: AgentProtocol,
  trace: TraceEvent[],
): string[] {
  const issues: string[] = [];
  const seenSources = new Set<string>();
  const cases = new Map(plan.study.cases.map((c) => [c.id, c]));
  const observed = new Set<string>(),
    submitted = new Set<string>();
  const actions = new Map<string, Set<string>>();
  const firstVisits: string[] = [];
  let currentPhase: string | undefined,
    currentCase: string | undefined,
    forecast = false;
  for (const e of trace) {
    if (e.type === "forecast") {
      forecast = true;
      continue;
    }
    if (forecast)
      issues.push(
        "Environment/source events occurred after the forecast boundary.",
      );
    if (e.type === "source") {
      if (!agent.sourceIds.includes(e.sourceId))
        issues.push(`Unapproved source delivered: ${e.sourceId}.`);
      if (!/^[a-f0-9]{64}$/i.test(e.sha256))
        issues.push(`Missing content hash for source ${e.sourceId}.`);
      seenSources.add(e.sourceId);
      continue;
    }
    if (e.type === "runtime") {
      if (!agent.tools.includes("xr-interact"))
        issues.push("A runtime reported itself for an agent without XR access.");
      continue;
    }
    if (e.type === "phase") {
      if (!plan.study.phases.some((p) => p.id === e.phaseId))
        issues.push(`Unknown phase ${e.phaseId}.`);
      currentPhase = e.phaseId;
      currentCase = undefined;
      continue;
    }
    if (!agent.tools.includes("xr-interact"))
      issues.push("XR events were recorded for an agent without XR access.");
    const c = cases.get(e.caseId);
    if (!c || c.phaseId !== e.phaseId || currentPhase !== e.phaseId)
      issues.push(`Case/phase mismatch: ${e.caseId}.`);
    if (e.type === "case-start") {
      currentCase = e.caseId;
      if (
        agent.requiredCaseIds.includes(e.caseId) &&
        !firstVisits.includes(e.caseId)
      )
        firstVisits.push(e.caseId);
      continue;
    }
    if (currentCase !== e.caseId)
      issues.push(`Event outside its active case: ${e.caseId}.`);
    if (e.type === "action") {
      if (e.completed) {
        const set = actions.get(e.caseId) ?? new Set<string>();
        set.add(e.action);
        actions.set(e.caseId, set);
      }
    } else if (e.type === "case-end") {
      if (e.submitted) submitted.add(e.caseId);
      currentCase = undefined;
    } else if (e.type === "observation") {
      const cap = e.captures;
      let valid = cap.every(
        (x) =>
          /^[a-f0-9]{64}$/i.test(x.sha256) &&
          Number.isFinite(x.simulationTimeMs),
      );
      if (agent.observation === "mono")
        valid &&= cap.length === 1 && cap[0].eye === "mono";
      else if (agent.observation === "stereo-pair") {
        valid &&=
          cap.length === 2 &&
          new Set(cap.map((x) => x.eye)).has("left") &&
          new Set(cap.map((x) => x.eye)).has("right");
        if (cap.length === 2)
          valid &&=
            cap[0].frameId === cap[1].frameId &&
            cap[0].simulationTimeMs === cap[1].simulationTimeMs &&
            cap.every(
              (x) =>
                typeof x.eyeSeparationM === "number" &&
                x.eyeSeparationM > 0 &&
                x.eyeSeparationM < 0.2,
            ) &&
            cap[0].eyeSeparationM === cap[1].eyeSeparationM &&
            cap.every(
              (x) =>
                x.viewMatrix?.length === 16 &&
                x.viewMatrix.every(Number.isFinite) &&
                x.projectionMatrix?.length === 16 &&
                x.projectionMatrix.every(Number.isFinite),
            ) &&
            JSON.stringify(cap[0].viewMatrix) !==
              JSON.stringify(cap[1].viewMatrix);
      } else valid = false;
      if (!valid)
        issues.push(`Invalid or downgraded observation in ${e.caseId}.`);
      else observed.add(e.caseId);
    }
  }
  if (
    agent.caseOrder === "as-listed" &&
    firstVisits.some((id, i) => id !== agent.requiredCaseIds[i])
  )
    issues.push("Required cases were visited outside their assigned order.");
  for (const id of agent.requiredSourceIds)
    if (!seenSources.has(id))
      issues.push(`Required source not delivered: ${id}.`);
  for (const id of agent.requiredCaseIds) {
    if (!observed.has(id))
      issues.push(`No valid observation for required case ${id}.`);
    if (!submitted.has(id))
      issues.push(`No submission for required case ${id}.`);
    for (const action of cases.get(id)!.requiredActions)
      if (!actions.get(id)?.has(action))
        issues.push(`Missing completed ${action} in ${id}.`);
  }
  return [...new Set(issues)];
}

/** Live worker gate: recording is permitted, forecasting requires checked exposure. */
export class ProtocolGate {
  readonly #events: TraceEvent[] = [];
  #closed = false;
  readonly #plan: Plan;
  readonly #agent: AgentProtocol;
  constructor(plan: Plan, job: Job) {
    verifyPlan(plan);
    requireThat(
      plan.jobs.some(
        (j) =>
          j.id === job.id &&
          j.agentId === job.agentId &&
          j.participantId === job.participantId,
      ),
      "Unknown job.",
    );
    this.#plan = structuredClone(plan);
    this.#agent = protocolForJob(this.#plan, job);
  }
  record(event: TraceEvent): void {
    requireThat(
      !this.#closed,
      "The forecast boundary is closed. Start a new job for more exploration.",
    );
    requireThat(
      event.type !== "forecast",
      "Call beginForecast() to enforce the transition.",
    );
    this.#events.push(structuredClone(event));
  }
  beginForecast(): void {
    const issues = exposureIssues(this.#plan, this.#agent, this.#events);
    requireThat(!issues.length, `Protocol incomplete: ${issues.join(" ")}`);
    this.#events.push({ type: "forecast" });
    this.#closed = true;
  }
  get trace(): TraceEvent[] {
    return structuredClone(this.#events);
  }
}

/**
 * Compares what the runtime reported about itself (the last "runtime" trace event) with the
 * frozen recipe. "custom" in the recipe's engine or backend means "not specified". Without a
 * report, the runtime's identity is unverified: the execution record alone is written by the
 * executor and cannot show it.
 */
export function runtimeIssues(plan: Plan, agent: AgentProtocol, trace: TraceEvent[]): string[] {
  const reports = (Array.isArray(trace) ? trace : []).filter(
    (e): e is Extract<TraceEvent, { type: "runtime" }> => !!e && e.type === "runtime",
  );
  const r = reports.at(-1);
  if (!r)
    return [
      "The runtime did not report itself (no 'runtime' trace event), so its engine, backend, device profile and observation are unverified.",
    ];
  const want = plan.study.runtime;
  const issues: string[] = [];
  const engines = new Set([want.engine, agent.runtime ?? (want.engine === "custom" ? "webxr" : want.engine)]);
  if (want.engine !== "custom" && !engines.has(r.engine))
    issues.push(`Runtime reported engine '${r.engine}', but the frozen recipe says '${want.engine}'.`);
  if (want.backend !== "custom" && r.backend !== want.backend)
    issues.push(`Runtime reported backend '${r.backend}', but the frozen recipe says '${want.backend}'.`);
  if (r.deviceProfile !== want.deviceProfile)
    issues.push(`Runtime reported device profile '${r.deviceProfile}', but the frozen recipe says '${want.deviceProfile}'.`);
  if (r.observation !== agent.observation)
    issues.push(`Runtime reported observation '${r.observation}', but this configuration requires '${agent.observation}'.`);
  const caps = Array.isArray(r.capabilities) ? r.capabilities : [];
  const lacking = want.requiredCapabilities.filter((c) => !caps.includes(c));
  if (lacking.length) issues.push(`Runtime reported no ${lacking.join(", ")}, which the study requires.`);
  if (agent.observation === "stereo-pair" && !caps.includes("stereo-capture"))
    issues.push("Runtime reported no stereo-capture capability for a stereo configuration.");
  if (new Set(reports.map((x) => JSON.stringify(x))).size > 1)
    issues.push("The runtime reported different identities within one session.");
  return issues;
}

export function auditRun(
  plan: Plan,
  job: Job,
  run: RunResult | undefined,
): Audit {
  const issues: string[] = [];
  if (!run)
    return {
      jobId: job.id,
      completed: false,
      scoreable: false,
      compliant: false,
      issues: ["Scheduled job was not returned."],
    };
  let scoreable = true;
  const agent = protocolForJob(plan, job);
  try {
    requireThat(
      run.jobId === job.id && run.planDigest === plan.digest,
      "Job identity or frozen-plan digest mismatch.",
    );
    requireThat(
      run.status === "completed",
      "Worker reported a failed execution.",
    );
    // Invented (mock or simulated) executions are only scoreable in synthetic studies;
    // real agent executions are scoreable in any study.
    requireThat(
      !run.execution.synthetic || plan.study.synthetic,
      "Simulated execution cannot be scored against a real study.",
    );
    const targets = agentTargets(plan.study, agent);
    const expected = plan.study.conditions.length * targets.length;
    requireThat(
      Array.isArray(run.measurements) && run.measurements.length === expected,
      "Incomplete or unexpected forecast grid.",
    );
    const seen = new Set<string>();
    for (const r of run.measurements) {
      requireThat(
        r.participantId === job.participantId,
        "Prediction participant does not match the job.",
      );
      const key = measurementKey(r);
      requireThat(!seen.has(key), "Duplicate forecast record.");
      requireThat(targets.includes(r.outcomeId), `Forecast for ${r.outcomeId}, which this configuration does not predict.`);
      seen.add(key);
      measurementValue(plan.study, r);
    }
  } catch (error) {
    scoreable = false;
    issues.push((error as Error).message);
  }
  try {
    requireThat(
      typeof run.sessionId === "string" && run.sessionId.length > 0,
      "Missing independent-session identifier.",
    );
    const e = run.execution;
    requireThat(
      Number.isFinite(Date.parse(e.startedAt)) &&
        Date.parse(e.startedAt) >=
          Date.parse(plan.jobFrozenAt?.[job.id] ?? plan.frozenAt),
      "Execution predates the frozen plan or lacks a start timestamp.",
    );
    requireThat(
      e.versions &&
        (["engine", "runtime", "connector", "provider"] as const).every(
          (k) => typeof e.versions[k] === "string" && e.versions[k].length > 0,
        ),
      "Record engine, runtime, connector and provider versions.",
    );
    for (const v of [
      e.inputTokens,
      e.cacheReadTokens,
      e.cacheWriteTokens,
      e.reasoningTokens,
    ])
      requireThat(
        v === null || (Number.isSafeInteger(v) && v >= 0),
        "Unavailable token breakdowns must be null, not invented.",
      );
    requireThat(
      e.provider === agent.model.provider &&
        e.model === agent.model.model &&
        e.reasoning === agent.model.reasoning,
      "Model settings differ from the frozen recipe.",
    );
    if (agent.tools.includes("xr-interact")) {
      issues.push(...runtimeIssues(plan, agent, run.trace));
      // "custom" engine or backend in the recipe means not specified (e.g. a WebXR app).
      const want = plan.study.runtime;
      requireThat(
        (want.engine === "custom" || e.engine === want.engine || e.engine === agent.runtime) &&
          (want.backend === "custom" || e.backend === want.backend) &&
          e.deviceProfile === want.deviceProfile &&
          e.observation === agent.observation,
        "Runtime, device profile or observation differs from the frozen recipe.",
      );
      requireThat(
        plan.study.runtime.requiredCapabilities.every((c) =>
          e.capabilities.includes(c),
        ),
        "Required runtime capability is absent.",
      );
      if (agent.observation === "stereo-pair")
        requireThat(
          e.capabilities.includes("stereo-capture"),
          "Stereo capture is not supported by this worker.",
        );
    }
    requireThat(
      Number.isInteger(e.toolCalls) &&
        e.toolCalls >= 0 &&
        e.toolCalls <= agent.maxToolCalls,
      "Tool budget exceeded or not recorded.",
    );
    requireThat(
      Number.isInteger(e.outputTokens) &&
        e.outputTokens >= 0 &&
        e.outputTokens <= agent.maxOutputTokens,
      "Output budget exceeded or not recorded.",
    );
    if (agent.maxTokens && !e.synthetic) {
      const used = [e.inputTokens, e.cacheReadTokens, e.cacheWriteTokens, e.outputTokens].reduce<number>((s, x) => s + (x ?? 0), 0);
      requireThat(used <= agent.maxTokens, `Token budget exceeded: ${used} of ${agent.maxTokens} tokens.`);
    }
    requireThat(
      Number.isFinite(e.inferenceWallTimeMs) &&
        e.inferenceWallTimeMs >= 0 &&
        Number.isFinite(e.simulationTimeMs) &&
        e.simulationTimeMs >= 0,
      "Keep valid model wall time and simulation time separately.",
    );
    requireThat(
      e.humanTimeEstimateMs === null ||
        (Number.isFinite(e.humanTimeEstimateMs) && e.humanTimeEstimateMs >= 0),
      "Invalid separately modeled human time.",
    );
    requireThat(
      Array.isArray(run.trace) &&
        run.trace.filter((e) => e.type === "forecast").length === 1,
      "Record exactly one forecast boundary.",
    );
    issues.push(...exposureIssues(plan, agent, run.trace));
  } catch (error) {
    issues.push((error as Error).message);
  }
  return {
    jobId: job.id,
    completed: run.status === "completed",
    scoreable,
    compliant: scoreable && issues.length === 0,
    issues: [...new Set(issues)],
  };
}

export interface RuntimeAdapter {
  describe(): Promise<{
    engine: string;
    backend: string;
    version: string;
    capabilities: string[];
  }>;
  reset(job: Job): Promise<void>;
  perform(action: string, args: Record<string, unknown>): Promise<TraceEvent[]>;
  observe(caseId: string, phaseId: string): Promise<TraceEvent>;
  close(): Promise<void>;
}
export class UnavailableRuntime implements RuntimeAdapter {
  constructor(readonly name: string) {}
  async describe(): Promise<never> {
    throw new Error(
      `${this.name} is an external adapter contract, not an installed XR runtime.`,
    );
  }
  async reset(_job: Job): Promise<never> {
    return this.describe();
  }
  async perform(
    _action: string,
    _args: Record<string, unknown>,
  ): Promise<never> {
    return this.describe();
  }
  async observe(_caseId: string, _phaseId: string): Promise<never> {
    return this.describe();
  }
  async close(): Promise<void> {}
}
