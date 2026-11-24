// Campaign history for the workbench: labels, lineage, progress and cost per campaign, and every
// attempt of a session. Labels live beside the frozen campaigns (campaign-labels.json), so frozen
// files are never edited.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conditionModel, type Campaign, type CampaignModel } from "./core/campaign.js";
import { hash } from "./core/planner.js";
import type { RunResult } from "./core/types.js";
import { requireThat } from "./core/validation.js";
import { listCampaigns, readReceipts, readResults, runDir, workspaceDir } from "./workspace.js";
import { runRecordPath } from "./executor/archive.js";
import { readJsonFile } from "./files.js";
import { mergeCampaignResults, simulatedJobIds } from "./core/campaign-study.js";

const labelsPath = (id: string) => join(workspaceDir(id), "campaign-labels.json");
export async function readLabels(id: string): Promise<Record<string, string>> {
  return existsSync(labelsPath(id)) ? readJsonFile<Record<string, string>>(labelsPath(id)) : {};
}
export async function writeLabel(id: string, campaignId: string, label: string) {
  requireThat((await listCampaigns(id)).some((c) => c.id === campaignId), "Unknown campaign.");
  const labels = await readLabels(id);
  const clean = label.replace(/\s+/g, " ").trim().slice(0, 80);
  if (clean) labels[campaignId] = clean;
  else delete labels[campaignId];
  await writeFile(labelsPath(id), JSON.stringify(labels, null, 2) + "\n");
  return labels;
}

/** Same configurations, models and sessions: freezing again would repeat this campaign. */
export function sameDesignKey(c: Campaign): string {
  return hash({
    // The suite without its notes: they name the plan digest, which changes with every freeze.
    suite: { ...c.suite, notes: [] },
    models: c.suite.conditions.map((x) => [x.id, conditionModel(c, x.id)]),
    jobs: c.jobs.filter((j) => j.kind === "llm").map((j) => [j.conditionId, j.participantId ?? null, j.repetition]),
  });
}

async function json<T>(path: string | null): Promise<T | null> {
  if (!path) return null;
  try {
    return await readJsonFile<T>(path);
  } catch {
    return null;
  }
}

export interface CampaignSummary {
  id: string;
  digest: string;
  createdAt: string;
  parentDigest: string | null;
  parentId: string | null;
  label: string | null;
  note: string | null;
  jobs: number;
  reused: number;
  done: number;
  /** Failed or stopped sessions (every attempt failed, simulated or real). */
  failed: number;
  notStarted: number;
  /** Running or waiting to start (only while the campaign's executor is open). */
  running: number;
  /** Configurations a continuation in this campaign's lineage left out on purpose. */
  dropped: string[];
  real: number;
  simulated: number;
  /** Total of real sessions' reported cost (all attempts), null when none reported one. */
  costUsd: number | null;
  models: Record<string, CampaignModel>;
  /**
   * The campaign's configurations, including model copies added by continuations (which are not
   * in agents.json): label, whether they forecast each participant, and runs (the highest
   * repetition: per participant for individual configurations, in total for population ones).
   */
  configs: { id: string; label: string; individual: boolean; runs: number }[];
  designKey: string;
}
/**
 * Progress, results and cost of every campaign. `live` gives the session statuses of a campaign
 * whose executor is open (see liveStatuses in the executor), so these counts match the executor
 * table exactly, also for attempts that failed before they could write a receipt. Otherwise the
 * receipts count: a session with only failed attempts is failed, one without any is not run yet.
 */
export async function campaignSummaries(id: string, live?: (campaignId: string) => Map<string, string> | null): Promise<CampaignSummary[]> {
  const campaigns = await listCampaigns(id);
  const labels = await readLabels(id);
  const byDigest = new Map(campaigns.map((c) => [c.digest, c.id]));
  const out: CampaignSummary[] = [];
  for (const c of campaigns) {
    const dir = runDir(id, c.id);
    const receipts = await readReceipts(id, [c.id]);
    const llm = c.jobs.filter((j) => j.kind === "llm");
    const completed = new Set(receipts.filter((r) => r.status === "completed").map((r) => r.jobId));
    const tried = new Set(receipts.map((r) => r.jobId));
    const statuses = live?.(c.id) ?? null;
    const status = (jobId: string) => statuses?.get(jobId) ?? (completed.has(jobId) ? "done" : tried.has(jobId) ? "failed" : "not-started");
    const fresh = llm.filter((j) => !j.inheritedFrom).map((j) => status(j.id));
    // Configurations dropped on purpose by a continuation of this campaign or of an ancestor.
    const chain = [...(c.lineage ?? []).map((d) => campaigns.find((x) => x.digest === d)), c];
    const present = new Set(c.suite.conditions.map((x) => x.id));
    const dropped = [...new Set(chain.flatMap((x) => x?.continuation?.dropConditions ?? []))].filter((x) => !present.has(x));
    let real = 0,
      simulated = 0;
    if (existsSync(join(dir, "results")))
      for (const f of await readdir(join(dir, "results"))) {
        const run = await json<RunResult>(join(dir, "results", f));
        if (run) run.execution?.synthetic ? simulated++ : real++;
      }
    let cost: number | null = null;
    for (const r of receipts)
      if (r.executionManifest) {
        const m = await json<{ costUsd?: number | null }>(runRecordPath(dir, r.executionManifest.path));
        if (typeof m?.costUsd === "number") cost = (cost ?? 0) + m.costUsd;
      }
    out.push({
      id: c.id,
      digest: c.digest,
      createdAt: c.createdAt,
      parentDigest: c.parentDigest,
      parentId: c.parentDigest ? byDigest.get(c.parentDigest) ?? null : null,
      label: labels[c.id] ?? null,
      note: c.continuation?.note ?? null,
      jobs: llm.length,
      reused: llm.filter((j) => j.inheritedFrom).length,
      done: fresh.filter((s) => s === "done").length,
      failed: fresh.filter((s) => s === "failed" || s === "stopped").length,
      notStarted: fresh.filter((s) => s === "not-started").length,
      running: fresh.filter((s) => s === "running" || s === "queued").length,
      dropped,
      real,
      simulated,
      costUsd: cost,
      models: Object.fromEntries(c.suite.conditions.map((x) => [x.id, conditionModel(c, x.id)])),
      configs: c.suite.conditions
        .filter((x) => x.kind === "llm")
        .map((x) => {
          const jobs = llm.filter((j) => j.conditionId === x.id);
          return { id: x.id, label: x.label, individual: jobs.some((j) => j.participantId), runs: Math.max(0, ...jobs.map((j) => j.repetition)) };
        }),
      designKey: sameDesignKey(c),
    });
  }
  return out;
}

/**
 * What each reused session of a campaign cost where it ran: whether it was simulated, its tokens
 * (input including cache, and output) and the cost of the attempt that counts, from the result and
 * receipt in the campaign named by inheritedFrom. Sessions whose run is not on this machine are left out.
 */
export async function reusedUsage(id: string, campaign: Campaign) {
  const out = new Map<string, { simulated: boolean; tokensIn: number | null; tokensOut: number | null; costUsd: number | null }>();
  const receiptsOf = new Map<string, Awaited<ReturnType<typeof readReceipts>>>();
  for (const j of campaign.jobs) {
    const o = j.inheritedFrom;
    if (!o || j.kind !== "llm") continue;
    let dir: string;
    try {
      dir = runDir(id, o.campaignId);
    } catch {
      continue;
    }
    const run = await json<RunResult>(join(dir, "results", `${o.jobId}.json`));
    if (!run) continue;
    const e = run.execution;
    const synthetic = !!e?.synthetic;
    const parts = [e?.inputTokens, e?.cacheReadTokens, e?.cacheWriteTokens].filter((x): x is number => typeof x === "number");
    if (!receiptsOf.has(o.campaignId)) receiptsOf.set(o.campaignId, await readReceipts(id, [o.campaignId]).catch(() => []));
    const r = receiptsOf.get(o.campaignId)!.filter((x) => x.jobId === o.jobId && x.status === "completed").sort((a, b) => a.attempt - b.attempt)[0];
    const manifest = !synthetic && r?.executionManifest?.path.endsWith("execution-manifest.json") ? await json<{ costUsd?: number | null }>(runRecordPath(dir, r.executionManifest.path)) : null;
    out.set(j.id, {
      simulated: synthetic,
      tokensIn: synthetic || !parts.length ? null : parts.reduce((s, x) => s + x, 0),
      tokensOut: synthetic ? null : e?.outputTokens ?? null,
      costUsd: typeof manifest?.costUsd === "number" ? manifest.costUsd : null,
    });
  }
  return out;
}

/**
 * Which sessions of a campaign have an accepted result anywhere in its lineage (their own run, or
 * the run they reuse) and which of those runs are simulated, from the result files the analysis
 * reads. A continuation made before reuse required an accepted forecast could mark a session as
 * reused although it never ran; such a session has no result here. Null when the lineage's
 * results cannot be combined (the analysis then says why).
 */
export async function lineageRuns(id: string, campaign: Campaign): Promise<{ accepted: Set<string>; simulated: Set<string> } | null> {
  if (!campaign.suite.study) return null;
  const all = await listCampaigns(id);
  const ids = [...(campaign.lineage ?? []).flatMap((d) => all.filter((c) => c.digest === d).map((c) => c.id)), campaign.id];
  try {
    const bundles = await readResults(id, campaign.suite.study, ids);
    if (!bundles.length) return { accepted: new Set(), simulated: new Set() };
    const merged = mergeCampaignResults(campaign, bundles);
    return {
      accepted: new Set(merged.bundle.runs.filter((r) => r.status === "completed").map((r) => r.jobId)),
      simulated: simulatedJobIds(campaign, bundles),
    };
  } catch {
    return null;
  }
}

/**
 * Every attempt of one session, including stopped ones, and which one counts. Tool calls exclude
 * the forecast submission (as in the executor); a real attempt that ended before Claude Code
 * reported its cost shows its tokens and an unknown cost.
 */
export async function sessionAttempts(id: string, campaign: Campaign, jobId: string) {
  requireThat(campaign.jobs.some((j) => j.id === jobId), "Unknown session.");
  const dir = runDir(id, campaign.id);
  const receipts = (await readReceipts(id, [campaign.id])).filter((r) => r.jobId === jobId);
  const jobDir = join(dir, "jobs", jobId);
  const folders = existsSync(jobDir) ? (await readdir(jobDir)).filter((f) => /^a\d+$/.test(f)).map((f) => Number(f.slice(1))) : [];
  const numbers = [...new Set([...folders, ...receipts.map((r) => r.attempt)])].sort((a, b) => a - b);
  const selected = receipts.filter((r) => r.status === "completed").sort((a, b) => a.attempt - b.attempt)[0]?.attempt ?? null;
  const attempts = [];
  for (const n of numbers) {
    const r = receipts.find((x) => x.attempt === n);
    const a = join(jobDir, `a${n}`);
    const calls = existsSync(join(a, "calls.log")) ? (await readFile(join(a, "calls.log"), "utf8")).split("\n").filter((l) => l && l !== "submit_forecast").length : 0;
    const manifest = await json<{ costUsd?: number | null }>(join(a, "execution-manifest.json"));
    const result = await json<RunResult>(join(a, "result.json"));
    // Tokens: the session's totals, else the live count the executor kept (usage.json).
    const live = await json<{ input?: number; output?: number }>(join(a, "usage.json"));
    const e = result?.execution;
    const real = e ? !e.synthetic : !!live;
    const tokensIn = e && !e.synthetic ? [e.inputTokens, e.cacheReadTokens, e.cacheWriteTokens].reduce<number | null>((s, x) => (typeof x === "number" ? (s ?? 0) + x : s), null) : live?.input ?? null;
    const tokensOut = e && !e.synthetic ? e.outputTokens : live?.output ?? null;
    const costUsd = typeof manifest?.costUsd === "number" ? manifest.costUsd : null;
    attempts.push({
      attempt: n,
      status: !r || r.error === "Stopped by you." ? "stopped" : r.status,
      error: r?.error ?? (r ? null : "Stopped before it finished; no result was recorded."),
      toolCalls: calls,
      tokensIn,
      tokensOut,
      costUsd,
      cost: costUsd !== null ? null : real && (tokensIn !== null || tokensOut !== null) ? "unknown (stopped before the end)" : null,
      simulated: e?.synthetic ?? null,
      counts: n === selected,
    });
  }
  return { jobId, attempts, selected };
}

/**
 * How deleting moves folders; tests replace `rename` to make a move fail. On Windows a folder
 * cannot be moved while a file in it is open (a session still ending, an image viewer, Explorer's
 * preview, a virus scan), so a refused move is tried again for `retryMs` before giving up.
 */
export const deleteMoves = { rename, retryMs: 5000, stepMs: 100 };
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);
async function moveFolder(from: string, to: string) {
  const until = Date.now() + deleteMoves.retryMs;
  for (;;)
    try {
      return await deleteMoves.rename(from, to);
    } catch (e) {
      if (!LOCKED.has((e as NodeJS.ErrnoException).code ?? "") || Date.now() >= until) throw e;
      await new Promise((ok) => setTimeout(ok, deleteMoves.stepMs));
    }
}
const openFile = (where: string, e: unknown) => {
  const code = (e as NodeJS.ErrnoException).code;
  return LOCKED.has(code ?? "")
    ? new Error(`A file in the ${where} folder is open (${code}: another program, such as an image viewer, Explorer or a session that is still stopping, holds it). Close it and try again.`)
    : (e as Error);
};

/**
 * Delete a campaign: its runs and campaign file move to <study>/deleted/<time>-<campaign>/, so
 * nothing is lost by mistake (remove that folder to free the space). Refused for a campaign that
 * another campaign continues from (its runs are reused there). The runs move first: if the
 * campaign file cannot follow, the runs move back, so a campaign is never gone while its runs stay.
 */
const deleting = new Set<string>();
async function dropLabel(id: string, campaignId: string) {
  const labels = await readLabels(id);
  if (!labels[campaignId]) return;
  delete labels[campaignId];
  await writeFile(labelsPath(id), JSON.stringify(labels, null, 2) + "\n");
}
const ALREADY_DELETED = "This campaign was already deleted.";
export async function deleteCampaign(id: string, campaignId: string) {
  const key = `${workspaceDir(id)}::${campaignId}`;
  // Two delete requests at once: the second one is told, instead of failing halfway.
  requireThat(!deleting.has(key), ALREADY_DELETED);
  deleting.add(key);
  try {
    const campaigns = await listCampaigns(id);
    const c = campaigns.find((x) => x.id === campaignId);
    if (!c) {
      const deleted = join(workspaceDir(id), "deleted");
      const gone = existsSync(deleted) ? (await readdir(deleted)).filter((f) => f.endsWith(`-${campaignId}`)).sort() : [];
      // An earlier delete moved the campaign but not its runs (a file in them was open): finish it.
      const last = gone[gone.length - 1];
      if (last && existsSync(runDir(id, campaignId)) && !existsSync(join(deleted, last, "runs"))) {
        await moveFolder(runDir(id, campaignId), join(deleted, last, "runs")).catch((e) => {
          throw openFile("runs", e);
        });
        await dropLabel(id, campaignId);
        return { deleted: campaignId, movedTo: `deleted/${last}` };
      }
      throw new Error(gone.length ? ALREADY_DELETED : "Unknown campaign.");
    }
    const children = campaigns.filter((x) => x.id !== campaignId && (x.parentDigest === c.digest || (x.lineage ?? []).includes(c.digest)));
    requireThat(!children.length, `Other campaigns continue from this one and reuse its runs (${children.map((x) => x.id.slice(9, 17)).join(", ")}). Delete those first.`);
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
    // Shown to the researcher: always with "/" (also on Windows).
    const movedTo = `deleted/${stamp}-${campaignId}`;
    const target = join(workspaceDir(id), "deleted", `${stamp}-${campaignId}`);
    await mkdir(target, { recursive: true });
    const runs = runDir(id, campaignId);
    let runsMoved = false;
    try {
      if (existsSync(runs)) {
        await moveFolder(runs, join(target, "runs")).catch((e) => {
          throw openFile("runs", e);
        });
        runsMoved = true;
      }
      await moveFolder(join(workspaceDir(id), "campaigns", campaignId), join(target, "campaign")).catch((e) => {
        throw (e as NodeJS.ErrnoException).code === "ENOENT" ? new Error(ALREADY_DELETED) : openFile("campaign", e);
      });
    } catch (e) {
      // Put back what moved, so the campaign and its runs stay together.
      if (runsMoved)
        try {
          await moveFolder(join(target, "runs"), runs);
        } catch {
          throw new Error(`${(e as Error).message} Its runs were already moved to ${movedTo}/runs and could not be moved back; move that folder back to runs/${campaignId} in the study folder.`);
        }
      await rmdir(target).catch(() => undefined); // only if empty again
      if (e instanceof Error && e.message.startsWith("A file in the ")) e.message += " Nothing was deleted.";
      throw e;
    }
    await dropLabel(id, campaignId);
    return { deleted: campaignId, movedTo };
  } finally {
    deleting.delete(key);
  }
}
