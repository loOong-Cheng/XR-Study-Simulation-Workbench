// How a forecast is written in submit_forecast, in the same words for the job's target list, the
// tool's description and its rejection message, so the first submission can be right.

/** A measure as the forecasting session sees it (job.json → targets). */
export interface ForecastTarget {
  id: string;
  label?: string;
  unit: string;
  scale: string;
  aggregation: string;
  /** The measure's declared range (study.json), which every value or composite must lie in. */
  range?: [number, number];
  components?: string[];
  /** How the items make the measure: their mean (default) or sum, each times its weight. */
  componentRule?: "mean" | "sum";
  componentWeights?: Record<string, number>;
}

/** "1–7" for a unit such as "1-7 item mean" or "0-10", else null. */
function unitRange(unit: string): string | null {
  const m = /(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)/.exec(unit ?? "");
  return m ? `${m[1]}–${m[2]}` : null;
}
/** The declared range as text, else the range the unit names. */
const rangeText = (t: ForecastTarget) => (t.range ? `${t.range[0]}–${t.range[1]}` : unitRange(t.unit));
/** A composite's value from its items: the declared mean (default) or sum, each item times its weight. */
function composite(t: ForecastTarget, items: Record<string, number>): number {
  const w = (c: string) => t.componentWeights?.[c] ?? 1;
  const total = t.components!.reduce((s, c) => s + w(c) * items[c], 0);
  return t.componentRule === "sum" ? total : total / t.components!.reduce((s, c) => s + w(c), 0);
}
/** Inside the declared range, with a hair of slack for composites computed in floating point. */
function inRange(t: ForecastTarget, v: number): boolean {
  if (!t.range) return true;
  const slack = 1e-9 * Math.max(1, Math.abs(t.range[0]), Math.abs(t.range[1]));
  return v >= t.range[0] - slack && v <= t.range[1] + slack;
}

/** What one row of a measure needs, e.g. `"items" general, spatial, involvement, realness, each on 1–7 (no "value")`. */
export function answerNeeds(t: ForecastTarget, designs: number): string {
  const range = rangeText(t);
  if (t.components?.length) {
    const shape = `(an object {${t.components.map((c) => `"${c}": number`).join(", ")}}, no "value")`;
    // A sum (e.g. an SSQ total) has no per-item range; its total must lie in the measure's range.
    if (t.componentRule === "sum")
      return `"items" ${t.components.join(", ")} ${shape}; the ${t.componentWeights ? "weighted " : ""}sum of the items is the score${range ? `, on ${range}` : ""} (${t.unit})`;
    return `"items" ${t.components.join(", ")}, each ${range ? `on ${range}` : `in ${t.unit}`} ${shape}`;
  }
  if (t.scale === "proportion") return `"value", a proportion from 0 to 1 (${t.unit})`;
  if (t.scale === "rank") return `"value", a rank from 1 to ${designs} (${t.unit})`;
  if (t.scale === "count") return `"value", a count of 0 or more${range ? ` on ${range}` : ""} (an expected count may have decimals; ${t.unit})`;
  if (range) return `"value" on ${range} (${t.unit})`;
  return `"value", a ${t.aggregation === "geometric" ? "positive " : ""}number (${t.unit})`;
}

/** One line per measure: "presence: give "items" general, spatial, … each on 1–7 (no "value")". */
export function answerLines(targets: ForecastTarget[], designs: number): string[] {
  return targets.map((t) => `${t.id}: give ${answerNeeds(t, designs)}`);
}

/** The description of submit_forecast for one job: the row shape, the design IDs and what each measure needs. */
export function submitDescription(designIds: string[], targets: ForecastTarget[]): string {
  return [
    `Submit your final forecast in one call: "predictions" holds one row per design × outcome (${designIds.length} × ${targets.length} = ${designIds.length * targets.length} rows), each {"design": <design ID>, "outcome": <outcome ID>, ...}.`,
    `Design IDs: ${designIds.join(", ")}.`,
    "Per outcome:",
    ...answerLines(targets, designIds.length).map((l) => `- ${l}`),
    "Call once, at the end.",
  ].join("\n");
}

/**
 * Everything wrong with a submission at once, grouped by measure: rows that are not understood,
 * then for every measure the designs without a row, without a number or with missing items.
 * Returns the measurements when there is nothing to fix.
 */
export function checkForecast(
  rows: Record<string, unknown>[],
  designIds: string[],
  targets: ForecastTarget[],
  participantId: string | null,
): { problems: string[]; measurements: Record<string, unknown>[] } {
  const problems: string[] = [];
  const designs = new Set(designIds);
  const byKey = new Map<string, Record<string, unknown>>();
  const duplicates: string[] = [];
  const notUnderstood: string[] = [];
  rows.forEach((r, i) => {
    const row = r && typeof r === "object" ? r : {};
    const t = targets.find((x) => x.id === row.outcome);
    const designOk = designs.has(String(row.design));
    if (!t || !designOk) {
      const items = row.items && typeof row.items === "object" ? Object.keys(row.items as object) : [];
      // A common slip: one row per measure with the designs inside "items".
      if (t && row.design === undefined && items.length && items.every((k) => designs.has(k)))
        notUnderstood.push(`row ${i + 1} (${t.id}) puts the designs inside "items": give one row per design instead, e.g. {"design": "${designIds[0]}", "outcome": "${t.id}", ${t.components?.length ? `"items": {${t.components.map((c) => `"${c}": …`).join(", ")}}` : `"value": …`}}`);
      else
        notUnderstood.push(
          `row ${i + 1}: ${[!designOk ? (row.design === undefined ? "no design" : `unknown design "${String(row.design)}"`) : "", !t ? (row.outcome === undefined ? "no outcome" : `unknown outcome "${String(row.outcome)}"`) : ""].filter(Boolean).join(", ")}`,
        );
      return;
    }
    const key = `${row.design}|${t.id}`;
    if (byKey.has(key)) duplicates.push(key);
    else byKey.set(key, row);
  });
  if (notUnderstood.length)
    problems.push(
      `Rows not understood (each row needs "design": one of ${designIds.join(", ")}, and "outcome": one of ${targets.map((t) => t.id).join(", ")}): ${notUnderstood.slice(0, 10).join("; ")}${notUnderstood.length > 10 ? `; and ${notUnderstood.length - 10} more` : ""}.`,
    );
  if (duplicates.length) problems.push(`Duplicate rows (give each design × outcome once): ${[...new Set(duplicates)].join(", ")}.`);
  const measurements: Record<string, unknown>[] = [];
  for (const t of targets) {
    const noRow: string[] = [];
    const notNumber: string[] = [];
    const outOfRange: string[] = [];
    const lacking: string[] = [];
    for (const d of designIds) {
      const row = byKey.get(`${d}|${t.id}`);
      if (!row) {
        noRow.push(d);
        continue;
      }
      if (t.components?.length) {
        const items = (row.items && typeof row.items === "object" ? row.items : {}) as Record<string, unknown>;
        const missing = t.components.filter((c) => typeof items[c] !== "number" || !Number.isFinite(items[c]));
        if (missing.length) lacking.push(`${d} (${missing.length === t.components.length ? "no items" : `missing ${missing.join(", ")}`})`);
        // The composite of the items must lie in the declared range (e.g. an SSQ total on 0–235.62).
        else if (!inRange(t, composite(t, items as Record<string, number>))) outOfRange.push(`${d} (the items give ${Number(composite(t, items as Record<string, number>).toPrecision(6))})`);
        else measurements.push({ conditionId: d, outcomeId: t.id, ...(participantId ? { participantId } : {}), components: Object.fromEntries(t.components.map((c) => [c, Number(items[c])])) });
        continue;
      }
      const value = row.value === null || row.value === "" || row.value === undefined ? NaN : Number(row.value);
      if (!Number.isFinite(value)) notNumber.push(d);
      else if (t.scale === "proportion" && (value < 0 || value > 1)) outOfRange.push(d);
      else if (t.scale === "rank" && (value < 1 || value > designIds.length)) outOfRange.push(d);
      else if (t.aggregation === "geometric" && value <= 0) outOfRange.push(d);
      else if (t.scale === "count" && value < 0) outOfRange.push(d);
      else if (!inRange(t, value)) outOfRange.push(d);
      else measurements.push({ conditionId: d, outcomeId: t.id, ...(participantId ? { participantId } : {}), value });
    }
    const parts = [
      noRow.length ? `no row for ${noRow.join(", ")}` : "",
      lacking.length ? `items missing for ${lacking.join("; ")}` : "",
      notNumber.length ? `no numeric "value" for ${notNumber.join(", ")}` : "",
      outOfRange.length ? `out of range for ${outOfRange.join(", ")}` : "",
    ].filter(Boolean);
    if (parts.length) problems.push(`${t.id} needs ${answerNeeds(t, designIds.length)} for every design: ${parts.join("; ")}.`);
  }
  return { problems, measurements };
}
