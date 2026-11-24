// The study brief: what every configuration gets, written for agents. It describes the task,
// designs, procedure and measures as participants experienced them, never results. "Understand
// study" drafts it from the document; the researcher can also write or edit it on Evidence &
// knowledge. It is saved as a file in the study folder (agent-brief.md) and mapped in workspace.json.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentProtocol, Study } from "./core/types.js";
import { requireThat, validateAgents, validateStudy } from "./core/validation.js";
import { leakCheck } from "./sources.js";
import { readStudyFolder, readWorkspace, sourceLocation, studyWriteTarget } from "./workspace.js";

const BRIEF_DESCRIPTION = "Task description for agents, without participant answers.";

/** The study's brief: file, size, hash, preview, who gets it, and the outcome-blind check. Null when the study has no brief source. */
export async function briefOverview(id: string, agents: { id: string; sourceIds: string[] }[]) {
  const ws = await readStudyFolder(id);
  const src = ws.study.sources.find((s) => s.kind === "brief");
  if (!src) return null;
  const rel = ws.manifest.sources?.[src.id] ?? null;
  // The same rule as for agents: only a file the agents may get is previewed.
  const where = rel ? sourceLocation(ws.dir, src.kind, rel) : null;
  const path = where?.path ?? null;
  const file = path && !(await stat(path)).isDirectory() ? await readFile(path) : null;
  const text = file?.toString("utf8") ?? "";
  return {
    id: src.id,
    label: src.label,
    description: src.description,
    path: rel,
    problem: where?.problem ?? null,
    exists: !!file && text.trim().length > 0,
    bytes: file?.length ?? 0,
    sha256: file ? createHash("sha256").update(file).digest("hex") : null,
    preview: text.slice(0, 6000),
    truncated: text.length > 6000,
    configs: agents.filter((a) => a.sourceIds.includes(src.id)).map((a) => a.id),
    check: file ? await leakCheck(id, ws.study, text) : null,
  };
}

/**
 * Write the brief. It goes to the file the brief is mapped to when that is a Markdown or text file
 * the workbench may write in the study folder, otherwise to agent-brief.md there (or a free name:
 * no other file is ever overwritten), and workspace.json maps it. A study without a brief source
 * gets one, and every configuration gets it.
 */
export async function saveBrief(id: string, text: unknown) {
  requireThat(typeof text === "string" && text.trim().length > 0, "The brief is empty. Describe the task, the designs, the procedure and the measures as participants experienced them.");
  requireThat((text as string).length <= 2_000_000, "The brief must be at most 2 MB.");
  const ws = await readStudyFolder(id);
  let study: Study = ws.study;
  let src = study.sources.find((s) => s.kind === "brief");
  if (!src) {
    // The configurations get the new brief too, so they must fit the study (see Agent configurations).
    const agents = existsSync(join(ws.dir, "agents.json")) ? (await readWorkspace(id)).agents : null;
    let sourceId = "brief",
      n = 2;
    while (study.sources.some((s) => s.id === sourceId)) sourceId = `brief-${n++}`;
    src = { id: sourceId, label: "Study brief", kind: "brief", description: BRIEF_DESCRIPTION };
    study = validateStudy({ ...study, sources: [src, ...study.sources] });
    const withBrief: AgentProtocol[] | null = agents?.map((a) => ({ ...a, sourceIds: [src!.id, ...a.sourceIds], requiredSourceIds: [src!.id, ...a.requiredSourceIds] })) ?? null;
    if (withBrief) validateAgents(study, withBrief);
    await writeFile(join(ws.dir, "study.json"), JSON.stringify(study, null, 2) + "\n");
    if (withBrief) await writeFile(join(ws.dir, "agents.json"), JSON.stringify(withBrief, null, 2) + "\n");
  }
  const mapped = ws.manifest.sources?.[src.id];
  const writable = (rel: string) => {
    try {
      const target = studyWriteTarget(ws.dir, rel);
      return !existsSync(target) || statSync(target).isFile() ? target : null;
    } catch {
      return null;
    }
  };
  let rel = mapped && /\.(md|markdown|txt)$/i.test(mapped) && writable(mapped) ? mapped : "agent-brief.md";
  if (rel !== mapped) {
    // Never overwrite another source's file, nor any file already in the study folder.
    const taken = (p: string) => Object.values(ws.manifest.sources ?? {}).includes(p) || existsSync(join(ws.dir, p));
    for (let n = 2; taken(rel); n++) rel = `agent-brief-${n}.md`;
  }
  const target = writable(rel);
  requireThat(target, `The brief cannot be written to ${rel} in the study folder.`);
  await writeFile(target!, text as string);
  const manifest = { ...ws.manifest, sources: { ...(ws.manifest.sources ?? {}), [src.id]: rel } };
  await writeFile(join(ws.dir, "workspace.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { saved: true, sourceId: src.id, path: rel, check: await leakCheck(id, study, text as string) };
}
