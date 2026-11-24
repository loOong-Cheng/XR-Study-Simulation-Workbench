// Study workspaces: one folder per study holding everything the planner,
// executor and analyzer need, so work can pause and continue from any step.
//
//   study.json  agents.json  comparisons.json  workspace.json
//   human.json                       (read only by the executor for declared inputs, and the analyzer)
//   campaigns/<campaign-id>/campaign.json
//   runs/<campaign-id>/{receipts.jsonl, events.jsonl, results/<job>.json, jobs/<job>/…}
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProtocol, Comparison, HumanData, ResultBundle, RunResult, Study } from "./core/types.js";
import type { Campaign, CampaignReceipt } from "./core/campaign.js";
import { requireThat, validateAgents, validateStudy } from "./core/validation.js";
import { PARTICIPANT_KINDS, participantProblems } from "./participant-knowledge.js";

// dist/workspace.js or .test-build/src/workspace.js: walk up to the folder holding package.json.
export const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4 && !existsSync(join(dir, "package.json")); i++) dir = dirname(dir);
  return dir;
})();
const roots = ["examples", join("private", "studies")];

/** Optional workspace.json: how the study is presented and run. */
export interface WorkspaceManifest {
  title?: string;
  suite?: string;
  description?: string;
  /** Folders/files (relative to the workspace) backing each study source ID. */
  sources?: Record<string, string>;
  /** WebXR apps: folder to serve and URL query per design, e.g. "?quality={condition}&study=1". */
  app?: { serve: string; query: string };
}

/** Study folders and files that hold human results or runs. No source may be, contain or reach them. */
const PROTECTED = new Set(["human.json", "campaigns", "runs", "deleted"]);
const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
/**
 * Where a study source really is (symlinks resolved), or why it may not be used. One rule for the
 * website, the executor and knowledge saving:
 * - a source resolves inside the study folder, never to the folder itself, human.json, campaigns/,
 *   runs/ or deleted/;
 * - only a project folder may live elsewhere on this machine (an engine project), and only when
 *   workspace.json gives it as an absolute path outside the workbench folder, holding no study.
 * The problem completes "Source '<id>' (<label>) …" and names no absolute path.
 */
export function sourceLocation(dir: string, kind: string, declared: unknown): { path: string; problem?: undefined } | { problem: string; path?: undefined } {
  if (typeof declared !== "string" || !declared.trim()) return { problem: "has no file on this machine (workspace.json → sources)" };
  const shown = isAbsolute(declared) ? `…/${basename(declared)}` : declared;
  let real: string, study: string;
  try {
    study = realpathSync(dir);
    real = realpathSync(resolve(dir, declared));
  } catch {
    return { problem: `points at ${shown}, which does not exist` };
  }
  if (within(real, study))
    return { problem: "points at the study folder or a folder around it, which holds the human results. Point it at a file or subfolder inside the study folder (workspace.json → sources)" };
  if (within(study, real)) {
    const first = relative(study, real).split(sep)[0].toLowerCase();
    if (PROTECTED.has(first) || basename(real).toLowerCase() === "human.json")
      return { problem: "points at human results or run records (human.json, campaigns/, runs/, deleted/), which agents must never get. Point it elsewhere (workspace.json → sources)" };
    return { path: real };
  }
  if (kind !== "project")
    return { problem: `points outside the study folder (${shown}). Copy the file into the study folder, for example evidence/ or data/, and point workspace.json → sources there` };
  if (!isAbsolute(declared))
    return { problem: `points outside the study folder (${shown}). A project folder elsewhere on this machine must be given as an absolute path in workspace.json → sources` };
  const repo = realpathSync(repoRoot);
  if (within(repo, real) || within(real, repo))
    return { problem: "points into the workbench folder but outside this study. Keep the project inside the study folder, or give a folder outside the workbench" };
  if (basename(real).toLowerCase() === "human.json" || existsSync(join(real, "study.json")) || existsSync(join(real, "human.json")))
    return { problem: `points at a study folder or human results (${shown}). Point it at the engine project itself` };
  return { path: real };
}
/**
 * A file the workbench may write in a study folder: inside the folder after resolving symlinks on
 * the way, never a link itself, never human.json, and (unless `records`, for loading runs) never
 * in campaigns/, runs/ or deleted/.
 */
export function studyWriteTarget(dir: string, rel: string, opts: { records?: boolean } = {}): string {
  const target = resolve(dir, rel);
  requireThat(within(resolve(dir), target) && target !== resolve(dir), "Not inside the study folder.");
  const study = realpathSync(dir);
  // The nearest part of the path that exists, with symlinks resolved, must still be in the study.
  let existing = target;
  while (!lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);
  requireThat(existing !== target || !lstatSync(target).isSymbolicLink(), "This file is a link; the workbench writes only plain files in the study folder.");
  let real: string;
  try {
    real = join(realpathSync(existing), relative(existing, target));
  } catch {
    throw new Error("Not inside the study folder (a folder on the way is a broken link).");
  }
  requireThat(within(study, real) && real !== study, "Not inside the study folder (a folder on the way links elsewhere).");
  const first = relative(study, real).split(sep)[0].toLowerCase();
  requireThat(basename(real).toLowerCase() !== "human.json" && (opts.records || !PROTECTED.has(first)), "Knowledge is never written to human.json, campaigns/, runs/ or deleted/.");
  return real;
}

/**
 * Sources that a configuration reads but that have no file or folder on this machine
 * (workspace.json → sources), or whose file may not be given to agents (see sourceLocation).
 * Such a configuration must not run: the agent would get nothing, or only the source's one-line
 * description, while the audit counts it as delivered.
 * Objective records come from human.json as declared inputs and need no file.
 */
export function missingSources(dir: string, study: Study, manifest: WorkspaceManifest, sourceIds: string[]) {
  return sourceIds.flatMap((id) => {
    const s = study.sources.find((x) => x.id === id);
    if (!s || s.kind === "objective-records") return [];
    const where = sourceLocation(dir, s.kind, manifest.sources?.[id]);
    if (where.problem !== undefined) return [{ id, label: s.label, message: `Source '${id}' (${s.label}) ${where.problem}.` }];
    const path = where.path;
    // Participant-specific knowledge must exist for every participant, with no empty field.
    if ((PARTICIPANT_KINDS as readonly string[]).includes(s.kind)) {
      const problems = participantProblems(study, s.kind, path, s.fields ?? []);
      if (problems.length) return [{ id, label: s.label, message: `Source '${id}' (${s.label}) is incomplete: ${problems.join("; ")}. Participant-specific knowledge must exist for every participant.` }];
    }
    return [];
  });
}
export interface WorkspaceInfo {
  id: string;
  title: string;
  suite: string | null;
  description: string | null;
  synthetic: boolean;
  engine: string;
  hasAgents: boolean;
  hasHuman: boolean;
  campaigns: number;
}
const load = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
const pretty = (x: unknown) => JSON.stringify(x, null, 2) + "\n";

/**
 * Resolve a study ID ("examples/graphics-quality") to its folder. Only the canonical spelling is
 * accepted (root/name exactly as listed, same letter case), so a study has exactly one ID: "./",
 * "//", a trailing "/" or another letter case would otherwise give the same folder a second
 * executor, cache entry or lock.
 */
const STUDY_ID = /^(examples|private\/studies)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,99})$/;
export function workspaceDir(id: string): string {
  const m = typeof id === "string" ? STUDY_ID.exec(id) : null;
  requireThat(m && !m[2].endsWith("."), "Invalid study ID. Use the form examples/<name> or private/studies/<name>, as listed on the home page.");
  const base = resolve(repoRoot, m![1]);
  const dir = join(base, m![2]);
  // Case-insensitive file systems (macOS, Windows) would also open "Study" for "study": require the exact name.
  requireThat(existsSync(join(dir, "study.json")) && readdirSync(base).includes(m![2]), `No study found at ${id}.`);
  return dir;
}
export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  const out: WorkspaceInfo[] = [];
  for (const r of roots) {
    const base = resolve(repoRoot, r);
    if (!existsSync(base)) continue;
    for (const entry of await readdir(base, { withFileTypes: true })) {
      const dir = join(base, entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, "study.json"))) continue;
      try {
        const study = await load<Study>(join(dir, "study.json"));
        const manifest = existsSync(join(dir, "workspace.json")) ? await load<WorkspaceManifest>(join(dir, "workspace.json")) : {};
        out.push({
          id: `${r.split(sep).join("/")}/${entry.name}`,
          // Bounded, so one oversized file cannot bloat the study list for everyone.
          title: String(manifest.title ?? study.title).slice(0, 300),
          suite: typeof manifest.suite === "string" ? manifest.suite.slice(0, 300) : null,
          description: typeof manifest.description === "string" ? manifest.description.slice(0, 2000) : null,
          synthetic: study.synthetic,
          engine: study.runtime.engine,
          hasAgents: existsSync(join(dir, "agents.json")),
          hasHuman: existsSync(join(dir, "human.json")),
          campaigns: existsSync(join(dir, "campaigns")) ? (await readdir(join(dir, "campaigns"))).length : 0,
        });
      } catch {
        // Skip folders whose study does not parse; `study-check` explains them.
      }
    }
  }
  return out.sort((a, b) => (a.suite ?? a.title).localeCompare(b.suite ?? b.title));
}
export async function readWorkspace(id: string) {
  const dir = workspaceDir(id);
  const study = validateStudy(await load(join(dir, "study.json")));
  const agents = existsSync(join(dir, "agents.json"))
    ? validateAgents(study, await load<AgentProtocol[]>(join(dir, "agents.json")))
    : null;
  const comparisons = existsSync(join(dir, "comparisons.json")) ? await load<Comparison[]>(join(dir, "comparisons.json")) : [];
  const manifest = existsSync(join(dir, "workspace.json")) ? await load<WorkspaceManifest>(join(dir, "workspace.json")) : {};
  return { dir, study, agents, comparisons, manifest };
}
export async function saveWorkspace(
  id: string,
  update: { study?: Study; agents?: AgentProtocol[]; comparisons?: Comparison[] },
) {
  const dir = workspaceDir(id);
  const study = validateStudy(update.study ?? (await load(join(dir, "study.json"))));
  if (update.study) await writeFile(join(dir, "study.json"), pretty(study));
  if (update.agents) await writeFile(join(dir, "agents.json"), pretty(validateAgents(study, update.agents)));
  if (update.comparisons) await writeFile(join(dir, "comparisons.json"), pretty(update.comparisons));
}
/** Human reference: never sent to the planner UI; only the executor (inputs) and analyzer read it. */
export async function readHuman(id: string): Promise<HumanData | null> {
  const path = join(workspaceDir(id), "human.json");
  return existsSync(path) ? load<HumanData>(path) : null;
}

// ---------- campaigns and runs ----------
export async function saveCampaign(id: string, campaign: Campaign) {
  const dir = join(workspaceDir(id), "campaigns", campaign.id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "campaign.json");
  requireThat(!existsSync(path), "A frozen campaign is never overwritten.");
  await writeFile(path, pretty(campaign), { flag: "wx" });
}
export async function listCampaigns(id: string): Promise<Campaign[]> {
  const dir = join(workspaceDir(id), "campaigns");
  if (!existsSync(dir)) return [];
  const list: Campaign[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name, "campaign.json");
    if (!existsSync(path)) continue;
    const c = await load<Campaign>(path);
    // A campaign lives in the folder named after its ID; a copy under another name is not listed.
    if (c?.id === name) list.push(c);
  }
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** Campaign IDs are simple names; every lookup and folder use checks this first. */
export const CAMPAIGN_ID = /^[a-zA-Z0-9_-]{1,200}$/;
export async function readCampaign(id: string, campaignId: string): Promise<Campaign> {
  requireThat(typeof campaignId === "string" && CAMPAIGN_ID.test(campaignId), "Invalid campaign ID.");
  const path = join(workspaceDir(id), "campaigns", campaignId, "campaign.json");
  requireThat(existsSync(path), "Unknown campaign. It may have been deleted; reload the page.");
  const campaign = await load<Campaign>(path);
  requireThat(campaign?.id === campaignId, "This campaign folder holds a campaign with another ID; it cannot be used.");
  return campaign;
}
export function runDir(id: string, campaignId: string) {
  requireThat(typeof campaignId === "string" && CAMPAIGN_ID.test(campaignId), "Invalid campaign ID.");
  return join(workspaceDir(id), "runs", campaignId);
}
export async function readReceipts(id: string, campaignIds: string[]): Promise<CampaignReceipt[]> {
  const out: CampaignReceipt[] = [];
  for (const c of campaignIds) {
    const path = join(runDir(id, c), "receipts.jsonl");
    if (!existsSync(path)) continue;
    const text = (await readFile(path, "utf8")).trim();
    if (text) out.push(...text.split(/\n/).map((l) => JSON.parse(l) as CampaignReceipt));
  }
  return out;
}
/** Result bundles of the given campaigns (one bundle per campaign) for lineage analysis. */
export async function readResults(id: string, study: Study, campaignIds: string[]): Promise<ResultBundle[]> {
  const bundles: ResultBundle[] = [];
  for (const c of campaignIds) {
    const dir = join(runDir(id, c), "results");
    if (!existsSync(dir)) continue;
    const runs: RunResult[] = [];
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) runs.push(await load<RunResult>(join(dir, f)));
    if (runs.length) bundles.push({ schemaVersion: "1.0", studyId: study.id, runs });
  }
  return bundles;
}

/**
 * A new study folder under private/studies with a valid placeholder study, until "Understand study"
 * drafts the real description. Validated before anything is created, so a failure leaves no folder.
 */
export async function createStudy(rawName: string) {
  const name = rawName.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  requireThat(name.length >= 2, "Give the study folder a name (letters, digits, dashes).");
  const dir = join(repoRoot, "private", "studies", name);
  requireThat(!existsSync(dir), "A study with this name already exists.");
  const placeholder: Study = {
    schemaVersion: "1.0",
    id: name,
    title: "New study (draft it from your document)",
    researchQuestion: "Not stated yet: draft the study from your document with Understand study.",
    synthetic: false,
    design: "within-subjects",
    predictionLevel: "population",
    predictionTiming: "after-experience",
    conditions: [
      { id: "design-a", label: "Design A" },
      { id: "design-b", label: "Design B" },
    ],
    phases: [{ id: "main", label: "Main task", kind: "main" }],
    cases: [],
    participants: [
      { id: "p01", stratum: "ab", conditionOrder: ["design-a", "design-b"] },
      { id: "p02", stratum: "ba", conditionOrder: ["design-b", "design-a"] },
    ],
    sources: [{ id: "brief", label: "Study brief", kind: "brief", description: "Task description for agents." }],
    runtime: { engine: "custom", backend: "custom", observation: "mono", deviceProfile: "unspecified", requiredCapabilities: [] },
    outcomes: [{ id: "measure", label: "Measure", domain: "subjective", unit: "1-7", scale: "ordinal", aggregation: "arithmetic", family: "measure", weight: 1, phaseIds: ["main"], description: "Placeholder" }],
    analysis: { mode: "both", familyWeights: { measure: 1 }, bootstrapDraws: 1000, seed: 2026, tieTolerance: 1e-8, contrasts: [] },
  };
  const valid = validateStudy(placeholder);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "study.json"), JSON.stringify(valid, null, 2) + "\n");
  return { id: `private/studies/${name}` };
}
