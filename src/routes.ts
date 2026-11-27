// Workbench API for study workspaces: planner, executor, analyzer, assistant.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { readChecked, ReadRefused, realPath } from "./runtimes/guard.js";
import { choice, flag, int, object, objects, text, texts, type Body } from "./request.js";
import { campaignFromStudy, campaignPlan, conditionModel, continueFromStatus, lineageJobIndex, type Campaign, type CampaignContinuation } from "./core/campaign.js";
import { analyzeCampaign, mergeCampaignResults, simulatedJobIds, type CampaignAnalysis } from "./core/campaign-study.js";
import type { AnalysisMemo } from "./core/analyzer.js";
import { compareAgents } from "./core/agent-comparison.js";
import { compareCampaignScores } from "./core/campaign-comparison.js";
import { agentVsHumanFigure, agreementFigure, correlationFigure, figureSelection, humanFigure, populationVsIndividualFigure, trajectoryFigure } from "./core/figures.js";
import { agentLevel, agentTargets, methodGets, proposeAgents } from "./core/planner.js";
import { extractProposal } from "./core/proposal.js";
import { studyWarnings } from "./core/explain.js";
import { fairnessWarnings } from "./core/fairness.js";
import type { AgentProtocol, AnalysisOptions, Comparison, Domain, Study } from "./core/types.js";
import { checkModelSettings, requireThat } from "./core/validation.js";
import { understandStudy, explainResults } from "./assistant.js";
import { briefOverview, saveBrief } from "./brief.js";
import { closeExecutor, Executor, liveStatuses, receiptsChanged, type ExecutorEvent } from "./executor/runner.js";
import { exportRunsReport, importRuns, runRecordPath } from "./executor/archive.js";
import { LOADING, loadingInto } from "./executor/loading.js";
import { capabilityWarnings, runtimeFor, runtimeStatus, webxrDeviceWarning } from "./executor/runtimes.js";
import { approvalState, approve } from "./review.js";
import { readSettings, writeSettings, type Settings } from "./settings.js";
import {
  listCampaigns,
  listWorkspaces,
  readCampaign,
  readHuman,
  readReceipts,
  readResults,
  readStudyFolder,
  readWorkspace,
  readWorkspaceForEditing,
  saveCampaign,
  saveSourceFingerprints,
  saveWorkspace,
  missingSources,
  runDir,
  createStudy,
  changedSources,
  rerunChangedSources,
  rerunChangedApp,
  changedApp,
  receiptsWithResults,
  workspaceDir,
} from "./workspace.js";
import { campaignSummaries, deleteCampaign, forgetSummaries, sameDesignKey, sessionAttempts, writeLabel } from "./history.js";
import { installStarter } from "./starters.js";
import { evidenceOverview, knowledgeDraft, leakCheck, participantKnowledgeOverview, saveKnowledge, sourceText } from "./sources.js";

type Json = (value: unknown, status?: number) => void;
/**
 * Recent analyses, so figures and views of one analysis do not recompute it: at most
 * ANALYSES_KEPT (least recently used go first), one per study, campaign and comparisons, valid for
 * the receipts it was made from. An entry is dropped as soon as a receipt of its campaign or of a
 * campaign it reuses runs from is written, or runs are loaded into one of them.
 */
export const ANALYSES_KEPT = 8;
const analysisCache = new Map<string, { id: string; chain: string[]; receipts: number; value: CampaignAnalysis }>();
export function forgetAnalyses(id: string, campaignId: string) {
  for (const [k, v] of analysisCache) if (v.id === id && v.chain.includes(campaignId)) analysisCache.delete(k);
  for (const [k, v] of scoreMemos) if (v.id === id && v.chain.includes(campaignId)) scoreMemos.delete(k);
}
/**
 * The scores of the last analyses of a campaign without their comparisons (AnalysisMemo), so
 * choosing other comparisons computes only the comparisons: at most SCORES_KEPT campaigns, valid
 * for the receipts and human.json they were computed from (dropped like the analyses).
 */
const SCORES_KEPT = 2;
/** Figure data per analysis (dropped with it). Labels come from the campaign, which the analysis belongs to. */
const figureCache = new WeakMap<CampaignAnalysis, Map<string, unknown>>();
const scoreMemos = new Map<string, { id: string; chain: string[]; receipts: number; human: string; memo: AnalysisMemo }>();
receiptsChanged.add(forgetAnalyses);
/** For the tests: how many analyses are kept now. */
export const cachedAnalyses = () => analysisCache.size;

/** Agent configs of a workspace, or templates with your default forecasting model when none exist yet. */
async function configs(study: Study, saved: AgentProtocol[] | null, settings: Settings) {
  if (saved) return saved;
  const templates = await proposeAgents(study);
  return templates.map((a) => ({
    ...a,
    model: { provider: settings.forecasting.provider, model: settings.forecasting.model, reasoning: settings.forecasting.reasoning },
  }));
}
async function lineage(id: string, campaign: Campaign) {
  const all = await listCampaigns(id);
  return [...(campaign.lineage ?? []).map((d) => all.find((c) => c.digest === d)!).filter(Boolean), campaign];
}
async function analysis(id: string, campaignId: string, comparisons?: Comparison[], options: AnalysisOptions = {}) {
  const campaign = await readCampaign(id, campaignId);
  const chain = await lineage(id, campaign);
  const receipts = await receiptsWithResults(id, chain.map((c) => c.id));
  const key = `${id}|${campaign.digest}|${JSON.stringify(comparisons ?? null)}|${options.excludeIncomplete ? "complete-only" : "all"}`;
  const kept = analysisCache.get(key);
  if (kept && kept.receipts === receipts.length) {
    // Most recently used last.
    analysisCache.delete(key);
    analysisCache.set(key, kept);
    return { campaign, analysis: kept.value, receipts };
  }
  const human = await readHuman(id);
  requireThat(human, "This study has no human reference (human.json) yet; the analyzer needs it.");
  const bundles = await readResults(id, campaign.suite.study!, chain.map((c) => c.id));
  requireThat(bundles.length, "No results yet. Run or simulate jobs in the executor, or load a runs zip.");
  // comparisons.json belongs to the study; a campaign may freeze only some of its configurations.
  const present = new Set(campaign.suite.conditions.map((c) => c.id));
  const usable = comparisons?.filter((c) => present.has(c?.candidate) && present.has(c?.baseline));
  const skipped = (comparisons ?? []).filter((c) => !usable?.includes(c));
  // Scores computed for other comparisons of the same campaign, receipts and human data are reused.
  const memoKey = `${id}|${campaign.digest}`;
  const humanStat = statSync(join(workspaceDir(id), "human.json"));
  const humanStamp = `${humanStat.size} ${humanStat.mtimeMs} ${humanStat.ino}`;
  let scores = scoreMemos.get(memoKey);
  if (!scores || scores.receipts !== receipts.length || scores.human !== humanStamp)
    scores = { id, chain: chain.map((c) => c.id), receipts: receipts.length, human: humanStamp, memo: new Map() };
  scoreMemos.delete(memoKey);
  scoreMemos.set(memoKey, scores);
  while (scoreMemos.size > SCORES_KEPT) scoreMemos.delete(scoreMemos.keys().next().value!);
  // Receipts name why a session failed (report exclusions and audits).
  const result = analyzeCampaign(campaign, human!, bundles, usable, receipts, scores.memo, options);
  if (skipped.length)
    result.report.notes.push(
      `Skipped ${skipped.length} saved comparison(s) whose configurations are not in this campaign: ${skipped.map((c) => `${c.candidate} − ${c.baseline} (${c.domain})`).join("; ")}. The Holm family covers the remaining ${usable!.length}.`,
    );
  analysisCache.delete(key);
  analysisCache.set(key, { id, chain: chain.map((c) => c.id), receipts: receipts.length, value: result });
  while (analysisCache.size > ANALYSES_KEPT) analysisCache.delete(analysisCache.keys().next().value!);
  return { campaign, analysis: result, receipts };
}
/**
 * A screenshot of a session in this campaign's run folder (jobs/<job>/a<n>/screenshots/<name>.jpg|png).
 * The study and campaign IDs are checked like everywhere else, and the file, with symlinks resolved,
 * must stay inside the campaign's run folder and have no other name on disk (a hard link could be
 * human.json).
 */
export function screenshotFile(id: string, campaignId: string, rel: string): string {
  const base = runDir(id, campaignId);
  // Answered with 404, whatever the reason, so a request learns nothing about other files.
  const notFound = () => Object.assign(new Error("Not found."), { status: 404 });
  if (!/^jobs\/[A-Za-z0-9_.-]{1,300}\/a\d{1,6}\/screenshots\/[^/\\:\0-\x1f]{1,200}\.(jpg|png)$/.test(rel) || rel.split("/").some((s) => s === "." || s === "..")) throw notFound();
  let root: string, real: string;
  try {
    root = realPath(base);
    real = realPath(join(base, ...rel.split("/")));
  } catch {
    throw notFound();
  }
  const st = statSync(real);
  // No link on the way either, not even to another file of the same run folder: the path resolves to itself.
  if (real !== join(root, ...rel.split("/")) || !real.startsWith(root + sep) || !st.isFile() || st.nlink !== 1) throw notFound();
  return real;
}
/** A screenshot's bytes (see screenshotFile), read from the file that was checked (readChecked). */
export async function screenshotBytes(id: string, campaignId: string, rel: string): Promise<Buffer> {
  const file = screenshotFile(id, campaignId, rel);
  try {
    return await readChecked(file, { protect: [join(workspaceDir(id), "human.json")] });
  } catch (e) {
    if (e instanceof ReadRefused) throw Object.assign(new Error("Not found."), { status: 404 });
    throw e;
  }
}
/** Session IDs of a request, each a session of this campaign. */
function jobIdsOf(body: Body, ex: Executor): string[] | undefined {
  const ids = texts(body, "jobIds", { optional: true, maxItems: 100_000, max: 300 });
  const unknown = ids?.find((j) => !ex.jobs.has(j));
  requireThat(unknown === undefined, `Unknown session: ${String(unknown).slice(0, 120)}. Reload the page.`);
  return ids;
}
/** Comparisons chosen at analysis: a list of { candidate, baseline, domain }. */
function comparisonsOf(body: Body): Comparison[] | undefined {
  const list = objects(body, "comparisons", { optional: true, maxItems: 1000 });
  requireThat(
    !list || list.every((c) => typeof c.candidate === "string" && typeof c.baseline === "string" && (c.domain === "objective" || c.domain === "subjective")),
    'Invalid request: each comparison needs "candidate", "baseline" and "domain" (objective or subjective).',
  );
  return list as unknown as Comparison[] | undefined;
}
/** Analysis choices in a request: { excludeIncomplete } leaves out incomplete sessions. */
function analysisOptions(body: Body): AnalysisOptions {
  return flag(body, "excludeIncomplete") ? { excludeIncomplete: true } : {};
}
/** How long the event stream gathers session changes before sending them in one "jobs" event. */
export const SSE_BATCH_MS = 250;
/**
 * The executor's live events for the website. Session changes are sent at most every
 * SSE_BATCH_MS as one "jobs" event with only the fields that changed since this stream last sent
 * them (a simulated session changes at every step; thousands of sessions made tens of thousands of
 * whole-session events). Log and state events go out at once, after the session changes before
 * them; a state event carries the executor's state (counts, queue, mode), so the page need not
 * fetch every session again.
 */
function sse(res: ServerResponse, ex: Executor) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const snapshot = ex.snapshot();
  res.write(`data: ${JSON.stringify({ type: "snapshot", snapshot })}\n\n`);
  const sent = new Map<string, Record<string, unknown>>(snapshot.jobs.map((j) => [j.jobId, { ...j }]));
  const changed = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!changed.size) return;
    const jobs: Record<string, unknown>[] = [];
    for (const jobId of changed) {
      const now = ex.jobs.get(jobId) as unknown as Record<string, unknown> | undefined;
      if (!now) continue;
      const before = sent.get(jobId) ?? {};
      const fields: Record<string, unknown> = { jobId };
      for (const [k, v] of Object.entries(now)) if (!Object.is(before[k], v)) fields[k] = v;
      sent.set(jobId, { ...now });
      if (Object.keys(fields).length > 1) jobs.push(fields);
    }
    changed.clear();
    if (jobs.length) res.write(`data: ${JSON.stringify({ type: "jobs", t: Date.now(), jobs })}\n\n`);
  };
  const listener = (e: ExecutorEvent) => {
    if (e.type === "job" && e.jobId) {
      changed.add(e.jobId);
      timer ??= setTimeout(flush, SSE_BATCH_MS);
      return;
    }
    flush();
    res.write(`data: ${JSON.stringify(e.type === "state" ? { ...e, state: ex.state() } : e)}\n\n`);
  };
  ex.listeners.add(listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
    if (timer) clearTimeout(timer);
    ex.listeners.delete(listener);
  });
}

export async function handleGet(path: string, url: URL, res: ServerResponse, json: Json): Promise<boolean> {
  const id = url.searchParams.get("id") ?? "";
  const campaignId = url.searchParams.get("campaign") ?? "";
  switch (path) {
    case "/api/workspaces":
      json(await listWorkspaces());
      return true;
    case "/api/workspace": {
      // Opens even when the saved study and configurations disagree: the problem is returned to show and fix.
      const ws = await readWorkspaceForEditing(id);
      // An example suite opened with no campaign yet gets its starter campaign, once (src/starters.ts).
      if (id.startsWith("examples/"))
        await installStarter(id).then(
          (r) => r.state === "installed" && console.log(`${id}: ${r.message}`),
          (e) => console.error(`${id}: the starter campaign could not be installed:`, (e as Error).message),
        );
      const settings = await readSettings();
      const agents = await configs(ws.study, ws.agents, settings);
      const each = <T>(f: (a: AgentProtocol) => T, fallback: T) =>
        Object.fromEntries(
          agents.map((a) => {
            try {
              return [a.id, f(a)];
            } catch {
              return [a.id, fallback];
            }
          }),
        );
      json({
        id,
        study: ws.study,
        agents,
        agentsSaved: !!ws.agents,
        comparisons: ws.comparisons,
        manifest: ws.manifest,
        hasHuman: existsSync(join(ws.dir, "human.json")),
        approval: await approvalState(join(ws.dir, "study.json"), ws.study, (!ws.problem && ws.agents) || undefined).catch(() => ({ approved: false, current: false, approval: null })),
        // Fairness of what the agents get (fairness.ts): shown on Study & variables and Freeze & campaigns.
        warnings: (() => {
          try {
            const device = webxrDeviceWarning(ws.study, agents);
            return [...(device ? [device] : []), ...fairnessWarnings(ws.study, agents, ws.comparisons)];
          } catch {
            return [] as string[];
          }
        })(),
        gets: each((a) => methodGets(a, ws.study), [] as string[]),
        runtimes: each((a) => runtimeFor(ws.study, a), "none"),
        missingSources: each((a) => missingSources(ws.dir, ws.study, ws.manifest, a.sourceIds).map((m) => m.label), [] as string[]),
        // Whether each source has a usable (complete) file on this machine, for the configuration templates.
        sourceFiles: Object.fromEntries(
          ws.study.sources.map((s) => {
            try {
              return [s.id, !missingSources(ws.dir, ws.study, ws.manifest, [s.id]).length];
            } catch {
              return [s.id, false];
            }
          }),
        ),
        // Open executors count as their table shows.
        campaigns: await campaignSummaries(id, (c) => liveStatuses(id, c)),
        problem: ws.problem,
        // Planning warnings (no human values read), e.g. too few people for any significant difference.
        studyWarnings: studyWarnings(ws.study),
        // Per configuration: what it names that the study lacks, so the page can offer to remove it.
        problems: ws.problems,
        // Required capabilities the app or a runtime does not declare (Start refuses those configurations).
        capabilityWarnings: (() => {
          try {
            return capabilityWarnings(ws.study, agents, ws.manifest, settings);
          } catch {
            return [];
          }
        })(),
      });
      return true;
    }
    case "/api/workspace/campaigns":
      // Progress of every campaign; open executors count as their table shows.
      json(await campaignSummaries(id, (c) => liveStatuses(id, c)));
      return true;
    case "/api/workspace/campaign-inputs": {
      // What the agents of a frozen campaign get: its own frozen sources, not the study as it is now.
      const ws = await readStudyFolder(id);
      const campaign = await readCampaign(id, campaignId);
      const frozen = campaign.suite.study!;
      const protocols = campaign.suite.conditions.flatMap((c) => (c.kind === "llm" && c.recipe.protocol ? [c.recipe.protocol] : []));
      json(
        frozen.sources
          .filter((s) => ["brief", "project", "evidence"].includes(s.kind))
          .map((s) => ({
            id: s.id,
            label: s.label,
            kind: s.kind,
            configs: protocols.filter((p) => p.sourceIds.includes(s.id)).length,
            path: ws.manifest.sources?.[s.id] ?? null,
            // Deleted from the study after this campaign was frozen.
            removed: !ws.study.sources.some((x) => x.id === s.id && x.kind === s.kind),
            // Still a source of the study with a file here, so it can be opened.
            readable: ws.study.sources.some((x) => x.id === s.id && x.kind === s.kind) && !!ws.manifest.sources?.[s.id],
          }))
          .filter((s) => s.configs > 0),
      );
      return true;
    }
    case "/api/settings":
      json(await readSettings());
      return true;
    case "/api/runtimes": {
      const ws = await readStudyFolder(id);
      const settings = await readSettings();
      // The study's required capabilities: a ready runtime that lacks one says so on its card.
      json(["none", "webxr", "unreal", "unity", "visionos"].map((r) => runtimeStatus(r, settings, ws.manifest, ws.study.runtime.requiredCapabilities ?? [])));
      return true;
    }
    case "/api/workspace/source": {
      // What agents get (brief, project, evidence), as plain text for the researcher. Never human data.
      const text = await sourceText(id, url.searchParams.get("source") ?? "");
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });
      res.end(text);
      return true;
    }
    case "/api/workspace/evidence": {
      const ws = await readWorkspaceForEditing(id);
      json({ brief: await briefOverview(id, ws.agents ?? []), general: await evidenceOverview(id, ws.agents ?? []), participants: await participantKnowledgeOverview(id, ws.agents ?? []) });
      return true;
    }
    case "/api/executor/attempts":
      json(await sessionAttempts(id, await readCampaign(id, campaignId), url.searchParams.get("job") ?? ""));
      return true;
    case "/api/executor/state":
      json((await Executor.open(id, campaignId)).snapshot());
      return true;
    case "/api/executor/events":
      sse(res, await Executor.open(id, campaignId));
      return true;
    case "/api/workspace/file": {
      // Only run screenshots are served (for the executor's live view).
      const rel = url.searchParams.get("path") ?? "";
      const bytes = await screenshotBytes(id, campaignId, rel);
      res.writeHead(200, { "Content-Type": rel.endsWith(".png") ? "image/png" : "image/jpeg" });
      res.end(bytes);
      return true;
    }
    case "/api/runs/export": {
      // Links, entries that are not plain files, and files or records Load runs zip would refuse are
      // left out (counted, with the reasons, in the zip's manifest.json → skipped).
      const { zip, skipped } = await exportRunsReport(id, campaignId);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="runs-${campaignId}.zip"`,
        "X-Runs-Skipped": String(skipped.notFiles + skipped.unfinished + skipped.names + skipped.invalid + skipped.records),
        // Why files or records were left out for their contents (also in the zip's manifest.json), URI-encoded.
        "X-Runs-Skipped-Reasons": encodeURIComponent(Array.from(skipped.reasons.join("\n")).slice(0, 1000).join("").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")),
      });
      res.end(zip);
      return true;
    }
  }
  return false;
}

export async function handlePost(path: string, body: Body, json: Json): Promise<boolean> {
  // Typed fields only (src/request.ts): a wrong type is refused with a plain message, never converted.
  const id = text(body, "id", { optional: true, max: 300 });
  const campaignId = (key = "campaignId") => text(body, key, { max: 200 });
  switch (path) {
    case "/api/settings":
      json(await writeSettings(object(body, "settings") as unknown as Settings));
      return true;
    case "/api/workspace/create":
      json(await createStudy(text(body, "name", { optional: true, max: 200 })));
      return true;
    case "/api/workspace/save":
      await saveWorkspace(id, {
        study: object(body, "study", { optional: true }) as unknown as Study | undefined,
        agents: objects(body, "agents", { optional: true, maxItems: 1000 }) as unknown as AgentProtocol[] | undefined,
        comparisons: comparisonsOf(body),
      });
      json({ saved: true });
      return true;
    case "/api/workspace/approve": {
      const ws = await readWorkspace(id);
      requireThat(ws.agents, "Save the agent configurations before approving.");
      const a = await approve(join(ws.dir, "study.json"), ws.study, ws.agents!, text(body, "note", { optional: true, max: 100_000 }).slice(0, 2000));
      json(a);
      return true;
    }
    case "/api/workspace/freeze": {
      // repetitions = runs per participant; configurations without their own count get it resolved here.
      const perParticipant = int(body, "repetitions", { min: 1, max: 50, fallback: 1 });
      const check = flag(body, "check");
      const label = text(body, "label", { optional: true, max: 1000 });
      const ws = await readWorkspace(id);
      const settings = await readSettings();
      const agents = await configs(ws.study, ws.agents, settings);
      const campaign = campaignFromStudy(ws.study, agents, perParticipant);
      if (check) {
        // Warn before repeating a campaign: same configurations, models and sessions.
        const key = sameDesignKey(campaign);
        json({ duplicates: (await campaignSummaries(id)).filter((c) => c.designKey === key).map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt })), jobs: campaign.jobs.filter((j) => j.kind === "llm").length });
        return true;
      }
      await saveCampaign(id, campaign);
      // What the sources hold now, beside the campaign: the executor refuses sessions whose source changed since.
      await saveSourceFingerprints(id, campaign);
      if (label.trim()) await writeLabel(id, campaign.id, label);
      // The freeze goes ahead; a study device the WebXR runtime does not report is said here too.
      const device = webxrDeviceWarning(ws.study, agents);
      json({ campaignId: campaign.id, jobs: campaign.jobs.length, warnings: device ? [device] : [] });
      return true;
    }
    case "/api/workspace/human-figure": {
      // Human data only (no agent runs needed). Only once a campaign is frozen, so human results
      // stay hidden while the study and configurations are planned.
      const outcomeId = text(body, "outcomeId", { optional: true, max: 200 });
      const campaign = await readCampaign(id, campaignId());
      const human = await readHuman(id);
      requireThat(human, "This study has no human reference (human.json) yet.");
      const study = campaign.suite.study!;
      json(humanFigure(study, human!, outcomeId || study.outcomes[0].id));
      return true;
    }
    case "/api/workspace/compare-agents": {
      // Configurations against each other: needs no human data.
      const campaign = await readCampaign(id, campaignId());
      const chain = await lineage(id, campaign);
      const bundles = await readResults(id, campaign.suite.study!, chain.map((c) => c.id));
      const merged = mergeCampaignResults(campaign, bundles).bundle;
      const receipts = await readReceipts(id, chain.map((c) => c.id));
      const dirOf = new Map(chain.map((c) => [c.digest, runDir(id, c.id)]));
      // Receipts name the job of the campaign that ran it; reused runs get this campaign's job ID,
      // as in the merged results. The first completed attempt is the one that counts.
      const index = lineageJobIndex(campaign);
      const extras: Record<string, { costUsd: number | null }> = {};
      for (const r of receipts) {
        const jobId = index.get(`${r.campaignDigest}/${r.jobId}`);
        if (!jobId || r.status !== "completed" || !r.executionManifest || extras[jobId]) continue;
        extras[jobId] = { costUsd: null };
        // Only a manifest inside the run folder of the campaign that ran the session.
        const path = dirOf.has(r.campaignDigest) ? runRecordPath(dirOf.get(r.campaignDigest)!, r.executionManifest.path) : null;
        if (!path) continue;
        try {
          const m = JSON.parse(await readFile(path, "utf8")) as { costUsd?: number | null };
          extras[jobId] = { costUsd: typeof m.costUsd === "number" ? m.costUsd : null };
        } catch {
          // manifest not here (e.g. a partial zip)
        }
      }
      // The study's saved comparisons name which configurations are compared (for the model check in the notes).
      const comparisons = (await readStudyFolder(id).catch(() => null))?.comparisons ?? [];
      json({ campaignId: campaign.id, ...compareAgents(campaignPlan(campaign), merged.runs, extras, comparisons) });
      return true;
    }
    case "/api/workspace/knowledge-draft":
      requireThat(typeof body.base64 === "string" && typeof body.name === "string", "Choose a file.");
      json(await knowledgeDraft(id, text(body, "name", { max: 300 }), Buffer.from(text(body, "base64", { max: 400 * 1024 * 1024 }), "base64")));
      return true;
    case "/api/workspace/knowledge-save": {
      const write = objects(body, "write", { optional: true, maxItems: 200 });
      requireThat(
        !write || write.every((w) => typeof w.sourceId === "string" && typeof w.path === "string" && w.path.length <= 300 && typeof w.text === "string"),
        'Invalid request: each file to write needs "sourceId", "path" and "text" as texts.',
      );
      json(
        await saveKnowledge(id, {
          study: object(body, "study"),
          agents: objects(body, "agents", { maxItems: 1000 }),
          write: write as { sourceId: string; path: string; text: string }[] | undefined,
          unmap: texts(body, "unmap", { optional: true, maxItems: 1000 }),
        }),
      );
      return true;
    }
    case "/api/workspace/brief-save":
      json(await saveBrief(id, text(body, "text", { max: 2_000_000 })));
      return true;
    case "/api/workspace/campaign-delete": {
      const c = campaignId();
      // The study ID is canonical (workspaceDir), so this finds the executor that runs its sessions.
      closeExecutor(id, c);
      forgetAnalyses(id, c);
      forgetSummaries(id, c);
      json(await deleteCampaign(id, c));
      return true;
    }
    case "/api/workspace/campaign-label":
      json(await writeLabel(id, campaignId(), text(body, "label", { optional: true, max: 1000 })));
      return true;
    case "/api/workspace/continue": {
      const changes = object(body, "changes") as unknown as CampaignContinuation;
      const preview = flag(body, "preview"),
        keepSimulated = flag(body, "keepSimulated");
      const previous = await readCampaign(id, campaignId());
      const chain = await lineage(id, previous);
      // Not from records a runs zip is being written into (see loading.ts).
      const loading = () => requireThat(!chain.some((c) => loadingInto(id!, c)), LOADING);
      loading();
      // Always from what actually happened: only sessions with an accepted forecast and their result
      // file are reused. Failed, stopped and never-started sessions run again, and so do simulated
      // ones unless body.keepSimulated. (body.useReceipts is no longer needed; receipts are always read.)
      const receipts = await receiptsWithResults(id, chain.map((c) => c.id));
      // Model settings Claude Code would refuse at run time are refused now.
      checkModelSettings(changes?.model, "the new default model");
      for (const [c, m] of Object.entries(changes?.conditionModels ?? {})) checkModelSettings(m, c);
      for (const c of changes?.cloneConditions ?? []) checkModelSettings(c?.model, c?.label ?? c?.id ?? "the added model");
      const bundles = previous.suite.study ? await readResults(id, previous.suite.study, chain.map((c) => c.id)) : [];
      const simulatedBefore = simulatedJobIds(previous, bundles);
      // Configurations that read a source changed since the parent was frozen run again: their
      // finished runs used the old version (recorded as rerunConditions in the change set).
      const { manifest } = await readStudyFolder(id);
      const sourceReruns = rerunChangedSources(previous, await changedSources(id, previous, manifest), changes);
      // Likewise the configurations that play the WebXR app, when the app changed.
      const appReruns = rerunChangedApp(previous, await changedApp(id, previous, manifest), sourceReruns.changes);
      const sourceNotes = [...sourceReruns.notes, ...appReruns.notes];
      const next = continueFromStatus(previous, receipts, appReruns.changes, undefined, undefined, {
        simulatedJobIds: simulatedBefore,
        keepSimulated,
        receiptsComplete: true,
      });
      const reused = next.jobs.filter((j) => j.inheritedFrom).length;
      // Simulated runs the continuation reuses (keepSimulated), and ones it runs again.
      const simulatedNow = simulatedJobIds(next, bundles);
      const templateOf = new Map(previous.jobs.map((j) => [j.templateJobId, j.id]));
      const simulated = Object.fromEntries(
        next.suite.conditions.map((c) => {
          const jobs = next.jobs.filter((j) => j.conditionId === c.id);
          return [
            c.id,
            {
              reused: jobs.filter((j) => simulatedNow.has(j.id)).length,
              runAgain: jobs.filter((j) => !j.inheritedFrom && simulatedBefore.has(templateOf.get(j.templateJobId) ?? "")).length,
            },
          ];
        }),
      );
      const totals = Object.values(simulated).reduce((s, x) => ({ reused: s.reused + x.reused, runAgain: s.runAgain + x.runAgain }), { reused: 0, runAgain: 0 });
      if (preview) {
        // What the website shows: counts per configuration. The whole new campaign (megabytes for
        // large studies) only when asked for with "full".
        const llm = next.jobs.filter((j) => j.kind === "llm");
        json({
          preview: true,
          keepSimulated,
          simulated: { ...totals, byCondition: simulated },
          sourceChanges: sourceNotes,
          continuation: next.continuation ?? null,
          sessions: { total: llm.length, new: llm.filter((j) => !j.inheritedFrom).length, reused: next.jobs.filter((j) => j.inheritedFrom).length },
          conditions: next.suite.conditions.map((c) => {
            const jobs = next.jobs.filter((j) => j.conditionId === c.id);
            return { id: c.id, label: c.label, model: next.conditionModels?.[c.id] ?? next.model, sessions: jobs.length, reused: jobs.filter((j) => j.inheritedFrom).length };
          }),
          ...(flag(body, "full") ? { campaign: next } : {}),
        });
        return true;
      }
      loading();
      await saveCampaign(id, next);
      await saveSourceFingerprints(id, next);
      json({ campaignId: next.id, reused, jobs: next.jobs.length, reusedSimulated: totals.reused, simulatedRunAgain: totals.runAgain, sourceChanges: sourceNotes });
      return true;
    }
    case "/api/executor/start": {
      const mode = choice(body, "mode", ["agent", "simulate"] as const, "simulate");
      const ex = await Executor.open(id, campaignId());
      json(await ex.start(mode, jobIdsOf(body, ex)));
      return true;
    }
    case "/api/executor/blockers": {
      const ex = await Executor.open(id, campaignId());
      json(await ex.blockers(jobIdsOf(body, ex) ?? [...ex.jobs.keys()]));
      return true;
    }
    case "/api/executor/estimate": {
      const ex = await Executor.open(id, campaignId());
      json(await ex.estimate(jobIdsOf(body, ex) ?? []));
      return true;
    }
    case "/api/executor/pause":
      json((await Executor.open(id, campaignId())).pause());
      return true;
    case "/api/executor/resume":
      json((await Executor.open(id, campaignId())).resume());
      return true;
    case "/api/executor/stop":
      json((await Executor.open(id, campaignId())).stop());
      return true;
    case "/api/runs/import": {
      requireThat(typeof body.base64 === "string", "Choose a runs zip.");
      // Loading into a campaign whose sessions are running is refused; otherwise its executor reloads from disk.
      let changed: string[] = [];
      const loaded = await importRuns(id, Buffer.from(body.base64, "base64"), (campaignIds) => {
        changed = campaignIds;
        campaignIds.forEach((c) => {
          closeExecutor(id, c);
          // Their analyses (and those of continuations from them) are out of date.
          forgetAnalyses(id, c);
          forgetSummaries(id, c);
        });
      });
      // Continuations of a campaign that gained records show their reused sessions from it
      // (simulated or real, tokens, cost): once the zip is written, their executors reload too,
      // unless sessions of theirs are running.
      // Summaries computed while the zip was being written count again from the files now there.
      changed.forEach((c) => forgetSummaries(id, c));
      if (loaded.written + loaded.updated > 0) {
        const all = await listCampaigns(id);
        const digests = new Set(all.filter((c) => changed.includes(c.id)).map((c) => c.digest));
        for (const c of all)
          if (!changed.includes(c.id) && (c.lineage ?? []).some((d) => digests.has(d)))
            try {
              closeExecutor(id, c.id);
            } catch {
              // running: it keeps what it showed until its sessions end and it is opened again
            }
      }
      json(loaded);
      return true;
    }
    case "/api/workspace/analyze": {
      const { campaign, analysis: a, receipts } = await analysis(id, campaignId(), comparisonsOf(body), analysisOptions(body));
      const study = campaign.suite.study!;
      // Interim or final: only sessions with an accepted result count as finished, their own or the
      // run they reuse (a completed receipt where it ran, or its result in the lineage). A session
      // an early continuation marked as reused without one never ran, like a session never started.
      const llmJobs = campaign.jobs.filter((j) => j.kind === "llm");
      const mine = receipts.filter((r) => r.campaignDigest === campaign.digest);
      const tried = new Set(mine.map((r) => r.jobId));
      const completedWhereRan = new Set(receipts.filter((r) => r.status === "completed").map((r) => `${r.campaignDigest}/${r.jobId}`));
      const returned = new Set(a.report.audits.filter((x) => x.completed).map((x) => x.jobId));
      const accepted = (j: (typeof llmJobs)[number]) =>
        returned.has(j.id) || completedWhereRan.has(j.inheritedFrom ? `${j.inheritedFrom.campaignDigest}/${j.inheritedFrom.jobId}` : `${campaign.digest}/${j.id}`);
      const notStarted = new Set(llmJobs.filter((j) => !accepted(j) && (j.inheritedFrom || !tried.has(j.id))).map((j) => j.id));
      const progress = {
        sessions: llmJobs.length,
        finished: llmJobs.filter(accepted).length,
        failed: llmJobs.filter((j) => !j.inheritedFrom && tried.has(j.id) && !accepted(j)).length,
        notStarted: notStarted.size,
        reusedNeverRan: llmJobs.filter((j) => j.inheritedFrom && !accepted(j)).length,
      };
      json({
        campaignId: campaign.id,
        configs: campaign.suite.conditions.map((c) => ({
          id: c.id,
          label: c.label,
          level: agentLevel(study, { ...c.recipe.protocol!, model: a.models[c.id] } as AgentProtocol),
          model: a.models[c.id],
          targets: agentTargets(study, { ...c.recipe.protocol!, model: a.models[c.id] } as AgentProtocol),
        })),
        outcomes: study.outcomes.map((o) => ({ id: o.id, label: o.label, domain: o.domain, unit: o.unit })),
        summaries: a.report.summaries,
        contrasts: a.report.contrasts,
        design: study.design,
        pairRule: a.report.pairRule ?? "means",
        humanPairs: a.report.humanPairs ?? [],
        absoluteFit: a.report.absoluteFit ?? [],
        significantOnly: a.report.significantOnly ?? null,
        // Sessions never run are counted in progress, not listed as lost runs; a failed one says why
        // it failed (analyzeCampaign reads the receipts).
        audits: a.report.audits.filter((x) => (!x.compliant || !x.scoreable) && !notStarted.has(x.jobId)).slice(0, 200),
        progress,
        assigned: a.report.audits.length,
        notes: a.report.notes,
        exclusions: a.report.exclusions,
        reused: a.reused.length,
        synthetic: a.report.synthetic,
        scorecard: a.scorecard,
      });
      return true;
    }
    case "/api/workspace/figure": {
      const ids = texts(body, "agentIds", { optional: true, maxItems: 1000 }) ?? [];
      requireThat(ids.length, "Select at least one agent configuration.");
      const domain: Domain = choice(body, "domain", ["objective", "subjective"] as const, "subjective");
      const kind = text(body, "kind", { max: 100 });
      const outcomeId = text(body, "outcomeId", { optional: true, max: 200 });
      const { campaign, analysis: a } = await analysis(id, campaignId(), comparisonsOf(body), analysisOptions(body));
      const study = campaign.suite.study!;
      const labels = Object.fromEntries(campaign.suite.conditions.map((c) => [c.id, c.label]));
      // Figures follow the summaries: unscored partial configurations and measures a configuration does not predict are left out, with a note.
      const protocols = Object.fromEntries(
        campaign.suite.conditions.map((c) => {
          const p = { ...c.recipe.protocol!, model: a.models[c.id] } as AgentProtocol;
          return [c.id, { level: agentLevel(study, p), targets: agentTargets(study, p) }];
        }),
      );
      const shown = figureSelection(study, a.report, ids, protocols, labels, kind === "agent-vs-human" ? { outcomeId } : kind === "correlation" ? {} : { domain });
      requireThat(shown.ids.length, `None of the chosen configurations can be shown here. ${shown.omitted.join(" ")}`);
      // Figures of one analysis are computed once each (the same configurations, view and measure).
      const figures = figureCache.get(a) ?? new Map<string, unknown>();
      figureCache.set(a, figures);
      const figureKey = JSON.stringify([kind, shown.ids, kind === "agent-vs-human" ? outcomeId : kind === "correlation" ? null : domain]);
      const figure =
        figures.get(figureKey) ??
        (kind === "agreement"
          ? agreementFigure(a.report, shown.ids, domain, labels)
          : kind === "agent-vs-human"
          ? agentVsHumanFigure(study, a.report, shown.ids, outcomeId, labels)
          : kind === "correlation"
          ? correlationFigure(study, a.report, shown.ids, labels)
          : kind === "population-vs-individual"
          ? populationVsIndividualFigure(study, a.report, shown.ids, domain, labels)
          : kind === "trajectories"
          ? trajectoryFigure(a.report, shown.ids, domain, labels)
          : (() => {
              throw new Error("Unknown figure.");
            })());
      figures.set(figureKey, figure);
      json({ ...(figure as object), omitted: shown.omitted });
      return true;
    }
    case "/api/workspace/compare": {
      const comparisons = comparisonsOf(body);
      const before = await analysis(id, campaignId("before"), comparisons, analysisOptions(body));
      const after = await analysis(id, campaignId("after"), comparisons, analysisOptions(body));
      json(compareCampaignScores(before.campaign, before.analysis.scorecard, after.campaign, after.analysis.scorecard));
      return true;
    }
    case "/api/assistant/understand": {
      requireThat(typeof body.name === "string" && typeof body.base64 === "string", "Choose a document.");
      const name = text(body, "name", { max: 300 });
      const participantsCsv = text(body, "participantsCsv", { optional: true, max: 20_000_000 }) || null;
      const document = await extractProposal(name, Buffer.from(text(body, "base64", { max: 400 * 1024 * 1024 }), "base64"));
      const current = id ? (await readStudyFolder(id)).study : null;
      const r = await understandStudy(document, participantsCsv, current);
      // The drafted brief goes through the same outcome-blind check as knowledge (counts only).
      json({ ...r, brief: r.brief ? { text: r.brief, check: id ? await leakCheck(id, r.study, r.brief) : null } : null });
      return true;
    }
    case "/api/assistant/explain": {
      const { campaign, analysis: a } = await analysis(id, campaignId(), comparisonsOf(body), analysisOptions(body));
      const study = campaign.suite.study!;
      // Every configuration by name, with what it gets, its level, model and effort, so the answer uses names and invents no differences.
      const configurations = campaign.suite.conditions.flatMap((c) => {
        if (!c.recipe.protocol) return [];
        const model = a.models[c.id] ?? conditionModel(campaign, c.id);
        const protocol = { ...c.recipe.protocol, model } as AgentProtocol;
        return [{ id: c.id, name: c.label, level: agentLevel(study, protocol), model: model.model, effort: model.reasoning, gets: methodGets(protocol, study) }];
      });
      json({
        text: await explainResults(
          {
            summaries: a.report.summaries,
            contrasts: a.report.contrasts,
            exclusions: a.report.exclusions,
            notes: a.report.notes,
          },
          configurations,
        ),
      });
      return true;
    }
  }
  return false;
}
export type { IncomingMessage };
