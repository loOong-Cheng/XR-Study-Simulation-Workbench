export type Domain = "objective" | "subjective";
export type Tool =
  | "read-files"
  | "xr-interact"
  | "read-evidence"
  | "read-participant-data"
  | "compute";
export type SourceKind =
  | "brief"
  | "project"
  | "evidence"
  | "demographics"
  | "objective-records"
  | "trajectory";
export type Observation = "none" | "mono" | "stereo-pair";
export interface Outcome {
  id: string;
  label: string;
  domain: Domain;
  unit: string;
  scale: "continuous" | "proportion" | "ordinal" | "rank";
  aggregation: "arithmetic" | "geometric";
  family: string;
  weight: number;
  phaseIds: string[];
  components?: string[];
  description: string;
}
export interface Study {
  schemaVersion: "1.0";
  id: string;
  title: string;
  researchQuestion: string;
  synthetic: boolean;
  design: "within-subjects" | "between-subjects";
  predictionLevel: "population" | "individual";
  predictionTiming: "before-experience" | "after-experience";
  conditions: { id: string; label: string }[];
  phases: {
    id: string;
    label: string;
    kind: "practice" | "exploration" | "main" | "questionnaire" | "break";
  }[];
  cases: {
    id: string;
    conditionId: string;
    phaseId: string;
    label: string;
    requiredActions: string[];
    /**
     * Least number of scored actions a participant-like run needs in this task (e.g. one answer
     * per trial). The audit checks it (see scoredAction in protocol.ts).
     */
    minActions?: number;
    /**
     * Protocol rule: every scored action needs an observation (screenshot) in this task since the
     * previous scored action. Breaking it is a protocol deviation (no clicking from memory).
     */
    observeBeforeEachAction?: boolean;
  }[];
  participants: { id: string; stratum: string; conditionOrder: string[] }[];
  sources: {
    id: string;
    label: string;
    kind: SourceKind;
    description: string;
    fields?: string[];
  }[];
  runtime: {
    engine: "unreal" | "unity" | "custom";
    backend: "meta-xr-simulator" | "openxr" | "editor" | "custom";
    observation: Exclude<Observation, "none">;
    deviceProfile: string;
    requiredCapabilities: string[];
  };
  outcomes: Outcome[];
  analysis: {
    mode: "relative" | "both";
    familyWeights: Record<string, number>;
    bootstrapDraws: number;
    seed: number;
    tieTolerance: number;
    contrasts: {
      id: string;
      baseline: string;
      candidate: string;
      domain: Domain;
    }[];
  };
}
export interface AgentProtocol {
  id: string;
  label: string;
  rationale: string;
  model: { provider: string; model: string; reasoning: string };
  autonomy: "standardized-exposure" | "autonomous-exploration";
  caseOrder: "as-listed" | "agent-choice";
  sourceIds: string[];
  tools: Tool[];
  observation: Observation;
  requiredCaseIds: string[];
  requiredSourceIds: string[];
  /** Safety cap on tool calls (submitting the forecast is not counted). */
  maxToolCalls: number;
  maxOutputTokens: number;
  /**
   * Token budget per session: all tokens the session uses (input including cache writes and
   * reads, plus output). The runtimes refuse further calls once 90% is used, so the agent submits
   * its forecast; the executor stops a session at 150%. Absent = no token limit.
   */
  maxTokens?: number;
  forecastInstruction: string;
  /** Population or individual forecasts; defaults to the study's prediction level. */
  level?: "population" | "individual";
  /** Independent sessions (per participant for individual configs); defaults to the plan's repetitions. */
  repetitions?: number;
  /** Outcome IDs this config predicts; defaults to every outcome not used as an input. */
  targets?: string[];
  /** Measured outcome IDs given to the agent as data (a dependent variable used as an independent one). */
  inputs?: string[];
  /** Execution runtime ID (webxr, unreal, unity, visionos, none). */
  runtime?: string;
}
export interface Job {
  id: string;
  agentId: string;
  repetition: number;
  participantId?: string;
}
export interface Plan {
  schemaVersion: "1.0";
  study: Study;
  agents: AgentProtocol[];
  repetitions: number;
  jobs: Job[];
  frozenAt: string;
  /** Per-job freeze times for campaign lineages (reused jobs were frozen by an earlier campaign). */
  jobFrozenAt?: Record<string, string>;
  digest: string;
}
export interface Measurement {
  participantId?: string;
  conditionId: string;
  outcomeId: string;
  value?: number;
  components?: Record<string, number>;
}
export interface HumanData {
  schemaVersion: "1.0";
  studyId: string;
  synthetic: boolean;
  measurements: Measurement[];
}
export interface Capture {
  eye: "mono" | "left" | "right";
  sha256: string;
  frameId: string;
  simulationTimeMs: number;
  /** Which clock simulationTimeMs is on: the app's own (getState().timeMs) or wall time since the design opened. */
  clock?: "app" | "wall";
  eyeSeparationM?: number;
  viewMatrix?: number[];
  projectionMatrix?: number[];
}
export type TraceEvent =
  | {
      type: "source";
      sourceId: string;
      delivery: "injected" | "read";
      sha256: string;
    }
  | { type: "phase"; phaseId: string }
  /**
   * What the runtime itself provides, reported by the runtime (not copied from the study):
   * engine and version, backend, device profile, observation and capabilities. The audit
   * compares it with the frozen recipe.
   */
  | {
      type: "runtime";
      engine: string;
      engineVersion: string;
      backend: string;
      deviceProfile: string;
      observation: Exclude<Observation, "none">;
      capabilities: string[];
    }
  | { type: "case-start"; caseId: string; phaseId: string }
  | {
      type: "observation";
      caseId: string;
      phaseId: string;
      captures: Capture[];
    }
  | {
      type: "action";
      caseId: string;
      phaseId: string;
      action: string;
      /** False when the app refused the action (e.g. a move into a wall, a click with no active trial). */
      completed: boolean;
      /**
       * A task answer (a selection, a click, an app action) rather than looking or pointing. When
       * a runtime marks it on any action, only scored actions count for minActions and
       * observeBeforeEachAction; otherwise every completed action except complete-task counts.
       */
      scored?: boolean;
      /** The app's reply, as far as documented (accepted, correct, hit, reason); null when the app gave none. */
      result?: Record<string, unknown> | null;
      /** Arguments that are not secret: the neutral object ID, the screen point (0–1) or the app action's arguments. */
      args?: Record<string, unknown>;
      /** Simulated runs: invented, not checked against a runtime. */
      checked?: boolean;
    }
  | { type: "case-end"; caseId: string; phaseId: string; submitted: boolean }
  | { type: "forecast" };
export interface RunResult {
  jobId: string;
  planDigest: string;
  status: "completed" | "failed";
  sessionId: string;
  error?: string;
  execution: {
    synthetic: boolean;
    engine: string;
    backend: string;
    observation: Observation;
    deviceProfile: string;
    provider: string;
    model: string;
    reasoning: string;
    versions: {
      engine: string;
      runtime: string;
      connector: string;
      provider: string;
    };
    startedAt: string;
    capabilities: string[];
    toolCalls: number;
    outputTokens: number;
    inputTokens: number | null;
    cacheReadTokens: number | null;
    cacheWriteTokens: number | null;
    reasoningTokens: number | null;
    inferenceWallTimeMs: number;
    simulationTimeMs: number;
    humanTimeEstimateMs: number | null;
    technicalRetries: number;
    /**
     * All tokens (input including cache, plus output) used up to the moment the forecast was
     * accepted; the turn that closes the session afterwards is not included. Absent when unknown.
     */
    tokensAtSubmit?: number;
    /** Times the session's external runtime (study bridge) was started; more than 1 is a restart. */
    runtimeStarts?: number;
  };
  measurements: Measurement[];
  trace: TraceEvent[];
}
export interface ResultBundle {
  schemaVersion: "1.0";
  studyId: string;
  runs: RunResult[];
}
export interface Audit {
  jobId: string;
  completed: boolean;
  scoreable: boolean;
  compliant: boolean;
  issues: string[];
}
export interface Interval {
  low: number;
  high: number;
}
export interface MetricScore {
  agentId: string;
  outcomeId: string;
  domain: Domain;
  agreement: number | null;
  absoluteMAE: number | null;
  informativeUnits: number;
  informativePairs: number;
  runs: number;
}
export interface SummaryScore {
  agentId: string;
  level?: "population" | "individual";
  domain: Domain;
  agreement: number | null;
  ci95: Interval | null;
  completeAdherenceSensitivity: number | null;
  assigned: number;
  returned: number;
  /** Returned runs made by a real agent session / by the simulator. They are never pooled. */
  real?: number;
  simulated?: number;
  scoreable: number;
  compliant: number;
}
export interface ContrastScore {
  id: string;
  baseline: string;
  candidate: string;
  domain: Domain;
  difference: number | null;
  ci95: Interval | null;
  p: number | null;
  holmP: number | null;
  status: string;
  /** Whether the comparison was frozen with the plan or chosen when analysing. */
  declared: "in plan" | "at analysis";
}
/** A comparison between two agent methods, chosen for the analysis. */
export interface Comparison {
  id?: string;
  candidate: string;
  baseline: string;
  domain: Domain;
}
export interface AnalysisReport {
  studyId: string;
  title: string;
  synthetic: boolean;
  planDigest: string;
  predictionLevel: Study["predictionLevel"];
  metrics: MetricScore[];
  summaries: SummaryScore[];
  contrasts: ContrastScore[];
  audits: Audit[];
  exclusions: string[];
  notes: string[];
  /** Agreement per run (population) or per participant (individual), for distribution plots. */
  runScores?: RunScore[];
  /** Agent predictions per unit and the human values, on the outcome's native scale. */
  values?: PredictedValue[];
  /**
   * Which human design differences are scored: "means" (any difference in the design means) or
   * "significant" (only pairs a test supports; always used for between-subjects studies).
   */
  pairRule?: "means" | "significant";
  /** Every human design pair of every measure, with its test (population level). */
  humanPairs?: HumanPair[];
  /** Population configurations' mean prediction against the human group's 95% CI, per measure and design. */
  absoluteFit?: AbsoluteFit[];
  /** Within-subjects studies: the population scores again, on significant human differences only. */
  significantOnly?: { summaries: SummaryScore[]; exclusions: string[]; humanPairs: HumanPair[] };
  humanValues?: { participantId: string; outcomeId: string; conditionId: string; value: number }[];
  /**
   * Configurations whose returned runs are all simulated (invented). Figures mark them and never
   * test them against configurations with real runs or against the human data.
   */
  simulatedConfigs?: string[];
  bootstrapDraws: number;
  seed: number;
}
export interface HumanPair {
  outcomeId: string;
  a: string;
  b: string;
  meanA: number;
  meanB: number;
  test: "Mann–Whitney U" | "Wilcoxon signed-rank";
  p: number | null;
  pHolm: number | null;
  significant: boolean;
  /** Whether agents are scored on this pair under the report's pair rule. */
  used: boolean;
}
export interface AbsoluteFit {
  agentId: string;
  outcomeId: string;
  conditionId: string;
  human: number;
  low: number;
  high: number;
  n: number;
  agent: number;
  /** Agent minus human, on the outcome's scale. */
  error: number;
  /** Inside the human 95% interval (an exact match, within the tie tolerance, when degenerate). */
  inside: boolean;
  /** Every person gave the same value, so the interval has zero width. */
  degenerate?: boolean;
  note?: string;
}
export interface RunScore {
  agentId: string;
  level: "population" | "individual";
  domain: Domain;
  /** Job ID (population run) or participant ID (individual). */
  unit: string;
  repetition: number;
  agreement: number | null;
}
export interface PredictedValue {
  agentId: string;
  level: "population" | "individual";
  unit: string;
  repetition: number;
  participantId?: string;
  outcomeId: string;
  conditionId: string;
  value: number;
}
