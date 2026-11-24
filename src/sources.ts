// Study sources for the researcher: read what agents get, manage evidence documents, add participant
// information, and check evidence for outcome leaks. Human results are never returned from here;
// the leak check only reports how many numbers match.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Study } from "./core/types.js";
import { measurementValue, requireThat } from "./core/validation.js";
// The study and its sources only: knowledge stays readable while saved configurations disagree with the study.
import { readHuman, readStudyFolder as readWorkspace, sourceLocation, studyWriteTarget, type WorkspaceManifest } from "./workspace.js";
import { backgroundText, columnGaps, idColumn, measureNamedFieldProblem, outcomeNamed, parseCsv, participantProblems, participantProblemsText, PARTICIPANT_KINDS, plural, strangerNote, strangers, tableEncodingNotes, toCsv } from "./participant-knowledge.js";
import { agentFileList } from "./runtimes/guard.js";
import { decodeText, encodingNote, windowsUnusableName } from "./files.js";
import { draftKnowledge } from "./assistant.js";
import { extractProposal } from "./core/proposal.js";
import type { AgentProtocol } from "./core/types.js";
import { checkNewConfigurations, validateAgents, validateStudy } from "./core/validation.js";

const READABLE = ["brief", "project", "evidence"];
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

/** Where a source lives, only if it is a readable kind, mapped, and allowed by sourceLocation (the agents' rule). */
async function sourcePath(id: string, sourceId: string) {
  const ws = await readWorkspace(id);
  const src = ws.study.sources.find((s) => s.id === sourceId);
  requireThat(src && READABLE.includes(src.kind), "Only the brief, project and evidence sources can be shown here.");
  const where = sourceLocation(ws.dir, src!.kind, ws.manifest.sources?.[sourceId]);
  requireThat(where.path, `Source '${sourceId}' ${where.problem}.`);
  return { ws, src: src!, path: where.path!, rel: ws.manifest.sources![sourceId] };
}
/** The source as plain text: a file's content (up to 2 MB) or a folder's file list (as agents see it). */
export async function sourceText(id: string, sourceId: string): Promise<string> {
  const { src, path, rel } = await sourcePath(id, sourceId);
  if ((await stat(path)).isDirectory()) return `${src.label} (${rel}): folder with these files\n\n${(await agentFileList(path)).join("\n")}\n`;
  const buf = await readFile(path);
  requireThat(buf.length <= 2_000_000, "This file is too large to show here.");
  return buf.toString("utf8");
}

/** Numbers in a text with at least two decimals (e.g. 3.42), as written. */
const decimals = (text: string) => new Set(text.match(/-?\d+\.\d{2,}/g) ?? []);
/**
 * Outcome-blind check for an evidence text: participant IDs it names, and how many of its numbers
 * equal a human design mean (rounded to 2 decimals). Only counts are returned.
 */
export async function leakCheck(id: string, study: Study, text: string) {
  const ids = study.participants.map((p) => p.id).filter((p) => new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text));
  const human = await readHuman(id);
  let matches = 0;
  if (human) {
    const groups = new Map<string, number[]>();
    for (const m of human.measurements) {
      try {
        const v = measurementValue(study, m);
        const k = `${m.outcomeId}|${m.conditionId}`;
        groups.set(k, [...(groups.get(k) ?? []), v]);
      } catch {
        // malformed reference rows are reported elsewhere
      }
    }
    const means = new Set([...groups.values()].map((v) => (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2)));
    for (const n of decimals(text)) if (means.has(Number(n).toFixed(2))) matches++;
  }
  return { participantIds: ids.length, humanMeanMatches: matches, checkedAgainstHuman: !!human };
}

/** Evidence sources of a study with preview, origin, hash, who gets them, and the outcome-blind check. */
export async function evidenceOverview(id: string, agents: { id: string; label: string; sourceIds: string[] }[]) {
  const ws = await readWorkspace(id);
  const out = [];
  for (const src of ws.study.sources.filter((s) => s.kind === "evidence")) {
    const rel = ws.manifest.sources?.[src.id] ?? null;
    // The same rule as for agents: only a file inside the study folder is previewed.
    const where = rel ? sourceLocation(ws.dir, src.kind, rel) : null;
    const path = where?.path ?? null;
    const file = path && !(await stat(path)).isDirectory() ? await readFile(path) : null;
    const text = file?.toString("utf8") ?? "";
    out.push({
      id: src.id,
      label: src.label,
      description: src.description,
      path: rel,
      problem: where?.problem ?? null,
      exists: !!file,
      bytes: file?.length ?? 0,
      sha256: file ? sha(file) : null,
      preview: text.slice(0, 6000),
      truncated: text.length > 6000,
      configs: agents.filter((a) => a.sourceIds.includes(src.id)).map((a) => a.id),
      check: file ? await leakCheck(id, ws.study, text) : null,
    });
  }
  return out;
}

async function saveManifest(dir: string, manifest: WorkspaceManifest) {
  await writeFile(join(dir, "workspace.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Participant-specific knowledge of a study (background and movement recordings): file, fields,
 * completeness, and what agents get. Background is shown as population and individual
 * configurations receive it; movement recordings show only their completeness and columns,
 * since they were measured during the study.
 */
export async function participantKnowledgeOverview(id: string, agents: { id: string; sourceIds: string[] }[]) {
  const ws = await readWorkspace(id);
  const out = [];
  for (const src of ws.study.sources.filter((s) => (PARTICIPANT_KINDS as readonly string[]).includes(s.kind))) {
    const rel = ws.manifest.sources?.[src.id] ?? null;
    const path = rel ? (sourceLocation(ws.dir, src.kind, rel).path ?? null) : null;
    const exists = !!path && existsSync(path);
    const problems = exists ? participantProblems(ws.study, src.kind, path!, src.fields ?? []) : [];
    const isFile = exists && !(await stat(path!)).isDirectory();
    // Read as agents get it: also a table Excel saved as Windows-1252 or UTF-16 (the notes say so).
    const bytes = isFile ? await readFile(path!) : null;
    const text = bytes ? decodeText(bytes).text : "";
    const example = ws.study.participants[0]?.id ?? null;
    const people = ws.study.participants.map((p) => p.id);
    out.push({
      id: src.id,
      label: src.label,
      kind: src.kind,
      description: src.description,
      fields: src.fields ?? [],
      path: rel,
      exists,
      sha256: bytes ? sha(bytes) : null,
      participants: ws.study.participants.length,
      problems,
      columns: src.kind === "demographics" && isFile ? participantColumns(ws.study, text).columns : [],
      population: src.kind === "demographics" && isFile && !problems.length ? backgroundText(text, src.fields ?? [], undefined, people) : null,
      individual: src.kind === "demographics" && isFile && !problems.length && example ? { participantId: example, text: backgroundText(text, src.fields ?? [], example) } : null,
      // Rows of people outside the study are never delivered or counted; say which.
      notes: [exists ? tableEncodingNotes(path!) : "", isFile ? strangerNote(strangers(ws.study, text)) : ""].filter(Boolean).join(" "),
      configs: agents.filter((a) => a.sourceIds.includes(src.id)).map((a) => a.id),
    });
  }
  return out;
}

/**
 * A short ID from a name, cut at a word boundary (at most 40 characters). It names files too
 * (data/<id>.csv), so a name Windows keeps for devices (con, aux, nul, com1 …) gets a suffix.
 */
const slug = (text: string) => {
  const full = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const id = full.length <= 40 ? full || "knowledge" : full.slice(0, 41).replace(/-[^-]*$/, "") || full.slice(0, 40);
  return windowsUnusableName(id) ? `${id}-source` : id;
};
/** Files a write must never replace: every mapped source's file, and any file already in the study folder. */
const taken = (ws: { dir: string; manifest: WorkspaceManifest }, rel: string) =>
  Object.values(ws.manifest.sources ?? {}).includes(rel) || existsSync(join(ws.dir, rel));
/** A source ID not used yet in this study, whose files (data/<id>.csv, evidence/<id>.md) do not exist yet either. */
function freshId(ws: { dir: string; study: { sources: { id: string }[] }; manifest: WorkspaceManifest }, base: string) {
  let id = /^[a-z]/.test(slug(base)) ? slug(base) : `k-${slug(base)}`,
    n = 2;
  const first = id;
  while (ws.study.sources.some((x) => x.id === id) || ws.manifest.sources?.[id] || taken(ws, `data/${id}.csv`) || taken(ws, `evidence/${id}.md`)) id = `${first}-${n++}`;
  return id;
}
/**
 * The path itself if it is free, else the same name with -2, -3 … (a kept file of a deleted source
 * is never overwritten; a name Windows cannot use, such as data/con.csv, is never chosen).
 */
function freePath(ws: { dir: string; manifest: WorkspaceManifest }, rel: string, also: Set<string>) {
  const m = /^(.*?)(\.[a-z0-9]+)$/i.exec(rel) ?? [rel, rel, ""];
  let path = rel,
    n = 2;
  while (taken(ws, path) || also.has(path) || windowsUnusableName(basename(path))) path = `${m[1]}-${n++}${m[2]}`;
  return path;
}

/** Columns that may become fields (outcome-named ones are left out, and the notes say so). */
function participantColumns(study: Parameters<typeof columnGaps>[0], csv: string, notes = "") {
  const all = columnGaps(study, csv);
  const results = outcomeNamed(study, all.map((c) => c.name));
  return {
    columns: all.filter((c) => !results.includes(c.name)),
    notes: [notes, results.length ? `Left out ${results.join(", ")}: named like ${plural(results.length, "a measure", "measures")}, and results are never participant knowledge.` : "", strangerNote(strangers(study, csv))].filter(Boolean).join(" "),
  };
}
/** A participant table as comma-separated text without columns named like a measure (unchanged if a quote is never closed). */
function withoutOutcomeColumns(study: Parameters<typeof columnGaps>[0], text: string) {
  const table = parseCsv(text);
  if (table.openQuoteLine !== null) return text;
  const keep = table.head.map((h, i) => (outcomeNamed(study, [h]).length ? -1 : i)).filter((i) => i >= 0);
  return toCsv(keep.map((i) => table.head[i]), table.rows.map((r) => keep.map((i) => r[i] ?? "")));
}
/**
 * A reviewed-before-saving draft of new knowledge from an uploaded file. A table with this
 * study's participant IDs is participant-specific knowledge and is taken as it is (exact values);
 * every other file (a paper, notes, a model description) is read by the assistant, which decides
 * whether it is general or participant-specific and drafts it. If the assistant cannot be reached,
 * the extracted text is offered as the draft.
 */
export async function knowledgeDraft(id: string, name: string, data: Buffer) {
  const ws = await readWorkspace(id);
  const people = new Set(ws.study.participants.map((p) => p.id));
  const base = basename(name).replace(/\.[a-z0-9]+$/i, "");
  if (/\.(csv|tsv)$/i.test(name)) {
    // Excel on Windows saves "CSV" as Windows-1252 and "Unicode text" as UTF-16; the draft is saved as UTF-8.
    const decoded = decodeText(data);
    const text = decoded.text;
    const readAs = encodingNote(basename(name), decoded.encoding);
    // Semicolon- and tab-separated files (as spreadsheet programs often save them) are read and kept comma-separated.
    const table = parseCsv(text, /\.tsv$/i.test(name) ? "\t" : undefined);
    const { head, rows } = table;
    const csv = table.openQuoteLine === null ? toCsv(head, rows) : text;
    const idCol = idColumn(head);
    const matched = idCol >= 0 ? rows.filter((r) => people.has(r[idCol]?.trim())).length : 0;
    // A table with an ID column is about people: if none of them is in this study, say so instead of drafting it.
    const ids = idCol >= 0 ? [...new Set(rows.map((r) => r[idCol]?.trim()).filter(Boolean))] : [];
    const some = (xs: string[]) => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? " \u2026" : ""}`;
    requireThat(
      !ids.length || matched > 0,
      `${basename(name)} has one row per person (column ${head[idCol]}), but none of its IDs (${some(ids)}) is a participant of this study (${some([...people])}). Check the IDs in the file, or the participants on Study & variables.`,
    );
    if (matched > 0) {
      const sourceId = freshId(ws, base);
      return {
        kind: "participant" as const,
        via: "table" as const,
        sourceId,
        label: base,
        description: `${basename(name)}: information about each participant.`,
        path: `data/${sourceId}.csv`,
        text: withoutOutcomeColumns(ws.study, csv).trim() + "\n",
        ...participantColumns(ws.study, csv, readAs),
        problems: participantProblemsText(ws.study, "demographics", csv, []),
        check: null,
      };
    }
  }
  const document = await extractProposal(name, data);
  let draft: Awaited<ReturnType<typeof draftKnowledge>>;
  let via: "assistant" | "raw" = "assistant";
  try {
    draft = await draftKnowledge(document, ws.study);
  } catch (e) {
    via = "raw";
    draft = { kind: "general", label: base, description: `${basename(name)}, as extracted (not drafted).`, evidence: document.text.slice(0, 200_000), csv: null, notes: `The assistant could not draft this (${(e as Error).message.slice(0, 200)}). The extracted text is shown; edit it before adding.` };
  }
  const sourceId = freshId(ws, draft.label || base);
  if (draft.kind === "participant" && draft.csv)
    return {
      kind: "participant" as const,
      via,
      sourceId,
      label: draft.label,
      description: draft.description,
      path: `data/${sourceId}.csv`,
      text: withoutOutcomeColumns(ws.study, draft.csv),
      ...participantColumns(ws.study, draft.csv, draft.notes),
      problems: participantProblemsText(ws.study, "demographics", draft.csv, []),
      check: null,
    };
  return {
    kind: "general" as const,
    via,
    sourceId,
    label: draft.label,
    description: draft.description,
    path: `evidence/${sourceId}.md`,
    text: draft.evidence ?? "",
    columns: null,
    problems: [],
    check: await leakCheck(id, ws.study, draft.evidence ?? ""),
    notes: draft.notes,
  };
}

/**
 * Save knowledge changes in one step: the study and configurations as edited in the workbench
 * (new, renamed or deleted sources, changed fields, which configurations get what), files to write,
 * and sources to unmap. Everything is validated before anything is written; participant-specific
 * knowledge must be complete. Deleted sources keep their files on disk.
 */
export async function saveKnowledge(
  id: string,
  change: { study: unknown; agents: unknown; write?: { sourceId: string; path: string; text: string }[]; unmap?: string[] },
) {
  const ws = await readWorkspace(id);
  const study = validateStudy(change.study);
  const agents = validateAgents(study, change.agents as AgentProtocol[]);
  checkNewConfigurations(study, agents);
  const writes = change.write ?? [];
  const measureField = measureNamedFieldProblem(study);
  requireThat(!measureField, measureField ?? "");
  // Where each write goes: its own mapped file, or a free name (never another source's file, nor a file kept from a deleted source).
  const used = new Set<string>();
  const targets: string[] = [];
  for (const w of writes) {
    const src = study.sources.find((x) => x.id === w.sourceId);
    requireThat(src && ["evidence", "demographics", "trajectory"].includes(src.kind), `Unknown knowledge source ${w.sourceId}.`);
    const mapped = ws.manifest.sources?.[w.sourceId];
    const fresh = /^(evidence|data)\/[a-z0-9][a-z0-9._-]*\.(md|txt|csv)$/.test(w.path);
    requireThat(fresh || mapped === w.path, `Knowledge is written to evidence/ or data/ in the study folder, not to ${w.path}.`);
    const path = mapped === w.path && !used.has(w.path) ? w.path : freePath(ws, w.path, used);
    used.add(path);
    targets.push(path);
    // Symlinks on the way (e.g. a linked evidence/ folder) must not lead out of the study folder.
    studyWriteTarget(ws.dir, path);
    requireThat(typeof w.text === "string" && w.text.length <= 2_000_000, "Knowledge text must be at most 2 MB.");
    if (src!.kind !== "evidence") {
      // Every column counts, not only the declared fields: a file holding results is refused as a whole.
      const results = outcomeNamed(study, parseCsv(w.text).head);
      requireThat(
        !results.length,
        `${src!.label} has ${plural(results.length, "a column", "columns")} named like ${plural(results.length, "a measure", "measures")} (${results.join(", ")}). Results are never participant knowledge: remove ${plural(results.length, "that column", "those columns")} from the file and add it again.`,
      );
      const problems = participantProblemsText(study, src!.kind, w.text, src!.fields ?? []);
      requireThat(!problems.length, `${src!.label} ${problems.join("; ")}. Participant-specific knowledge needs exactly one complete entry per participant: fix the file and add it again.`);
    }
  }
  for (const [i, w] of writes.entries()) {
    const target = studyWriteTarget(ws.dir, targets[i]);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, w.text);
  }
  const sources = { ...(ws.manifest.sources ?? {}) };
  writes.forEach((w, i) => (sources[w.sourceId] = targets[i]));
  for (const u of change.unmap ?? []) if (!study.sources.some((x) => x.id === u)) delete sources[u];
  await saveManifest(ws.dir, { ...ws.manifest, sources });
  await writeFile(join(ws.dir, "study.json"), JSON.stringify(study, null, 2) + "\n");
  await writeFile(join(ws.dir, "agents.json"), JSON.stringify(agents, null, 2) + "\n");
  return { saved: true, written: targets };
}
