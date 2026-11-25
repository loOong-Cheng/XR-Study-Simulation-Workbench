// Starter campaigns of the example suites. Each suite keeps one in git, in examples/<suite>/starter/:
//
//   campaign.json  frozen from the suite's study.json and agents.json at 1 run per participant, exactly
//                  as Freeze & campaigns → Freeze campaign freezes it, with a fixed ID and date
//   sources.json   the source fingerprints freezing writes beside it (what the sources held)
//   starter.json   its label, its sessions per configuration and what each configuration needs
//
// The first time an example study opens in the website with no campaign (and setup does it for every
// suite), the starter is copied into campaigns/<id>/ and labelled, so a fresh clone can Simulate or
// Start at once. That happens once per study: campaigns/.starters.json records it, so a starter the
// researcher deleted is never put back. User campaigns (campaigns/, runs/, labels) stay git-ignored.
// `npm run starters` rebuilds every starter from the suite's current files; test/starters.test.ts
// fails when one is out of date.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { campaignFromStudy, verifyCampaign, type Campaign } from "./core/campaign.js";
import { agentLevel, hash } from "./core/planner.js";
import type { AgentProtocol, Study } from "./core/types.js";
import { requireThat } from "./core/validation.js";
import { runtimeFor } from "./executor/runtimes.js";
import { writeLabel } from "./history.js";
import { listCampaigns, listWorkspaces, readWorkspace, saveCampaign, sourceRecord, sourceRecordText, workspaceDir } from "./workspace.js";

/** The folder in an example suite that holds its starter (tracked in git). */
export const STARTER_FOLDER = "starter";
/** Fixed, so every machine and every rebuild of unchanged files gets the same campaign (runs zips of it merge). */
export const STARTER_FROZEN_AT = "2026-01-01T00:00:00.000Z";
export const STARTER_RUNS_PER_PARTICIPANT = 1;
export const STARTER_LABEL = "Starter · 1 run per participant";
/** In campaigns/ (git-ignored): the starters installed in this study, so a deleted one is never installed again. */
export const STARTER_MARKER = ".starters.json";
const FILES = ["campaign.json", "sources.json", "starter.json"] as const;
export type StarterFiles = Record<(typeof FILES)[number], string>;

const pretty = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
/** Engine runtimes, with the article for "… study bridge". */
const ENGINES: Record<string, string> = { unreal: "an Unreal", unity: "a Unity", visionos: "an Apple Vision Pro" };
/** What one configuration needs on the machine to run as a real agent session. */
function needs(study: Study, a: AgentProtocol): string {
  const runtime = runtimeFor(study, a);
  if (runtime === "none") return "nothing (app-free)";
  if (runtime === "webxr") return "Chrome (built-in WebXR runtime)";
  return `${ENGINES[runtime] ?? `a ${runtime}`} study bridge (Settings → Runtimes → ${runtime})`;
}
/**
 * A suite's starter as it is built from its current files: the three files' text. The campaign ID
 * names the content (the campaign and the fingerprints of what it reads), so a starter of changed
 * files never takes the ID of an earlier one.
 */
export async function buildStarter(id: string): Promise<{ campaign: Campaign; files: StarterFiles }> {
  const ws = await readWorkspace(id);
  requireThat(ws.agents, `${id} has no agents.json; a starter is frozen from the suite's own configurations.`);
  const agents = ws.agents!;
  const freeze = (campaignId: string) => campaignFromStudy(ws.study, agents, STARTER_RUNS_PER_PARTICIPANT, campaignId, STARTER_FROZEN_AT);
  const draft = freeze("campaign-starter");
  const draftSources = sourceRecord(ws.dir, ws.manifest, draft, STARTER_FROZEN_AT)!;
  const campaignId = `campaign-starter-${hash({ campaign: draft.digest, sources: draftSources.sources, app: draftSources.app }).slice(0, 12)}`;
  const campaign = freeze(campaignId);
  const sources = sourceRecord(ws.dir, ws.manifest, campaign, STARTER_FROZEN_AT)!;
  const llm = campaign.jobs.filter((j) => j.kind === "llm");
  const configurations = campaign.suite.conditions
    .filter((c) => c.kind === "llm" && c.recipe.protocol)
    .map((c) => {
      const a = agents.find((x) => x.id === c.id) ?? (c.recipe.protocol as AgentProtocol);
      return { id: c.id, label: c.label, level: agentLevel(ws.study, a), runtime: runtimeFor(ws.study, a), sessions: llm.filter((j) => j.conditionId === c.id).length, needs: needs(ws.study, a) };
    });
  const engine = [...new Set(configurations.filter((c) => ENGINES[c.runtime]).map((c) => c.runtime))];
  const appFree = configurations.filter((c) => c.runtime === "none").map((c) => c.id);
  const notes = [
    `Frozen from this suite's study.json and agents.json at ${STARTER_RUNS_PER_PARTICIPANT} run per participant (configurations with their own run count keep it), exactly as Freeze & campaigns → Freeze campaign freezes them, with a fixed ID and date so every machine gets the same campaign.`,
    "Installed into campaigns/ when the study opens with no campaign yet (and by node scripts/setup.mjs); deleting it does not bring it back. Freeze another campaign at any time.",
    "Simulate works for every configuration at no cost. Real sessions (Mode: Run agents) use your Claude Code login: start with one session (Run this session only).",
    ...(engine.length
      ? [
          `The configurations that use the app (${configurations
            .filter((c) => ENGINES[c.runtime])
            .map((c) => c.id)
            .join(", ")}) need ${engine.map((r) => `${ENGINES[r]} study bridge`).join(" or ")} in Settings → Runtimes; until one is set they can only be simulated. ${appFree.length ? `The app-free ones (${appFree.join(", ")}) run as real sessions on any machine with Claude Code.` : ""}`.trim(),
        ]
      : []),
  ];
  const starter = {
    schemaVersion: "xr-starter/1",
    label: STARTER_LABEL,
    campaignId,
    campaignDigest: campaign.digest,
    runsPerParticipant: STARTER_RUNS_PER_PARTICIPANT,
    sessions: llm.length,
    configurations,
    notes,
    rebuild: "npm run starters (after changing the suite's study.json, agents.json, workspace.json or a source file)",
  };
  return { campaign, files: { "campaign.json": pretty(campaign), "sources.json": sourceRecordText(sources), "starter.json": pretty(starter) } };
}
/** The example suites that ship a starter: every examples/<name> (and examples/<name>/<variant>) with a study.json. */
export async function exampleSuites(): Promise<string[]> {
  return (await listWorkspaces()).map((w) => w.id).filter((id) => id.startsWith("examples/")).sort();
}
const starterDir = (id: string) => join(workspaceDir(id), STARTER_FOLDER);
/** The starter files a suite has in git now (null for a missing file). */
export async function committedStarter(id: string): Promise<Record<(typeof FILES)[number], string | null>> {
  const dir = starterDir(id);
  const read = async (f: string) => (existsSync(join(dir, f)) ? readFile(join(dir, f), "utf8") : null);
  return { "campaign.json": await read("campaign.json"), "sources.json": await read("sources.json"), "starter.json": await read("starter.json") };
}
/** Why a suite's committed starter differs from one built from its current files (empty when it is current and verifies). */
export async function starterProblems(id: string): Promise<string[]> {
  const built = await buildStarter(id);
  const committed = await committedStarter(id);
  const missing = FILES.filter((f) => committed[f] === null);
  const problems = missing.map((f) => `${STARTER_FOLDER}/${f} is missing`);
  const differ = FILES.filter((f) => committed[f] !== null && committed[f] !== built.files[f]);
  if (differ.length) problems.push(`${STARTER_FOLDER}/ is out of date: ${outOfDateReasons(committed, built).join(", ")}`);
  if (committed["campaign.json"] !== null)
    try {
      verifyCampaign(JSON.parse(committed["campaign.json"]) as Campaign);
    } catch (e) {
      problems.push(`${STARTER_FOLDER}/campaign.json does not verify: ${(e as Error).message}`);
    }
  return problems;
}
/** What changed since a committed starter was built, in the suite's terms (for the stale-starter message). */
function outOfDateReasons(committed: Record<string, string | null>, built: { campaign: Campaign; files: StarterFiles }): string[] {
  const parse = <T>(text: string | null): T | null => {
    try {
      return text === null ? null : (JSON.parse(text) as T);
    } catch {
      return null;
    }
  };
  const reasons: string[] = [];
  const old = parse<Campaign>(committed["campaign.json"]);
  // The suite's digest is a function of study.json and agents.json alone (the date is fixed).
  if (old?.protocolDigest !== built.campaign.protocolDigest) reasons.push("study.json or agents.json changed");
  type Record_ = { sources?: Record<string, { path: string; sha256: string | null }>; app?: { serve: string; sha256: string | null; declared: string; query: string } | null };
  const was = parse<Record_>(committed["sources.json"]);
  const now = JSON.parse(built.files["sources.json"]) as Record_;
  for (const k of new Set([...Object.keys(was?.sources ?? {}), ...Object.keys(now.sources ?? {})])) {
    const a = was?.sources?.[k];
    const b = now.sources?.[k];
    if (a?.path !== b?.path || a?.sha256 !== b?.sha256) reasons.push(`the source "${k}" (${b?.path ?? a?.path}) changed`);
  }
  if (JSON.stringify(was?.app ?? null) !== JSON.stringify(now.app ?? null)) reasons.push(`the WebXR app (${now.app?.serve ?? was?.app?.serve ?? "workspace.json → app"}) changed`);
  if (!reasons.length) reasons.push("its files differ from a rebuild");
  return reasons;
}
/** Write a suite's starter from its current files. Returns whether anything changed. */
export async function writeStarter(id: string): Promise<{ id: string; changed: boolean; campaignId: string; sessions: number }> {
  const built = await buildStarter(id);
  const committed = await committedStarter(id);
  const dir = starterDir(id);
  await mkdir(dir, { recursive: true });
  let changed = false;
  for (const f of FILES)
    if (committed[f] !== built.files[f]) {
      await writeFile(join(dir, f), built.files[f]);
      changed = true;
    }
  return { id, changed, campaignId: built.campaign.id, sessions: built.campaign.jobs.filter((j) => j.kind === "llm").length };
}

// ---------- installing a starter into a study ----------
export type InstallState = "installed" | "not-an-example" | "no-starter" | "has-campaigns" | "installed-before" | "out-of-date";
export interface InstallResult {
  id: string;
  state: InstallState;
  campaignId: string | null;
  sessions: number | null;
  message: string;
}
interface Marker {
  installed: { campaignId: string; installedAt: string }[];
}
/** One install at a time per study (two pages opening the study together install it once). */
const installing = new Map<string, Promise<InstallResult>>();
/**
 * Install an example suite's starter into campaigns/ when the study has no campaign and never had a
 * starter installed (campaigns/.starters.json). Never for private/studies, never over a campaign,
 * and only a starter that is current (the suite's files unchanged since it was built) and verifies.
 */
export async function installStarter(id: string): Promise<InstallResult> {
  if (!id.startsWith("examples/")) return { id, state: "not-an-example", campaignId: null, sessions: null, message: "Only example suites have starter campaigns." };
  return installStarterFrom(id, starterDir(id));
}
/** installStarter from a given starter folder (installStarter, and the tests on a copy of a suite). */
export function installStarterFrom(id: string, folder: string): Promise<InstallResult> {
  const key = workspaceDir(id);
  const next = (installing.get(key) ?? Promise.resolve(null)).then(
    () => installNow(id, folder),
    () => installNow(id, folder),
  );
  installing.set(key, next);
  void next.finally(() => installing.get(key) === next && installing.delete(key)).catch(() => undefined);
  return next;
}
async function installNow(id: string, folder: string): Promise<InstallResult> {
  const result = (state: InstallState, message: string, c?: Campaign): InstallResult => ({
    id,
    state,
    campaignId: c?.id ?? null,
    sessions: c ? c.jobs.filter((j) => j.kind === "llm").length : null,
    message,
  });
  const file = (f: string) => join(folder, f);
  if (!FILES.every((f) => existsSync(file(f)))) return result("no-starter", "This suite has no starter campaign.");
  const campaigns = join(workspaceDir(id), "campaigns");
  const markerPath = join(campaigns, STARTER_MARKER);
  if (existsSync(markerPath)) return result("installed-before", "A starter campaign was installed in this study before; it is not installed again.");
  if ((await listCampaigns(id)).length) return result("has-campaigns", "This study has campaigns already; no starter is installed.");
  const text = { campaign: await readFile(file("campaign.json"), "utf8"), sources: await readFile(file("sources.json"), "utf8"), starter: await readFile(file("starter.json"), "utf8") };
  const campaign = JSON.parse(text.campaign) as Campaign;
  const starter = JSON.parse(text.starter) as { label?: string; campaignId?: string };
  try {
    verifyCampaign(campaign);
    requireThat(starter.campaignId === campaign.id && (JSON.parse(text.sources) as { campaignId?: string }).campaignId === campaign.id, "its files name different campaigns");
  } catch (e) {
    return result("out-of-date", `The starter campaign does not verify (${(e as Error).message}); rebuild it with npm run starters.`);
  }
  // Only a starter of the suite's files as they are now: one frozen from other files would be refused
  // by the executor (a source changed since it was frozen) or describe other configurations.
  const built = await buildStarter(id);
  if (built.files["campaign.json"] !== text.campaign || built.files["sources.json"] !== text.sources)
    return result("out-of-date", "The starter campaign is out of date with this suite's files (study.json, agents.json, workspace.json or a source changed); rebuild it with npm run starters, or freeze a campaign on Freeze & campaigns.");
  await saveCampaign(id, campaign);
  await writeFile(join(campaigns, campaign.id, "sources.json"), text.sources);
  await writeLabel(id, campaign.id, typeof starter.label === "string" && starter.label.trim() ? starter.label : STARTER_LABEL);
  const marker: Marker = { installed: [{ campaignId: campaign.id, installedAt: new Date().toISOString() }] };
  await writeFile(markerPath, pretty(marker));
  return result("installed", `Installed the starter campaign ${campaign.id}.`, campaign);
}
/** installStarter for every example suite (setup does this). */
export async function installStarters(): Promise<InstallResult[]> {
  const out: InstallResult[] = [];
  for (const id of await exampleSuites()) {
    try {
      out.push(await installStarter(id));
    } catch (e) {
      out.push({ id, state: "out-of-date", campaignId: null, sessions: null, message: `The starter campaign could not be installed: ${(e as Error).message}` });
    }
  }
  return out;
}
