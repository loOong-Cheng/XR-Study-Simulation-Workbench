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
}
export interface Bracket {
  a: string;
  b: string;
  test: "Mann–Whitney U" | "Wilcoxon signed-rank";
  p: number | null;
  holm: number | null;
  stars: string;
}
const labelOf = (labels: Record<string, string>, id: string) => labels[id] ?? id;

/**
 * Pairwise brackets between groups; paired Wilcoxon when both are individual configs. The scores
 * are computed against one fixed human sample, so the tests condition on it. Without a study tie
 * tolerance, near-ties are rounded at 1e-9 (relative to the largest value when that exceeds 1).
 */
function brackets(groups: Group[], tolerance?: number): Bracket[] {
  const rows: Bracket[] = [];
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i],
        b = groups[j];
      if (a.level === "individual" && b.level === "individual") {
        const byUnit = new Map(b.units.map((u, k) => [u, b.values[k]]));
        const diffs = a.units.flatMap((u, k) => (byUnit.has(u) ? [byUnit.get(u)! - a.values[k]] : []));
        rows.push({ a: a.id, b: b.id, test: "Wilcoxon signed-rank", p: wilcoxonSignedRank(diffs, tolerance).p, holm: null, stars: "" });
      } else
        rows.push({ a: a.id, b: b.id, test: "Mann–Whitney U", p: mannWhitney(a.values, b.values, tolerance).p, holm: null, stars: "" });
    }
  holm(rows.map((r) => r.p)).forEach((h, i) => {
    rows[i].holm = h;
    rows[i].stars = stars(h);
  });
  return rows;
}
function group(id: string, label: string, level: Group["level"], values: number[], units: string[]): Group {
  return { id, label, level, values, units, stats: describe(values) };
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
    const rows = (report.values ?? []).filter((v) => v.agentId === id && v.level === "individual" && v.repetition === 1);
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
export function agreementFigure(
  report: AnalysisReport,
  agentIds: string[],
  domain: Domain,
  labels: Record<string, string> = {},
) {
  const groups = agentIds.map((id) => {
    const rows = (report.runScores ?? []).filter(
      (r) => r.agentId === id && r.domain === domain && r.agreement !== null && (r.level === "population" || r.repetition === 1),
    );
    return group(id, labelOf(labels, id), rows[0]?.level ?? "population", rows.map((r) => r.agreement!), rows.map((r) => r.unit));
  });
  const chance = holm(groups.map((g) => wilcoxonSignedRank(g.values.map((v) => v - 0.5)).p));
  groups.forEach((g, i) => (g.vsChance = { p: wilcoxonSignedRank(g.values.map((v) => v - 0.5)).p, holm: chance[i] }));
  return {
    kind: "agreement" as const,
    domain,
    yLabel: "Agreement (%)",
    chance: 0.5,
    groups,
    brackets: brackets(groups),
    note: "Population configs: one value per run (Mann–Whitney U between configs). Individual configs: one value per participant, primary forecast (Wilcoxon signed-rank, paired by participant). Holm across all brackets in the figure; marks above boxes test against 50% (Wilcoxon, Holm).",
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
  const designs = study.conditions.map((c) => {
    const human = (report.humanValues ?? []).filter((v) => v.outcomeId === outcomeId && v.conditionId === c.id);
    const groups: Group[] = [
      group("human", "Human", "human", human.map((v) => v.value), human.map((v) => v.participantId)),
      ...agentIds.map((id) => {
        const rows = (report.values ?? []).filter(
          (v) => v.agentId === id && v.outcomeId === outcomeId && v.conditionId === c.id && (v.level === "population" || v.repetition === 1),
        );
        return group(id, labelOf(labels, id), rows[0]?.level ?? "population", rows.map((v) => v.value), rows.map((v) => v.unit));
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
  holm(rows.map((r) => r.p)).forEach((h, i) => {
    rows[i].holm = h;
    rows[i].stars = stars(h);
  });
  return {
    kind: "agent-vs-human" as const,
    outcome: { id: o.id, label: o.label, unit: o.unit, domain: o.domain, scale: o.scale },
    logScale: g,
    designs,
    discrepancies: rows,
    note: `Human: one value per participant. Configs: one prediction per population run, or per participant (primary forecast) for individual configs. Discrepancy = config ${g ? "geometric mean" : "mean"} − human ${g ? "geometric mean" : "mean"}. Individual configs: Wilcoxon signed-rank on each participant's forecast − their value. Population configs: one-sample Wilcoxon signed-rank of the human values against the mean forecast (the runs are not people). ${g ? "Log scale. " : ""}Holm across this table; the tests treat the human sample as fixed.`,
  };
}
export interface Discrepancy {
  agentId: string;
  conditionId: string;
  humanCentre: number;
  agentCentre: number;
  discrepancy: number;
  /** What was tested for this configuration and design. */
  test: "Wilcoxon signed-rank, paired by participant" | "One-sample Wilcoxon signed-rank vs mean forecast";
  /** Non-zero differences the test used. */
  n: number;
  p: number | null;
  holm: number | null;
  stars: string;
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
  const series = agentIds.map((id) => {
    const points: { outcomeId: string; conditionId: string; human: number; agent: number; domain: Domain }[] = [];
    for (const o of study.outcomes) {
      const g = geo(study, o.id);
      const hm = study.conditions.map((c) =>
        centre((report.humanValues ?? []).filter((v) => v.outcomeId === o.id && v.conditionId === c.id).map((v) => v.value), g),
      );
      const am = study.conditions.map((c) =>
        centre(
          (report.values ?? [])
            .filter((v) => v.agentId === id && v.outcomeId === o.id && v.conditionId === c.id && (v.level === "population" || v.repetition === 1))
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
      label: labelOf(labels, id),
      points,
      pearson: pearson(points.map((p) => p.human), points.map((p) => p.agent)),
      spearman: spearman(points.map((p) => p.human), points.map((p) => p.agent)),
    };
  });
  return {
    kind: "correlation" as const,
    series,
    note: "Each point is one outcome × design. Human and agent design means are z-scored within each outcome across designs (log scale for geometric outcomes), so the correlation reflects agreement in the pattern across designs, not in absolute level.",
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
  const groups = agentIds.map((id) => {
    const rows = (report.values ?? []).filter((v) => v.agentId === id);
    const level = rows[0]?.level ?? "population";
    const targets = new Set(rows.map((v) => v.outcomeId));
    const units = new Map<string, typeof rows>();
    // population: one unit per run; individual: one cohort profile per repetition
    rows.forEach((v) => {
      const key = level === "population" ? v.unit : `rep${v.repetition}`;
      units.set(key, [...(units.get(key) ?? []), v]);
    });
    const values: number[] = [],
      names: string[] = [];
    for (const [key, list] of units) {
      // Design means on the analysis scale (log for geometric measures: geometric means).
      const profile = study.outcomes.map((o) => {
        const scale = (v: number) => (o.aggregation === "geometric" ? Math.log(v) : v);
        const byDesign = study.conditions.map((c) => {
          const xs = list.filter((v) => v.outcomeId === o.id && v.conditionId === c.id).map((v) => scale(v.value));
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
    return group(id, labelOf(labels, id), level, values, names);
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
    note: `Population configs: each run's forecast, scored as in the analyzer's per-run scores. Individual configs: each repetition's participant forecasts averaged per design (geometric mean where declared) and scored the same way against the human population pattern (${study.design === "between-subjects" ? "significant group differences only" : "every difference of the design means"}). Mann–Whitney U, Holm across brackets; the tests treat the human sample as fixed.`,
  };
}

/** (5) Participant trajectories across individual configs, plus Spearman correlations between configs. */
export function trajectoryFigure(
  report: AnalysisReport,
  agentIds: string[],
  domain: Domain,
  labels: Record<string, string> = {},
) {
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
    configs: agentIds.map((id) => ({ id, label: labelOf(labels, id) })),
    participants,
    means,
    spearman: matrix,
    note: "Each line is one participant (primary forecast per config). Right: Spearman correlation of participant scores between configs. Descriptive; no additional tests.",
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
