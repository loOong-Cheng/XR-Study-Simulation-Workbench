// Participant-specific knowledge: background per person (demographics) and movement recordings
// (trajectory). It must be complete: every participant has an entry and no allowed field is empty,
// so no agent ever gets "unknown" for one person and real values for another. The same reader
// builds what agents receive, so the Evidence page preview is exactly what they get.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Study } from "./core/types.js";

export const PARTICIPANT_KINDS = ["demographics", "trajectory"] as const;
/** Values that count as missing (after trimming). "none" is a real answer (e.g. no XR experience). */
const MISSING = /^(|na|n\/a|nan|null|\?)$/i;
export const isMissing = (v: string | undefined) => v === undefined || MISSING.test(v.trim());

/** A small CSV reader with quoted fields ("a, b" and doubled quotes), BOM and CRLF tolerant. */
export function parseCsv(text: string): { head: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      (row = []), (cell = "");
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  const [head = [], ...body] = rows;
  return { head: head.map((h) => h.trim()), rows: body };
}
export const idColumn = (head: string[]) => head.findIndex((h) => /^(participant|participant_id|id)$/i.test(h));

const list = (ids: string[], max = 6) => (ids.length > max ? `${ids.slice(0, max).join(", ")} and ${ids.length - max} more` : ids.join(", "));

/**
 * Problems that make participant-specific knowledge unusable: a participant without an entry,
 * a duplicate entry, a declared field that is not a column, or an empty value. Empty list = complete.
 */
export function participantProblems(study: Study, kind: string, path: string, fields: string[]): string[] {
  if (!existsSync(path)) return [`${path} does not exist.`];
  const people = study.participants.map((p) => p.id);
  if (kind === "trajectory" && statSync(path).isDirectory()) {
    const files = readdirSync(path);
    const without = people.filter((p) => !files.some((f) => f === p || f.startsWith(`${p}.`) || f.startsWith(`${p}_`)));
    return without.length ? [`no recording for ${list(without)}`] : [];
  }
  return participantProblemsText(study, kind, readFileSync(path, "utf8"), fields);
}
/** The same check on the text of a table that is not written yet. */
export function participantProblemsText(study: Study, kind: string, text: string, fields: string[]): string[] {
  const people = study.participants.map((p) => p.id);
  const { head, rows } = parseCsv(text);
  const idCol = idColumn(head);
  if (idCol < 0) return ["the ID column (participant, participant_id or id) is missing"];
  const problems: string[] = [];
  const absentFields = fields.filter((f) => !head.includes(f));
  if (absentFields.length) problems.push(`no column for ${absentFields.join(", ")}`);
  const byPerson = new Map<string, string[][]>();
  for (const r of rows) byPerson.set(r[idCol]?.trim() ?? "", [...(byPerson.get(r[idCol]?.trim() ?? "") ?? []), r]);
  const without = people.filter((p) => !byPerson.has(p));
  if (without.length) problems.push(`no entry for ${list(without)}`);
  if (kind === "demographics") {
    const doubled = people.filter((p) => (byPerson.get(p)?.length ?? 0) > 1);
    if (doubled.length) problems.push(`more than one row for ${list(doubled)}`);
  }
  for (const f of fields.filter((x) => head.includes(x))) {
    const col = head.indexOf(f);
    const empty = people.filter((p) => (byPerson.get(p) ?? []).some((r) => isMissing(r[col])));
    if (empty.length) problems.push(`empty ${f} for ${list(empty)}`);
  }
  return problems;
}

/** Per column of an uploaded table: which participants have no value (to choose complete fields only). */
export function columnGaps(study: Study, text: string) {
  const { head, rows } = parseCsv(text);
  const idCol = idColumn(head);
  const people = study.participants.map((p) => p.id);
  return head
    .filter((_, i) => i !== idCol)
    .map((name) => {
      const col = head.indexOf(name);
      const missing = people.filter((p) => {
        const r = rows.find((x) => x[idCol]?.trim() === p);
        return !r || isMissing(r[col]);
      });
      return { name, missing };
    });
}

/**
 * Background as agents receive it: a person's allowed fields (individual configurations), or a
 * summary of the cohort (population configurations): mean for numbers, counts for categories.
 */
export function backgroundText(text: string, fields: string[], participantId?: string): string {
  const { head, rows } = parseCsv(text);
  const idCol = idColumn(head);
  const col = (name: string) => head.indexOf(name);
  if (participantId) {
    const row = rows.find((r) => r[idCol]?.trim() === participantId);
    return row ? fields.map((f) => `${f}: ${row[col(f)]?.trim()}`).join("\n") : "(no background recorded for this participant)";
  }
  return fields
    .map((f) => {
      const values = rows.map((r) => r[col(f)]?.trim()).filter((v): v is string => v !== undefined && !isMissing(v));
      const nums = values.map(Number);
      if (values.length && nums.every(Number.isFinite)) return `${f}: mean ${(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(2)}, range ${Math.min(...nums)}–${Math.max(...nums)} (n=${nums.length})`;
      const counts = new Map<string, number>();
      values.forEach((v) => counts.set(v, (counts.get(v) ?? 0) + 1));
      return `${f}: ${[...counts].map(([k, v]) => `${k} ${v}`).join(", ")} (n=${values.length})`;
    })
    .join("\n");
}
/** A participant's movement rows (with the header), from a CSV or a folder of per-participant files. */
export function trajectoryText(path: string, participantId: string): string {
  if (statSync(path).isDirectory()) {
    const file = readdirSync(path)
      .sort()
      .find((f) => f === participantId || f.startsWith(`${participantId}.`) || f.startsWith(`${participantId}_`));
    return file ? readFileSync(join(path, file), "utf8") : "(no movement recorded for this participant)";
  }
  const text = readFileSync(path, "utf8").replace(/^﻿/, "");
  const [head, ...rows] = text.trim().split(/\r?\n/);
  const idCol = idColumn(parseCsv(head).head);
  const mine = rows.filter((r) => parseCsv(head + "\n" + r).rows[0]?.[idCol]?.trim() === participantId);
  return mine.length ? [head, ...mine].join("\n") : "(no movement recorded for this participant)";
}
