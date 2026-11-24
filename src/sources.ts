// Study sources for the researcher: read what agents get, manage evidence documents, add participant
// information, and check evidence for outcome leaks. Human results are never returned from here;
// the leak check only reports how many numbers match.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Study } from "./core/types.js";
import { measurementValue, requireThat } from "./core/validation.js";
import { readHuman, readWorkspace, repoRoot, type WorkspaceManifest } from "./workspace.js";
import { backgroundText, columnGaps, idColumn, parseCsv, participantProblems, participantProblemsText, PARTICIPANT_KINDS } from "./participant-knowledge.js";
import { draftKnowledge } from "./assistant.js";
import { extractProposal } from "./core/proposal.js";
import type { AgentProtocol } from "./core/types.js";
import { validateAgents, validateStudy } from "./core/validation.js";

const READABLE = ["brief", "project", "evidence"];
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");

/** Where a source lives, only if it is a readable kind, mapped, exists and is inside the repository. */
async function sourcePath(id: string, sourceId: string) {
  const ws = await readWorkspace(id);
  const src = ws.study.sources.find((s) => s.id === sourceId);
  requireThat(src && READABLE.includes(src.kind), "Only the brief, project and evidence sources can be shown here.");
  const rel = ws.manifest.sources?.[sourceId];
  requireThat(rel, `Source '${sourceId}' has no file on this machine (workspace.json → sources).`);
  const path = resolve(ws.dir, rel!);
  requireThat(path.startsWith(repoRoot + sep) && existsSync(path) && !/human\.json$/i.test(path), `Source '${sourceId}' was not found.`);
  return { ws, src: src!, path, rel: rel! };
}
async function tree(root: string, prefix = "", out: string[] = []): Promise<string[]> {
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (e.name.startsWith(".") || out.length >= 500) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) await tree(root, rel, out);
    else out.push(rel);
  }
  return out;
}
/** The source as plain text: a file's content (up to 2 MB) or a folder's file list. */
export async function sourceText(id: string, sourceId: string): Promise<string> {
  const { src, path, rel } = await sourcePath(id, sourceId);
  if ((await stat(path)).isDirectory()) return `${src.label} (${rel}): folder with these files\n\n${(await tree(path)).join("\n")}\n`;
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
    const path = rel ? resolve(ws.dir, rel) : null;
    const file = path && existsSync(path) && !(await stat(path)).isDirectory() ? await readFile(path) : null;
    const text = file?.toString("utf8") ?? "";
    out.push({
      id: src.id,
      label: src.label,
      description: src.description,
      path: rel,
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
    const path = rel ? resolve(ws.dir, rel) : null;
    const exists = !!path && existsSync(path);
    const problems = exists ? participantProblems(ws.study, src.kind, path!, src.fields ?? []) : [];
    const isFile = exists && !(await stat(path!)).isDirectory();
    const text = isFile ? await readFile(path!, "utf8") : "";
    const example = ws.study.participants[0]?.id ?? null;
    out.push({
      id: src.id,
      label: src.label,
      kind: src.kind,
      description: src.description,
      fields: src.fields ?? [],
      path: rel,
      exists,
      sha256: isFile ? sha(text) : null,
      participants: ws.study.participants.length,
      problems,
      columns: src.kind === "demographics" && isFile ? participantColumns(ws.study, text).columns : [],
      population: src.kind === "demographics" && isFile && !problems.length ? backgroundText(text, src.fields ?? []) : null,
      individual: src.kind === "demographics" && isFile && !problems.length && example ? { participantId: example, text: backgroundText(text, src.fields ?? [], example) } : null,
      configs: agents.filter((a) => a.sourceIds.includes(src.id)).map((a) => a.id),
    });
  }
  return out;
}

/** Columns named like a measured outcome are results, never participant knowledge. */
function outcomeColumns(study: { outcomes: { id: string; label: string }[] }, names: string[]) {
  const outcome = new Set(study.outcomes.flatMap((o) => [o.id.toLowerCase(), o.label.toLowerCase()]));
  return names.filter((n) => outcome.has(n.toLowerCase()));
}
/** A short ID from a name, cut at a word boundary (at most 40 characters). */
const slug = (text: string) => {
  const full = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (full.length <= 40) return full || "knowledge";
  const cut = full.slice(0, 41).replace(/-[^-]*$/, "");
  return cut || full.slice(0, 40);
};
/** A source ID and file name not used yet in this study. */
function freshId(ws: { study: { sources: { id: string }[] }; manifest: WorkspaceManifest }, base: string) {
  let id = /^[a-z]/.test(slug(base)) ? slug(base) : `k-${slug(base)}`,
    n = 2;
  const first = id;
  while (ws.study.sources.some((x) => x.id === id) || ws.manifest.sources?.[id]) id = `${first}-${n++}`;
  return id;
}

/** Columns that may become fields (outcome-named ones are left out, and the notes say so). */
function participantColumns(study: Parameters<typeof columnGaps>[0], csv: string, notes = "") {
  const all = columnGaps(study, csv);
  const results = outcomeColumns(study, all.map((c) => c.name));
  return {
    columns: all.filter((c) => !results.includes(c.name)),
    notes: [notes, results.length ? `Left out ${results.join(", ")}: named like a measure, and results are never participant knowledge.` : ""].filter(Boolean).join(" "),
  };
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
    const text = data.toString("utf8").replace(/^\uFEFF/, "");
    const csv = /\.tsv$/i.test(name) ? text.split(/\r?\n/).map((l) => l.split("\t").map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") : text;
    const { head, rows } = parseCsv(csv);
    const idCol = idColumn(head);
    const matched = idCol >= 0 ? rows.filter((r) => people.has(r[idCol]?.trim())).length : 0;
    if (matched > 0) {
      const sourceId = freshId(ws, base);
      return {
        kind: "participant" as const,
        via: "table" as const,
        sourceId,
        label: base,
        description: `${basename(name)}: information about each participant.`,
        path: `data/${sourceId}.csv`,
        text: csv.trim() + "\n",
        ...participantColumns(ws.study, csv),
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
      text: draft.csv,
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
  const writes = change.write ?? [];
  for (const src of study.sources.filter((x) => (PARTICIPANT_KINDS as readonly string[]).includes(x.kind))) {
    const results = outcomeColumns(study, src.fields ?? []);
    requireThat(!results.length, `${results.join(", ")} look like measured outcomes and must not be participant information (${src.label}).`);
  }
  for (const w of writes) {
    const src = study.sources.find((x) => x.id === w.sourceId);
    requireThat(src && ["evidence", "demographics", "trajectory"].includes(src.kind), `Unknown knowledge source ${w.sourceId}.`);
    const mapped = ws.manifest.sources?.[w.sourceId];
    const fresh = /^(evidence|data)\/[a-z0-9][a-z0-9._-]*\.(md|txt|csv)$/.test(w.path);
    requireThat(fresh || mapped === w.path, `Knowledge is written to evidence/ or data/ in the study folder, not to ${w.path}.`);
    const target = resolve(ws.dir, w.path);
    requireThat(target.startsWith(ws.dir + sep) && !/human\.json$/i.test(target), "Not inside the study folder.");
    requireThat(typeof w.text === "string" && w.text.length <= 2_000_000, "Knowledge text must be at most 2 MB.");
    if (src!.kind !== "evidence") {
      const problems = participantProblemsText(study, src!.kind, w.text, src!.fields ?? []);
      requireThat(!problems.length, `${src!.label} is incomplete: ${problems.join("; ")}. Participant-specific knowledge must exist for every participant.`);
    }
  }
  for (const w of writes) {
    const target = resolve(ws.dir, w.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, w.text);
  }
  const sources = { ...(ws.manifest.sources ?? {}) };
  for (const w of writes) sources[w.sourceId] = w.path;
  for (const u of change.unmap ?? []) if (!study.sources.some((x) => x.id === u)) delete sources[u];
  await saveManifest(ws.dir, { ...ws.manifest, sources });
  await writeFile(join(ws.dir, "study.json"), JSON.stringify(study, null, 2) + "\n");
  await writeFile(join(ws.dir, "agents.json"), JSON.stringify(agents, null, 2) + "\n");
  return { saved: true, written: writes.map((w) => w.path) };
}
