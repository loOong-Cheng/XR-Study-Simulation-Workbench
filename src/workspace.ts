// Study workspaces: one folder per study holding everything the planner,
// executor and analyzer need, so work can pause and continue from any step.
//
//   study.json  agents.json  comparisons.json  workspace.json
//   human.json                       (read only by the executor for declared inputs, and the analyzer)
//   campaigns/<campaign-id>/campaign.json
//   campaigns/<campaign-id>/sources.json   (fingerprints of the source files at freeze; beside, never inside, campaign.json)
//   runs/<campaign-id>/{receipts.jsonl, events.jsonl, results/<job>.json, jobs/<job>/…}
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentProtocol, Comparison, HumanData, ResultBundle, RunResult, Study } from "./core/types.js";
import type { Campaign, CampaignReceipt } from "./core/campaign.js";
import { checkNewConfigurations, requireThat, validateAgents, validateComparisons, validateStudy } from "./core/validation.js";
import { PARTICIPANT_KINDS, participantProblems } from "./participant-knowledge.js";
import { agentRefusal, inside, nameKey, realPath, windowsAliasProblem, within } from "./runtimes/guard.js";
import { readJsonFile, unquotePath, windowsUnusableName } from "./files.js";

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
/**
 * Where a study source really is (symlinks resolved), or why it may not be used. One rule for the
 * website, the executor and knowledge saving:
 * - a source resolves inside the study folder, never to the folder itself, human.json, campaigns/,
 *   runs/ or deleted/;
 * - only a project folder may live elsewhere on this machine (an engine project), and only when
 *   workspace.json gives it as an absolute path outside the workbench folder, holding no study.
 * The problem completes "Source '<id>' (<label>) …" and names no absolute path.
 *
 * Paths are compared by the names they have on disk (realPath), never as written: "HUMAN.JSON",
 * "human.jſon", "runſ/…" or, on Windows, "human.json." and short names open the protected files on
 * case-insensitive volumes. Protected folders count in every study folder on the way (a study kept
 * inside another one), and a hard link is refused (its other name may be human.json).
 */
export function sourceLocation(dir: string, kind: string, declaredValue: unknown): { path: string; problem?: undefined } | { problem: string; path?: undefined } {
  const declared = typeof declaredValue === "string" ? unquotePath(declaredValue) : declaredValue;
  if (typeof declared !== "string" || !declared) return { problem: "has no file on this machine (workspace.json → sources)" };
  const shown = isAbsolute(declared) ? `…/${basename(declared)}` : declared;
  const alias = windowsAliasProblem(declared);
  if (alias) return { problem: `points at ${shown}, which ${alias}. Write the name as it is on disk (workspace.json → sources)` };
  let real: string, study: string;
  try {
    study = realPath(dir);
    real = realPath(resolve(dir, declared));
  } catch {
    return { problem: `points at ${shown}, which does not exist` };
  }
  if (within(real, study))
    return { problem: "points at the study folder or a folder around it, which holds the human results. Point it at a file or subfolder inside the study folder (workspace.json → sources)" };
  const refusal = agentRefusal(real);
  if (refusal === "hardlink")
    return { problem: "points at a file with more than one name on disk (a hard link), which may be human results or run records. Copy the file instead of linking it (workspace.json → sources)" };
  if (refusal === "alias") return { problem: `points at ${shown}, a Windows short name (~1) that could not be resolved. Write the full name (workspace.json → sources)` };
  if (refusal || (inside(study, real) && PROTECTED.has(nameKey(relative(study, real).split(sep)[0]))))
    return { problem: "points at human results or run records (human.json, campaigns/, runs/, deleted/), which agents must never get. Point it elsewhere (workspace.json → sources)" };
  if (inside(study, real)) return { path: real };
  if (kind !== "project")
    return { problem: `points outside the study folder (${shown}). Copy the file into the study folder, for example evidence/ or data/, and point workspace.json → sources there` };
  if (!isAbsolute(declared))
    return { problem: `points outside the study folder (${shown}). A project folder elsewhere on this machine must be given as an absolute path in workspace.json → sources` };
  // Real paths on both sides, letter case ignored on macOS and Windows: "/XR-STUDY-SIM/…" is the workbench too.
  const repo = realPath(repoRoot);
  if (within(repo, real) || within(real, repo))
    return { problem: "points into the workbench folder but outside this study. Keep the project inside the study folder, or give a folder outside the workbench" };
  if (existsSync(join(real, "study.json")) || existsSync(join(real, "human.json")))
    return { problem: `points at a study folder or human results (${shown}). Point it at the engine project itself` };
  return { path: real };
}
/**
 * A file the workbench may write in a study folder: inside the folder after resolving symlinks on
 * the way, never a link itself (symbolic or hard), never human.json, and (unless `records`, for
 * loading runs) never in campaigns/, runs/ or deleted/ of this or a nested study. Names are
 * compared as the volume does (see sourceLocation).
 */
export function studyWriteTarget(dir: string, rel: string, opts: { records?: boolean } = {}): string {
  const alias = windowsAliasProblem(rel);
  requireThat(!alias, `Not a usable file name: it ${alias}.`);
  const target = resolve(dir, rel);
  requireThat(within(resolve(dir), target) && target !== resolve(dir), "Not inside the study folder.");
  const study = realPath(dir);
  // The nearest part of the path that exists, with symlinks resolved, must still be in the study.
  let existing = target;
  while (!lstatSync(existing, { throwIfNoEntry: false })) existing = dirname(existing);
  requireThat(existing !== target || !lstatSync(target).isSymbolicLink(), "This file is a link; the workbench writes only plain files in the study folder.");
  let real: string;
  try {
    real = join(realPath(existing), relative(existing, target));
  } catch {
    throw new Error("Not inside the study folder (a folder on the way is a broken link).");
  }
  requireThat(inside(study, real) && !within(real, study), "Not inside the study folder (a folder on the way links elsewhere).");
  const first = nameKey(relative(study, real).split(sep)[0]);
  const refusal = agentRefusal(real);
  requireThat(
    refusal !== "human" && first !== "human.json" && (opts.records || (refusal !== "records" && !PROTECTED.has(first))),
    "Knowledge is never written to human.json, campaigns/, runs/ or deleted/.",
  );
  requireThat(refusal !== "hardlink", "This file has more than one name on disk (a hard link), so writing it would change another file too. Remove the link first.");
  requireThat(refusal !== "alias", "Not a usable file name: it is a Windows short name (~1) that could not be resolved.");
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
      const shown = String(manifest.sources?.[id] ?? "");
      if (problems.length) return [{ id, label: s.label, message: `Source '${id}' (${s.label}, ${isAbsolute(shown) ? `…/${basename(shown)}` : shown}) ${problems.join("; ")}. Participant-specific knowledge needs exactly one complete entry per participant: fix it on Evidence & knowledge.` }];
    }
    return [];
  });
}

// ---------- what a campaign froze: source fingerprints ----------
/** Kinds whose content reaches the agent as it was frozen. Project folders are read live (engines rewrite them when opened). */
const FINGERPRINTED = ["brief", "evidence", "demographics", "trajectory"];
export interface SourceFingerprint {
  path: string;
  sha256: string | null;
}
/** sha256 of a file, or of a folder's files (relative path and content, sorted; dot files left out). */
export function sourceHash(path: string): string | null {
  if (!existsSync(path)) return null;
  const h = createHash("sha256");
  if (!statSync(path).isDirectory()) return h.update(readFileSync(path)).digest("hex");
  const walk = (rel: string): string[] =>
    readdirSync(join(path, rel), { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .flatMap((e) => (e.isDirectory() ? walk(join(rel, e.name)) : [join(rel, e.name)]));
  for (const f of walk("").sort()) h.update(f.split(sep).join("/")).update("\0").update(createHash("sha256").update(readFileSync(join(path, f))).digest("hex")).update("\n");
  return h.digest("hex");
}
/** Fingerprints of the sources the configurations read, as they are on disk now (null where a source may not be used). */
export function sourceFingerprints(dir: string, study: Study, manifest: WorkspaceManifest, sourceIds?: string[]): Record<string, SourceFingerprint> {
  const ids = sourceIds ?? study.sources.map((s) => s.id);
  return Object.fromEntries(
    study.sources
      .filter((s) => ids.includes(s.id) && FINGERPRINTED.includes(s.kind) && typeof manifest.sources?.[s.id] === "string")
      .map((s) => {
        const where = sourceLocation(dir, s.kind, manifest.sources![s.id]);
        return [s.id, { path: manifest.sources![s.id], sha256: where.path ? sourceHash(where.path) : null }];
      }),
  );
}
const fingerprintFile = (id: string, campaignId: string) => join(workspaceDir(id), "campaigns", campaignId, "sources.json");
/** Records the sources a campaign freezes (written beside campaign.json, whose digest it does not touch). */
export async function saveSourceFingerprints(id: string, campaign: Campaign) {
  const { dir, manifest } = await readStudyFolder(id);
  const study = campaign.suite.study;
  if (!study) return;
  const used = [...new Set(campaign.suite.conditions.flatMap((c) => c.recipe.protocol?.sourceIds ?? []))];
  await writeFile(fingerprintFile(id, campaign.id), pretty({ campaignId: campaign.id, recordedAt: new Date().toISOString(), sources: sourceFingerprints(dir, study, manifest, used) }));
}
/**
 * Sources whose file changed since the campaign was frozen, with the message for the researcher.
 * Campaigns frozen before fingerprints were recorded have none, and nothing is refused for them.
 */
export async function changedSources(id: string, campaign: Campaign, manifest: WorkspaceManifest): Promise<{ id: string; message: string }[]> {
  const file = fingerprintFile(id, campaign.id);
  const study = campaign.suite.study;
  if (!existsSync(file) || !study) return [];
  const frozen = await load<{ sources: Record<string, SourceFingerprint> }>(file);
  const now = sourceFingerprints(workspaceDir(id), study, manifest, Object.keys(frozen.sources));
  return Object.entries(frozen.sources).flatMap(([sid, f]) => {
    const current = now[sid];
    if (current && current.path === f.path && current.sha256 === f.sha256) return [];
    const label = study.sources.find((s) => s.id === sid)?.label ?? sid;
    const where = current && current.path !== f.path ? `${f.path}, now ${current.path}` : f.path;
    return [{ id: sid, message: `${label} (${where}) changed after this campaign was frozen. Freeze a new campaign, or Continue / rerun to use the new version.` }];
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
// Also files a Windows program saved with a byte-order mark (PowerShell 5.1) or as UTF-16.
const load = <T>(path: string) => readJsonFile<T>(path);
/**
 * workspace.json, with every path as written but without surrounding quotes, which a path pasted
 * from Windows Explorer ("Copy as path") brings along.
 */
async function loadManifest(dir: string): Promise<WorkspaceManifest> {
  if (!existsSync(join(dir, "workspace.json"))) return {};
  const m = await load<WorkspaceManifest>(join(dir, "workspace.json"));
  if (!m || typeof m !== "object") return m;
  const sources = m.sources && typeof m.sources === "object" ? Object.fromEntries(Object.entries(m.sources).map(([k, v]) => [k, typeof v === "string" ? unquotePath(v) : v])) : m.sources;
  const app = m.app && typeof m.app === "object" && typeof m.app.serve === "string" ? { ...m.app, serve: unquotePath(m.app.serve) } : m.app;
  return { ...m, ...(sources ? { sources } : {}), ...(app ? { app } : {}) };
}
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
        const manifest = await loadManifest(dir);
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
/** The study, its sources and comparisons, without checking the configurations against it. */
export async function readStudyFolder(id: string) {
  const dir = workspaceDir(id);
  const study = validateStudy(await load(join(dir, "study.json")));
  const comparisons = existsSync(join(dir, "comparisons.json")) ? await load<Comparison[]>(join(dir, "comparisons.json")) : [];
  const manifest = await loadManifest(dir);
  return { dir, study, comparisons, manifest };
}
export async function readWorkspace(id: string) {
  const folder = await readStudyFolder(id);
  const agents = existsSync(join(folder.dir, "agents.json"))
    ? validateAgents(folder.study, await load<AgentProtocol[]>(join(folder.dir, "agents.json")))
    : null;
  return { ...folder, agents };
}
/**
 * The workspace for the website, even when its saved files disagree (for example configurations
 * that no longer fit an edited study): the configurations as saved, and a problem that says what
 * to fix. Saving again is refused until they fit.
 */
export async function readWorkspaceForEditing(id: string) {
  const folder = await readStudyFolder(id);
  const path = join(folder.dir, "agents.json");
  if (!existsSync(path)) return { ...folder, agents: null, problem: null as string | null };
  const raw = await load<unknown>(path);
  try {
    return { ...folder, agents: validateAgents(folder.study, raw as AgentProtocol[]), problem: null as string | null };
  } catch (e) {
    const usable = Array.isArray(raw) && raw.every((a) => a && typeof a === "object" && Array.isArray(a.sourceIds) && Array.isArray(a.tools) && a.model && typeof a.id === "string");
    return {
      ...folder,
      agents: usable ? (raw as AgentProtocol[]) : null,
      problem: `The saved agent configurations (agents.json) do not fit the saved study (study.json): ${(e as Error).message} Fix this on Agent configurations and save${usable ? "" : "; agents.json could not be read, so templates are shown instead"}.`,
    };
  }
}
/**
 * Save the study, configurations and comparisons in one step: whatever is not sent is taken as
 * saved, and all of them are checked together before anything is written, so a refused save
 * leaves every file as it was.
 */
export async function saveWorkspace(
  id: string,
  update: { study?: Study; agents?: AgentProtocol[]; comparisons?: Comparison[] },
) {
  const dir = workspaceDir(id);
  const study = validateStudy(update.study ?? (await load(join(dir, "study.json"))));
  const savedAgents = !update.agents && existsSync(join(dir, "agents.json")) ? await load<AgentProtocol[]>(join(dir, "agents.json")) : null;
  let agents: AgentProtocol[] | null = null;
  if (update.agents) {
    agents = validateAgents(study, update.agents);
    checkNewConfigurations(study, agents);
  } else if (savedAgents)
    try {
      agents = validateAgents(study, savedAgents);
    } catch (e) {
      throw new Error(`This change does not fit the saved agent configurations: ${(e as Error).message} Change those configurations on Agent configurations and save the study and configurations together.`);
    }
  const comparisons = update.comparisons === undefined ? null : validateComparisons(update.comparisons);
  if (update.study) await writeFile(join(dir, "study.json"), pretty(study));
  if (update.agents) await writeFile(join(dir, "agents.json"), pretty(agents));
  if (comparisons) await writeFile(join(dir, "comparisons.json"), pretty(comparisons));
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
  requireThat(!windowsUnusableName(name), `"${name}" is a name Windows keeps for devices (CON, PRN, AUX, NUL, COM1–9, LPT1–9), so the study folder could not be opened there. Choose another name.`);
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
