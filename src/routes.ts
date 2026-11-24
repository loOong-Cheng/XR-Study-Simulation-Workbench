// Workbench API for study workspaces: planner, executor, analyzer, assistant.
import type { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { realPath } from "./runtimes/guard.js";
import { choice, flag, int, object, objects, text, texts, type Body } from "./request.js";
import { campaignFromPlan, campaignPlan, conditionModel, continueFromStatus, lineageJobIndex, type Campaign, type CampaignContinuation } from "./core/campaign.js";
import { analyzeCampaign, mergeCampaignResults, simulatedJobIds, type CampaignAnalysis } from "./core/campaign-study.js";
import { compareAgents } from "./core/agent-comparison.js";
import { compareCampaignScores } from "./core/campaign-comparison.js";
import { agentVsHumanFigure, agreementFigure, correlationFigure, figureSelection, humanFigure, populationVsIndividualFigure, trajectoryFigure } from "./core/figures.js";
import { agentLevel, agentTargets, freezePlan, methodGets, proposeAgents, withDefaultRuns } from "./core/planner.js";
import { extractProposal } from "./core/proposal.js";
import type { AgentProtocol, Comparison, Domain, Study } from "./core/types.js";
import { checkModelSettings, requireThat } from "./core/validation.js";
import { understandStudy, explainResults } from "./assistant.js";
import { briefOverview, saveBrief } from "./brief.js";
import { closeExecutor, Executor, liveStatuses } from "./executor/runner.js";
import { exportRunsReport, importRuns, runRecordPath } from "./executor/archive.js";
import { runtimeFor, runtimeStatus } from "./executor/runtimes.js";
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
} from "./workspace.js";
import { campaignSummaries, deleteCampaign, sameDesignKey, sessionAttempts, writeLabel } from "./history.js";
import { evidenceOverview, knowledgeDraft, leakCheck, participantKnowledgeOverview, saveKnowledge, sourceText } from "./sources.js";

type Json = (value: unknown, status?: number) => void;
const analysisCache = new Map<string, CampaignAnalysis>();

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
async function analysis(id: string, campaignId: string, comparisons?: Comparison[]) {
  const campaign = await readCampaign(id, campaignId);
  const chain = await lineage(id, campaign);
  const receipts = await readReceipts(id, chain.map((c) => c.id));
  const key = `${id}|${campaign.digest}|${receipts.length}|${JSON.stringify(comparisons ?? null)}`;
  if (analysisCache.has(key)) return { campaign, analysis: analysisCache.get(key)!, receipts };
  const human = await readHuman(id);
  requireThat(human, "This study has no human reference (human.json) yet; the analyzer needs it.");
  const bundles = await readResults(id, campaign.suite.study!, chain.map((c) => c.id));
  requireThat(bundles.length, "No results yet. Run or simulate jobs in the executor, or load a runs zip.");
  // comparisons.json belongs to the study; a campaign may freeze only some of its configurations.
  const present = new Set(campaign.suite.conditions.map((c) => c.id));
  const usable = comparisons?.filter((c) => present.has(c?.candidate) && present.has(c?.baseline));
  const skipped = (comparisons ?? []).filter((c) => !usable?.includes(c));
  const result = analyzeCampaign(campaign, human!, bundles, usable);
  if (skipped.length)
    result.report.notes.push(
      `Skipped ${skipped.length} saved comparison(s) whose configurations are not in this campaign: ${skipped.map((c) => `${c.candidate} − ${c.baseline} (${c.domain})`).join("; ")}. The Holm family covers the remaining ${usable!.length}.`,
    );
  analysisCache.set(key, result);
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
  requireThat(
    /^jobs\/[A-Za-z0-9_.-]{1,300}\/a\d{1,6}\/screenshots\/[^/\\:\0-\x1f]{1,200}\.(jpg|png)$/.test(rel) && !rel.split("/").some((s) => s === "." || s === ".."),
    "Not found.",
  );
  let root: string, real: string;
  try {
    root = realPath(base);
    real = realPath(join(base, ...rel.split("/")));
  } catch {
    throw new Error("Not found.");
  }
  const st = statSync(real);
  requireThat(real.startsWith(root + sep) && st.isFile() && st.nlink === 1, "Not found.");
  return real;
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
function sse(res: ServerResponse, ex: Executor) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  res.write(`data: ${JSON.stringify({ type: "snapshot", snapshot: ex.snapshot() })}\n\n`);
  const listener = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  ex.listeners.add(listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(ping);
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
      json(["none", "webxr", "unreal", "unity", "visionos"].map((r) => runtimeStatus(r, settings, ws.manifest)));
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
      const file = screenshotFile(id, campaignId, url.searchParams.get("path") ?? "");
      res.writeHead(200, { "Content-Type": file.endsWith(".png") ? "image/png" : "image/jpeg" });
      res.end(await readFile(file));
      return true;
    }
    case "/api/runs/export": {
      // Links and other entries that are not plain files are left out (counted in the zip's manifest.json).
      const { zip, skipped } = await exportRunsReport(id, campaignId);
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="runs-${campaignId}.zip"`,
        "X-Runs-Skipped": String(skipped.notFiles + skipped.unfinished + skipped.names),
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
      const plan = freezePlan(ws.study, withDefaultRuns(ws.study, agents, perParticipant), perParticipant);
      const campaign = campaignFromPlan(plan);
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
      json({ campaignId: campaign.id, jobs: campaign.jobs.length });
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
      json({ campaignId: campaign.id, ...compareAgents(campaignPlan(campaign), merged.runs, extras) });
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
      // Always from what actually happened: only sessions with an accepted forecast are reused.
      // Failed, stopped and never-started sessions run again, and so do simulated ones unless
      // body.keepSimulated. (body.useReceipts is no longer needed; receipts are always read.)
      const receipts = await readReceipts(id, chain.map((c) => c.id));
      // Model settings Claude Code would refuse at run time are refused now.
      checkModelSettings(changes?.model, "the new default model");
      for (const [c, m] of Object.entries(changes?.conditionModels ?? {})) checkModelSettings(m, c);
      for (const c of changes?.cloneConditions ?? []) checkModelSettings(c?.model, c?.label ?? c?.id ?? "the added model");
      const bundles = previous.suite.study ? await readResults(id, previous.suite.study, chain.map((c) => c.id)) : [];
      const simulatedBefore = simulatedJobIds(previous, bundles);
      const next = continueFromStatus(previous, receipts, changes, undefined, undefined, {
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
        json({ preview: true, campaign: next, keepSimulated, simulated: { ...totals, byCondition: simulated } });
        return true;
      }
      await saveCampaign(id, next);
      await saveSourceFingerprints(id, next);
      json({ campaignId: next.id, reused, jobs: next.jobs.length, reusedSimulated: totals.reused, simulatedRunAgain: totals.runAgain });
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
      json(await importRuns(id, Buffer.from(body.base64, "base64"), (campaignIds) => campaignIds.forEach((c) => closeExecutor(id, c))));
      return true;
    }
    case "/api/workspace/analyze": {
      const { campaign, analysis: a, receipts } = await analysis(id, campaignId(), comparisonsOf(body));
      const study = campaign.suite.study!;
      // Interim or final: a session with no receipt in this campaign (and not reused) was never run.
      const llmJobs = campaign.jobs.filter((j) => j.kind === "llm");
      const mine = receipts.filter((r) => r.campaignDigest === campaign.digest);
      const completed = new Set(mine.filter((r) => r.status === "completed").map((r) => r.jobId));
      const tried = new Set(mine.map((r) => r.jobId));
      const notStarted = new Set(llmJobs.filter((j) => !j.inheritedFrom && !tried.has(j.id)).map((j) => j.id));
      const progress = {
        sessions: llmJobs.length,
        finished: llmJobs.filter((j) => j.inheritedFrom || completed.has(j.id)).length,
        failed: llmJobs.filter((j) => !j.inheritedFrom && tried.has(j.id) && !completed.has(j.id)).length,
        notStarted: notStarted.size,
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
        // Sessions never run are counted in progress, not listed as lost runs; a failed one says why it failed.
        audits: a.report.audits
          .filter((x) => (!x.compliant || !x.scoreable) && !notStarted.has(x.jobId))
          .slice(0, 200)
          .map((x) => {
            const failed = mine.filter((r) => r.jobId === x.jobId && r.status === "failed" && r.error).at(-1);
            return failed && !completed.has(x.jobId) ? { ...x, issues: x.issues.map((i) => (i === "Scheduled job was not returned." ? `Failed (attempt ${failed.attempt}): ${failed.error}` : i)) } : x;
          }),
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
      const { campaign, analysis: a } = await analysis(id, campaignId(), comparisonsOf(body));
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
      const figure =
        kind === "agreement"
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
            })();
      json({ ...figure, omitted: shown.omitted });
      return true;
    }
    case "/api/workspace/compare": {
      const comparisons = comparisonsOf(body);
      const before = await analysis(id, campaignId("before"), comparisons);
      const after = await analysis(id, campaignId("after"), comparisons);
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
      const { campaign, analysis: a } = await analysis(id, campaignId(), comparisonsOf(body));
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
