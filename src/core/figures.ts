// Figure data and rank tests for the analyzer. Pure functions: the browser only
// draws what these return, so every number on a figure can be checked here.
import {
  designPairTests,
  humanMatrix,
  meanInterval,
  populationReference,
  populationRunScore,
} from "./analyzer.js";
import type { AnalysisReport, Domain, HumanData, Study } from "./types.js";
import { measurementValue } from "./validation.js";

// ---------- statistics (src/core/rank-tests.ts) ----------
import { holm, mannWhitney, ranks, wilcoxonSignedRank } from "./rank-tests.js";
export { holm, mannWhitney, wilcoxonSignedRank };

// ---------- the report's values, indexed once per report ----------
type Value = NonNullable<AnalysisReport["values"]>[number];
type HumanValue = NonNullable<AnalysisReport["humanValues"]>[number];
/**
 * A report's predicted and human values by configuration, measure and design, each list in the
 * report's order (as filtering the report's lists gives them). Large studies have hundreds of
 * thousands of values; every figure used to filter all of them per configuration, measure and design.
 */
interface ValueIndex {
  byAgent: Map<string, Value[]>;
  byCell: Map<string, Value[]>;
  human: Map<string, HumanValue[]>;
}
const valueIndexes = new WeakMap<AnalysisReport, { values: Value[] | undefined; humanValues: HumanValue[] | undefined; index: ValueIndex }>();
function valueIndex(report: AnalysisReport): ValueIndex {
  const kept = valueIndexes.get(report);
  // Built again if the report's lists were replaced.
  if (kept && kept.values === report.values && kept.humanValues === report.humanValues) return kept.index;
  const index: ValueIndex = { byAgent: new Map(), byCell: new Map(), human: new Map() };
  const add = <T>(map: Map<string, T[]>, key: string, v: T) => {
    const list = map.get(key);
    if (list) list.push(v);
    else map.set(key, [v]);
  };
  for (const v of report.values ?? []) {
    add(index.byAgent, v.agentId, v);
    add(index.byCell, `${v.agentId}\u0000${v.outcomeId}\u0000${v.conditionId}`, v);
  }
  for (const v of report.humanValues ?? []) add(index.human, `${v.outcomeId}\u0000${v.conditionId}`, v);
  valueIndexes.set(report, { values: report.values, humanValues: report.humanValues, index });
  return index;
}
/** The report's values of a configuration (all measures), or of one measure and design. */
const valuesOf = (report: AnalysisReport, agentId: string, outcomeId?: string, conditionId?: string): Value[] =>
  (outcomeId === undefined ? valueIndex(report).byAgent.get(agentId) : valueIndex(report).byCell.get(`${agentId}\u0000${outcomeId}\u0000${conditionId}`)) ?? [];
/** The human values of one measure and design. */
const humanValuesOf = (report: AnalysisReport, outcomeId: string, conditionId: string): HumanValue[] => valueIndex(report).human.get(`${outcomeId}\u0000${conditionId}`) ?? [];

export const stars = (p: number | null) =>
  p === null ? "" : p < 0.001 ? "***" : p < 0.01 ? "**" : p < 0.05 ? "*" : "";

function spearman(x: number[], y: number[]): number | null {
  if (x.length < 3) return null;
  return pearson(ranks(x).ranks, ranks(y).ranks);
}
function pearson(x: number[], y: number[]): number | null {
  const n = x.length;
  if (n < 3) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n,
    my = y.reduce((s, v) => s + v, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
export function describe(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    if (!v.length) return NaN;
    const pos = (v.length - 1) * p,
      lo = Math.floor(pos);
    return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (pos - lo);
  };
  const q1 = q(0.25),
    q3 = q(0.75),
    iqr = q3 - q1;
  const inside = v.filter((x) => x >= q1 - 1.5 * iqr && x <= q3 + 1.5 * iqr);
  return {
    n: v.length,
    mean: v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN,
    median: q(0.5),
    q1,
    q3,
    whiskerLow: inside.length ? inside[0] : NaN,
    whiskerHigh: inside.length ? inside[inside.length - 1] : NaN,
  };
}

// ---------- figure data ----------

export interface Group {
  id: string;
  label: string;
  level: "population" | "individual" | "human";
  values: number[];
  units: string[];
  stats: ReturnType<typeof describe>;
  vsChance?: { p: number | null; holm: number | null };
  /**
   * Scored on simulated (invented) runs only. The label ends in "(simulated)"; the group is never
   * tested against a group with real runs, nor against chance or the human data.
   */
  simulated?: boolean;
}
export interface Bracket {
  a: string;
  b: string;
  test: "Mann–Whitney U" | "Wilcoxon signed-rank";
  p: number | null;
  holm: number | null;
  stars: string;
  /** Between two simulated configurations: its own Holm family, drawn and labelled as simulated. */
  simulated?: boolean;
}
const labelOf = (labels: Record<string, string>, id: string) => labels[id] ?? id;
/** Appended to the label of every configuration a figure shows on simulated runs. */
export const SIMULATED_SUFFIX = " (simulated)";

/**
 * Configurations scored on simulated (invented) runs only, as the analyzer decided: a
 * configuration with real runs is scored on them alone, so only configurations without any real
 * run rest on simulated ones. Reports without that list (earlier or hand-built ones) fall back to
 * the summaries' run counts.
 */
export function simulatedConfigs(report: AnalysisReport): Set<string> {
  if (Array.isArray(report.simulatedConfigs)) return new Set(report.simulatedConfigs);
  const kinds = new Map<string, { real: number; simulated: number }>();
  for (const s of report.summaries ?? []) {
    if (typeof s.real !== "number" || typeof s.simulated !== "number") continue;
    const k = kinds.get(s.agentId) ?? { real: 0, simulated: 0 };
    kinds.set(s.agentId, { real: Math.max(k.real, s.real), simulated: Math.max(k.simulated, s.simulated) });
  }
  return new Set([...kinds].filter(([, k]) => k.simulated > 0 && k.real === 0).map(([id]) => id));
}
const markedLabel = (labels: Record<string, string>, id: string, simulated: boolean) =>
  labelOf(labels, id) + (simulated ? SIMULATED_SUFFIX : "");
/** The sentence every figure with simulated configurations carries. */
function simulatedNote(groups: { simulated?: boolean }[], tested: "brackets" | "humans" | "none"): string {
  if (!groups.some((g) => g.simulated)) return "";
  const what =
    tested === "brackets"
      ? groups.some((g) => !g.simulated)
        ? " They are never tested against configurations with real runs, nor against chance; brackets between two simulated configurations form their own Holm family and are drawn dashed."
        : " They are not tested against chance; brackets between them are drawn dashed and test the pipeline only."
      : tested === "humans"
      ? " They get no test against the human data: their discrepancy is shown, not tested, and they stay out of the Holm family."
      : "";
  return ` Marked "(simulated)" and drawn dashed: configurations scored on simulated (invented) runs only, which test the pipeline, not how well agents forecast.${what}`;
}

/**
 * Pairwise brackets between groups; paired Wilcoxon when both are individual configs. The scores
 * are computed against one fixed human sample, so the tests condition on it. Without a study tie
 * tolerance, near-ties are rounded at 1e-9 (relative to the largest value when that exceeds 1).
 */
function brackets(groups: Group[], tolerance?: number): Bracket[] {
  // Real and simulated configurations are never tested against each other. Pairs of real
  // configurations form the figure's Holm family; pairs of simulated ones (only when the figure
  // shows them) a separate family, marked as simulated.
  const real: Bracket[] = [],
    simulated: Bracket[] = [];
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i],
        b = groups[j];
      if (!!a.simulated !== !!b.simulated) continue;
      let row: Bracket;
      if (a.level === "individual" && b.level === "individual") {
        const byUnit = new Map(b.units.map((u, k) => [u, b.values[k]]));
        const diffs = a.units.flatMap((u, k) => (byUnit.has(u) ? [byUnit.get(u)! - a.values[k]] : []));
        row = { a: a.id, b: b.id, test: "Wilcoxon signed-rank", p: wilcoxonSignedRank(diffs, tolerance).p, holm: null, stars: "" };
      } else row = { a: a.id, b: b.id, test: "Mann–Whitney U", p: mannWhitney(a.values, b.values, tolerance).p, holm: null, stars: "" };
      if (a.simulated) simulated.push({ ...row, simulated: true });
      else real.push(row);
    }
  for (const rows of [real, simulated])
    holm(rows.map((r) => r.p)).forEach((h, i) => {
      rows[i].holm = h;
      rows[i].stars = stars(h);
    });
  return [...real, ...simulated];
}
function group(id: string, label: string, level: Group["level"], values: number[], units: string[], simulated = false): Group {
  return { id, label, level, values, units, stats: describe(values), ...(simulated ? { simulated: true } : {}) };
}

/**
 * Which of the chosen configurations a figure shows, by the same rule as the summaries: an
 * individual configuration is left out until every participant has a primary forecast (it is
 * not scored before), and a configuration is left out of a measure (or domain) it does not
 * predict, for example one it gets as a measured input. `omitted` says why, for the figure's notes.
 */
export function figureSelection(
  study: Study,
  report: AnalysisReport,
  agentIds: string[],
  configs: Record<string, { level: "population" | "individual"; targets: string[] }>,
  labels: Record<string, string> = {},
  scope: { outcomeId?: string; domain?: Domain } = {},
) {
  const people = study.participants.length;
  const omitted: string[] = [];
  const ids = agentIds.filter((id) => {
    const label = labelOf(labels, id);
    const own = configs[id]?.targets ?? study.outcomes.map((o) => o.id);
    if (scope.outcomeId && !own.includes(scope.outcomeId)) {
      const o = study.outcomes.find((x) => x.id === scope.outcomeId);
      omitted.push(`${label} is left out: it does not predict ${o?.label ?? scope.outcomeId} (it is a measured input or not one of its targets).`);
      return false;
    }
    if (scope.domain && !study.outcomes.some((o) => o.domain === scope.domain && own.includes(o.id))) {
      omitted.push(`${label} is left out: it predicts no ${scope.domain} measure.`);
      return false;
    }
    const rows = valuesOf(report, id).filter((v) => v.level === "individual" && v.repetition === 1);
    if (configs[id]?.level === "individual" || rows.length) {
      const have = new Set(rows.map((v) => v.participantId ?? v.unit)).size;
      if (have < people) {
        omitted.push(`${label} is left out until every participant has a forecast (${have} of ${people} so far); it is not scored before, as in the summaries.`);
        return false;
      }
    }
    return true;
  });
  return { ids, omitted };
}

/** (1) Agreement per run / participant for the selected configs, with brackets and tests against chance (50%). */
/**
 * Whether the report scores this configuration on the measure, or on any measure of the domain
 * (report.metrics has one row per configuration and predicted measure). A configuration that does
 * not predict it gets no group and no test, so it never enters the figure's Holm family; routes
 * leave it out first with figureSelection, which also says why. A hand-built report without
 * metrics counts the configurations that have forecasts for the measure.
 */
function predicts(report: AnalysisReport, id: string, scope: { outcomeId: string } | { domain: Domain }): boolean {
  if (report.metrics?.length)
    return report.metrics.some((m) => m.agentId === id && ("outcomeId" in scope ? m.outcomeId === scope.outcomeId : m.domain === scope.domain));
  return "outcomeId" in scope ? valuesOf(report, id).some((v) => v.outcomeId === scope.outcomeId) : true;
}

export function agreementFigure(
  report: AnalysisReport,
  agentIds: string[],
  domain: Domain,
  labels: Record<string, string> = {},
) {
  const sim = simulatedConfigs(report);
  const groups = agentIds.filter((id) => predicts(report, id, { domain })).map((id) => {
    const rows = (report.runScores ?? []).filter(
      (r) => r.agentId === id && r.domain === domain && r.agreement !== null && (r.level === "population" || r.repetition === 1),
    );
    return group(id, markedLabel(labels, id, sim.has(id)), rows[0]?.level ?? "population", rows.map((r) => r.agreement!), rows.map((r) => r.unit), sim.has(id));
  });
  // Tests against chance, Holm over the configurations with real runs; simulated ones are not tested.
  const tested = groups.filter((g) => !g.simulated);
  const chance = holm(tested.map((g) => wilcoxonSignedRank(g.values.map((v) => v - 0.5)).p));
  tested.forEach((g, i) => (g.vsChance = { p: wilcoxonSignedRank(g.values.map((v) => v - 0.5)).p, holm: chance[i] }));
  groups.filter((g) => g.simulated).forEach((g) => (g.vsChance = { p: null, holm: null }));
  return {
    kind: "agreement" as const,
    domain,
    yLabel: "Agreement (%)",
    chance: 0.5,
    groups,
    brackets: brackets(groups),
    note: "Population configs: one value per run (Mann–Whitney U between configs). Individual configs: one value per participant, primary forecast (Wilcoxon signed-rank, paired by participant). Holm across all brackets in the figure; marks above boxes test against 50% (Wilcoxon, Holm)." + simulatedNote(groups, "brackets"),
  };
}

const geo = (study: Study, outcomeId: string) =>
  study.outcomes.find((o) => o.id === outcomeId)?.aggregation === "geometric";
const centre = (values: number[], geometric: boolean) =>
  !values.length
    ? NaN
    : geometric
    ? Math.exp(values.reduce((s, v) => s + Math.log(v), 0) / values.length)
    : values.reduce((s, v) => s + v, 0) / values.length;

/** (2) Agent vs human for one outcome: human participant values beside each config's predictions, per design. */
export function agentVsHumanFigure(
  study: Study,
  report: AnalysisReport,
  agentIds: string[],
  outcomeId: string,
  labels: Record<string, string> = {},
) {
  const o = study.outcomes.find((x) => x.id === outcomeId);
  if (!o) throw new Error(`Unknown outcome ${outcomeId}.`);
  const g = geo(study, outcomeId);
  // Only configurations that predict this measure get a row and a test (one Holm family over them).
  const shown = agentIds.filter((id) => predicts(report, id, { outcomeId }));
  const sim = simulatedConfigs(report);
  const designs = study.conditions.map((c) => {
    const human = humanValuesOf(report, outcomeId, c.id);
    const groups: Group[] = [
      group("human", "Human", "human", human.map((v) => v.value), human.map((v) => v.participantId)),
      ...shown.map((id) => {
        const rows = valuesOf(report, id, outcomeId, c.id).filter((v) => v.level === "population" || v.repetition === 1);
        return group(id, markedLabel(labels, id, sim.has(id)), rows[0]?.level ?? "population", rows.map((v) => v.value), rows.map((v) => v.unit), sim.has(id));
      }),
    ];
    return { conditionId: c.id, label: c.label, groups };
  });
  // Individual configurations forecast each participant: paired Wilcoxon signed-rank on
  // (forecast − that person's value). Population runs are not people: one-sample Wilcoxon
  // signed-rank of the human values against the configuration's mean forecast (H0: the humans are
  // centred on the forecast). Both on the log scale for geometric measures, Holm over the table.
  const tolerance = study.analysis.tieTolerance;
  const scale = (v: number) => (g ? Math.log(v) : v);
  const rows = designs.flatMap((d) => {
    const human = d.groups[0];
    return d.groups.slice(1).map((ag) => {
      // Simulated (invented) forecasts get no test against the human data: the discrepancy is
      // described, and the row stays out of the Holm family.
      if (ag.simulated) {
        const row: Discrepancy = {
          agentId: ag.id,
          conditionId: d.conditionId,
          humanCentre: centre(human.values, g),
          agentCentre: centre(ag.values, g),
          discrepancy: centre(ag.values, g) - centre(human.values, g),
          test: "Not tested: simulated (invented) forecasts",
          n: 0,
          p: null,
          holm: null,
          stars: "",
          simulated: true,
        };
        return row;
      }
      let diffs: number[];
      let test: Discrepancy["test"];
      if (ag.level === "individual") {
        const byPerson = new Map(human.units.map((u, k) => [u, human.values[k]]));
        diffs = ag.units.flatMap((u, k) => (byPerson.has(u) ? [scale(ag.values[k]) - scale(byPerson.get(u)!)] : []));
        test = "Wilcoxon signed-rank, paired by participant";
      } else {
        const forecast = ag.values.length ? ag.values.reduce((s, v) => s + scale(v), 0) / ag.values.length : NaN;
        diffs = Number.isFinite(forecast) ? human.values.map((v) => scale(v) - forecast) : [];
        test = "One-sample Wilcoxon signed-rank vs mean forecast";
      }
      const r = wilcoxonSignedRank(diffs, tolerance);
      const row: Discrepancy = {
        agentId: ag.id,
        conditionId: d.conditionId,
        humanCentre: centre(human.values, g),
        agentCentre: centre(ag.values, g),
        discrepancy: centre(ag.values, g) - centre(human.values, g),
        test,
        n: r.n,
        p: r.p,
        holm: null,
        stars: "",
      };
      return row;
    });
  });
  const tested = rows.filter((r) => !r.simulated);
  holm(tested.map((r) => r.p)).forEach((h, i) => {
    tested[i].holm = h;
    tested[i].stars = stars(h);
  });
  return {
    kind: "agent-vs-human" as const,
    outcome: { id: o.id, label: o.label, unit: o.unit, domain: o.domain, scale: o.scale },
    logScale: g,
    designs,
    discrepancies: rows,
    note: `Human: one value per participant. Configs: one prediction per population run, or per participant (primary forecast) for individual configs. Discrepancy = config ${g ? "geometric mean" : "mean"} − human ${g ? "geometric mean" : "mean"}. Individual configs: Wilcoxon signed-rank on each participant's forecast − their value. Population configs: one-sample Wilcoxon signed-rank of the human values against the mean forecast (the runs are not people). ${g ? "Log scale. " : ""}Holm across this table; the tests treat the human sample as fixed.${simulatedNote(designs[0]?.groups.slice(1) ?? [], "humans")}`,
  };
}
export interface Discrepancy {
  agentId: string;
  conditionId: string;
  humanCentre: number;
  agentCentre: number;
  discrepancy: number;
  /** What was tested for this configuration and design. */
  test: "Wilcoxon signed-rank, paired by participant" | "One-sample Wilcoxon signed-rank vs mean forecast" | "Not tested: simulated (invented) forecasts";
  /** Non-zero differences the test used. */
  n: number;
  p: number | null;
  holm: number | null;
  stars: string;
  /** Simulated configuration: described, not tested, not in the Holm family. */
  simulated?: boolean;
}

/** (3) Correlation of agent design means with human design means (each outcome z-scored across designs). */
export function correlationFigure(
  study: Study,
  report: AnalysisReport,
  agentIds: string[],
  labels: Record<string, string> = {},
) {
  const z = (values: number[]) => {
    const m = values.reduce((s, v) => s + v, 0) / values.length;
    const sd = Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
    return values.map((v) => (sd > 0 ? (v - m) / sd : 0));
  };
  const sim = simulatedConfigs(report);
  const series = agentIds.map((id) => {
    const points: { outcomeId: string; conditionId: string; human: number; agent: number; domain: Domain }[] = [];
    for (const o of study.outcomes) {
      const g = geo(study, o.id);
      const hm = study.conditions.map((c) =>
        centre(humanValuesOf(report, o.id, c.id).map((v) => v.value), g),
      );
      const am = study.conditions.map((c) =>
        centre(
          valuesOf(report, id, o.id, c.id)
            .filter((v) => v.level === "population" || v.repetition === 1)
            .map((v) => v.value),
          g,
        ),
      );
      if ([...hm, ...am].some((v) => !Number.isFinite(v))) continue;
      const hz = z(g ? hm.map(Math.log) : hm),
        az = z(g ? am.map(Math.log) : am);
      study.conditions.forEach((c, i) =>
        points.push({ outcomeId: o.id, conditionId: c.id, human: hz[i], agent: az[i], domain: o.domain }),
      );
    }
    return {
      id,
      label: markedLabel(labels, id, sim.has(id)),
      ...(sim.has(id) ? { simulated: true } : {}),
      points,
      pearson: pearson(points.map((p) => p.human), points.map((p) => p.agent)),
      spearman: spearman(points.map((p) => p.human), points.map((p) => p.agent)),
    };
  });
  return {
    kind: "correlation" as const,
    series,
    note: "Each point is one outcome × design. Human and agent design means are z-scored within each outcome across designs (log scale for geometric outcomes), so the correlation reflects agreement in the pattern across designs, not in absolute level." + simulatedNote(series, "none"),
  };
}

/** (4) Repeated population runs vs individual forecasts averaged to the cohort (one value per repetition). */
export function populationVsIndividualFigure(
  study: Study,
  report: AnalysisReport,
  agentIds: string[],
  domain: Domain,
  labels: Record<string, string> = {},
) {
  // The analyzer's population scoring (pair masks, uninformative measures, weights), so a
  // population run's value here equals its per-run score in the report.
  const human = new Map((report.humanValues ?? []).map((v) => [`${v.participantId}|${v.conditionId}|${v.outcomeId}`, v.value]));
  const reference = populationReference(
    study,
    humanMatrix(study, (p, c, o) => human.get(`${p}|${c}|${o}`)),
    study.design === "between-subjects" ? "significant" : "means",
  );
  const sim = simulatedConfigs(report);
  const groups = agentIds.filter((id) => predicts(report, id, { domain })).map((id) => {
    const rows = valuesOf(report, id);
    const level = rows[0]?.level ?? "population";
    const targets = new Set(rows.map((v) => v.outcomeId));
    // population: one unit per run; individual: one cohort profile per repetition. Each unit's
    // values by measure and design, in the report's order.
    const units = new Map<string, Map<string, typeof rows>>();
    rows.forEach((v) => {
      const key = level === "population" ? v.unit : `rep${v.repetition}`;
      let cells = units.get(key);
      if (!cells) units.set(key, (cells = new Map()));
      const cell = `${v.outcomeId}\u0000${v.conditionId}`;
      const list = cells.get(cell);
      if (list) list.push(v);
      else cells.set(cell, [v]);
    });
    const values: number[] = [],
      names: string[] = [];
    for (const [key, cells] of units) {
      // Design means on the analysis scale (log for geometric measures: geometric means).
      const profile = study.outcomes.map((o) => {
        const scale = (v: number) => (o.aggregation === "geometric" ? Math.log(v) : v);
        const byDesign = study.conditions.map((c) => {
          const xs = (cells.get(`${o.id}\u0000${c.id}`) ?? []).map((v) => scale(v.value));
          return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
        });
        return byDesign.every(Number.isFinite) ? byDesign : undefined;
      });
      const a = populationRunScore(study, reference, targets, profile, domain);
      if (a !== null) {
        values.push(a);
        names.push(key);
      }
    }
    return group(id, markedLabel(labels, id, sim.has(id)), level, values, names, sim.has(id));
  });
  // Here every unit is an independent cohort-level forecast, so all brackets use Mann–Whitney U.
  const independent = groups.map((g) => ({ ...g, level: "population" as const }));
  return {
    kind: "population-vs-individual" as const,
    domain,
    yLabel: "Population agreement (%)",
    chance: 0.5,
    groups,
    brackets: brackets(independent, study.analysis.tieTolerance),
    note: `Population configs: each run's forecast, scored as in the analyzer's per-run scores. Individual configs: each repetition's participant forecasts averaged per design (geometric mean where declared) and scored the same way against the human population pattern (${study.design === "between-subjects" ? "significant group differences only" : "every difference of the design means"}). Mann–Whitney U, Holm across brackets; the tests treat the human sample as fixed.${simulatedNote(groups, "brackets")}`,
  };
}

/** (5) Participant trajectories across individual configs, plus Spearman correlations between configs. */
export function trajectoryFigure(
  report: AnalysisReport,
  agentIds: string[],
  domain: Domain,
  labels: Record<string, string> = {},
) {
  // Participant lines need a forecast per participant: individual configurations only.
  const levelOf = (id: string) =>
    valuesOf(report, id)[0]?.level ??
    (report.runScores ?? []).find((r) => r.agentId === id)?.level ??
    (report.summaries ?? []).find((s) => s.agentId === id)?.level;
  const population = agentIds.filter((id) => levelOf(id) !== "individual");
  agentIds = agentIds.filter((id) => levelOf(id) === "individual");
  const names = (ids: string[]) => ids.map((id) => labelOf(labels, id)).join(", ");
  if (!agentIds.length)
    return {
      kind: "trajectories" as const,
      domain,
      empty: true,
      configs: [],
      participants: [],
      means: [],
      spearman: [],
      note: `Participant lines need an individual-level configuration (one forecast per participant). ${population.length === 1 ? `${names(population)} is` : `${names(population)} are`} population-level: ${population.length === 1 ? "it forecasts" : "they forecast"} the group, not each person. Select an individual configuration, or use the Agreement view.`,
    };
  const sim = simulatedConfigs(report);
  const score = new Map<string, Map<string, number>>();
  for (const r of report.runScores ?? [])
    if (r.level === "individual" && r.domain === domain && r.repetition === 1 && r.agreement !== null && agentIds.includes(r.agentId)) {
      const m = score.get(r.unit) ?? new Map<string, number>();
      m.set(r.agentId, r.agreement);
      score.set(r.unit, m);
    }
  const participants = [...score.entries()].map(([id, m]) => ({ id, values: agentIds.map((a) => m.get(a) ?? null) }));
  const means = agentIds.map((_, i) => {
    const v = participants.map((p) => p.values[i]).filter((x): x is number => x !== null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  });
  const matrix = agentIds.map((_, i) =>
    agentIds.map((_, j) => {
      const pairs = participants.filter((p) => p.values[i] !== null && p.values[j] !== null);
      return spearman(pairs.map((p) => p.values[i]!), pairs.map((p) => p.values[j]!));
    }),
  );
  return {
    kind: "trajectories" as const,
    domain,
    configs: agentIds.map((id) => ({ id, label: markedLabel(labels, id, sim.has(id)), ...(sim.has(id) ? { simulated: true } : {}) })),
    participants,
    means,
    spearman: matrix,
    note:
      "Each line is one participant (primary forecast per config). Right: Spearman correlation of participant scores between configs. Descriptive; no additional tests." +
      (population.length ? ` Left out (population-level, no forecast per participant): ${names(population)}.` : "") +
      simulatedNote(agentIds.map((id) => ({ simulated: sim.has(id) })), "none"),
  };
}

/**
 * (6) Human data only, for one measure: each design's participant values, with the test that fits
 * the study design between every pair of designs (Wilcoxon signed-rank on each person's paired
 * difference within subjects, Mann–Whitney U between independent groups), Holm-adjusted over the
 * pairs of this measure. The same tests decide which human differences agents are scored on.
 */
export function humanFigure(study: Study, human: HumanData, outcomeId: string) {
  const o = study.outcomes.find((x) => x.id === outcomeId);
  if (!o) throw new Error(`Unknown measure ${outcomeId}.`);
  const geometric = o.aggregation === "geometric";
  const between = study.design === "between-subjects";
  const byDesign = study.conditions.map((c) => {
    const rows = human.measurements.filter((m) => m.outcomeId === o.id && m.conditionId === c.id && m.participantId);
    const values: number[] = [],
      units: string[] = [];
    for (const m of rows)
      try {
        values.push(measurementValue(study, m));
        units.push(m.participantId!);
      } catch {
        // malformed reference rows are reported by the human-data check
      }
    return group(c.id, c.label, "human", values, units);
  });
  // The analyzer's tests (designPairTests): same data on the analysis scale, so paired differences
  // of geometric measures are log ratios and the p-values equal the analyzer's human pairs.
  const value = new Map<string, number>();
  for (const m of human.measurements)
    if (m.outcomeId === o.id && m.participantId)
      try {
        value.set(`${m.participantId}|${m.conditionId}`, measurementValue(study, m));
      } catch {
        // malformed reference rows are reported by the human-data check
      }
  const oi = study.outcomes.indexOf(o);
  const matrix = humanMatrix(study, (p, c, outcome) => (outcome === o.id ? value.get(`${p}|${c}`) : undefined));
  const rows: Bracket[] = designPairTests(study, matrix[oi]).map((t) => ({
    a: study.conditions[t.i].id,
    b: study.conditions[t.j].id,
    test: t.test,
    p: t.p,
    holm: t.pHolm,
    stars: stars(t.pHolm),
  }));
  const summary = byDesign.map((g) => {
    const xs = geometric ? g.values.map(Math.log) : g.values;
    const n = xs.length;
    const ci = meanInterval(study, o, xs);
    const m = n ? xs.reduce((s, x) => s + x, 0) / n : NaN;
    const sd = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1)) : NaN;
    const back = (x: number) => (geometric ? Math.exp(x) : x);
    return {
      conditionId: g.id,
      label: g.label,
      n,
      mean: ci ? ci.mean : back(m),
      median: g.stats.median,
      sd: geometric ? NaN : sd,
      low: ci ? ci.low : NaN,
      high: ci ? ci.high : NaN,
      degenerate: ci?.degenerate ?? false,
      ...(ci?.degenerate ? { note: `All ${n} people gave the same value; the interval is degenerate.` } : {}),
    };
  });
  return {
    outcome: { id: o.id, label: o.label, unit: o.unit, scale: o.scale, domain: o.domain },
    design: study.design,
    logScale: geometric,
    groups: byDesign,
    brackets: rows,
    summary,
    note: `${between ? "Independent groups: Mann–Whitney U" : `Same people in every design: Wilcoxon signed-rank on each person's difference${geometric ? " (log ratio)" : ""}`} between every pair of designs, Holm-adjusted over this measure's pairs. ${geometric ? "Geometric means and intervals (log scale)." : "Means with 95% t intervals."}${summary.some((s) => s.degenerate) ? " A zero-width interval means every person gave the same value." : ""}`,
  };
}
