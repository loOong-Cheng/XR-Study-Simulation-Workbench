// Participant-specific knowledge: background per person (demographics) and movement recordings
// (trajectory). It must be complete: every participant has an entry and no allowed field is empty,
// so no agent ever gets "unknown" for one person and real values for another. The same reader
// builds what agents receive, so the Evidence page preview is exactly what they get: only the
// ID column and the declared fields, and only rows of this study's participants.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Study } from "./core/types.js";
import { decodeText, encodingNote, readTextSync, type TextEncoding } from "./files.js";

export const PARTICIPANT_KINDS = ["demographics", "trajectory"] as const;
/** Values that count as missing (after trimming). "none" is a real answer (e.g. no XR experience). */
const MISSING = /^(|na|n\/a|nan|null|\?)$/i;
export const isMissing = (v: string | undefined) => v === undefined || MISSING.test(v.trim());

export type Delimiter = "," | ";" | "\t";
export interface Table {
  head: string[];
  rows: string[][];
  /** The separator the file uses: commas, or semicolons or tabs (as spreadsheet programs often save). */
  delimiter: Delimiter;
  /** Line (1-based) of a quote that is never closed; it swallows the rest of the file. */
  openQuoteLine: number | null;
}

/** The separator of the first non-empty line: semicolons or tabs only when they outnumber commas. */
function sniff(text: string): Delimiter {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const n = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (const c of line) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "," || c === ";" || c === "\t")) n[c]++;
  }
  if (n[";"] > n[","] && n[";"] >= n["\t"]) return ";";
  if (n["\t"] > n[","] && n["\t"] > n[";"]) return "\t";
  return ",";
}

/** A small CSV reader with quoted fields ("a, b" and doubled quotes), BOM and CRLF tolerant; comma, semicolon or tab separated. */
export function parseCsv(text: string, delimiter?: Delimiter): Table {
  const s = text.replace(/^﻿/, "");
  const sep = delimiter ?? sniff(s);
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    line = 1,
    quoteLine = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\n") line++;
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') (quoted = true), (quoteLine = line);
    else if (c === sep) row.push(cell), (cell = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++, line++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      (row = []), (cell = "");
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  const [head = [], ...body] = rows;
  return { head: head.map((h) => h.trim()), rows: body, delimiter: sep, openQuoteLine: quoted ? quoteLine : null };
}
/** A table as comma-separated text (quoted where needed). */
export function toCsv(head: string[], rows: string[][]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [head, ...rows].map((r) => r.map((v) => cell(v ?? "")).join(",")).join("\n") + "\n";
}
export const idColumn = (head: string[]) => head.findIndex((h) => /^(participant|participant_id|id)$/i.test(h));

const list = (ids: string[], max = 6) => (ids.length > max ? `${ids.slice(0, max).join(", ")} and ${ids.length - max} more` : ids.join(", "));
/** "realism" / "realism, presence" with the verb that fits: one column is … / columns are … */
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Column or field names that equal a measure's ID or label (any case): results, never participant knowledge. */
export function outcomeNamed(study: Pick<Study, "outcomes">, names: string[]): string[] {
  const outcome = new Set(study.outcomes.flatMap((o) => [o.id.toLowerCase(), o.label.toLowerCase()]));
  return names.filter((n) => outcome.has(n.trim().toLowerCase()));
}
/** Column names that appear more than once (only the first would count). */
function duplicateNames(head: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(head.filter((h) => (seen.has(h.toLowerCase()) ? true : (seen.add(h.toLowerCase()), false))))];
}
/** Problems of the declared fields themselves: a field named like a measure is refused. */
function fieldProblems(study: Study, fields: string[]): string[] {
  const named = outcomeNamed(study, fields);
  return named.length
    ? [`has the ${plural(named.length, "field", "fields")} ${named.join(", ")}, named like ${plural(named.length, "a measure", "measures")}; results are never participant knowledge`]
    : [];
}
/** Problems of a table's shape: an unclosed quote, duplicate column names, no ID column. */
function shapeProblems(table: Table, needsId = true): string[] {
  const problems: string[] = [];
  if (table.openQuoteLine !== null) problems.push(`has a quote (") opened on line ${table.openQuoteLine} that is never closed, so the rest of the file reads as one value`);
  const doubled = duplicateNames(table.head);
  if (doubled.length) problems.push(`has the ${plural(doubled.length, "column", "columns")} ${doubled.join(", ")} more than once; give each column its own name`);
  if (needsId && idColumn(table.head) < 0) problems.push("has no ID column (participant, participant_id or id)");
  return problems;
}

/** A person's files in a folder of per-participant recordings ("p03.csv", "p03_low.csv"), sorted. */
const filesOf = (files: string[], p: string) => files.filter((f) => f === p || f.startsWith(`${p}.`) || f.startsWith(`${p}_`)).sort();
const isTable = (f: string) => /\.(csv|tsv)$/i.test(f);

/**
 * Problems that make participant-specific knowledge unusable, each phrased to follow the source's
 * name ("Background has no entry for p03"): a participant without an entry, a duplicate entry,
 * a declared field that is not a column or is named like a measure, or an empty value.
 * Empty list = complete.
 */
export function participantProblems(study: Study, kind: string, path: string, fields: string[]): string[] {
  if (!existsSync(path)) return [`does not exist (${path})`];
  const people = study.participants.map((p) => p.id);
  if (kind === "trajectory" && statSync(path).isDirectory()) {
    const files = readdirSync(path).filter((f) => !f.startsWith(".") && statSync(join(path, f)).isFile());
    const problems = fieldProblems(study, fields);
    const without: string[] = [],
      empty: string[] = [],
      notTables: string[] = [],
      absent = new Set<string>(),
      blanks: string[] = [];
    for (const p of people) {
      const mine = filesOf(files, p);
      if (!mine.length) without.push(p);
      for (const f of mine) {
        if (!isTable(f)) {
          notTables.push(f);
          continue;
        }
        const table = parseCsv(readTextSync(join(path, f)));
        // A 0-byte or header-only file is no recording.
        if (!table.rows.length) empty.push(f);
        problems.push(...shapeProblems(table, false).map((x) => `${f} ${x}`));
        fields.filter((x) => !table.head.includes(x)).forEach((x) => absent.add(`${x} (${f})`));
        for (const x of fields.filter((y) => table.head.includes(y)))
          if (table.rows.some((r) => isMissing(r[table.head.indexOf(x)]))) blanks.push(`${x} in ${f}`);
      }
    }
    if (without.length) problems.push(`has no recording for ${list(without)}`);
    if (empty.length) problems.push(`has ${plural(empty.length, "an empty recording", "empty recordings")} (no rows below the header): ${list(empty)}`);
    if (notTables.length) problems.push(`has ${plural(notTables.length, "a file", "files")} that ${plural(notTables.length, "is", "are")} not a CSV table, so ${plural(notTables.length, "its", "their")} fields cannot be limited: ${list(notTables)}`);
    if (absent.size) problems.push(`has no column for ${list([...absent])}`);
    if (blanks.length) problems.push(`has empty values for ${list(blanks)}`);
    return problems;
  }
  return participantProblemsText(study, kind, readTextSync(path), fields);
}
/** The same check on the text of a table that is not written yet. */
export function participantProblemsText(study: Study, kind: string, text: string, fields: string[]): string[] {
  const people = study.participants.map((p) => p.id);
  const table = parseCsv(text);
  const { head, rows } = table;
  const problems = [...fieldProblems(study, fields), ...shapeProblems(table)];
  const idCol = idColumn(head);
  if (idCol < 0) return problems;
  const absentFields = fields.filter((f) => !head.includes(f));
  if (absentFields.length) problems.push(`has no column for ${absentFields.join(", ")}`);
  const byPerson = rowsByPerson(rows, idCol);
  const without = people.filter((p) => !byPerson.has(p));
  if (without.length) problems.push(`has no entry for ${list(without)}`);
  if (kind === "demographics") {
    const doubled = people.filter((p) => (byPerson.get(p)?.length ?? 0) > 1);
    if (doubled.length) problems.push(`has more than one row for ${list(doubled)}`);
  }
  for (const f of fields.filter((x) => head.includes(x))) {
    const col = head.indexOf(f);
    const empty = people.filter((p) => (byPerson.get(p) ?? []).some((r) => isMissing(r[col])));
    if (empty.length) problems.push(`has an empty ${f} for ${list(empty)}`);
  }
  return problems;
}
function rowsByPerson(rows: string[][], idCol: number) {
  const byPerson = new Map<string, string[][]>();
  for (const r of rows) {
    const id = r[idCol]?.trim() ?? "";
    byPerson.set(id, [...(byPerson.get(id) ?? []), r]);
  }
  return byPerson;
}

/** IDs with rows in the table that are not participants of this study (their rows are never used). */
export function strangers(study: Pick<Study, "participants">, text: string): string[] {
  const { head, rows } = parseCsv(text);
  const idCol = idColumn(head);
  if (idCol < 0) return [];
  const people = new Set(study.participants.map((p) => p.id));
  return [...new Set(rows.map((r) => r[idCol]?.trim() ?? "").filter((id) => id && !people.has(id)))];
}
/** The note shown with a table that has rows for people not in this study. */
export const strangerNote = (ids: string[]) => (ids.length ? `Rows for people not in this study are ignored: ${list(ids)}.` : "");

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

/** A category as shown in a summary: quoted when it contains a separator, so "contacts, both eyes" stays one value. */
const category = (v: string) => (/[,;"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
/**
 * Background as agents receive it: a person's allowed fields (individual configurations), or a
 * summary of the cohort (population configurations): mean for numbers, counts for categories
 * (case-insensitive, shown in the first spelling). With `people`, only their rows count.
 */
export function backgroundText(text: string, fields: string[], participantId?: string, people?: string[]): string {
  const { head, rows: all } = parseCsv(text);
  const idCol = idColumn(head);
  const col = (name: string) => head.indexOf(name);
  if (participantId) {
    const row = all.find((r) => r[idCol]?.trim() === participantId);
    return row ? fields.map((f) => `${f}: ${row[col(f)]?.trim()}`).join("\n") : "(no background recorded for this participant)";
  }
  const cohort = people ? new Set(people) : null;
  const rows = cohort ? all.filter((r) => cohort.has(r[idCol]?.trim() ?? "")) : all;
  return fields
    .map((f) => {
      const values = rows.map((r) => r[col(f)]?.trim()).filter((v): v is string => v !== undefined && !isMissing(v));
      const nums = values.map(Number);
      if (values.length && nums.every(Number.isFinite)) return `${f}: mean ${(nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(2)}, range ${Math.min(...nums)}–${Math.max(...nums)} (n=${nums.length})`;
      const counts = new Map<string, { shown: string; n: number }>();
      values.forEach((v) => {
        const k = v.toLowerCase();
        counts.set(k, { shown: counts.get(k)?.shown ?? v, n: (counts.get(k)?.n ?? 0) + 1 });
      });
      return `${f}: ${[...counts.values()].map((c) => `${category(c.shown)} ${c.n}`).join(", ")} (n=${values.length})`;
    })
    .join("\n");
}

/** Only the ID column (when there is one) and the declared fields, as comma-separated text. */
function onlyFields(table: Table, fields: string[], keep: (row: string[]) => boolean): { text: string; rows: number } {
  const idCol = idColumn(table.head);
  const cols = [...(idCol >= 0 ? [idCol] : []), ...fields.map((f) => table.head.indexOf(f)).filter((i) => i >= 0 && i !== idCol)];
  const rows = table.rows.filter(keep).map((r) => cols.map((i) => (r[i] ?? "").trim()));
  return { text: toCsv(cols.map((i) => table.head[i]), rows).trimEnd(), rows: rows.length };
}
/**
 * A participant's movement rows as agents receive them: only the ID column and the declared
 * fields, from a CSV with a participant column, or from every file of a folder of per-participant
 * recordings (sorted, each under its file name).
 */
export function trajectoryText(path: string, participantId: string, fields: string[]): string {
  const none = "(no movement recorded for this participant)";
  if (statSync(path).isDirectory()) {
    const mine = filesOf(readdirSync(path), participantId).filter((f) => isTable(f) && statSync(join(path, f)).isFile());
    const parts = mine.flatMap((f) => {
      const part = onlyFields(parseCsv(readTextSync(join(path, f))), fields, () => true);
      return part.rows ? [`## ${f}\n${part.text}`] : [];
    });
    return parts.length ? parts.join("\n\n") : none;
  }
  const table = parseCsv(readTextSync(path));
  const idCol = idColumn(table.head);
  const part = onlyFields(table, fields, (r) => r[idCol]?.trim() === participantId);
  return idCol >= 0 && part.rows ? part.text : none;
}

/**
 * How the tables of a participant source were read, for the knowledge overview: "" when every one
 * is UTF-8, else which were read as Windows-1252 or UTF-16 (see decodeText). Tables are read the
 * same way everywhere, so agents get what the overview shows.
 */
export function tableEncodingNotes(path: string): string {
  if (!existsSync(path)) return "";
  if (!statSync(path).isDirectory()) return encodingNote(basename(path), decodeText(readFileSync(path)).encoding);
  const byEncoding = new Map<string, string[]>();
  for (const f of readdirSync(path).filter((f) => isTable(f) && !f.startsWith(".")).sort()) {
    if (!statSync(join(path, f)).isFile()) continue;
    const { encoding } = decodeText(readFileSync(join(path, f)));
    if (encoding !== "utf-8") byEncoding.set(encoding, [...(byEncoding.get(encoding) ?? []), f]);
  }
  return [...byEncoding].map(([encoding, files]) => encodingNote(list(files), encoding as TextEncoding)).join(" ");
}
