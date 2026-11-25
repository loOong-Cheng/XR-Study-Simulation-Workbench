// Rank tests and distribution helpers shared by the analyzer (deciding which human design
// differences are reliable) and the figures (brackets). Pure functions, checked against R, scipy
// and a full permutation enumeration in the tests.
//
// Ties. Values are rounded to multiples of a tie step before ranking, so values that differ only
// by floating-point noise tie (|1/3 − 0.5| and |2/3 − 0.5| differ by 6e-17). Callers pass the
// study's tie tolerance; without one the step is 1e-9 of the largest absolute value (at least 1e-9).
//
// p-values. Small samples get exact conditional (permutation) p-values, also with ties: the null
// distribution of the rank sum (Mann–Whitney) or of the positive-rank sum (Wilcoxon) given the
// observed midranks, by dynamic programming over midranks doubled to integers. Two-sided
// p = min(1, 2 × the smaller one-sided tail probability), each tail including the observed value.
// Above the cutoff, the normal approximation with tie and continuity correction is used.

/**
 * Largest n1 + n2 (Mann–Whitney) and n (Wilcoxon, after dropping zeros) with exact p-values. Chosen
 * by cost: about 5 ms per Mann–Whitney test at n1 + n2 = 80 (13 ms at 100) and 4 ms per Wilcoxon
 * test at n = 200 on a laptop; the normal approximation is accurate well before these sizes.
 */
export const EXACT_MANN_WHITNEY_MAX_N = 80;
export const EXACT_WILCOXON_MAX_N = 200;

/** Rounding step that makes floating-point near-ties exact ties. */
export function tieStep(values: number[], tolerance?: number): number {
  if (tolerance !== undefined && Number.isFinite(tolerance) && tolerance > 0) return tolerance;
  const largest = values.reduce((m, x) => (Number.isFinite(x) ? Math.max(m, Math.abs(x)) : m), 0);
  return 1e-9 * Math.max(1, largest);
}
/** Values on the tie grid (integer multiples of the step), so equal values compare equal. */
export function roundForTies(values: number[], tolerance?: number): number[] {
  const step = tieStep(values, tolerance);
  return values.map((x) => Math.round(x / step));
}

/** Midranks (ties share their mean rank) after rounding to the tie step. */
export function ranks(values: number[], tolerance?: number): { ranks: number[]; tieGroups: number[] } {
  return midranks(roundForTies(values, tolerance));
}
function midranks(values: number[]): { ranks: number[]; tieGroups: number[] } {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const r = new Array<number>(values.length);
  const tieGroups: number[] = [];
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[order[k][1]] = avg;
    if (j > i) tieGroups.push(j - i + 1);
    i = j + 1;
  }
  return { ranks: r, tieGroups };
}

function normalTwoSided(z: number): number {
  // Abramowitz–Stegun 7.1.26 erfc approximation (|error| < 1.5e-7).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return Math.min(1, y * Math.exp(-x * x));
}
/** Two-sided p from exact tail probabilities (each tail includes the observed value). */
const twoSided = (lower: number, upper: number) => Math.min(1, 2 * Math.min(lower, upper));

/**
 * Exact conditional null distribution of the sum of `size` scores drawn without replacement from
 * `scores` (non-negative integers): tail probabilities at `observed`.
 */
function subsetSumTails(scores: number[], size: number, observed: number): { lower: number; upper: number } {
  const total = scores.reduce((s, x) => s + x, 0);
  const width = total + 1;
  // counts[k * width + s]: number of k-subsets of the scores seen so far with sum s.
  const counts = new Float64Array((size + 1) * width);
  counts[0] = 1;
  // lo[k]..hi[k] holds every sum with a non-zero count in row k (none while hi < lo). Only sums
  // whose source count can be non-zero are updated: the others would add 0, which changes nothing,
  // so the counts are exactly those of updating every sum.
  const lo = new Array<number>(size + 1).fill(Infinity),
    hi = new Array<number>(size + 1).fill(-Infinity);
  lo[0] = hi[0] = 0;
  let reach = 0;
  scores.forEach((c, i) => {
    reach += c;
    for (let k = Math.min(i + 1, size); k >= 1; k--) {
      if (hi[k - 1] < lo[k - 1]) continue;
      const row = k * width,
        prev = (k - 1) * width;
      const top = Math.min(reach, hi[k - 1] + c),
        bottom = Math.max(c, lo[k - 1] + c);
      if (top < bottom) continue;
      for (let s = top; s >= bottom; s--) counts[row + s] += counts[prev + s - c];
      lo[k] = Math.min(lo[k], bottom);
      hi[k] = Math.max(hi[k], top);
    }
  });
  let all = 0,
    lower = 0,
    upper = 0;
  const row = size * width;
  for (let s = 0; s <= total; s++) {
    const n = counts[row + s];
    all += n;
    if (s <= observed) lower += n;
    if (s >= observed) upper += n;
  }
  return { lower: lower / all, upper: upper / all };
}
/** Exact null distribution of the sum of scores with independent random signs: tails at `observed`. */
function signedSumTails(scores: number[], observed: number): { lower: number; upper: number } {
  const total = scores.reduce((s, x) => s + x, 0);
  let dist = new Float64Array(total + 1);
  dist[0] = 1;
  let reach = 0;
  for (const c of scores) {
    const next = new Float64Array(total + 1);
    for (let s = 0; s <= reach; s++) {
      if (!dist[s]) continue;
      next[s] += dist[s] / 2;
      next[s + c] += dist[s] / 2;
    }
    reach += c;
    dist = next;
  }
  let lower = 0,
    upper = 0;
  for (let s = 0; s <= total; s++) {
    if (s <= observed) lower += dist[s];
    if (s >= observed) upper += dist[s];
  }
  return { lower, upper };
}

/**
 * Two-sided Mann–Whitney U test. Exact conditional p-value (given the observed ties) when
 * n1 + n2 ≤ EXACT_MANN_WHITNEY_MAX_N, otherwise the normal approximation with tie and continuity
 * correction. `p` is null with fewer than two values per group or when every value is tied.
 */
export function mannWhitney(a: number[], b: number[], tolerance?: number): { u: number; p: number | null; exact: boolean } {
  const n1 = a.length,
    n2 = b.length;
  if (n1 < 2 || n2 < 2) return { u: NaN, p: null, exact: false };
  const { ranks: r, tieGroups } = ranks([...a, ...b], tolerance);
  const r1 = r.slice(0, n1).reduce((s, x) => s + x, 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  const n = n1 + n2;
  if (tieGroups.length === 1 && tieGroups[0] === n) return { u, p: null, exact: false };
  if (n <= EXACT_MANN_WHITNEY_MAX_N) {
    // Midranks are multiples of 1/2: doubled, they are integers and the rank sum is exact.
    // The smaller group's rank sum carries the same information and is cheaper to enumerate.
    const scores = r.map((x) => Math.round(2 * x));
    const sumA = scores.slice(0, n1).reduce((s, x) => s + x, 0);
    const { lower, upper } =
      n1 <= n2 ? subsetSumTails(scores, n1, sumA) : subsetSumTails(scores, n2, scores.reduce((s, x) => s + x, 0) - sumA);
    return { u, p: twoSided(lower, upper), exact: true };
  }
  const tie = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = ((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1)));
  if (variance <= 0) return { u, p: null, exact: false };
  const z = (Math.abs(u1 - (n1 * n2) / 2) - 0.5) / Math.sqrt(variance);
  return { u, p: normalTwoSided(Math.max(0, z)), exact: false };
}

/**
 * Two-sided Wilcoxon signed-rank test on paired differences. Differences that are zero after
 * rounding to the tie step are dropped. Exact conditional p-value (given the observed tied absolute
 * differences) when n ≤ EXACT_WILCOXON_MAX_N, otherwise the normal approximation with tie and
 * continuity correction. `p` is null with fewer than two non-zero differences.
 */
export function wilcoxonSignedRank(differences: number[], tolerance?: number): { w: number; n: number; p: number | null; exact: boolean } {
  const finite = differences.filter((x) => Number.isFinite(x));
  const d = roundForTies(finite, tolerance).filter((x) => x !== 0);
  const n = d.length;
  if (n < 2) return { w: NaN, n, p: null, exact: false };
  const { ranks: r, tieGroups } = midranks(d.map(Math.abs));
  const wPlus = d.reduce((s, x, i) => s + (x > 0 ? r[i] : 0), 0);
  const total = (n * (n + 1)) / 2;
  const w = Math.min(wPlus, total - wPlus);
  if (n <= EXACT_WILCOXON_MAX_N) {
    const scores = r.map((x) => Math.round(2 * x));
    const observed = d.reduce((s, x, i) => s + (x > 0 ? scores[i] : 0), 0);
    const { lower, upper } = signedSumTails(scores, observed);
    return { w, n, p: twoSided(lower, upper), exact: true };
  }
  const tie = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tie / 48;
  if (variance <= 0) return { w, n, p: null, exact: false };
  const z = (Math.abs(wPlus - total / 2) - 0.5) / Math.sqrt(variance);
  return { w, n, p: normalTwoSided(Math.max(0, z)), exact: false };
}

/**
 * Holm step-down adjustment over the whole family. Untestable comparisons (null p) stay null but
 * count in the family size, which is conservative: the family is what was declared, not what
 * happened to be testable.
 */
export function holm(ps: (number | null)[]): (number | null)[] {
  const m = ps.length;
  const idx = ps.map((p, i) => [p, i] as const).filter((x): x is readonly [number, number] => x[0] !== null);
  idx.sort((a, b) => a[0] - b[0]);
  const out: (number | null)[] = ps.map(() => null);
  let prev = 0;
  idx.forEach(([p, i], k) => {
    prev = Math.max(prev, Math.min(1, (m - k) * p));
    out[i] = prev;
  });
  return out;
}

/**
 * The smallest two-sided p the exact Wilcoxon signed-rank test can reach with n non-zero
 * differences: every difference on one side, 2 / 2^n (also with ties, since that sign pattern is
 * the only one giving the extreme sum). Fewer than two differences give no test (1 here).
 */
export function smallestWilcoxonP(n: number): number {
  return n < 2 ? 1 : Math.min(1, 2 / 2 ** n);
}
/**
 * The smallest two-sided p the exact Mann–Whitney U test can reach for groups of n1 and n2:
 * complete separation, 2 / C(n1 + n2, n1). An empty group gives no test (1 here).
 */
export function smallestMannWhitneyP(n1: number, n2: number): number {
  if (n1 < 1 || n2 < 1) return 1;
  let ways = 1;
  for (let k = 1; k <= Math.min(n1, n2); k++) ways = (ways * (n1 + n2 - Math.min(n1, n2) + k)) / k;
  return Math.min(1, 2 / ways);
}

// ---------- Student t quantile ----------

function logGamma(x: number): number {
  // Lanczos approximation (g = 7, n = 9), relative error ~1e-15 for x > 0.
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1,
    d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 100000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return h;
}
/** Regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  return x < (a + 1) / (a + b + 2) ? (front * betaFraction(a, b, x)) / a : 1 - (front * betaFraction(b, a, 1 - x)) / b;
}
/** Upper tail P(T > t) of Student's t with df degrees of freedom, t ≥ 0. */
function tUpperTail(t: number, df: number): number {
  return 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
}
const quantiles = new Map<string, number>();
/** Quantile of Student's t distribution (any df > 0): inverts the CDF by bisection to machine precision. */
export function studentTQuantile(p: number, df: number): number {
  if (!(df > 0) || !(p > 0 && p < 1)) return NaN;
  if (p === 0.5) return 0;
  if (p < 0.5) return -studentTQuantile(1 - p, df);
  const key = `${p}|${df}`;
  const cached = quantiles.get(key);
  if (cached !== undefined) return cached;
  const target = 1 - p;
  let lo = 0,
    hi = 2;
  while (tUpperTail(hi, df) > target) (lo = hi), (hi *= 2);
  for (let i = 0; i < 200 && hi - lo > 1e-15 * hi; i++) {
    const mid = (lo + hi) / 2;
    if (tUpperTail(mid, df) > target) lo = mid;
    else hi = mid;
  }
  const q = (lo + hi) / 2;
  quantiles.set(key, q);
  return q;
}
/** Two-sided 95% Student t quantile (the 0.975 quantile) for df degrees of freedom. */
export function t975(df: number): number {
  return df >= 1 ? studentTQuantile(0.975, df) : NaN;
}
