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
import { casesInOrder, validOrder } from "./fairness.js";

/**
 * Whether an action event is a scored action (a task answer): marked `scored: true` when the
 * runtime marks any action in the trace (the WebXR runtime does), otherwise every completed action
 * except the runtime's own complete-task. A refused action (`completed: false`) never counts, also
 * when a runtime marked it scored: it was not an answer the app took.
 */
export function scoredAction(e: Extract<TraceEvent, { type: "action" }>, marked: boolean): boolean {
  return e.completed === true && (marked ? e.scored === true : e.action !== "complete-task");
}
/** Project files the session opened (read_file calls recorded as `source` events with delivery "read"). */
export function filesRead(trace: TraceEvent[]): number {
  return (Array.isArray(trace) ? trace : []).filter((e) => e?.type === "source" && e.delivery === "read").length;
}
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
  // Scored actions per case, those without an observation since the previous one, and the cases
  // with an observation since their last scored action.
  const marked = trace.some((e) => e?.type === "action" && typeof e.scored === "boolean");
  const scored = new Map<string, number>(),
    blind = new Map<string, number>(),
    fresh = new Set<string>();
  const readSources = new Set<string>();
  const firstVisits: string[] = [];
  let currentPhase: string | undefined,
    currentCase: string | undefined,
    forecast = false;
  for (const e of trace) {
    if (e.type === "forecast") {
      forecast = true;
      continue;
    }
    if (forecast) {
      // Closing a case that is still open when the session ends (the runtime's stdin closes after
      // the forecast) is allowed: the case is recorded as not submitted. Anything else is not.
      if (e.type === "case-end" && !e.submitted && e.caseId === currentCase) {
        currentCase = undefined;
        continue;
      }
      issues.push(
        "Environment/source events occurred after the forecast boundary.",
      );
    }
    if (e.type === "source") {
      if (!agent.sourceIds.includes(e.sourceId))
        issues.push(`Unapproved source delivered: ${e.sourceId}.`);
      if (!/^[a-f0-9]{64}$/i.test(e.sha256))
        issues.push(`Missing content hash for source ${e.sourceId}.`);
      seenSources.add(e.sourceId);
      if (e.delivery === "read") readSources.add(e.sourceId);
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
      if (scoredAction(e, marked)) {
        scored.set(e.caseId, (scored.get(e.caseId) ?? 0) + 1);
        if (c?.observeBeforeEachAction && !fresh.has(e.caseId))
          blind.set(e.caseId, (blind.get(e.caseId) ?? 0) + 1);
        fresh.delete(e.caseId);
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
      else {
        observed.add(e.caseId);
        fresh.add(e.caseId);
      }
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
    const c = cases.get(id)!;
    for (const action of c.requiredActions)
      if (!actions.get(id)?.has(action))
        issues.push(`Missing completed ${action} in ${id}.`);
    const n = scored.get(id) ?? 0;
    if (c.minActions && n < c.minActions)
      issues.push(`Too few actions in ${id}: ${n} scored action${n === 1 ? "" : "s"}, at least ${c.minActions} required.`);
    if (blind.get(id))
      issues.push(`${blind.get(id)} of ${n} scored actions in ${id} came without an observation since the previous one (the task requires one before each action).`);
  }
  // A configuration whose ingredient is reading the project (read-files without the app) gets only
  // its file list injected: it must open a file. For app configurations the project is extra
  // material; how many files they opened is information (filesRead), not a deviation.
  const projects = agent.sourceIds.filter((id) => plan.study.sources.find((s) => s.id === id)?.kind === "project");
  if (agent.tools.includes("read-files") && !agent.tools.includes("xr-interact") && projects.length && !projects.some((id) => readSources.has(id)))
    issues.push("Did not open any project file (no read_file call), although this configuration reads the project.");
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
  // A process ID or other extra fields may differ between reports; the identity may not.
  const identity = (x: typeof r) => JSON.stringify([x.engine, x.engineVersion, x.backend, x.deviceProfile, x.observation, x.capabilities]);
  if (new Set(reports.map(identity)).size > 1)
    issues.push("The runtime reported different identities within one session.");
  // A runtime reports itself once per session: a second report means it was started again.
  if (reports.length > 1) issues.push(restartIssue(reports.length));
  return issues;
}
/** The deviation for a runtime that was started more than once in one session. */
export const restartIssue = (starts: number) =>
  `The runtime restarted during the session (${starts} starts): what the agent experienced before the restart may be lost or repeated.`;

/**
 * The token-budget check of a real session. When the execution record carries the tokens used up
 * to the moment the forecast was accepted (`tokensAtSubmit`), those are what the budget covers;
 * the session's closing turn after the forecast is reported separately and does not count.
 * Without that field, the session's total is compared.
 */
export function tokenBudgetIssue(
  execution: RunResult["execution"],
  maxTokens: number | undefined,
): string | null {
  if (!maxTokens || execution.synthetic) return null;
  const total = [
    execution.inputTokens,
    execution.cacheReadTokens,
    execution.cacheWriteTokens,
    execution.outputTokens,
  ].reduce<number>((s, x) => s + (typeof x === "number" && Number.isFinite(x) ? x : 0), 0);
  const atSubmit = (execution as { tokensAtSubmit?: unknown }).tokensAtSubmit;
  if (typeof atSubmit === "number" && Number.isFinite(atSubmit) && atSubmit >= 0) {
    if (atSubmit <= maxTokens) return null;
    const closing = total - atSubmit;
    return `Token budget exceeded: ${atSubmit} of ${maxTokens} tokens before the forecast was accepted${closing > 0 ? ` (the closing turn after it used ${closing} more, which the budget does not count)` : ""}.`;
  }
  return total <= maxTokens ? null : `Token budget exceeded: ${total} of ${maxTokens} tokens.`;
}

/**
 * Audit one returned run. Every check runs and every deviation is listed: one failed check
 * (for example the token budget) never hides the others. Scoreability depends only on the
 * forecast itself; any listed issue makes the run non-compliant.
 */
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
  const agent = protocolForJob(plan, job);
  /** Record a deviation when `ok` is false. */
  const check = (ok: unknown, message: string) => {
    if (!ok) issues.push(message);
    return !!ok;
  };
  /** Run checks that may meet malformed data; an unexpected error becomes a deviation, not a stop. */
  const guarded = (fn: () => void) => {
    try {
      fn();
    } catch (error) {
      issues.push((error as Error).message);
    }
  };
  // Scoreability: is this a usable forecast for this job?
  check(
    run.jobId === job.id && run.planDigest === plan.digest,
    "Job identity or frozen-plan digest mismatch.",
  );
  const e = run.execution as RunResult["execution"] | undefined;
  const recorded = check(e && typeof e === "object", "Missing execution record (versions, model, budgets and times).");
  const failed = !check(run.status === "completed", "Worker reported a failed execution.");
  // Invented (mock or simulated) executions are only scoreable in synthetic studies;
  // real agent executions are scoreable in any study.
  check(
    !e?.synthetic || plan.study.synthetic,
    "Simulated execution cannot be scored against a real study.",
  );
  if (!failed)
    guarded(() => {
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
    });
  const scoreable = issues.length === 0;
  // Compliance: how the forecast was made. Each check is independent.
  check(
    typeof run.sessionId === "string" && run.sessionId.length > 0,
    "Missing independent-session identifier.",
  );
  if (recorded) {
    const x = e!;
    check(
      Number.isFinite(Date.parse(x.startedAt)) &&
        Date.parse(x.startedAt) >=
          Date.parse(plan.jobFrozenAt?.[job.id] ?? plan.frozenAt),
      "Execution predates the frozen plan or lacks a start timestamp.",
    );
    check(
      x.versions &&
        (["engine", "runtime", "connector", "provider"] as const).every(
          (k) => typeof x.versions[k] === "string" && x.versions[k].length > 0,
        ),
      "Record engine, runtime, connector and provider versions.",
    );
    check(
      [x.inputTokens, x.cacheReadTokens, x.cacheWriteTokens, x.reasoningTokens].every(
        (v) => v === null || (Number.isSafeInteger(v) && v >= 0),
      ),
      "Unavailable token breakdowns must be null, not invented.",
    );
    check(
      x.provider === agent.model.provider &&
        x.model === agent.model.model &&
        x.reasoning === agent.model.reasoning,
      "Model settings differ from the frozen recipe.",
    );
    if (agent.tools.includes("xr-interact")) {
      guarded(() => issues.push(...runtimeIssues(plan, agent, run.trace)));
      // The executor counts the starts of a bridge it wrapped (bridge.jsonl), also when the
      // restarted bridge did not report itself again.
      const starts = (x as { runtimeStarts?: unknown }).runtimeStarts;
      if (typeof starts === "number" && starts > 1 && !issues.some((i) => i.startsWith("The runtime restarted")))
        issues.push(restartIssue(starts));
      // "custom" engine or backend in the recipe means not specified (e.g. a WebXR app).
      const want = plan.study.runtime;
      const capabilities = Array.isArray(x.capabilities) ? x.capabilities : [];
      check(
        (want.engine === "custom" || x.engine === want.engine || x.engine === agent.runtime) &&
          (want.backend === "custom" || x.backend === want.backend) &&
          x.deviceProfile === want.deviceProfile &&
          x.observation === agent.observation,
        "Runtime, device profile or observation differs from the frozen recipe.",
      );
      check(
        want.requiredCapabilities.every((c) => capabilities.includes(c)),
        "Required runtime capability is absent.",
      );
      if (agent.observation === "stereo-pair")
        check(
          capabilities.includes("stereo-capture"),
          "Stereo capture is not supported by this worker.",
        );
    }
    check(
      Number.isInteger(x.toolCalls) &&
        x.toolCalls >= 0 &&
        x.toolCalls <= agent.maxToolCalls,
      "Tool budget exceeded or not recorded.",
    );
    check(
      Number.isInteger(x.outputTokens) &&
        x.outputTokens >= 0 &&
        x.outputTokens <= agent.maxOutputTokens,
      "Output budget exceeded or not recorded.",
    );
    const budget = tokenBudgetIssue(x, agent.maxTokens);
    if (budget) issues.push(budget);
    check(
      Number.isFinite(x.inferenceWallTimeMs) &&
        x.inferenceWallTimeMs >= 0 &&
        Number.isFinite(x.simulationTimeMs) &&
        x.simulationTimeMs >= 0,
      "Keep valid model wall time and simulation time separately.",
    );
    check(
      x.humanTimeEstimateMs === null ||
        (Number.isFinite(x.humanTimeEstimateMs) && x.humanTimeEstimateMs >= 0),
      "Invalid separately modeled human time.",
    );
  }
  const trace = Array.isArray(run.trace) ? run.trace : null;
  check(
    trace && trace.filter((t) => t?.type === "forecast").length === 1,
    "Record exactly one forecast boundary.",
  );
  // The design order the executor assigned at launch (counterbalanced population sessions): visits
  // are checked against it. Runs without one were given the protocol's order.
  const assigned = (e as { designOrder?: unknown } | undefined)?.designOrder;
  if (validOrder(plan.study, assigned, agent.requiredCaseIds)) agent.requiredCaseIds = casesInOrder(plan.study, agent.requiredCaseIds, assigned);
  if (trace) guarded(() => issues.push(...exposureIssues(plan, agent, trace)));
  return {
    jobId: job.id,
    completed: run.status === "completed",
    scoreable,
    compliant: scoreable && issues.length === 0,
    issues: [...new Set(issues)],
    // Information, not a deviation: how many project files a configuration with project access opened.
    ...(agent.tools.includes("read-files") && trace ? { filesRead: filesRead(trace) } : {}),
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
