// Rank tests shared by the analyzer (deciding which human design differences are reliable) and
// the figures (brackets). Pure functions, checked against R in the tests.
export function ranks(values: number[]): { ranks: number[]; tieGroups: number[] } {
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

/** Two-sided Mann–Whitney U test (exact without ties for small samples, else normal with tie and continuity correction). */
export function mannWhitney(a: number[], b: number[]): { u: number; p: number | null } {
  const n1 = a.length,
    n2 = b.length;
  if (n1 < 2 || n2 < 2) return { u: NaN, p: null };
  const { ranks: r, tieGroups } = ranks([...a, ...b]);
  const r1 = r.slice(0, n1).reduce((s, x) => s + x, 0);
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u = Math.min(u1, n1 * n2 - u1);
  if (!tieGroups.length && n1 + n2 <= 40) {
    // counts[k] = number of arrangements with U = k (recurrence over sample sizes)
    let table = new Map<string, number[]>();
    const count = (m: number, n: number): number[] => {
      const key = `${m},${n}`;
      if (table.has(key)) return table.get(key)!;
      let res: number[];
      if (m === 0 || n === 0) res = [1];
      else {
        const x = count(m - 1, n),
          y = count(m, n - 1);
        res = new Array(m * n + 1).fill(0);
        x.forEach((v, k) => (res[k + n] += v));
        y.forEach((v, k) => (res[k] += v));
      }
      table.set(key, res);
      return res;
    };
    const dist = count(n1, n2);
    const total = dist.reduce((s, v) => s + v, 0);
    const tail = dist.slice(0, Math.floor(u) + 1).reduce((s, v) => s + v, 0);
    table = new Map();
    return { u, p: Math.min(1, (2 * tail) / total) };
  }
  const n = n1 + n2;
  const tie = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = ((n1 * n2) / 12) * (n + 1 - tie / (n * (n - 1)));
  if (variance <= 0) return { u, p: null };
  const z = (Math.abs(u1 - (n1 * n2) / 2) - 0.5) / Math.sqrt(variance);
  return { u, p: normalTwoSided(Math.max(0, z)) };
}

/** Two-sided Wilcoxon signed-rank test on paired differences (zeros dropped). */
export function wilcoxonSignedRank(differences: number[]): { w: number; n: number; p: number | null } {
  const d = differences.filter((x) => Number.isFinite(x) && Math.abs(x) > 1e-12);
  const n = d.length;
  if (n < 2) return { w: NaN, n, p: null };
  const { ranks: r, tieGroups } = ranks(d.map(Math.abs));
  const wPlus = d.reduce((s, x, i) => s + (x > 0 ? r[i] : 0), 0);
  const total = (n * (n + 1)) / 2;
  const w = Math.min(wPlus, total - wPlus);
  if (!tieGroups.length && n <= 30) {
    const dist = new Array(total + 1).fill(0);
    dist[0] = 1;
    for (let k = 1; k <= n; k++) for (let s = total; s >= k; s--) dist[s] += dist[s - k];
    const all = 2 ** n;
    const tail = dist.slice(0, Math.floor(w) + 1).reduce((s, v) => s + v, 0);
    return { w, n, p: Math.min(1, (2 * tail) / all) };
  }
  const tie = tieGroups.reduce((s, t) => s + (t ** 3 - t), 0);
  const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tie / 48;
  if (variance <= 0) return { w, n, p: null };
  const z = (Math.abs(wPlus - total / 2) - 0.5) / Math.sqrt(variance);
  return { w, n, p: normalTwoSided(Math.max(0, z)) };
}

/** Holm step-down adjustment; nulls stay null and are not counted. */
export function holm(ps: (number | null)[]): (number | null)[] {
  const idx = ps.map((p, i) => [p, i] as const).filter((x): x is readonly [number, number] => x[0] !== null);
  idx.sort((a, b) => a[0] - b[0]);
  const out: (number | null)[] = ps.map(() => null);
  let prev = 0;
  idx.forEach(([p, i], k) => {
    prev = Math.max(prev, Math.min(1, (idx.length - k) * p));
    out[i] = prev;
  });
  return out;
}
