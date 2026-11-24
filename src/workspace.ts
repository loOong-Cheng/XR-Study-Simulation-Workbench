// Study workspaces: one folder per study holding everything the planner,
// executor and analyzer need, so work can pause and continue from any step.
//
//   study.json  agents.json  comparisons.json  workspace.json
//   human.json                       (read only by the executor for declared inputs, and the analyzer)
//   campaigns/<campaign-id>/campaign.json
//   runs/<campaign-id>/{receipts.jsonl, events.jsonl, results/<job>.json, jobs/<job>/…}
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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

/**
 * Sources that a configuration reads but that have no file or folder on this machine
 * (workspace.json → sources). Such a configuration must not run: the agent would get
 * nothing, or only the source's one-line description, while the audit counts it as delivered.
 * Objective records come from human.json as declared inputs and need no file.
 */
export function missingSources(dir: string, study: Study, manifest: WorkspaceManifest, sourceIds: string[]) {
  return sourceIds.flatMap((id) => {
    const s = study.sources.find((x) => x.id === id);
    if (!s || s.kind === "objective-records") return [];
    const rel = manifest.sources?.[id];
    if (!rel) return [{ id, label: s.label, message: `Source '${id}' (${s.label}) has no file on this machine (workspace.json → sources).` }];
    const path = resolve(dir, rel);
    if (!existsSync(path)) return [{ id, label: s.label, message: `Source '${id}' (${s.label}) points at ${rel}, which does not exist.` }];
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

/** Resolve a workspace ID ("examples/graphics-quality") to its folder; only known roots are allowed. */
export function workspaceDir(id: string): string {
  requireThat(typeof id === "string" && /^[a-zA-Z0-9_./-]+$/.test(id) && !id.split("/").includes(".."), "Invalid study ID.");
  const dir = resolve(repoRoot, id);
  requireThat(
    roots.some((r) => dir.startsWith(resolve(repoRoot, r) + sep)) && existsSync(join(dir, "study.json")),
    `No study found at ${id}.`,
  );
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
          title: manifest.title ?? study.title,
          suite: manifest.suite ?? null,
          description: manifest.description ?? null,
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
    if (existsSync(path)) list.push(await load<Campaign>(path));
  }
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export async function readCampaign(id: string, campaignId: string): Promise<Campaign> {
  requireThat(/^[a-zA-Z0-9_-]+$/.test(campaignId), "Invalid campaign ID.");
  return load<Campaign>(join(workspaceDir(id), "campaigns", campaignId, "campaign.json"));
}
export function runDir(id: string, campaignId: string) {
  requireThat(/^[a-zA-Z0-9_-]+$/.test(campaignId), "Invalid campaign ID.");
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
