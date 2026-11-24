// SVG figures for the analyzer. Inputs are the figure data from core/figures.ts;
// every statistic shown is computed there. Output is a standalone SVG string
// that can be saved as SVG or rendered to PNG.
type Stats = { n: number; mean: number; median: number; q1: number; q3: number; whiskerLow: number; whiskerHigh: number };
export interface Group {
  id: string;
  label: string;
  level: string;
  values: number[];
  units: string[];
  stats: Stats;
  vsChance?: { p: number | null; holm: number | null };
  /** Scored on simulated (invented) runs only: drawn dashed and hollow, label ends in "(simulated)". */
  simulated?: boolean;
}
export interface Bracket {
  a: string;
  b: string;
  test: string;
  p: number | null;
  holm: number | null;
  stars: string;
  /** Between two simulated configurations (their own Holm family): drawn dashed. */
  simulated?: boolean;
}
/** Dash pattern for everything drawn from simulated (invented) runs. */
const SIM_DASH = ' stroke-dasharray="4 3"';
/** The legend line every figure with simulated configurations carries. */
const SIMULATED_LEGEND = "Dashed, hollow, “(simulated)”: invented forecasts that test the pipeline; never tested against real configurations or the human data.";
const PALETTE = ["#4C78A8", "#E6AD70", "#7EAE98", "#B392B4", "#E45756", "#72B7B2", "#9D755D", "#EECA3B", "#FF9DA6", "#739DC0", "#727D88", "#54A24B"];
const HUMAN = "#6B7280";
export function colorFor(id: string, order: string[]): string {
  if (id === "human") return HUMAN;
  const i = order.indexOf(id);
  return PALETTE[(i >= 0 ? i : [...id].reduce((s, c) => s + c.charCodeAt(0), 0)) % PALETTE.length];
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");
function svg(width: number, height: number, body: string, title: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="Inter, -apple-system, 'Segoe UI', sans-serif"><rect width="100%" height="100%" fill="#fff"/><text x="16" y="24" font-size="15" font-weight="700" fill="#1f2a24">${esc(title)}</text>${body}</svg>`;
}
function niceTicks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1)!;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}
/** Gaussian kernel density for violins (Silverman bandwidth). */
function kde(values: number[], lo: number, hi: number, points = 40): [number, number][] {
  if (values.length < 3) return [];
  const n = values.length;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) || (hi - lo) / 20 || 1;
  const h = 1.06 * sd * n ** -0.2;
  const minV = Math.min(...values) - h,
    maxV = Math.max(...values) + h;
  const a = Math.max(lo, minV),
    b = Math.min(hi, maxV);
  return Array.from({ length: points }, (_, i) => {
    const x = a + ((b - a) * i) / (points - 1);
    const d = values.reduce((s, v) => s + Math.exp(-0.5 * ((x - v) / h) ** 2), 0) / (n * h * Math.sqrt(2 * Math.PI));
    return [x, d];
  });
}
function jitter(i: number) {
  return ((Math.sin(i * 12.9898) * 43758.5453) % 1) - 0.5;
}

interface Axis {
  lo: number;
  hi: number;
  log: boolean;
  top: number;
  bottom: number;
}
const project = (ax: Axis, v: number) => {
  const t = ax.log ? (Math.log(v) - Math.log(ax.lo)) / (Math.log(ax.hi) - Math.log(ax.lo)) : (v - ax.lo) / (ax.hi - ax.lo);
  return ax.bottom - t * (ax.bottom - ax.top);
};
function yAxis(ax: Axis, x: number, width: number, label: string, percent: boolean) {
  const ticks = ax.log
    ? niceTicks(Math.log10(ax.lo), Math.log10(ax.hi), 4).map((t) => 10 ** t)
    : niceTicks(ax.lo, ax.hi, 5);
  const lines = ticks
    .map((t) => {
      const y = project(ax, t);
      return `<line x1="${x}" x2="${x + width}" y1="${y}" y2="${y}" stroke="#eef1ec"/><text x="${x - 6}" y="${y + 4}" font-size="11" text-anchor="end" fill="#55635a">${percent ? Math.round(t * 100) : Number(t.toPrecision(3))}</text>`;
    })
    .join("");
  return `${lines}<line x1="${x}" x2="${x}" y1="${ax.top}" y2="${ax.bottom}" stroke="#1f2a24"/><text transform="translate(${x - 44},${(ax.top + ax.bottom) / 2}) rotate(-90)" font-size="12" text-anchor="middle" fill="#1f2a24">${esc(label)}</text>`;
}
/** One distribution: violin, box, whiskers, dots, mean diamond. */
function distribution(g: Group, cx: number, w: number, ax: Axis, color: string, percent: boolean, violin: boolean) {
  const s = g.stats;
  if (!s.n) return `<text x="${cx}" y="${ax.bottom - 6}" font-size="10" text-anchor="middle" fill="#888">no data</text>`;
  // Simulated groups: dashed outlines, a lighter box and hollow dots, so they never pass for real runs.
  const dash = g.simulated ? SIM_DASH : "";
  let out = "";
  if (violin) {
    const dens = kde(ax.log ? g.values.map(Math.log) : g.values, ax.log ? Math.log(ax.lo) : ax.lo, ax.log ? Math.log(ax.hi) : ax.hi);
    if (dens.length) {
      const max = Math.max(...dens.map((d) => d[1]));
      const pts = dens.map(([v, d]) => [cx + (d / max) * (w / 2), project(ax, ax.log ? Math.exp(v) : v)]);
      const back = dens.map(([v, d]) => [cx - (d / max) * (w / 2), project(ax, ax.log ? Math.exp(v) : v)]).reverse();
      out += `<path d="M${[...pts, ...back].map((p) => p.map((n) => n.toFixed(1)).join(",")).join("L")}Z" fill="${color}" fill-opacity="${g.simulated ? 0.06 : 0.16}" stroke="${color}" stroke-opacity="0.4"${dash}/>`;
    }
  }
  const bw = w * 0.42;
  out += `<line x1="${cx}" x2="${cx}" y1="${project(ax, s.whiskerLow)}" y2="${project(ax, s.whiskerHigh)}" stroke="${color}" stroke-width="1.4"${dash}/>`;
  out += `<line x1="${cx - bw / 3}" x2="${cx + bw / 3}" y1="${project(ax, s.whiskerLow)}" y2="${project(ax, s.whiskerLow)}" stroke="${color}"/><line x1="${cx - bw / 3}" x2="${cx + bw / 3}" y1="${project(ax, s.whiskerHigh)}" y2="${project(ax, s.whiskerHigh)}" stroke="${color}"/>`;
  out += `<rect x="${cx - bw / 2}" y="${project(ax, s.q3)}" width="${bw}" height="${Math.max(1, project(ax, s.q1) - project(ax, s.q3))}" fill="${color}" fill-opacity="${g.simulated ? 0.08 : 0.28}" stroke="${color}"${dash}/>`;
  out += `<line x1="${cx - bw / 2}" x2="${cx + bw / 2}" y1="${project(ax, s.median)}" y2="${project(ax, s.median)}" stroke="#111" stroke-width="1.6"/>`;
  out += g.values
    .map((v, i) => `<circle cx="${(cx + jitter(i + 1) * bw * 0.9).toFixed(1)}" cy="${project(ax, v).toFixed(1)}" r="2.6" ${g.simulated ? `fill="#fff" stroke="${color}"` : `fill="${color}" fill-opacity="0.85"`}/>`)
    .join("");
  const my = project(ax, s.mean);
  out += `<path d="M${cx},${my - 5}L${cx + 5},${my}L${cx},${my + 5}L${cx - 5},${my}Z" fill="#fff" stroke="#111" stroke-width="1.2"><title>mean ${fmt(percent ? s.mean * 100 : s.mean)}</title></path>`;
  return out;
}
function bracketLayer(brackets: Bracket[], xs: Map<string, number>, top: number) {
  const shown = brackets.filter((b) => b.stars);
  return shown
    .map((b, i) => {
      const x1 = xs.get(b.a)!,
        x2 = xs.get(b.b)!;
      const y = top - 8 - i * 14;
      return `<path d="M${x1},${y + 5}V${y}H${x2}V${y + 5}" fill="none" stroke="${b.simulated ? "#888" : "#1f2a24"}"${b.simulated ? SIM_DASH : ""}/><text x="${(x1 + x2) / 2}" y="${y - 2}" font-size="12" text-anchor="middle" fill="${b.simulated ? "#888" : "#1f2a24"}">${b.stars}<title>${b.simulated ? "Both simulated (separate Holm family): " : ""}${esc(b.test)}, Holm p = ${fmt(b.holm ?? NaN, 4)}</title></text>`;
    })
    .join("");
}

/** Agreement distributions (also population-vs-individual). */
export function agreementPlot(fig: { groups: Group[]; brackets: Bracket[]; chance: number; yLabel: string; domain?: string }, title: string, order: string[], violin = true): string {
  const n = fig.groups.length;
  const shown = fig.brackets.filter((b) => b.stars).length;
  const left = 64,
    slot = Math.max(70, Math.min(130, 760 / Math.max(1, n))),
    width = left + slot * n + 30;
  const simulated = fig.groups.some((g) => g.simulated);
  const top = 50 + shown * 14 + 18,
    height = top + 300 + 104 + (simulated ? 14 : 0);
  const ax: Axis = { lo: 0, hi: 1, log: false, top, bottom: top + 300 };
  let body = yAxis(ax, left, slot * n + 10, fig.yLabel, true);
  const cy = project(ax, fig.chance);
  body += `<line x1="${left}" x2="${left + slot * n + 10}" y1="${cy}" y2="${cy}" stroke="#888" stroke-dasharray="4 4"/><text x="${left + slot * n + 8}" y="${cy - 4}" font-size="10" text-anchor="end" fill="#777">chance</text>`;
  const xs = new Map<string, number>();
  fig.groups.forEach((g, i) => {
    const cx = left + slot * (i + 0.5) + 5;
    xs.set(g.id, cx);
    const color = colorFor(g.id, order);
    body += distribution(g, cx, slot * 0.8, ax, color, true, violin);
    body += `<text x="${cx}" y="${top - 6}" font-size="11" text-anchor="middle" fill="${color}">${fmt(g.stats.mean * 100, 1)}${g.vsChance?.holm != null && g.vsChance.holm < 0.05 ? " †" : ""}</text>`;
    const words = g.label.split(" ");
    const lines: string[] = [];
    words.forEach((w) => (lines.length && (lines.at(-1)! + " " + w).length <= 16 ? (lines[lines.length - 1] += " " + w) : lines.push(w)));
    body += lines
      .slice(0, 3)
      .map((l, k) => `<text x="${cx}" y="${ax.bottom + 18 + k * 13}" font-size="11" text-anchor="middle" fill="#1f2a24"${g.simulated ? ' font-style="italic"' : ""}>${esc(l)}</text>`)
      .join("");
    body += `<text x="${cx}" y="${ax.bottom + 18 + Math.min(3, lines.length) * 13}" font-size="10" text-anchor="middle" fill="#888">n=${g.stats.n}${g.units[0]?.startsWith("rep") ? " repetition(s)" : g.level === "individual" ? " people" : g.level === "population" ? " runs" : ""}</text>`;
  });
  body += bracketLayer(fig.brackets, xs, top - 14);
  body += `<text x="${left}" y="${height - 22 - (simulated ? 14 : 0)}" font-size="10" fill="#666">Above boxes: mean (%); † above chance (Wilcoxon vs 50%, Holm).</text><text x="${left}" y="${height - 8 - (simulated ? 14 : 0)}" font-size="10" fill="#666">Brackets: * p&lt;.05, ** p&lt;.01, *** p&lt;.001 (Holm).</text>`;
  if (simulated) body += `<text x="${left}" y="${height - 8}" font-size="10" fill="#666">${esc(SIMULATED_LEGEND)}</text>`;
  return svg(Math.max(width, 420), height + 8, body, title);
}

/** Agent vs human for one outcome: grouped by design. */
export function agentVsHumanPlot(
  fig: { outcome: { label: string; unit: string; scale: string }; logScale: boolean; designs: { conditionId: string; label: string; groups: Group[] }[]; discrepancies: { agentId: string; conditionId: string; stars: string; test?: string; holm?: number | null }[] },
  title: string,
  order: string[],
): string {
  const all = fig.designs.flatMap((d) => d.groups.flatMap((g) => g.values)).filter(Number.isFinite);
  let lo = Math.min(...all),
    hi = Math.max(...all);
  if (fig.outcome.scale === "proportion") (lo = Math.min(lo, 0)), (hi = Math.max(hi, 1));
  if (fig.logScale) (lo = Math.max(lo * 0.85, 1e-6)), (hi *= 1.15);
  else {
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;
  }
  const per = fig.designs[0]?.groups.length ?? 1;
  const slot = Math.max(30, Math.min(60, 560 / (per * fig.designs.length)));
  const left = 70,
    gap = 26,
    width = left + fig.designs.length * (per * slot + gap) + 20;
  const top = 64,
    ax: Axis = { lo, hi, log: fig.logScale, top, bottom: top + 290 };
  let body = yAxis(ax, left, width - left - 10, `${fig.outcome.label} (${fig.outcome.unit})`, false);
  fig.designs.forEach((d, di) => {
    const x0 = left + 10 + di * (per * slot + gap);
    d.groups.forEach((g, gi) => {
      const cx = x0 + slot * (gi + 0.5);
      body += distribution(g, cx, slot * 0.9, ax, colorFor(g.id, order), false, g.values.length >= 5);
      const row = fig.discrepancies.find((r) => r.agentId === g.id && r.conditionId === d.conditionId);
      if (row?.stars) body += `<text x="${cx}" y="${top - 4}" font-size="15" font-weight="700" text-anchor="middle">${row.stars}${row.test ? `<title>${esc(row.test)}, Holm p = ${fmt(row.holm ?? NaN, 4)}</title>` : ""}</text>`;
    });
    body += `<text x="${x0 + (per * slot) / 2}" y="${ax.bottom + 20}" font-size="12" font-weight="600" text-anchor="middle">${esc(d.label.length > 28 ? d.label.slice(0, 27) + "…" : d.label)}</text>`;
  });
  const legend = fig.designs[0]?.groups ?? [];
  // Legend labels keep their "(simulated)" ending; simulated swatches are hollow and dashed.
  body += legend
    .map((g, i) => `<rect x="${left + i * 150}" y="${ax.bottom + 36}" width="10" height="10" ${g.simulated ? `fill="#fff" stroke="${colorFor(g.id, order)}"${SIM_DASH}` : `fill="${colorFor(g.id, order)}"`}/><text x="${left + i * 150 + 14}" y="${ax.bottom + 45}" font-size="11"${g.simulated ? ' font-style="italic"' : ""}>${esc(legendLabel(g.label, 22))}</text>`)
    .join("");
  body += `<text x="${left}" y="${ax.bottom + 66}" font-size="10" fill="#666">Stars above a box: config differs from humans for that design (Wilcoxon signed-rank: paired by participant for individual configs, humans vs the mean forecast for population configs; Holm across the table).</text>`;
  const simulated = legend.some((g) => g.simulated);
  if (simulated) body += `<text x="${left}" y="${ax.bottom + 80}" font-size="10" fill="#666">${esc(SIMULATED_LEGEND)}</text>`;
  return svg(Math.max(width, 520), ax.bottom + 76 + (simulated ? 14 : 0), body, title);
}

/** Shortens a label but keeps a "(simulated)" ending visible. */
function legendLabel(label: string, max: number): string {
  if (label.length <= max) return label;
  const suffix = label.endsWith(" (simulated)") ? " (simulated)" : "";
  return label.slice(0, Math.max(4, max - suffix.length - 1)) + "…" + suffix;
}

/** Correlation scatter of z-scored design means. */
export function correlationPlot(fig: { series: { id: string; label: string; simulated?: boolean; points: { human: number; agent: number }[]; pearson: number | null; spearman: number | null }[] }, title: string, order: string[]): string {
  const size = 360,
    left = 60,
    top = 44;
  const ax: Axis = { lo: -2.2, hi: 2.2, log: false, top, bottom: top + size };
  const px = (v: number) => left + ((v + 2.2) / 4.4) * size;
  let body = yAxis(ax, left, size, "Agent pattern (z)", false);
  body += `<line x1="${left}" x2="${left + size}" y1="${ax.bottom}" y2="${ax.bottom}" stroke="#1f2a24"/><text x="${left + size / 2}" y="${ax.bottom + 34}" font-size="12" text-anchor="middle">Human pattern (z)</text>`;
  [-2, -1, 0, 1, 2].forEach((t) => (body += `<text x="${px(t)}" y="${ax.bottom + 16}" font-size="11" text-anchor="middle" fill="#55635a">${t}</text>`));
  body += `<line x1="${px(-2.2)}" y1="${project(ax, -2.2)}" x2="${px(2.2)}" y2="${project(ax, 2.2)}" stroke="#bbb" stroke-dasharray="4 4"/>`;
  fig.series.forEach((s) => {
    const c = colorFor(s.id, order);
    body += s.points.map((p, i) => `<circle cx="${(px(p.human) + jitter(i) * 3).toFixed(1)}" cy="${project(ax, p.agent).toFixed(1)}" r="3.2" ${s.simulated ? `fill="#fff" stroke="${c}"${SIM_DASH.replace("4 3", "2 1.5")}` : `fill="${c}" fill-opacity="0.7"`}/>`).join("");
  });
  body += fig.series
    .map((s, i) => `<rect x="${left + size + 24}" y="${top + 6 + i * 34}" width="10" height="10" ${s.simulated ? `fill="#fff" stroke="${colorFor(s.id, order)}"${SIM_DASH}` : `fill="${colorFor(s.id, order)}"`}/><text x="${left + size + 40}" y="${top + 15 + i * 34}" font-size="12"${s.simulated ? ' font-style="italic"' : ""}>${esc(legendLabel(s.label, 30))}</text><text x="${left + size + 40}" y="${top + 29 + i * 34}" font-size="11" fill="#55635a">r = ${fmt(s.pearson ?? NaN)}, ρ = ${fmt(s.spearman ?? NaN)}, n = ${s.points.length}</text>`)
    .join("");
  const simulated = fig.series.some((s) => s.simulated);
  if (simulated) body += `<text x="${left}" y="${ax.bottom + 52}" font-size="10" fill="#666">${esc(SIMULATED_LEGEND)}</text>`;
  return svg(left + size + 300, ax.bottom + 48 + (simulated ? 14 : 0), body, title);
}

/** Participant trajectories across individual configs + Spearman heatmap (as in the paper). */
export function trajectoryPlot(
  fig: { configs: { id: string; label: string; simulated?: boolean }[]; participants: { id: string; values: (number | null)[] }[]; means: (number | null)[]; spearman: (number | null)[][] },
  title: string,
): string {
  const k = fig.configs.length;
  const left = 64,
    top = 50,
    w = Math.max(260, 110 * k),
    h = 300;
  const ax: Axis = { lo: 0.1, hi: 1, log: false, top, bottom: top + h };
  const x = (i: number) => left + 20 + (k > 1 ? (i * (w - 40)) / (k - 1) : (w - 40) / 2);
  let body = yAxis(ax, left, w, "Participant agreement (%)", true);
  const cy = project(ax, 0.5);
  body += `<line x1="${left}" x2="${left + w}" y1="${cy}" y2="${cy}" stroke="#888" stroke-dasharray="4 4"/>`;
  // A simulated configuration's column gets a dashed guide.
  fig.configs.forEach((c, i) => {
    if (c.simulated) body += `<line x1="${x(i)}" x2="${x(i)}" y1="${ax.top}" y2="${ax.bottom}" stroke="#888"${SIM_DASH}/>`;
  });
  fig.participants.forEach((p) => {
    const delta = p.values[1] != null && p.values[0] != null ? p.values[1]! - p.values[0]! : 0;
    const color = delta > 0.02 ? "#3f9b6b" : delta < -0.02 ? "#c8564b" : "#9aa1a6";
    const pts = p.values.map((v, i) => (v == null ? null : [x(i), project(ax, v)])).filter((q): q is number[] => !!q);
    if (pts.length > 1) body += `<path d="M${pts.map((q) => q.join(",")).join("L")}" fill="none" stroke="${color}" stroke-opacity="0.55"><title>${esc(p.id)}</title></path>`;
    body += pts.map((q) => `<circle cx="${q[0]}" cy="${q[1]}" r="2.4" fill="${color}" fill-opacity="0.7"/>`).join("");
  });
  const mean = fig.means.map((v, i) => (v == null ? null : [x(i), project(ax, v)])).filter((q): q is number[] => !!q);
  if (mean.length) body += `<path d="M${mean.map((q) => q.join(",")).join("L")}" fill="none" stroke="#111" stroke-width="3"/>` + mean.map((q) => `<path d="M${q[0]},${q[1] - 6}L${q[0] + 6},${q[1]}L${q[0]},${q[1] + 6}L${q[0] - 6},${q[1]}Z" fill="#111"/>`).join("");
  fig.configs.forEach((c, i) => (body += `<text x="${x(i)}" y="${ax.bottom + 18}" font-size="11" text-anchor="middle"${c.simulated ? ' font-style="italic"' : ""}>${esc(legendLabel(c.label, 18))}</text>`));
  body += `<text x="${left}" y="${ax.bottom + 40}" font-size="10" fill="#666">Each line is one participant (green: gained from the first to the second config, red: lost). Black: mean.</text>`;
  const simulated = fig.configs.some((c) => c.simulated);
  if (simulated) body += `<text x="${left}" y="${ax.bottom + 54}" font-size="10" fill="#666">${esc(SIMULATED_LEGEND)}</text>`;
  // heatmap
  const hx = left + w + 140,
    cell = Math.min(54, 300 / Math.max(1, k));
  const color = (r: number | null) => {
    if (r == null) return "#eee";
    const t = (r + 1) / 2;
    const lerp = (a: number, b: number) => Math.round(a + (b - a) * Math.abs(t - 0.5) * 2);
    return t >= 0.5 ? `rgb(${lerp(247, 178)},${lerp(247, 24)},${lerp(247, 43)})` : `rgb(${lerp(247, 33)},${lerp(247, 102)},${lerp(247, 172)})`;
  };
  fig.spearman.forEach((row, i) =>
    row.forEach((r, j) => {
      body += `<rect x="${hx + j * cell}" y="${top + i * cell}" width="${cell}" height="${cell}" fill="${color(r)}"/><text x="${hx + j * cell + cell / 2}" y="${top + i * cell + cell / 2 + 4}" font-size="10" text-anchor="middle" fill="${r != null && Math.abs(r) > 0.6 ? "#fff" : "#222"}">${r == null ? "" : r.toFixed(2)}</text>`;
    }),
  );
  fig.configs.forEach((c, i) => {
    body += `<text x="${hx - 6}" y="${top + i * cell + cell / 2 + 4}" font-size="10" text-anchor="end"${c.simulated ? ' font-style="italic"' : ""}>${esc(legendLabel(c.label, 20))}</text>`;
  });
  body += `<text x="${hx}" y="${top - 10}" font-size="11">Spearman ρ between configs</text>`;
  return svg(Math.max(hx + k * cell + 30, hx + 190), ax.bottom + 50 + (simulated ? 14 : 0), body, title);
}

/** Download helpers. */
export function downloadSvg(svgText: string, name: string) {
  const a = document.createElement("a");
  a.href = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
  a.download = name + ".svg";
  a.click();
}
export function downloadPng(svgText: string, name: string, scale = 2) {
  const img = new Image();
  const m = svgText.match(/viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/);
  const w = Number(m?.[1] ?? 800),
    h = Number(m?.[2] ?? 500);
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = name + ".png";
    a.click();
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svgText);
}

/** Human data only: one distribution per design, with test brackets between designs. */
export function humanPlot(
  fig: { outcome: { label: string; unit: string; scale: string }; logScale: boolean; groups: Group[]; brackets: Bracket[]; note: string },
  title: string,
): string {
  const all = fig.groups.flatMap((g) => g.values).filter(Number.isFinite);
  let lo = all.length ? Math.min(...all) : 0,
    hi = all.length ? Math.max(...all) : 1;
  if (fig.outcome.scale === "proportion") (lo = Math.min(lo, 0)), (hi = Math.max(hi, 1));
  if (fig.logScale) (lo = Math.max(lo * 0.85, 1e-6)), (hi *= 1.15);
  else {
    const pad = (hi - lo) * 0.08 || 1;
    lo -= pad;
    hi += pad;
  }
  const n = fig.groups.length;
  const shown = fig.brackets.filter((b) => b.stars).length;
  const left = 70,
    slot = Math.max(80, Math.min(150, 700 / Math.max(1, n))),
    width = left + slot * n + 30;
  const top = 50 + shown * 14 + 18;
  const ax: Axis = { lo, hi, log: fig.logScale, top, bottom: top + 290 };
  let body = yAxis(ax, left, slot * n + 10, `${fig.outcome.label} (${fig.outcome.unit})`, false);
  const xs = new Map<string, number>();
  fig.groups.forEach((g, i) => {
    const cx = left + slot * (i + 0.5) + 5;
    xs.set(g.id, cx);
    const color = PALETTE[i % PALETTE.length];
    body += distribution(g, cx, slot * 0.7, ax, color, false, g.values.length >= 5);
    body += `<text x="${cx}" y="${ax.bottom + 18}" font-size="11" text-anchor="middle" fill="#1f2a24">${esc(g.label.length > 24 ? g.label.slice(0, 23) + "…" : g.label)}</text><text x="${cx}" y="${ax.bottom + 32}" font-size="10" text-anchor="middle" fill="#888">n=${g.stats.n} people</text>`;
  });
  body += bracketLayer(fig.brackets, xs, top - 14);
  body += `<text x="${left}" y="${ax.bottom + 54}" font-size="10" fill="#666">${esc(fig.note.slice(0, 150))}</text><text x="${left}" y="${ax.bottom + 68}" font-size="10" fill="#666">Brackets: * p&lt;.05, ** p&lt;.01, *** p&lt;.001 (Holm). Box: quartiles; diamond: mean; dots: participants.</text>`;
  return svg(Math.max(width, 480), ax.bottom + 80, body, title);
}
