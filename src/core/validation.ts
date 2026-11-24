import type { AgentProtocol, Comparison, Domain, HumanData, Measurement, Study } from "./types.js";

export function requireThat(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
function keys(value: object, allowed: string[], label: string): void {
  requireThat(
    Object.keys(value).every((k) => allowed.includes(k)),
    `Unknown ${label} properties. Keep reference answers and credentials out of planning contracts.`,
  );
}
function uniqueIds(rows: { id: string }[], label: string): void {
  requireThat(Array.isArray(rows), `${label} must be an array.`);
  requireThat(
    rows.every((r) => r && typeof r === "object" && !Array.isArray(r)),
    `Each entry of ${label} must be an object.`,
  );
  requireThat(
    rows.every((r) => typeof r.id === "string" && identifier.test(r.id)),
    `${label} need unique, simple identifiers.`,
  );
  requireThat(
    new Set(rows.map((r) => r.id)).size === rows.length,
    `Duplicate ${label} identifier.`,
  );
}
/**
 * Length limits for a study's texts, so one oversized field cannot bloat every page and file that
 * shows the study: titles and labels 500 characters, the research question and descriptions 5,000,
 * short words (units, families, strata, fields, actions, capabilities) 200.
 */
export const STUDY_TEXT_LIMITS = { label: 500, long: 5000, word: 200 };
function textField(value: unknown, max: number, what: string, optional = false): void {
  if (optional && value === undefined) return;
  requireThat(typeof value === "string", `${what} must be text.`);
  requireThat(value.length <= max, `${what} is too long: keep it to ${max.toLocaleString("en")} characters.`);
}
const words = (value: unknown, what: string, optional = false) => {
  if (optional && value === undefined) return;
  requireThat(Array.isArray(value), `${what} must be a list.`);
  value.forEach((x) => textField(x, STUDY_TEXT_LIMITS.word, `Each entry of ${what}`));
};
export function validateStudy(value: unknown): Study {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "Provide a study object.");
  const s = value as Study;
  requireThat(
    Object.keys(s).every((k) =>
      [
        "schemaVersion",
        "id",
        "title",
        "researchQuestion",
        "synthetic",
        "design",
        "predictionLevel",
        "predictionTiming",
        "conditions",
        "phases",
        "cases",
        "participants",
        "sources",
        "runtime",
        "outcomes",
        "analysis",
      ].includes(k),
    ),
    "Unknown study properties. Keep human reference answers in their separate analysis file.",
  );
  requireThat(
    s.schemaVersion === "1.0" && identifier.test(s.id),
    "Unsupported study schema or invalid study ID.",
  );
  requireThat(
    typeof s.title === "string" && s.title.trim().length > 0,
    "A study title is required.",
  );
  textField(s.title, STUDY_TEXT_LIMITS.label, "The study title");
  requireThat(
    typeof s.researchQuestion === "string" &&
      s.researchQuestion.trim().length > 0,
    "State the research question.",
  );
  textField(s.researchQuestion, STUDY_TEXT_LIMITS.long, "The research question");
  requireThat(
    typeof s.synthetic === "boolean",
    "Declare whether the study is synthetic.",
  );
  requireThat(
    ["within-subjects", "between-subjects"].includes(s.design),
    "Unknown experimental design.",
  );
  requireThat(
    ["population", "individual"].includes(s.predictionLevel),
    "Choose a prediction level.",
  );
  requireThat(
    ["before-experience", "after-experience"].includes(s.predictionTiming),
    "Choose prediction timing.",
  );
  requireThat(
    !(s.design === "between-subjects" && s.predictionLevel === "individual"),
    "Individual within-person design ranking requires a within-subjects study. Use population comparison for a between-subjects study.",
  );
  for (const [key, rows] of Object.entries({
    conditions: s.conditions,
    phases: s.phases,
    cases: s.cases,
    participants: s.participants,
    sources: s.sources,
    outcomes: s.outcomes,
  }))
    uniqueIds(rows, key);
  requireThat(
    s.runtime && typeof s.runtime === "object" && !Array.isArray(s.runtime),
    "Declare the runtime (engine, backend, observation, device profile, capabilities).",
  );
  requireThat(
    s.analysis &&
      typeof s.analysis === "object" &&
      s.analysis.familyWeights &&
      typeof s.analysis.familyWeights === "object" &&
      Array.isArray(s.analysis.contrasts) &&
      s.analysis.contrasts.every((x) => x && typeof x === "object"),
    "Declare the analysis (mode, family weights, bootstrap draws, seed, tie tolerance, contrasts).",
  );
  // Texts: of the right type and bounded (STUDY_TEXT_LIMITS).
  const { label, long } = STUDY_TEXT_LIMITS;
  s.conditions.forEach((x) => textField(x.label, label, `The label of design ${x.id}`));
  s.phases.forEach((x) => textField(x.label, label, `The label of phase ${x.id}`));
  s.cases.forEach((x) => {
    textField(x.label, label, `The label of task ${x.id}`, true);
    words(x.requiredActions, `the required actions of task ${x.id}`);
  });
  s.participants.forEach((x) => textField(x.stratum, STUDY_TEXT_LIMITS.word, `The stratum of participant ${x.id}`, true));
  s.sources.forEach((x) => {
    textField(x.label, label, `The label of source ${x.id}`);
    textField(x.description, long, `The description of source ${x.id}`, true);
    words(x.fields, `the fields of source ${x.id}`, true);
  });
  s.outcomes.forEach((x) => {
    textField(x.label, label, `The label of measure ${x.id}`);
    textField(x.description, long, `The description of measure ${x.id}`, true);
    textField(x.unit, STUDY_TEXT_LIMITS.word, `The unit of measure ${x.id}`);
    textField(x.family, STUDY_TEXT_LIMITS.word, `The family of measure ${x.id}`);
    words(x.phaseIds, `the measurement phases of ${x.id}`);
    words(x.components, `the items of ${x.id}`, true);
  });
  textField(s.runtime.deviceProfile, STUDY_TEXT_LIMITS.word, "The device profile", true);
  words(s.runtime.requiredCapabilities, "the required capabilities", true);
  s.conditions.forEach((x) => keys(x, ["id", "label"], "condition"));
  s.phases.forEach((x) => keys(x, ["id", "label", "kind"], "phase"));
  s.cases.forEach((x) =>
    keys(
      x,
      ["id", "conditionId", "phaseId", "label", "requiredActions", "minActions"],
      "case",
    ),
  );
  s.participants.forEach((x) =>
    keys(x, ["id", "stratum", "conditionOrder"], "participant"),
  );
  s.sources.forEach((x) =>
    keys(x, ["id", "label", "kind", "description", "fields"], "source"),
  );
  s.outcomes.forEach((x) =>
    keys(
      x,
      [
        "id",
        "label",
        "domain",
        "unit",
        "scale",
        "aggregation",
        "family",
        "weight",
        "phaseIds",
        "components",
        "description",
      ],
      "outcome",
    ),
  );
  keys(
    s.runtime,
    [
      "engine",
      "backend",
      "observation",
      "deviceProfile",
      "requiredCapabilities",
    ],
    "runtime",
  );
  keys(
    s.analysis,
    [
      "mode",
      "familyWeights",
      "bootstrapDraws",
      "seed",
      "tieTolerance",
      "contrasts",
    ],
    "analysis",
  );
  s.analysis.contrasts.forEach((x) =>
    keys(x, ["id", "baseline", "candidate", "domain"], "contrast"),
  );
  requireThat(
    s.conditions.length >= 2,
    "At least two design conditions are required.",
  );
  requireThat(
    s.participants.length >= 2,
    "Declare at least two reference participants.",
  );
  requireThat(
    s.outcomes.length > 0 && s.phases.length > 0,
    "Declare phases and outcomes.",
  );
  const conditions = new Set(s.conditions.map((c) => c.id));
  const phases = new Set(s.phases.map((p) => p.id));
  requireThat(
    s.phases.every((p) =>
      ["practice", "exploration", "main", "questionnaire", "break"].includes(
        p.kind,
      ),
    ),
    "Unknown study phase kind.",
  );
  for (const p of s.participants) {
    requireThat(
      typeof p.stratum === "string" && p.stratum.length > 0,
      "Participants need an order/design stratum.",
    );
    requireThat(
      Array.isArray(p.conditionOrder) &&
        new Set(p.conditionOrder).size === p.conditionOrder.length &&
        p.conditionOrder.every((c) => conditions.has(c)),
      `The design order of ${p.id} (${Array.isArray(p.conditionOrder) ? p.conditionOrder.join(", ") || "empty" : "missing"}) must list known designs (${[...conditions].join(", ")}), each at most once.`,
    );
    requireThat(
      s.design === "within-subjects"
        ? p.conditionOrder.length === conditions.size
        : p.conditionOrder.length === 1,
      s.design === "within-subjects"
        ? `In a within-subjects study each person experiences every design (${conditions.size}), but ${p.id} has ${p.conditionOrder.length} (${p.conditionOrder.join(", ")}). Fix the orders (participants file or study.json), or choose Between-subjects.`
        : `In a between-subjects study each person experiences one design, but ${p.id} has ${p.conditionOrder.length} (${p.conditionOrder.join(", ")}). Give each person the one design they saw (participants file or study.json), or keep Within-subjects.`,
    );
  }
  const expectedPerStratum = new Map<string, string>();
  for (const p of s.participants) {
    const order = p.conditionOrder.join("|");
    requireThat(
      !expectedPerStratum.has(p.stratum) ||
        expectedPerStratum.get(p.stratum) === order,
      `Stratum ${p.stratum} mixes different orders. Give each order/condition its own stratum.`,
    );
    expectedPerStratum.set(p.stratum, order);
  }
  for (const c of s.cases)
    requireThat(
      conditions.has(c.conditionId) &&
        phases.has(c.phaseId) &&
        Array.isArray(c.requiredActions) &&
        c.requiredActions.every((a) => typeof a === "string") &&
        (c.minActions === undefined || (Number.isInteger(c.minActions) && c.minActions >= 0)),
      `Invalid case ${c.id}.`,
    );
  const sourceKinds = [
    "brief",
    "project",
    "evidence",
    "demographics",
    "objective-records",
    "trajectory",
  ];
  requireThat(
    s.sources.every((x) => sourceKinds.includes(x.kind)),
    "Unknown source kind. Target answers must not be declared as an agent source.",
  );
  for (const source of s.sources)
    if (
      ["demographics", "objective-records", "trajectory"].includes(source.kind)
    ) {
      requireThat(
        Array.isArray(source.fields) &&
          source.fields.length > 0 &&
          source.fields.every((f) => typeof f === "string") &&
          new Set(source.fields).size === source.fields.length,
        `List the exact permitted fields for ${source.id}.`,
      );
      requireThat(
        !source.fields.some((f) => s.outcomes.some((o) => o.id === f)),
        `Target outcome field included in source ${source.id}. Use predictor-only source definitions.`,
      );
    }
  requireThat(
    s.runtime &&
      ["unreal", "unity", "custom"].includes(s.runtime.engine) &&
      ["meta-xr-simulator", "openxr", "editor", "custom"].includes(
        s.runtime.backend,
      ),
    "Choose an engine and execution backend.",
  );
  requireThat(
    ["mono", "stereo-pair"].includes(s.runtime.observation) &&
      Array.isArray(s.runtime.requiredCapabilities),
    "Declare runtime observations and capabilities.",
  );
  requireThat(
    typeof s.runtime.deviceProfile === "string" &&
      s.runtime.deviceProfile.trim().length > 0,
    "Declare the target device profile; do not silently substitute another headset.",
  );
  for (const o of s.outcomes) {
    requireThat(
      ["objective", "subjective"].includes(o.domain) &&
        ["continuous", "proportion", "ordinal", "rank"].includes(o.scale),
      `Invalid outcome ${o.id}.`,
    );
    // A preference ranking compares designs within one person; in a between-subjects study each
    // person experienced one design, so there is nothing to rank.
    requireThat(
      !(s.design === "between-subjects" && o.scale === "rank"),
      `${o.label} is a ranking of the designs, but in a between-subjects study each person experienced only one design. Measure a rating per design instead (for example appeal 1–7).`,
    );
    requireThat(
      ["arithmetic", "geometric"].includes(o.aggregation),
      `Invalid aggregation for ${o.id}.`,
    );
    requireThat(
      Number.isFinite(o.weight) && o.weight > 0,
      `Outcome ${o.id} needs a positive within-family weight.`,
    );
    requireThat(
      o.phaseIds.length > 0 && o.phaseIds.every((p) => phases.has(p)),
      `Declare measurement windows for ${o.id}.`,
    );
    requireThat(
      o.components === undefined ||
        (o.components.length > 1 &&
          new Set(o.components).size === o.components.length),
      `Invalid retained-item composite ${o.id}.`,
    );
    requireThat(
      o.components === undefined || o.aggregation === "arithmetic",
      "Item composites use arithmetic item means.",
    );
  }
  requireThat(
    s.analysis && ["relative", "both"].includes(s.analysis.mode),
    "Choose relative ranking or relative plus absolute diagnostics.",
  );
  requireThat(
    Number.isInteger(s.analysis.bootstrapDraws) &&
      s.analysis.bootstrapDraws >= 100 &&
      s.analysis.bootstrapDraws <= 20000,
    "Use 100–20,000 bootstrap draws.",
  );
  requireThat(
    Number.isSafeInteger(s.analysis.seed) &&
      Number.isFinite(s.analysis.tieTolerance) &&
      s.analysis.tieTolerance >= 0,
    "Declare a seed and a nonnegative numerical tie tolerance.",
  );
  for (const o of s.outcomes)
    requireThat(
      Number.isFinite(s.analysis.familyWeights[o.family]) &&
        s.analysis.familyWeights[o.family] > 0,
      `Missing positive family weight for ${o.family}.`,
    );
  uniqueIds(s.analysis.contrasts, "contrasts");
  requireThat(
    s.analysis.contrasts.every(
      (c) =>
        ["objective", "subjective"].includes(c.domain) &&
        c.baseline !== c.candidate,
    ),
    "Invalid planned contrast.",
  );
  return structuredClone(s);
}
export function validateAgents(
  s: Study,
  agents: AgentProtocol[],
): AgentProtocol[] {
  uniqueIds(agents, "agents");
  requireThat(
    agents.length > 0 && agents.length <= 40,
    "Choose 1–40 agent configurations.",
  );
  const sources = new Map(s.sources.map((x) => [x.id, x]));
  const cases = new Set(s.cases.map((c) => c.id));
  const allowed = [
    "read-files",
    "xr-interact",
    "read-evidence",
    "read-participant-data",
    "compute",
  ];
  for (const a of agents) {
    keys(
      a,
      [
        "id",
        "label",
        "rationale",
        "model",
        "autonomy",
        "caseOrder",
        "sourceIds",
        "tools",
        "observation",
        "requiredCaseIds",
        "requiredSourceIds",
        "maxToolCalls",
        "maxOutputTokens",
        "maxTokens",
        "forecastInstruction",
        "level",
        "repetitions",
        "targets",
        "inputs",
        "runtime",
      ],
      "agent",
    );
    const outcomeIds = new Set(s.outcomes.map((o) => o.id));
    requireThat(
      a.level === undefined || ["population", "individual"].includes(a.level),
      `Unknown prediction level for ${a.id}.`,
    );
    // Individual scoring orders the designs within one person; between subjects, each person has one.
    requireThat(
      !(s.design === "between-subjects" && (a.level ?? s.predictionLevel) === "individual"),
      `${a.label} predicts at individual level, which needs every person to experience several designs. In a between-subjects study use population level: the groups are compared, with independent-samples tests.`,
    );
    requireThat(
      a.repetitions === undefined ||
        (Number.isInteger(a.repetitions) &&
          a.repetitions >= 1 &&
          a.repetitions <= ((a.level ?? s.predictionLevel) === "individual" ? 50 : 1000)),
      `Use 1–50 runs per participant for an individual configuration, or 1–1000 runs for a population configuration (${a.id}).`,
    );
    for (const [field, list] of [
      ["targets", a.targets],
      ["inputs", a.inputs],
    ] as const)
      requireThat(
        list === undefined ||
          (Array.isArray(list) &&
            list.every((id) => outcomeIds.has(id)) &&
            new Set(list).size === list.length),
        `Unknown or duplicate outcome in ${field} of ${a.id}.`,
      );
    requireThat(
      !a.inputs?.some((id) => a.targets?.includes(id)),
      `${a.id} cannot predict an outcome it is given as input.`,
    );
    requireThat(
      !a.inputs?.length || s.predictionTiming === "after-experience",
      `${a.id} uses measured outcomes as inputs, which requires an after-experience forecast.`,
    );
    requireThat(
      a.runtime === undefined || identifier.test(a.runtime),
      `Invalid runtime ID for ${a.id}.`,
    );
    requireThat(
      (a.targets ?? s.outcomes.map((o) => o.id)).some((id) => !a.inputs?.includes(id)),
      `${a.id} has nothing left to predict.`,
    );
    keys(a.model, ["provider", "model", "reasoning"], "model");
    requireThat(
      a.model &&
        [a.model.provider, a.model.model, a.model.reasoning].every(
          (v) => typeof v === "string" && v.length > 0,
        ),
      `Declare the model settings for ${a.id}.`,
    );
    requireThat(
      ["standardized-exposure", "autonomous-exploration"].includes(a.autonomy),
      `Unknown autonomy mode for ${a.id}.`,
    );
    requireThat(
      ["as-listed", "agent-choice"].includes(a.caseOrder),
      `Declare the case-order policy for ${a.id}.`,
    );
    requireThat(
      a.tools.every((t) => allowed.includes(t)) &&
        new Set(a.tools).size === a.tools.length,
      `Invalid tools for ${a.id}.`,
    );
    requireThat(
      ["none", "mono", "stereo-pair"].includes(a.observation),
      `Invalid observation for ${a.id}.`,
    );
    requireThat(
      a.sourceIds.every((id) => sources.has(id)) &&
        new Set(a.sourceIds).size === a.sourceIds.length,
      `Unknown/duplicate source for ${a.id}.`,
    );
    requireThat(
      a.requiredSourceIds.every((id) => a.sourceIds.includes(id)) &&
        a.requiredCaseIds.every((id) => cases.has(id)),
      `Unknown required exposure for ${a.id}.`,
    );
    requireThat(
      new Set(a.requiredSourceIds).size === a.requiredSourceIds.length &&
        new Set(a.requiredCaseIds).size === a.requiredCaseIds.length,
      `Duplicate required exposure for ${a.id}; define repeated cases with distinct IDs.`,
    );
    requireThat(
      a.tools.includes("xr-interact") ||
        (a.requiredCaseIds.length === 0 && a.observation === "none"),
      `An agent without XR tools cannot require XR observations: ${a.id}.`,
    );
    requireThat(
      !a.tools.includes("xr-interact") ||
        a.observation === s.runtime.observation,
      "Keep the observation mode fixed within a comparison plan. Use another frozen plan to compare mono and stereo.",
    );
    requireThat(
      Number.isInteger(a.maxToolCalls) &&
        a.maxToolCalls >= 0 &&
        a.maxToolCalls <= 100000 &&
        Number.isInteger(a.maxOutputTokens) &&
        a.maxOutputTokens > 0,
      `Invalid resource limits for ${a.id}.`,
    );
    // Empty (null) means no limit. Frozen campaigns keep the older lower bound of 1000 tokens.
    const budget = a.maxTokens as unknown;
    if (budget !== undefined && budget !== null) {
      requireThat(
        typeof budget === "number" && Number.isInteger(budget),
        `The token budget of ${a.label} must be a whole number of tokens, such as 200000 (not ${JSON.stringify(budget)}). Leave it empty for no limit.`,
      );
      requireThat(budget >= 1000, budgetTooLow(a.label));
      requireThat(budget <= 1_000_000_000, budgetTooHigh(a.label));
    }
    requireThat(
      typeof a.forecastInstruction === "string" &&
        a.forecastInstruction.length > 0,
      `Missing forecast instruction for ${a.id}.`,
    );
    for (const id of a.sourceIds) {
      const kind = sources.get(id)!.kind;
      if (kind === "project")
        requireThat(
          a.tools.includes("read-files"),
          `Project access needs read-files: ${a.id}.`,
        );
      if (kind === "evidence")
        requireThat(
          a.tools.includes("read-evidence"),
          `Evidence access needs read-evidence: ${a.id}.`,
        );
      if (["demographics", "objective-records", "trajectory"].includes(kind)) {
        requireThat(
          a.tools.includes("read-participant-data"),
          `Participant access needs its own permission: ${a.id}.`,
        );
        requireThat(
          s.predictionTiming === "after-experience" ||
            !["objective-records", "trajectory"].includes(kind),
          `${a.label} gets ${sources.get(id)!.label}, recorded during the study, which a before-experience forecast cannot use. Remove it from ${a.label}, or set the forecast timing to after the experience.`,
        );
      }
    }
  }
  requireThat(
    s.analysis.contrasts.every(
      (c) =>
        agents.some((a) => a.id === c.baseline) &&
        agents.some((a) => a.id === c.candidate),
    ),
    "Every contrast must refer to two declared agents.",
  );
  // An empty budget (null) is no limit, as when the field is left out.
  return structuredClone(agents).map((a) => {
    if ((a.maxTokens as unknown) === null) delete a.maxTokens;
    return a;
  });
}

/** Smallest and largest token budget for configurations saved or frozen now. */
export const MIN_TOKEN_BUDGET = 20_000;
export const MAX_TOKEN_BUDGET = 50_000_000;
const budgetTooLow = (label: string) =>
  `The token budget of ${label} must be at least ${MIN_TOKEN_BUDGET.toLocaleString("en-US")} tokens: the first turn alone (instructions, brief and tools) uses several thousand, and every later turn re-reads it. Leave it empty for no limit.`;
const budgetTooHigh = (label: string) => `The token budget of ${label} must be at most ${MAX_TOKEN_BUDGET.toLocaleString("en-US")} tokens. Leave it empty for no limit.`;

/**
 * Claude Code's --effort level for a reasoning setting: null for "default" (nothing is passed),
 * "high" for "high" or "effort=high" (low, medium, high, xhigh, max), undefined when Claude Code
 * would not understand it.
 */
export function claudeEffort(reasoning: string): string | null | undefined {
  const r = String(reasoning ?? "").trim().toLowerCase();
  if (!r || r === "default") return null;
  return /^(?:effort\s*[=:]\s*)?(low|medium|high|xhigh|max)$/.exec(r)?.[1];
}
export const effortProblem = (reasoning: unknown, label?: string) =>
  `Reasoning setting "${String(reasoning)}"${label ? ` of ${label}` : ""} is not understood by Claude Code. Use default, or effort=low|medium|high|xhigh|max.`;
/** A model for a Claude Code session: refused here when Claude Code would refuse it at run time. */
export function checkModelSettings(model: { provider?: unknown; model?: unknown; reasoning?: unknown } | null | undefined, label: string) {
  if (!model || model.provider !== "claude-code") return;
  requireThat(claudeEffort(String(model.reasoning ?? "")) !== undefined, effortProblem(model.reasoning, label));
}

/**
 * Rules for configurations that are saved or frozen now. Older frozen campaigns are read without
 * them, so they stay open: a budget of 20,000–50,000,000 tokens, an app runtime exactly when the
 * configuration uses the app, and movement recordings only for individual forecasts.
 */
export function checkNewConfigurations(s: Study, agents: AgentProtocol[]): void {
  for (const a of agents) {
    if (typeof a.maxTokens === "number") {
      requireThat(a.maxTokens >= MIN_TOKEN_BUDGET, budgetTooLow(a.label));
      requireThat(a.maxTokens <= MAX_TOKEN_BUDGET, budgetTooHigh(a.label));
    }
    // Model settings Claude Code would refuse at run time are refused here.
    checkModelSettings(a.model, a.label);
    const app = a.tools.includes("xr-interact");
    requireThat(
      !(app && a.runtime === "none"),
      `${a.label} uses the running app, but its runtime is "none". Choose the study's runtime (for example webxr), or untick "the running app".`,
    );
    requireThat(
      app || a.runtime === undefined || a.runtime === "none",
      `${a.label} has the runtime "${a.runtime}" but does not use the running app. Tick "the running app", or set its runtime to none.`,
    );
    const level = a.level ?? s.predictionLevel;
    const movement = a.sourceIds.map((id) => s.sources.find((x) => x.id === id)).filter((x) => x?.kind === "trajectory");
    requireThat(
      level === "individual" || !movement.length,
      `${a.label} predicts the population but gets ${movement.map((x) => x!.label).join(", ")}: movement recordings are per participant, so a population forecast would get none. Remove ${movement.length === 1 ? "it" : "them"}, or make ${a.label} an individual configuration.`,
    );
  }
}

/** Saved comparisons (comparisons.json): pairs of configuration IDs and a domain, nothing else. */
export function validateComparisons(value: unknown): Comparison[] {
  requireThat(Array.isArray(value) && value.length <= 200, "Comparisons must be a list (at most 200).");
  return (value as unknown[]).map((c, i) => {
    requireThat(c && typeof c === "object" && !Array.isArray(c), `Comparison ${i + 1} must be an object with candidate, baseline and domain.`);
    const x = c as Record<string, unknown>;
    requireThat(Object.keys(x).every((k) => ["id", "candidate", "baseline", "domain"].includes(k)), `Comparison ${i + 1} has unknown properties; only id, candidate, baseline and domain are kept.`);
    requireThat(
      typeof x.candidate === "string" && typeof x.baseline === "string" && identifier.test(x.candidate) && identifier.test(x.baseline) && x.candidate !== x.baseline,
      `Comparison ${i + 1} needs two different configuration IDs (candidate and baseline).`,
    );
    requireThat(x.domain === "objective" || x.domain === "subjective", `Comparison ${i + 1} needs the domain objective or subjective.`);
    requireThat(x.id === undefined || (typeof x.id === "string" && identifier.test(x.id)), `Comparison ${i + 1} has an invalid ID.`);
    return { ...(x.id !== undefined ? { id: x.id as string } : {}), candidate: x.candidate as string, baseline: x.baseline as string, domain: x.domain as Domain };
  });
}
export function measurementKey(r: Measurement): string {
  return `${r.participantId ?? "*"}|${r.conditionId}|${r.outcomeId}`;
}
export function measurementValue(s: Study, r: Measurement): number {
  const o = s.outcomes.find((x) => x.id === r.outcomeId);
  requireThat(
    o && s.conditions.some((c) => c.id === r.conditionId),
    "Unknown outcome or design in a measurement.",
  );
  let value = r.value;
  if (o.components) {
    requireThat(
      r.components &&
        o.components.every((id) => Number.isFinite(r.components![id])),
      `${o.label} requires all retained item predictions; a scaled six-item total is insufficient.`,
    );
    value =
      o.components.reduce((sum, id) => sum + r.components![id], 0) /
      o.components.length;
    requireThat(
      r.value === undefined || Math.abs(r.value - value) <= 1e-7,
      `Composite total disagrees with retained items for ${o.id}.`,
    );
  }
  requireThat(
    typeof value === "number" && Number.isFinite(value),
    `Invalid numeric value for ${o.id}.`,
  );
  requireThat(
    o.aggregation !== "geometric" || value > 0,
    `Geometric-mean input must be positive: ${o.id}.`,
  );
  requireThat(
    o.scale !== "proportion" || (value >= 0 && value <= 1),
    `Proportion outside 0–1: ${o.id}.`,
  );
  requireThat(
    o.scale !== "rank" || (value >= 1 && value <= s.conditions.length),
    `Mean rank outside the design range: ${o.id}.`,
  );
  return value;
}
export function validateHumanData(s: Study, h: HumanData): void {
  requireThat(h?.schemaVersion === "1.0" && Array.isArray(h.measurements), "human.json needs schemaVersion 1.0 and a list of measurements.");
  requireThat(h.studyId === s.id, `human.json belongs to study "${h.studyId}", but this study's ID is "${s.id}".`);
  requireThat(h.synthetic === s.synthetic, `human.json is marked ${h.synthetic ? "synthetic (invented)" : "real"}, but the study is marked ${s.synthetic ? "synthetic" : "real"}. Both must say the same.`);
  const seen = new Set<string>();
  const measures = new Set(s.outcomes.map((o) => o.id));
  for (const r of h.measurements) {
    // Records of measures the study no longer has (e.g. removed on the Study page) are not used.
    if (!measures.has(r.outcomeId)) continue;
    const person = s.participants.find((p) => p.id === r.participantId);
    requireThat(
      person,
      `human.json has data for participant "${r.participantId}", who is not in this study's participants. Add them back, or remove their records from human.json.`,
    );
    requireThat(
      person!.conditionOrder.includes(r.conditionId),
      s.conditions.some((c) => c.id === r.conditionId)
        ? `human.json has data for ${r.participantId} in design "${r.conditionId}", which is not in their design order (${person!.conditionOrder.join(", ")}).`
        : `human.json has data in design "${r.conditionId}", which this study does not have (designs: ${s.conditions.map((c) => c.id).join(", ")}). If the design was renamed, rename it in human.json too.`,
    );
    const key = measurementKey(r);
    requireThat(!seen.has(key), `Duplicate human record: ${key}.`);
    seen.add(key);
    measurementValue(s, r);
  }
}
