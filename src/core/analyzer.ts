import type {
  AnalysisOptions,
  AnalysisReport,
  Comparison,
  ContrastScore,
  Domain,
  HumanData,
  Measurement,
  MetricScore,
  Outcome,
  Plan,
  AbsoluteFit,
  HumanPair,
  PredictedValue,
  ResultBundle,
  RunResult,
  RunScore,
  Study,
  SummaryScore,
} from "./types.js";
import { agentLevel, agentTargets, verifyPlan } from "./planner.js";
import { holm, mannWhitney, roundForTies, t975, wilcoxonSignedRank } from "./rank-tests.js";
import { auditRun } from "./protocol.js";
import {
  measurementKey,
  measurementValue,
  mixedLevelsMessage,
  requireThat,
  validateHumanData,
} from "./validation.js";

export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function mean(values: number[]): number | null {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}
export function quantile(values: number[], p: number): number {
  const a = [...values].sort((x, y) => x - y);
  const i = (a.length - 1) * p;
  const lo = Math.floor(i);
  return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo);
}
function interval(
  values: (number | null)[],
): { low: number; high: number } | null {
  const valid = values.filter(
    (x): x is number => x !== null && Number.isFinite(x),
  );
  return valid.length >= values.length * 0.9 && valid.length
    ? { low: quantile(valid, 0.025), high: quantile(valid, 0.975) }
    : null;
}
function sign(v: number, tolerance: number): number {
  return Math.abs(v) <= tolerance ? 0 : Math.sign(v);
}
export function directionalAgreement(
  human: number[],
  predicted: number[],
  tolerance = 1e-8,
  mask?: boolean[],
): { score: number | null; pairs: number } {
  let sum = 0,
    count = 0,
    index = 0;
  for (let i = 0; i < human.length; i++)
    for (let j = i + 1; j < human.length; j++) {
      const hs = sign(human[j] - human[i], tolerance),
        ps = sign(predicted[j] - predicted[i], tolerance);
      const retained = mask ? mask[index] : hs !== 0;
      index++;
      if (!retained) continue;
      // A tie created by human resampling is neutral on the original pair mask.
      sum += hs === 0 || ps === 0 ? 0.5 : hs === ps ? 1 : 0;
      count++;
    }
  return { score: count ? sum / count : null, pairs: count };
}
function pairMask(values: number[], tolerance: number): boolean[] {
  const result: boolean[] = [];
  for (let i = 0; i < values.length; i++)
    for (let j = i + 1; j < values.length; j++)
      result.push(sign(values[j] - values[i], tolerance) !== 0);
  return result;
}
function resamplePeople(plan: Plan, rng: () => number): number[] {
  const strata = new Map<string, number[]>();
  plan.study.participants.forEach((p, i) => {
    const a = strata.get(p.stratum) ?? [];
    a.push(i);
    strata.set(p.stratum, a);
  });
  return [...strata.values()].flatMap((indices) =>
    indices.map(() => indices[Math.floor(rng() * indices.length)]),
  );
}
/**
 * Outcome weights within one domain over the included outcomes (indices of study.outcomes): the
 * declared family budgets normalised over the families present, outcome weights normalised within
 * a family. Shared by the summaries, the per-run scores, the figures and the agent comparison.
 */
export function outcomeWeights(
  study: Study,
  domain: Domain,
  included: boolean[],
): Map<number, number> {
  const groups = new Map<string, number[]>();
  study.outcomes.forEach((o, i) => {
    if (o.domain === domain && included[i]) {
      const rows = groups.get(o.family) ?? [];
      rows.push(i);
      groups.set(o.family, rows);
    }
  });
  const total = [...groups.keys()].reduce(
    (a, f) => a + study.analysis.familyWeights[f],
    0,
  );
  const weights = new Map<number, number>();
  for (const [f, indices] of groups) {
    const within = indices.reduce(
      (a, i) => a + study.outcomes[i].weight,
      0,
    );
    for (const i of indices)
      weights.set(
        i,
        ((study.analysis.familyWeights[f] / total) *
          study.outcomes[i].weight) /
          within,
      );
  }
  return weights;
}
function weightedScore(
  values: (number | null)[],
  weights: Map<number, number>,
): number | null {
  if (!weights.size || [...weights.keys()].some((i) => values[i] === null))
    return null;
  return [...weights].reduce((a, [i, w]) => a + values[i]! * w, 0);
}
/** Weighted mean over the outcomes that have a score, weights renormalised over those. */
export function weightedAvailable(
  scores: (number | null)[],
  weights: Map<number, number>,
): number | null {
  let sum = 0,
    total = 0;
  for (const [i, wi] of weights)
    if (scores[i] !== null && scores[i] !== undefined) {
      sum += scores[i]! * wi;
      total += wi;
    }
  return total > 0 ? sum / total : null;
}
/** Holm over the declared family; untestable comparisons count in the family size (see holm). */
export function holmAdjust(rows: ContrastScore[]): void {
  holm(rows.map((r) => r.p)).forEach((p, i) => (rows[i].holmP = p));
}

/** Human values per measure × person × design on the analysis scale (log for geometric measures). */
export type HumanMatrix = (number | null)[][][];
export function humanMatrix(
  study: Study,
  valueOf: (participantId: string, conditionId: string, outcomeId: string) => number | undefined,
): HumanMatrix {
  return study.outcomes.map((o) =>
    study.participants.map((p) =>
      study.conditions.map((c) => {
        const v = valueOf(p.id, c.id, o.id);
        return v === undefined ? null : o.aggregation === "geometric" ? Math.log(v) : v;
      }),
    ),
  );
}
export interface DesignPairTest {
  i: number;
  j: number;
  test: "Mann–Whitney U" | "Wilcoxon signed-rank";
  p: number | null;
  pHolm: number | null;
}
/**
 * Tests every pair of designs of one measure (rows: person × design on the analysis scale, so
 * paired differences of geometric measures are log ratios): Mann–Whitney U between the independent
 * groups (between subjects) or Wilcoxon signed-rank on each person's difference (within subjects),
 * values rounded to the study's tie tolerance, Holm over the pairs of the measure. The analyzer and
 * the human-data figure both use this, so their p-values are the same.
 */
export function designPairTests(
  study: Study,
  rows: (number | null)[][],
): DesignPairTest[] {
  // Exact tests take long on large studies, and the same human values are tested again by the
  // significant-only view, the human-data figure and every new analysis of the campaign: tests of
  // the same values are computed once (copies are returned, so callers cannot change them).
  // Every value exactly (String keeps all digits, NaN and infinities; -0 is marked).
  const cell = (v: number | null) => (v === null ? "n" : Object.is(v, -0) ? "-0" : String(v));
  const key = `${study.design}|${String(study.analysis.tieTolerance)}|${study.conditions.length}|${rows.map((r) => r.map(cell).join(",")).join(";")}`;
  let kept = pairTestCache.get(key);
  if (kept) {
    pairTestCache.delete(key);
    pairTestCache.set(key, kept);
  } else {
    pairTestStats.computed++;
    kept = computeDesignPairTests(study, rows);
    pairTestCache.set(key, kept);
    while (pairTestCache.size > 2000) pairTestCache.delete(pairTestCache.keys().next().value!);
  }
  return kept.map((t) => ({ ...t }));
}
const pairTestCache = new Map<string, DesignPairTest[]>();
/** For the tests: how many sets of design pair tests were computed (not taken from the cache). */
export const pairTestStats = { computed: 0 };
function computeDesignPairTests(
  study: Study,
  rows: (number | null)[][],
): DesignPairTest[] {
  const between = study.design === "between-subjects";
  const tolerance = study.analysis.tieTolerance;
  const tests: DesignPairTest[] = [];
  const group = (ci: number) =>
    rows.map((row) => row[ci]).filter((x): x is number => x !== null);
  for (let i = 0; i < study.conditions.length; i++)
    for (let j = i + 1; j < study.conditions.length; j++) {
      const paired = rows
        .filter((row) => row[i] !== null && row[j] !== null)
        .map((row) => (row[j] as number) - (row[i] as number));
      tests.push({
        i,
        j,
        test: between ? "Mann–Whitney U" : "Wilcoxon signed-rank",
        p: between
          ? mannWhitney(group(i), group(j), tolerance).p
          : wilcoxonSignedRank(paired, tolerance).p,
        pHolm: null,
      });
    }
  holm(tests.map((t) => t.p)).forEach((p, k) => (tests[k].pHolm = p));
  return tests;
}
/** The human population pattern agents are scored against, and which design pairs count. */
export interface PopulationReference {
  /** Design means per measure on the analysis scale (null if a design has no data). */
  truth: (number[] | null)[];
  /** Per measure, whether each design pair (i < j, row-major) is scored. */
  masks: boolean[][];
  /** Measures with at least one scored pair. */
  informative: boolean[];
  pairs: HumanPair[];
}
/**
 * "means": every difference of the design means beyond the tie tolerance. "significant": only
 * pairs whose test (designPairTests) is significant after Holm at α = .05.
 */
export function populationReference(
  study: Study,
  h: HumanMatrix,
  pairRule: "means" | "significant",
): PopulationReference {
  const tolerance = study.analysis.tieTolerance;
  const pairs: HumanPair[] = [];
  const truth = study.outcomes.map((_, oi) => {
    const means = study.conditions.map((_, ci) =>
      mean(h[oi].map((row) => row[ci]).filter((x): x is number => x !== null)),
    );
    return means.some((v) => v === null) ? null : (means as number[]);
  });
  const masks = study.outcomes.map((o, oi) => {
    const profile = truth[oi];
    if (!profile) return [];
    const byMean = pairMask(profile, tolerance);
    const tests = designPairTests(study, h[oi]);
    const restore = (v: number) => (o.aggregation === "geometric" ? Math.exp(v) : v);
    tests.forEach((t, k) => {
      const significant = t.pHolm !== null && t.pHolm < ALPHA;
      pairs.push({
        outcomeId: o.id,
        a: study.conditions[t.i].id,
        b: study.conditions[t.j].id,
        meanA: restore(profile[t.i]),
        meanB: restore(profile[t.j]),
        test: t.test,
        p: t.p,
        pHolm: t.pHolm,
        significant,
        used: byMean[k] && (pairRule === "means" || significant),
      });
    });
    return pairRule === "means"
      ? byMean
      : byMean.map((m, k) => m && tests[k].pHolm !== null && tests[k].pHolm! < ALPHA);
  });
  return { truth, masks, informative: masks.map((m) => m.some(Boolean)), pairs };
}
/**
 * Per-outcome directional agreement of one population forecast (profile per outcome on the
 * analysis scale) with the reference; null for outcomes not predicted or not informative.
 */
export function populationOutcomeScores(
  study: Study,
  ref: PopulationReference,
  targets: Set<string>,
  profile: (number[] | undefined)[],
): (number | null)[] {
  return study.outcomes.map((o, oi) => {
    const truth = ref.truth[oi],
      p = profile[oi];
    if (!targets.has(o.id) || !ref.informative[oi] || !truth || !p || p.length !== truth.length) return null;
    return directionalAgreement(truth, p, study.analysis.tieTolerance, ref.masks[oi]).score;
  });
}
/** A population forecast's agreement in one domain, exactly as the analyzer's per-run scores. */
export function populationRunScore(
  study: Study,
  ref: PopulationReference,
  targets: Set<string>,
  profile: (number[] | undefined)[],
  domain: Domain,
): number | null {
  const weights = outcomeWeights(
    study,
    domain,
    study.outcomes.map((o, i) => ref.informative[i] && targets.has(o.id)),
  );
  return weightedAvailable(populationOutcomeScores(study, ref, targets, profile), weights);
}
/**
 * Seed of one bootstrap stream, derived from the study seed and a name (FNV-1a), so that each
 * configuration resamples its runs from its own stream: its interval does not change when other
 * configurations are added, removed or reordered.
 */
export function streamSeed(seed: number, name: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${seed >>> 0}\u0000${name}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/**
 * Bounds a measure's values cannot leave: proportions [0, 1], mean ranks [1, number of designs],
 * counts [0, ∞), narrowed by a declared range (for example [1, 7] for a rating). Null when
 * nothing bounds the measure.
 */
export function scaleBounds(study: Study, o: Outcome): [number, number] | null {
  const fixed: [number, number] | null =
    o.scale === "proportion" ? [0, 1] : o.scale === "rank" ? [1, study.conditions.length] : o.scale === "count" ? [0, Infinity] : null;
  if (!o.range) return fixed;
  return fixed ? [Math.max(fixed[0], o.range[0]), Math.min(fixed[1], o.range[1])] : [o.range[0], o.range[1]];
}
export interface MeanInterval {
  /** Mean (geometric mean for geometric measures) and its 95% t interval on the measure's scale. */
  mean: number;
  low: number;
  high: number;
  n: number;
  /** Analysis-scale (log for geometric measures) mean and half-width, before clipping. */
  centre: number;
  half: number;
  /** All n people gave the same value (within the tie tolerance): a zero-width interval. */
  degenerate: boolean;
}
/**
 * Mean and 95% t interval of the human values of one measure and design (analysis scale in, the
 * measure's scale out). Intervals of bounded scales are clipped to the scale's bounds.
 */
export function meanInterval(study: Study, o: Outcome, values: number[]): MeanInterval | null {
  const n = values.length;
  if (n < 2) return null;
  const m = mean(values)!;
  const grid = roundForTies(values, study.analysis.tieTolerance);
  const degenerate = grid.every((x) => x === grid[0]);
  const sd = degenerate ? 0 : Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1));
  const half = t975(n - 1) * (sd / Math.sqrt(n));
  const back = (v: number) => (o.aggregation === "geometric" ? Math.exp(v) : v);
  const bounds = scaleBounds(study, o);
  const clip = (v: number) => (bounds ? Math.min(bounds[1], Math.max(bounds[0], v)) : v);
  return { mean: back(m), low: clip(back(m - half)), high: clip(back(m + half)), n, centre: m, half, degenerate };
}
export function analyze(
  plan: Plan,
  human: HumanData,
  bundle: ResultBundle,
  comparisons?: Comparison[],
  options: AnalysisOptions = {},
): AnalysisReport {
  verifyPlan(plan);
  return analyzeVerifiedPlan(plan, human, bundle, comparisons, undefined, options);
}
/**
 * Comparisons are an analysis choice: they are not needed to collect data. If
 * none are given, those stored with the plan are used. Each is labelled with
 * where it was declared so the report can disclose analysis-time choices.
 */
export function resolveComparisons(
  plan: Plan,
  comparisons?: Comparison[],
): (Comparison & { id: string; declared: "in plan" | "at analysis" })[] {
  const inPlan = plan.study.analysis.contrasts;
  const list = comparisons ?? inPlan;
  requireThat(Array.isArray(list) && list.length <= 50, "Give comparisons as a list (at most 50).");
  const ids = new Set(plan.agents.map((a) => a.id));
  const seen = new Set<string>();
  return list.map((c) => {
    requireThat(
      c && ids.has(c.candidate) && ids.has(c.baseline) && c.candidate !== c.baseline &&
        ["objective", "subjective"].includes(c.domain),
      `Comparison ${c?.candidate} − ${c?.baseline}: choose two different agent methods of this plan and a domain.`,
    );
    const key = `${c.candidate}|${c.baseline}|${c.domain}`;
    requireThat(!seen.has(key), `Duplicate comparison ${c.candidate} − ${c.baseline} (${c.domain}).`);
    seen.add(key);
    const planned = inPlan.find(
      (x) => x.candidate === c.candidate && x.baseline === c.baseline && x.domain === c.domain,
    );
    return {
      id: c.id ?? planned?.id ?? `${c.candidate}-vs-${c.baseline}-${c.domain}`,
      candidate: c.candidate,
      baseline: c.baseline,
      domain: c.domain,
      declared: planned ? ("in plan" as const) : ("at analysis" as const),
    };
  });
}
/**
 * Analysis core for an already-verified schedule. Campaigns use this after
 * verifying their own digest, because a continued campaign can have unequal
 * repetition counts per condition and therefore is not a uniform Plan.
 */
export function analyzeVerifiedPlan(
  plan: Plan,
  human: HumanData,
  bundle: ResultBundle,
  comparisons?: Comparison[],
  /** Scores kept from an analysis of the same plan, human data and results (see AnalysisMemo). */
  memo?: AnalysisMemo,
  options: AnalysisOptions = {},
): AnalysisReport {
  // Configs can predict at different levels; each level is analysed with its own
  // resampling, then merged. Comparisons must stay within one level.
  // A comparison across levels cannot be tested: it is skipped with a note, the others are analysed.
  const levelOf = new Map(plan.agents.map((a) => [a.id, agentLevel(plan.study, a)]));
  const all = resolveComparisons(plan, comparisons);
  const resolved = all.filter((c) => levelOf.get(c.candidate) === levelOf.get(c.baseline));
  const skippedMixed = all.filter((c) => !resolved.includes(c));
  const levels = [...new Set(levelOf.values())];
  const parts = levels.map((level) => {
    const ids = new Set(plan.agents.filter((a) => levelOf.get(a.id) === level).map((a) => a.id));
    const jobIds = new Set(plan.jobs.filter((j) => ids.has(j.agentId)).map((j) => j.id));
    const sub: Plan = {
      ...plan,
      study: { ...plan.study, predictionLevel: level },
      agents: plan.agents.filter((a) => ids.has(a.id)),
      jobs: plan.jobs.filter((j) => ids.has(j.agentId)),
    };
    return analyzeLevel(
      sub,
      human,
      { ...bundle, runs: bundle.runs.filter((r) => jobIds.has(r.jobId)) },
      resolved.filter((c) => ids.has(c.candidate)),
      undefined,
      memo,
      options,
    );
  });
  const report = mergeLevels(plan, parts);
  if (skippedMixed.length)
    report.notes.push(
      `Skipped ${skippedMixed.length} comparison(s): ${skippedMixed.map((c) => mixedLevelsMessage(c.candidate, c.baseline)).join(" ")} The Holm family covers the remaining ${resolved.length}.`,
    );
  // Within subjects, the main scores keep every difference of the means; a second view scores the
  // population configurations on significant paired differences only (Wilcoxon signed-rank, Holm).
  if (plan.study.design === "within-subjects" && levels.includes("population")) {
    const ids = new Set(plan.agents.filter((a) => levelOf.get(a.id) === "population").map((a) => a.id));
    const jobIds = new Set(plan.jobs.filter((j) => ids.has(j.agentId)).map((j) => j.id));
    const sub: Plan = { ...plan, study: { ...plan.study, predictionLevel: "population" }, agents: plan.agents.filter((a) => ids.has(a.id)), jobs: plan.jobs.filter((j) => ids.has(j.agentId)) };
    const sig = analyzeLevel(sub, human, { ...bundle, runs: bundle.runs.filter((r) => jobIds.has(r.jobId)) }, [], "significant", memo, options);
    report.significantOnly = { summaries: sig.summaries, exclusions: sig.exclusions, humanPairs: sig.humanPairs ?? [] };
  }
  return report;
}
function mergeLevels(plan: Plan, parts: AnalysisReport[]): AnalysisReport {
  if (parts.length === 1) return parts[0];
  const [first] = parts;
  const contrasts = parts.flatMap((p) => p.contrasts);
  holmAdjust(contrasts);
  return {
    ...first,
    predictionLevel: plan.study.predictionLevel,
    metrics: parts.flatMap((p) => p.metrics),
    summaries: parts.flatMap((p) => p.summaries),
    contrasts,
    audits: parts.flatMap((p) => p.audits),
    exclusions: [...new Set(parts.flatMap((p) => p.exclusions.map((e) => e)))],
    notes: [
      ...new Set(parts.flatMap((p) => p.notes)),
      "Population and individual configs are analysed separately (each with its own resampling); one Holm family covers all comparisons.",
    ],
    runScores: parts.flatMap((p) => p.runScores ?? []),
    values: parts.flatMap((p) => p.values ?? []),
    humanValues: first.humanValues,
    pairRule: parts.find((p) => p.predictionLevel === "population")?.pairRule ?? first.pairRule,
    humanPairs: parts.flatMap((p) => p.humanPairs ?? []),
    absoluteFit: parts.flatMap((p) => p.absoluteFit ?? []),
    simulatedConfigs: parts.flatMap((p) => p.simulatedConfigs ?? []),
  };
}
const ALPHA = 0.05;
/** For the tests: how often a configuration was scored in full (point estimates; never per bootstrap draw). */
export const analysisStats = { fullScores: 0 };
/**
 * The per-outcome scores of one bootstrap draw, exactly as analyzeLevel's scoreAgent(agentId,
 * indices, rng).scores computes them: the same random numbers in the same order and the same
 * additions in the same order, without what a draw does not use (absolute errors, units, pair
 * counts). What no draw changes is computed once: each run's predicted direction on every scored
 * design pair (population level), each person's agreement (individual level). The design means of
 * the resampled people are computed once per draw for all configurations.
 */
function bootstrapScorer(
  plan: Plan,
  h: HumanMatrix,
  masks: boolean[][],
  tolerance: number,
  targetSets: Map<string, Set<string>>,
  validJobs: (agentId: string) => Plan["jobs"],
  predicted: Map<string, number[][]>,
): (indices: number[]) => (agentId: string, rng: () => number) => (number | null)[] {
  const outcomes = plan.study.outcomes,
    people = plan.study.participants,
    k = plan.study.conditions.length;
  const population = plan.study.predictionLevel === "population";
  // The design pairs (i < j, row-major, as directionalAgreement counts them) each mask scores.
  const pairsOf = outcomes.map((_, oi) => {
    const mask = masks[oi] ?? [];
    const list: [number, number][] = [];
    let index = 0;
    for (let i = 0; i < k; i++)
      for (let j = i + 1; j < k; j++) {
        if (mask[index]) list.push([i, j]);
        index++;
      }
    return list;
  });
  type Prepared =
    | { population: true; runs: number; signs: (Float64Array | null)[] }
    | { population: false; personScores: ((number | null | undefined)[] | null)[] };
  const prepared = new Map<string, Prepared>();
  for (const a of plan.agents) {
    const candidates = validJobs(a.id);
    const targets = targetSets.get(a.id)!;
    if (population) {
      // signs[oi][run * pairs + r]: the predicted direction of scored pair r in that run.
      const signs = outcomes.map((o, oi) => {
        if (!targets.has(o.id)) return null;
        const pairs = pairsOf[oi],
          R = pairs.length;
        const out = new Float64Array(candidates.length * R);
        candidates.forEach((j, c) => {
          const p = predicted.get(j.id)![oi];
          pairs.forEach(([x, y], r) => (out[c * R + r] = sign(p[y] - p[x], tolerance)));
        });
        return out;
      });
      prepared.set(a.id, { population: true, runs: candidates.length, signs });
    } else {
      const byPerson = new Map(candidates.map((j) => [j.participantId, j]));
      const complete = people.every((p) => byPerson.has(p.id));
      // personScores[oi][pi]: the person's agreement; undefined when the person's profile is incomplete.
      const personScores = outcomes.map((o, oi) =>
        !complete || !targets.has(o.id)
          ? null
          : people.map((p, pi) =>
              h[oi][pi].every((v) => v !== null)
                ? directionalAgreement(h[oi][pi] as number[], predicted.get(byPerson.get(p.id)!.id)![oi], tolerance).score
                : undefined,
            ),
      );
      prepared.set(a.id, { population: false, personScores });
    }
  }
  return (indices) => {
    // Directions of the resampled people's design means on each outcome's scored pairs (null when
    // a design has no value among them), computed when first needed in this draw.
    const truthSigns: (Float64Array | null | undefined)[] = new Array(outcomes.length);
    const truthOf = (oi: number): Float64Array | null => {
      let t = truthSigns[oi];
      if (t === undefined) {
        const means: number[] = [];
        for (let ci = 0; ci < k && means.length === ci; ci++) {
          let s = 0,
            n = 0;
          for (const pi of indices) {
            const v = h[oi][pi][ci];
            if (v !== null) (s += v), n++;
          }
          if (n) means.push(s / n);
        }
        if (means.length < k) t = null;
        else {
          const pairs = pairsOf[oi];
          const signs = new Float64Array(pairs.length);
          pairs.forEach(([x, y], r) => (signs[r] = sign(means[y] - means[x], tolerance)));
          t = signs;
        }
        truthSigns[oi] = t;
      }
      return t;
    };
    return (agentId, rng) => {
      const a = prepared.get(agentId)!;
      if (!a.population)
        return a.personScores.map((scores) => {
          if (!scores) return null;
          let sum = 0,
            count = 0;
          for (const pi of indices) {
            const s = scores[pi];
            if (s !== undefined && s !== null) (sum += s), count++;
          }
          return count ? sum / count : null;
        });
      const n = a.runs;
      const drawn = new Array<number>(n);
      for (let c = 0; c < n; c++) drawn[c] = Math.floor(rng() * n);
      return a.signs.map((signs, oi) => {
        if (!signs) return null;
        const truth = truthOf(oi);
        if (!truth || !truth.length) return null;
        const R = truth.length;
        let sum = 0,
          count = 0;
        for (const c of drawn) {
          let agree = 0;
          for (let r = 0; r < R; r++) {
            const hs = truth[r],
              ps = signs[c * R + r];
            agree += hs === 0 || ps === 0 ? 0.5 : hs === ps ? 1 : 0;
          }
          sum += agree / R;
          count++;
        }
        return count ? sum / count : null;
      });
    };
  };
}
/**
 * What one level's analysis keeps between analyses that differ only in the comparisons: every score,
 * interval and audit (the report without its contrasts), and the bootstrap draws the contrasts need.
 * Kept by the caller in an AnalysisMemo (see analyzeVerifiedPlan), valid for the same plan, human
 * data and results only.
 */
interface LevelCore {
  report: Omit<AnalysisReport, "contrasts" | "notes"> & { notesBefore: string[]; notesAfter: string[] };
  contrasts: ContrastData;
}
/**
 * Scores of a campaign's analysis kept for further analyses of the same plan, human data and
 * results with other comparisons: only the contrasts are computed again. Opaque to callers.
 */
export type AnalysisMemo = Map<string, LevelCore>;
/**
 * What a level's contrasts need from its scores (see LevelCore): plain data, nothing of the runs, so
 * kept scores do not keep a campaign's results in memory.
 */
interface ContrastData {
  study: Study;
  informative: boolean[];
  targetSets: Map<string, Set<string>>;
  point: Map<string, (number | null)[]>;
  draws: Map<string, (number | null)[][]>;
  simulatedOnlyIds: Set<string>;
}
/** The chosen comparisons of one level, from its point scores and bootstrap draws. */
function levelContrasts(d: ContrastData, chosen: ReturnType<typeof resolveComparisons>): ContrastScore[] {
  const plan = { study: d.study },
    outcomes = d.study.outcomes,
    simulatedOnlyIds = d.simulatedOnlyIds;
  const weightsOver = (domain: Domain, ...agentIds: string[]) =>
    outcomeWeights(
      d.study,
      domain,
      d.informative.map((x, i) => x && agentIds.every((id) => d.targetSets.get(id)!.has(outcomes[i].id))),
    );
  const point = new Map([...d.point].map(([id, scores]) => [id, { scores }]));
  const bootstrapOf = (agentId: string, w: Map<number, number>) =>
    d.draws.get(agentId)!.map((scores) => weightedScore(scores, w));
  return chosen.map((c) => {
    // Weighted over the outcomes both configs predict (common coverage).
    const w = weightsOver(c.domain, c.baseline, c.candidate);
    const baseScore = weightedScore(point.get(c.baseline)!.scores, w),
      candScore = weightedScore(point.get(c.candidate)!.scores, w);
    const difference =
      baseScore != null && candScore != null ? candScore - baseScore : null;
    const a = bootstrapOf(c.baseline, w),
      b = bootstrapOf(c.candidate, w);
    const diffs = b.map((x, i) =>
      x !== null && a[i] !== null ? x! - a[i]! : null,
    );
    const valid = diffs.filter((x): x is number => x !== null);
    const eligible =
      difference !== null &&
      valid.length >= plan.study.analysis.bootstrapDraws * 0.9;
    const degenerate =
      valid.length > 0 && Math.max(...valid) - Math.min(...valid) < 1e-12;
    // Invented forecasts are never tested against real ones: the difference is shown, untested
    // (it still counts in the declared Holm family, like every untestable comparison).
    const mixed = simulatedOnlyIds.has(c.baseline) !== simulatedOnlyIds.has(c.candidate);
    const p =
      eligible && !degenerate && !mixed
        ? (1 +
            valid.filter(
              (x) => Math.abs(x - difference!) >= Math.abs(difference!) - 1e-12,
            ).length) /
          (valid.length + 1)
        : null;
    return {
      ...c,
      difference,
      ci95: eligible && !mixed ? interval(diffs) : null,
      p,
      holmP: null,
      status: !eligible
        ? "Insufficient matched coverage"
        : mixed
        ? "Not tested: compares simulated (invented) with real runs"
        : degenerate
        ? "No test: empirically degenerate bootstrap variance"
        : "Exploratory centered-bootstrap contrast; Holm across the declared family",
    };
    });
}
function analyzeLevel(
  plan: Plan,
  human: HumanData,
  bundle: ResultBundle,
  comparisons?: Comparison[],
  // Between subjects, a design difference counts only when a test supports it (independent groups).
  pairRule: "means" | "significant" = plan.study.design === "between-subjects" ? "significant" : "means",
  memo?: AnalysisMemo,
  options: AnalysisOptions = {},
): AnalysisReport {
  const chosen = resolveComparisons(plan, comparisons);
  const key = `${plan.study.predictionLevel}|${pairRule}|${options.excludeIncomplete ? "complete-only" : "all"}`;
  let core = memo?.get(key);
  if (!core) {
    core = scoreLevel(plan, human, bundle, pairRule, options);
    memo?.set(key, core);
  }
  const contrasts = levelContrasts(core.contrasts, chosen);
  holmAdjust(contrasts);
  const { notesBefore, notesAfter, ...r } = core.report;
  // A kept core is shared: what callers may change (lists, audits' issues) is copied.
  const copy = <T>(list: T[]): T[] => (memo ? [...list] : list);
  return {
    pairRule: r.pairRule,
    humanPairs: r.humanPairs && copy(r.humanPairs),
    absoluteFit: r.absoluteFit && copy(r.absoluteFit),
    runScores: r.runScores && copy(r.runScores),
    values: r.values && copy(r.values),
    humanValues: r.humanValues && copy(r.humanValues),
    simulatedConfigs: r.simulatedConfigs && copy(r.simulatedConfigs),
    studyId: r.studyId,
    title: r.title,
    synthetic: r.synthetic,
    planDigest: r.planDigest,
    predictionLevel: r.predictionLevel,
    metrics: copy(r.metrics),
    summaries: copy(r.summaries),
    contrasts,
    audits: memo ? r.audits.map((a) => ({ ...a, issues: [...a.issues] })) : r.audits,
    exclusions: copy(r.exclusions),
    bootstrapDraws: r.bootstrapDraws,
    seed: r.seed,
    notes: [
      ...notesBefore,
      ...(chosen.some((c) => c.declared === "at analysis")
        ? [
            "Comparisons marked 'at analysis' were chosen when analysing, not frozen with the plan. If they were chosen after seeing these scores, report them as exploratory.",
          ]
        : []),
      ...notesAfter,
    ],
  };
}
function scoreLevel(
  plan: Plan,
  human: HumanData,
  bundle: ResultBundle,
  pairRule: "means" | "significant",
  options: AnalysisOptions = {},
): LevelCore {
  validateHumanData(plan.study, human);
  requireThat(
    bundle.schemaVersion === "1.0" &&
      bundle.studyId === plan.study.id &&
      Array.isArray(bundle.runs),
    "Results do not match the study.",
  );
  requireThat(
    bundle.runs.every(
      (r) => r && typeof r === "object" && typeof r.jobId === "string",
    ),
    "Every returned execution needs a scheduled job identifier.",
  );
  const jobs = new Map(plan.jobs.map((j) => [j.id, j]));
  const returned = new Map(bundle.runs.map((r) => [r.jobId, r]));
  requireThat(
    returned.size === bundle.runs.length,
    "Duplicate job outputs: preserve attempts separately; return one selected result per scheduled job.",
  );
  requireThat(
    bundle.runs.every((r) => jobs.has(r.jobId)),
    "Results contain an unscheduled job.",
  );
  const audits = plan.jobs.map((j) => auditRun(plan, j, returned.get(j.id), options));
  const sessions = new Map<string, string[]>();
  for (const r of bundle.runs) {
    const ids = sessions.get(r.sessionId) ?? [];
    ids.push(r.jobId);
    sessions.set(r.sessionId, ids);
  }
  for (const ids of sessions.values())
    if (ids.length > 1)
      for (const id of ids) {
        const a = audits.find((a) => a.jobId === id)!;
        a.compliant = false;
        a.issues.push("Session identifier reused across jobs.");
      }
  const frames = new Map<string, Set<string>>();
  for (const r of bundle.runs)
    for (const e of Array.isArray(r.trace) ? r.trace : [])
      if (e && e.type === "observation" && Array.isArray(e.captures))
        for (const c of e.captures) {
          if (!c || typeof c.frameId !== "string") continue;
          const owners = frames.get(c.frameId) ?? new Set<string>();
          owners.add(r.jobId + "|" + e.caseId);
          frames.set(c.frameId, owners);
        }
  for (const owners of frames.values())
    if (owners.size > 1)
      for (const owner of owners) {
        const id = owner.split("|")[0];
        const a = audits.find((a) => a.jobId === id)!;
        a.compliant = false;
        a.issues.push("Capture frame identity reused across jobs or cases.");
      }
  // Real and simulated runs are never pooled. When a configuration has real runs, its simulated
  // runs are left out of every score (they stay listed in the audit); a configuration with only
  // simulated runs is scored on them and named in a note.
  const isSimulated = (r: RunResult) => (r.execution as { synthetic?: unknown } | undefined)?.synthetic === true;
  const kinds = new Map<string, { real: number; simulated: number }>();
  for (const r of bundle.runs) {
    const agentId = jobs.get(r.jobId)!.agentId;
    const k = kinds.get(agentId) ?? { real: 0, simulated: 0 };
    if (isSimulated(r)) k.simulated++;
    else k.real++;
    kinds.set(agentId, k);
  }
  const labelOf = (id: string) => plan.agents.find((a) => a.id === id)?.label ?? id;
  const poolingNotes: string[] = [];
  for (const [agentId, k] of kinds)
    if (k.real && k.simulated) {
      for (const r of bundle.runs)
        if (jobs.get(r.jobId)!.agentId === agentId && isSimulated(r)) {
          const a = audits.find((x) => x.jobId === r.jobId)!;
          a.scoreable = false;
          a.issues.push("Simulated run left out: this configuration also has real runs, and real and simulated runs are never pooled.");
        }
      poolingNotes.push(`${labelOf(agentId)}: ${k.real} real + ${k.simulated} simulated run(s). Scored on the ${k.real} real run(s) only; the simulated ones are left out.`);
    }
  const simulatedOnlyIds = new Set([...kinds].filter(([, k]) => k.simulated && !k.real).map(([id]) => id));
  const simulatedOnly = [...simulatedOnlyIds].map(labelOf);
  if (plan.study.synthetic && simulatedOnly.length && [...kinds.values()].some((k) => k.real))
    poolingNotes.push(`Scored on simulated (invented) runs only: ${simulatedOnly.join(", ")}. Comparisons between these and configurations with real runs compare invented with real forecasts.`);
  // A research study never scores invented forecasts (the audit marks them); the notes say so.
  const simulatedRuns = bundle.runs.filter(isSimulated).length;
  if (!plan.study.synthetic && simulatedRuns)
    poolingNotes.push(`${simulatedRuns} simulated (invented) run(s) left out: this is a research study, so only real agent runs are scored against the human data. Simulated runs only test the pipeline.`);
  const auditMap = new Map(audits.map((a) => [a.jobId, a]));
  const targetSets = new Map(
    plan.agents.map((a) => [a.id, new Set(agentTargets(plan.study, a))]),
  );
  const outcomes = plan.study.outcomes,
    conditions = plan.study.conditions,
    people = plan.study.participants;
  const humanMap = new Map(
    human.measurements.map((r) => [measurementKey(r), r]),
  );
  const transform = (i: number, v: number): number =>
    outcomes[i].aggregation === "geometric" ? Math.log(v) : v;
  const restore = (i: number, v: number): number =>
    outcomes[i].aggregation === "geometric" ? Math.exp(v) : v;
  const h = humanMatrix(plan.study, (p, c, o) => {
    const r = humanMap.get(`${p}|${c}|${o}`);
    return r ? measurementValue(plan.study, r) : undefined;
  });
  const truthProfile = (oi: number, indices: number[]): number[] | null => {
    const means = conditions.map((_, ci) =>
      mean(
        indices
          .map((pi) => h[oi][pi][ci])
          .filter((x): x is number => x !== null),
      ),
    );
    return means.some((v) => v === null) ? null : (means as number[]);
  };
  const all = people.map((_, i) => i),
    tolerance = plan.study.analysis.tieTolerance;
  // Which human design differences count. "means": any difference of the design means beyond the
  // tie tolerance. "significant": only pairs a test supports, Holm-adjusted over the design pairs of
  // one measure at .05: Mann–Whitney U between the two groups (between-subjects) or Wilcoxon
  // signed-rank on each person's difference (within-subjects), both on the analysis scale (paired
  // differences of geometric measures are log ratios). See populationReference.
  const between = plan.study.design === "between-subjects";
  const reference =
    plan.study.predictionLevel === "population" ? populationReference(plan.study, h, pairRule) : null;
  const humanPairs: HumanPair[] = reference?.pairs ?? [];
  const masks = reference?.masks ?? outcomes.map(() => []);
  const individualEligible = outcomes.map((_, oi) =>
    people.map(
      (_, pi) =>
        h[oi][pi].every((x) => x !== null) &&
        pairMask(h[oi][pi] as number[], tolerance).some(Boolean),
    ),
  );
  const informative = outcomes.map((_, oi) =>
    plan.study.predictionLevel === "population"
      ? masks[oi].some(Boolean)
      : individualEligible[oi].some(Boolean),
  );
  const exclusions = outcomes.flatMap((o, i) =>
    informative[i]
      ? []
      : [
          pairRule === "significant" && plan.study.predictionLevel === "population"
            ? `${o.label}: no design pair differs significantly for the humans; excluded identically for all agents.`
            : `${o.label}: no complete, non-tied human design comparison; excluded identically for all agents.`,
        ],
  );
  if (plan.study.predictionLevel === "population")
    outcomes.forEach((o, oi) =>
      conditions.forEach((c, ci) => {
        const assigned = people.filter((p) =>
          p.conditionOrder.includes(c.id),
        ).length;
        const observed = h[oi].filter((row) => row[ci] !== null).length;
        if (observed < assigned)
          exclusions.push(
            `${o.label}, ${c.label}: ${observed}/${assigned} assigned people observed. Available-case population means are used; missing values are not imputed.`,
          );
      }),
    );
  if (plan.study.predictionLevel === "individual")
    outcomes.forEach((o, oi) => {
      const n = individualEligible[oi].filter(Boolean).length;
      if (n < people.length)
        exclusions.push(
          `${o.label}: ${n}/${people.length} people have complete, non-tied profiles; the same human support is used for all agents.`,
        );
    });
  const agentOfJob = new Map(plan.jobs.map((j) => [j.id, j.agentId]));
  const predicted = new Map<string, number[][]>();
  for (const r of bundle.runs)
    if (auditMap.get(r.jobId)!.scoreable) {
      const lookup = new Map(
        r.measurements.map((m) => [`${m.conditionId}|${m.outcomeId}`, m]),
      );
      const targets = targetSets.get(agentOfJob.get(r.jobId)!)!;
      predicted.set(
        r.jobId,
        outcomes.map((o, oi) =>
          !targets.has(o.id) ? [] : conditions.map((c) =>
            transform(
              oi,
              measurementValue(
                plan.study,
                lookup.get(`${c.id}|${o.id}`) as Measurement,
              ),
            ),
          ),
        ),
      );
    }
  const metrics: MetricScore[] = [],
    summaries: SummaryScore[] = [];
  // Each configuration's jobs are listed once (in schedule order): the bootstrap asks for them
  // in every draw. The lists are read only.
  const jobsOfAgent = new Map<string, Plan["jobs"]>(plan.agents.map((a) => [a.id, []]));
  for (const j of plan.jobs) jobsOfAgent.get(j.agentId)?.push(j);
  const primaryLists = new Map<string, Plan["jobs"]>();
  const primaryJobs = (agentId: string) => {
    let list = primaryLists.get(agentId);
    if (!list)
      primaryLists.set(
        agentId,
        (list = (jobsOfAgent.get(agentId) ?? plan.jobs.filter((j) => j.agentId === agentId)).filter(
          (j) => plan.study.predictionLevel === "population" || j.repetition === 1,
        )),
      );
    return list;
  };
  const validLists = new Map<string, Plan["jobs"]>();
  const validJobs = (agentId: string, adherent = false) => {
    const key = `${adherent ? 1 : 0}|${agentId}`;
    let list = validLists.get(key);
    if (!list)
      validLists.set(
        key,
        (list = primaryJobs(agentId).filter(
          (j) =>
            predicted.has(j.id) && (!adherent || auditMap.get(j.id)!.compliant),
        )),
      );
    return list;
  };
  const scoreAgent = (
    agentId: string,
    indices: number[],
    rng?: () => number,
    adherent = false,
  ): {
    scores: (number | null)[];
    absolute: (number | null)[];
    units: number[];
    pairs: number[];
  } => {
    analysisStats.fullScores++;
    const candidates = validJobs(agentId, adherent);
    const populationJobs =
      rng && plan.study.predictionLevel === "population"
        ? candidates.map(
            () => candidates[Math.floor(rng() * candidates.length)],
          )
        : candidates;
    const byPerson = new Map(candidates.map((j) => [j.participantId, j]));
    const individualComplete =
      plan.study.predictionLevel === "population" ||
      people.every((p) => byPerson.has(p.id));
    const scores: (number | null)[] = [],
      absolute: (number | null)[] = [],
      units: number[] = [],
      pairs: number[] = [];
    const targets = targetSets.get(agentId)!;
    for (let oi = 0; oi < outcomes.length; oi++) {
      if (!individualComplete || !targets.has(outcomes[oi].id)) {
        scores.push(null);
        absolute.push(null);
        units.push(0);
        pairs.push(0);
        continue;
      }
      const values: number[] = [],
        errors: number[] = [];
      let pairCount = 0;
      if (plan.study.predictionLevel === "population") {
        const truth = truthProfile(oi, indices);
        if (truth)
          for (const j of populationJobs) {
            const p = predicted.get(j.id)![oi];
            const a = directionalAgreement(truth, p, tolerance, masks[oi]);
            if (a.score !== null) values.push(a.score);
            pairCount = a.pairs;
            errors.push(
              ...truth.map((v, i) =>
                Math.abs(restore(oi, v) - restore(oi, p[i])),
              ),
            );
          }
        units.push(
          truth
            ? indices.filter((pi) => h[oi][pi].some((x) => x !== null)).length
            : 0,
        );
      } else {
        for (const pi of indices)
          if (h[oi][pi].every((v) => v !== null)) {
            const j = byPerson.get(people[pi].id)!;
            const truth = h[oi][pi] as number[];
            const p = predicted.get(j.id)![oi];
            const a = directionalAgreement(truth, p, tolerance);
            if (a.score !== null) values.push(a.score);
            pairCount += a.pairs;
            errors.push(
              ...truth.map((v, i) =>
                Math.abs(restore(oi, v) - restore(oi, p[i])),
              ),
            );
          }
        units.push(values.length);
      }
      scores.push(mean(values));
      absolute.push(mean(errors));
      pairs.push(pairCount);
    }
    return { scores, absolute, units, pairs };
  };
  const domains: Domain[] = ["objective", "subjective"];
  const weightsOver = (domain: Domain, ...agentIds: string[]) =>
    outcomeWeights(
      plan.study,
      domain,
      informative.map((x, i) => x && agentIds.every((id) => targetSets.get(id)!.has(outcomes[i].id))),
    );
  const point = new Map<
    string,
    {
      scores: (number | null)[];
      absolute: (number | null)[];
      units: number[];
      pairs: number[];
    }
  >();
  for (const a of plan.agents) {
    const values = scoreAgent(a.id, all);
    point.set(a.id, values);
    outcomes.forEach((o, i) =>
      targetSets.get(a.id)!.has(o.id) && metrics.push({
        agentId: a.id,
        outcomeId: o.id,
        domain: o.domain,
        agreement: values.scores[i],
        absoluteMAE:
          plan.study.analysis.mode === "both" ? values.absolute[i] : null,
        informativeUnits: values.units[i],
        informativePairs: values.pairs[i],
        runs: validJobs(a.id).length,
      }),
    );
  }
  // Per-outcome bootstrap scores, so any comparison can be weighted over common targets. People are
  // resampled from one stream shared by every configuration (paired draws for comparisons); each
  // configuration resamples its runs from its own stream, derived from the seed and its ID, so its
  // interval does not depend on which other configurations are analysed.
  const draws = new Map<string, (number | null)[][]>(plan.agents.map((a) => [a.id, []]));
  const seed = plan.study.analysis.seed;
  const peopleStream = random(streamSeed(seed, "participants"));
  const runStreams = new Map(plan.agents.map((a) => [a.id, random(streamSeed(seed, `config:${a.id}`))]));
  const drawScores = bootstrapScorer(plan, h, masks, tolerance, targetSets, validJobs, predicted);
  for (let draw = 0; draw < plan.study.analysis.bootstrapDraws; draw++) {
    const indices = resamplePeople(plan, peopleStream);
    const scoreDraw = drawScores(indices);
    for (const a of plan.agents) draws.get(a.id)!.push(scoreDraw(a.id, runStreams.get(a.id)!));
  }
  const bootstrapOf = (agentId: string, w: Map<number, number>) =>
    draws.get(agentId)!.map((scores) => weightedScore(scores, w));
  for (const a of plan.agents)
    for (const domain of domains) {
      const w = weightsOver(domain, a.id);
      if (!outcomes.some((o) => o.domain === domain && targetSets.get(a.id)!.has(o.id))) continue;
      const assigned = primaryJobs(a.id),
        ret = assigned.filter((j) => returned.has(j.id));
      summaries.push({
        agentId: a.id,
        level: plan.study.predictionLevel,
        domain,
        agreement: weightedScore(point.get(a.id)!.scores, w),
        ci95: interval(bootstrapOf(a.id, w)),
        completeAdherenceSensitivity: weightedScore(
          scoreAgent(a.id, all, undefined, true).scores,
          w,
        ),
        assigned: assigned.length,
        returned: ret.length,
        real: ret.filter((j) => !isSimulated(returned.get(j.id)!)).length,
        simulated: ret.filter((j) => isSimulated(returned.get(j.id)!)).length,
        scoreable: validJobs(a.id).length,
        compliant: validJobs(a.id, true).length,
        // Only when there are any, so the summaries of studies without app tasks are as before.
        ...(() => {
          const n = ret.filter((j) => auditMap.get(j.id)?.unfinishedTasks?.length).length;
          return n ? { incomplete: n } : {};
        })(),
      });
    }
  // Distribution data for plots: agreement per population run or per participant
  // (weights renormalised over the outcomes available for that unit), plus values.
  const level = plan.study.predictionLevel;
  const runScores: RunScore[] = [];
  const values: PredictedValue[] = [];
  for (const a of plan.agents) {
    const targets = targetSets.get(a.id)!;
    const ownWeights = new Map(domains.map((d) => [d, weightsOver(d, a.id)]));
    for (const job of plan.jobs.filter((j) => j.agentId === a.id && predicted.has(j.id))) {
      const p = predicted.get(job.id)!;
      const pi = job.participantId ? people.findIndex((x) => x.id === job.participantId) : -1;
      // Population runs: the shared scorer, which the population-vs-individual figure reuses.
      const perOutcome = reference
        ? populationOutcomeScores(plan.study, reference, targets, p)
        : outcomes.map((o, oi) => {
            if (!targets.has(o.id) || !informative[oi]) return null;
            const truth = h[oi][pi];
            return truth && truth.every((x) => x !== null)
              ? directionalAgreement(truth as number[], p[oi], tolerance).score
              : null;
          });
      for (const domain of domains)
        if (ownWeights.get(domain)!.size)
          runScores.push({
            agentId: a.id,
            level,
            domain,
            unit: level === "population" ? job.id : job.participantId!,
            repetition: job.repetition,
            agreement: weightedAvailable(perOutcome, ownWeights.get(domain)!),
          });
      outcomes.forEach((o, oi) => {
        if (!targets.has(o.id)) return;
        conditions.forEach((c, ci) =>
          values.push({
            agentId: a.id,
            level,
            unit: level === "population" ? job.id : job.participantId!,
            repetition: job.repetition,
            ...(job.participantId ? { participantId: job.participantId } : {}),
            outcomeId: o.id,
            conditionId: c.id,
            value: restore(oi, p[oi][ci]),
          }),
        );
      });
    }
  }
  const humanValues = outcomes.flatMap((o, oi) =>
    people.flatMap((person, pi) =>
      conditions.flatMap((c, ci) =>
        h[oi][pi][ci] === null
          ? []
          : [{ participantId: person.id, outcomeId: o.id, conditionId: c.id, value: restore(oi, h[oi][pi][ci]!) }],
      ),
    ),
  );
  // Absolute values (population level): each configuration's mean prediction against the human
  // group's 95% t interval, per measure and design (geometric measures on the log scale; intervals
  // of proportions, mean ranks, counts and declared ranges clipped to them). When every person gave the same value
  // the interval has zero width and "inside" means an exact match (within the tie tolerance).
  const absoluteFit: AbsoluteFit[] = [];
  if (plan.study.predictionLevel === "population")
    for (const a of plan.agents) {
      const jobs = validJobs(a.id);
      if (!jobs.length) continue;
      outcomes.forEach((o, oi) => {
        if (!targetSets.get(a.id)!.has(o.id)) return;
        conditions.forEach((c, ci) => {
          const hv = h[oi].map((row) => row[ci]).filter((x): x is number => x !== null);
          const ci95 = meanInterval(plan.study, o, hv);
          if (!ci95) return;
          const m = ci95.centre;
          const av = mean(jobs.map((j) => predicted.get(j.id)![oi][ci]))!;
          absoluteFit.push({
            agentId: a.id,
            outcomeId: o.id,
            conditionId: c.id,
            human: ci95.mean,
            low: ci95.low,
            high: ci95.high,
            n: ci95.n,
            agent: restore(oi, av),
            error: restore(oi, av) - ci95.mean,
            inside: ci95.degenerate ? Math.abs(av - m) <= tolerance : av >= m - ci95.half && av <= m + ci95.half,
            degenerate: ci95.degenerate,
            ...(ci95.degenerate
              ? { note: `All ${ci95.n} people gave the same value; the interval is degenerate, so "inside" means an exact match.` }
              : {}),
          });
        });
      });
    }
  const pairNote =
    plan.study.predictionLevel !== "population"
      ? []
      : pairRule === "significant"
      ? [
          `Scored on significant human design differences only: ${between ? "Mann–Whitney U between the independent groups" : "Wilcoxon signed-rank on each person's paired difference"}, Holm-adjusted over the design pairs of each measure, α = .05. ${humanPairs.filter((p) => p.used).length} of ${humanPairs.length} design pairs are used; the others are reported, not scored.`,
        ]
      : ["Scored on every human design difference of the means (the significant-only view is reported separately)."];
  const report: LevelCore["report"] = {
    pairRule,
    humanPairs,
    absoluteFit,
    runScores,
    values,
    humanValues,
    simulatedConfigs: [...simulatedOnlyIds],
    studyId: plan.study.id,
    title: plan.study.title,
    synthetic: plan.study.synthetic,
    planDigest: plan.digest,
    predictionLevel: plan.study.predictionLevel,
    metrics,
    summaries,
    audits,
    exclusions,
    bootstrapDraws: plan.study.analysis.bootstrapDraws,
    seed: plan.study.analysis.seed,
    // The note on comparisons chosen at analysis goes between these (see analyzeLevel).
    notesBefore: [
      ...poolingNotes,
      ...pairNote,
      // Individual scores compare every person; say when some forecasts are still missing.
      ...(plan.study.predictionLevel === "individual"
        ? plan.agents.flatMap((a) => {
            const have = new Set(validJobs(a.id).map((j) => j.participantId)).size;
            return have < people.length ? [`${a.label}: scored once every participant has a forecast (${have} of ${people.length} so far).`] : [];
          })
        : []),
      "Directional agreement concerns raw measure ordering across designs, not which design is objectively better. Random directions have expectation 50%.",
      "Exact human ties are excluded; tied forecasts receive half credit. Bootstrap-created human ties are neutral on the fixed original population pair mask.",
      "Declared family budgets are normalized within objective and subjective domains; outcome weights are normalized within a family. Correlated/duplicate measures must be grouped in the frozen plan, not selected using favorable model results.",
      "Complete numeric outputs remain in the main score despite protocol deviations. Adherence-only sensitivity is descriptive and may select a different set of runs. Failed, missing and malformed outputs are reported rather than imputed as zero.",
      plan.study.predictionLevel === "population"
        ? "Shared whole-participant resampling within order/design strata, with independent whole-run resampling within each agent."
        : "First scheduled repetition per person is primary. Later repetitions are diagnostics and never replace a failed primary. Whole people are resampled; generation uncertainty is not estimated.",
      "Intervals are approximate, unadjusted 95% participant-cluster bootstrap intervals with fixed groups and pair masks. Near ties and small human samples limit interpretation; nonsignificance is not equivalence.",
      "Candidate-minus-baseline comparisons use two-sided centered-bootstrap p-values and one Holm family over every comparison listed. Exploratory weights and any post-results plan changes must be disclosed.",
    ],
    notesAfter: [
      "Model inference wall time, simulation time and estimated human response time are distinct. Runtime fidelity and trace receipts do not prove human experience or internal use of evidence.",
      "Hashes detect changes and bind artifacts to a plan; they do not authenticate a worker or establish that target data were never leaked.",
      ...(Object.values(
        people.reduce<Record<string, number>>((a, p) => {
          a[p.stratum] = (a[p.stratum] ?? 0) + 1;
          return a;
        }, {}),
      ).some((n) => n === 1)
        ? [
            "At least one order/design stratum contains a single person. Stratified resampling cannot estimate within-stratum human variation there.",
          ]
        : []),
      ...(plan.study.predictionLevel === "population" &&
      plan.agents.some((a) => validJobs(a.id).length === 1)
        ? [
            "A method has only one scoreable forecast run; its between-generation variability cannot be estimated from this execution.",
          ]
        : []),
      ...(plan.study.synthetic
        ? [
            "SYNTHETIC DEMONSTRATION. No result is evidence about real people, agent quality, engine fidelity or headset experience.",
          ]
        : []),
    ],
  };
  return {
    report,
    contrasts: { study: plan.study, informative, targetSets, point: new Map([...point].map(([id, v]) => [id, v.scores])), draws, simulatedOnlyIds },
  };
}
