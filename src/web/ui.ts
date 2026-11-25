// Page logic of the workbench website that needs no DOM, so it can be tested in Node:
// stable focus keys (focus survives a redraw), a small safe Markdown subset, colour
// contrast, and number formats.

/** The part of an element the focus key reads (an HTMLElement in the page, a stub in tests). */
export interface Keyed {
  tagName: string;
  getAttribute(name: string): string | null;
}
/**
 * Attributes that name a control the same way after every redraw. The visible label is not one of
 * them: it changes ("Save study" becomes "Saved") while the control stays the same.
 */
const KEY_ATTRS = [
  "id",
  "data-key",
  "data-page",
  "data-action",
  "data-cfg",
  "data-field",
  "data-edit",
  "data-id",
  "data-src",
  "data-app",
  "data-target",
  "data-input",
  "data-pick",
  "data-pick-job",
  "data-pick-config",
  "data-cont",
  "data-campaign-label",
  "data-kfield",
  "data-kdfield",
  "data-view",
  "data-job",
  "name",
] as const;
/**
 * A key for a focusable element that a redraw keeps: its tag and naming attributes (and the value
 * of a radio button, which shares its name with the others). Null when nothing names it.
 */
export function focusKey(el: Keyed): string | null {
  const parts: string[] = [];
  for (const a of KEY_ATTRS) {
    const v = el.getAttribute(a);
    if (v !== null) parts.push(`${a}=${v}`);
  }
  const tag = el.tagName.toUpperCase();
  if (tag === "INPUT" && el.getAttribute("type") === "radio") parts.push(`value=${el.getAttribute("value") ?? ""}`);
  if (tag === "A" && el.getAttribute("href") !== null) parts.push(`href=${el.getAttribute("href")}`);
  return parts.length ? `${tag}|${parts.join("|")}` : null;
}
/** Where the focus was: its key, and which of several elements with that key it was. */
export interface FocusMark {
  key: string;
  index: number;
}
/** The mark of `active` among the elements of the page before a redraw (null if it has no key). */
export function focusMark(active: Keyed, before: ArrayLike<Keyed>): FocusMark | null {
  const key = focusKey(active);
  if (!key) return null;
  const same = Array.from(before).filter((x) => focusKey(x) === key);
  return { key, index: Math.max(0, same.indexOf(active)) };
}
/** The element to focus after a redraw: the same key and position, else the first with that key. */
export function focusTarget<T extends Keyed>(mark: FocusMark, after: ArrayLike<T>): T | null {
  const same = Array.from(after).filter((x) => focusKey(x) === mark.key);
  return same[mark.index] ?? same[0] ?? null;
}

const escapeHtml = (x: string) => x.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Inline Markdown on text that is already escaped: `code`, **bold**, *emphasis* and _emphasis_. */
function inline(escaped: string): string {
  const codes: string[] = [];
  // Code spans first, so that asterisks inside them stay as written.
  let s = escaped.replace(/`([^`\n]+)`/g, (_, c: string) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s.replace(/\*\*(?=\S)([^*\n]*?\S)\*\*|__(?=\S)([^_\n]*?\S)__/g, (_, a?: string, b?: string) => `<strong>${a ?? b}</strong>`);
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*\n]*?\S)\*(?![*\w])/g, (_, pre: string, t: string) => `${pre}<em>${t}</em>`);
  s = s.replace(/(^|[^_\w])_(?=\S)([^_\n]*?\S)_(?![_\w])/g, (_, pre: string, t: string) => `${pre}<em>${t}</em>`);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}
/**
 * A small, safe subset of Markdown as HTML: paragraphs, line breaks, bulleted and numbered lists,
 * headings (shown as bold lines), bold, emphasis and code. Every character of the text is escaped
 * first; the only tags in the output are the ones made here, and links stay plain text.
 */
export function markdownToHtml(text: string): string {
  const lines = String(text ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map((l) => inline(escapeHtml(l))).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(escapeHtml(i))}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line);
    const head = /^\s{0,3}#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (head) {
      flushPara();
      flushList();
      out.push(`<p><strong>${inline(escapeHtml(head[1]))}</strong></p>`);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      // An indented line continues the last list item.
      list.items[list.items.length - 1] += " " + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join("");
}

/** WCAG relative luminance of #rgb or #rrggbb. */
export function luminance(hex: string): number {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) throw new Error(`Not a colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** WCAG contrast ratio of two colours (1 to 21). AA: 4.5 for small text, 3 for large text, controls and focus rings. */
export function contrastRatio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** Dollars for people: two decimals, and small amounts with four so they never read "$0.00". */
export function money(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  if (x === 0) return "$0.00";
  const a = Math.abs(x);
  if (a < 0.0001) return x < 0 ? "−<$0.0001" : "<$0.0001";
  return `${x < 0 ? "−" : ""}$${a < 0.01 ? a.toFixed(4) : a.toFixed(2)}`;
}
/** "1 session", "2 sessions". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/**
 * Whether a 95% interval was clipped to the bounds of its scale, as the analyzer clips them
 * (scaleBounds: proportions 0–1, mean ranks 1–k, counts from 0, narrowed by a declared range):
 * a bound reached by an interval that is not a single value.
 */
export function clippedToScale(scale: string | undefined, designs: number, low: number, high: number, degenerate = false, range?: [number, number] | null): boolean {
  const fixed = scale === "proportion" ? [0, 1] : scale === "rank" ? [1, designs] : scale === "count" ? [0, Infinity] : null;
  const bounds = range ? (fixed ? [Math.max(fixed[0], range[0]), Math.min(fixed[1], range[1])] : range) : fixed;
  if (!bounds || degenerate || !(high > low)) return false;
  const eps = 1e-9;
  return low <= bounds[0] + eps || high >= bounds[1] - eps;
}
