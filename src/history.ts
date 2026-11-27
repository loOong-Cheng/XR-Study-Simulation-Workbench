// Campaign history for the workbench: labels, lineage, progress and cost per campaign, and every
// attempt of a session. Labels live beside the frozen campaigns (campaign-labels.json), so frozen
// files are never edited.
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { conditionModel, type Campaign, type CampaignModel, type CampaignReceipt } from "./core/campaign.js";
import { hash } from "./core/planner.js";
import type { RunResult } from "./core/types.js";
import { requireThat } from "./core/validation.js";
import { listCampaigns, readReceipts, readResults, runDir, workspaceDir } from "./workspace.js";
import { runRecordPath } from "./executor/archive.js";
import { readJsonFile } from "./files.js";
import { mergeCampaignResults, simulatedJobIds } from "./core/campaign-study.js";
import { unfinishedTasks } from "./core/progress.js";

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
  /** Sessions whose forecast was accepted before every required task was finished (not counted in done). */
  incomplete: number;
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
  /**
   * Real attempts left out of costUsd because their cost is unknown, with their tokens: stopped
   * before the end, or (`unpriced`, counted among them) on a model Claude Code has no price for.
   */
  unknownCost: UnknownCost;
  models: Record<string, CampaignModel>;
  /**
   * The campaign's configurations, including model copies added by continuations (which are not
   * in agents.json): label, whether they forecast each participant, and runs (the highest
   * repetition: per participant for individual configurations, in total for population ones).
   */
  configs: { id: string; label: string; individual: boolean; runs: number }[];
  designKey: string;
}
/** The cost label of a real attempt that ended before Claude Code reported its cost. */
export const COST_UNKNOWN = "unknown (stopped before the end)";
/**
 * The cost label of a real attempt on a model Claude Code has no price for (a local model behind
 * ANTHROPIC_BASE_URL): Claude Code prices it at a fallback rate that was never charged.
 */
export const COST_UNPRICED = "unknown (Claude Code has no price for this model)";
/** What an attempt's execution manifest says about its cost (execution-manifest.json). */
export type CostManifest = { costUsd?: number | null; cost?: string; usage?: Record<string, unknown> } | null;
/** Attempts whose cost is unknown and their tokens; `unpriced` of them ran on a model Claude Code has no price for. */
export interface UnknownCost {
  attempts: number;
  tokens: number;
  unpriced: number;
}
/**
 * A real attempt whose cost is unknown, from its execution manifest: all its tokens (input, cache
 * and output), and whether it is unknown because Claude Code has no price for the model (else it
 * was stopped, timed out or crashed before Claude Code reported a cost). Null when its cost is
 * known or no model ran. Cost totals add up known costs only and name these beside them.
 */
export function unknownCostOf(m: CostManifest): { tokens: number; unpriced: boolean } | null {
  if (!m || typeof m.costUsd === "number" || (m.cost !== COST_UNKNOWN && m.cost !== COST_UNPRICED)) return null;
  const u = m.usage ?? {};
  const tokens = ["inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens"].reduce((n, k) => n + (typeof u[k] === "number" ? (u[k] as number) : 0), 0);
  return { tokens, unpriced: m.cost === COST_UNPRICED };
}
/** The tokens of an attempt whose cost is unknown (see unknownCostOf), else null. */
export function unknownCostTokens(m: CostManifest): number | null {
  return unknownCostOf(m)?.tokens ?? null;
}
/** Spending of real attempts: the reported costs, and the attempts whose cost is unknown with their tokens. */
export interface Spent {
  usd: number;
  unknownAttempts: number;
  unknownTokens: number;
  /** Of the unknown attempts, those on a model Claude Code has no price for. */
  unpricedAttempts: number;
}
export const noSpending = (): Spent => ({ usd: 0, unknownAttempts: 0, unknownTokens: 0, unpricedAttempts: 0 });
// ---------- what the summaries read, kept between requests ----------
// The page asks for the summaries every few seconds while sessions run. Frozen campaign files are
// read again only when they change on disk; receipts.jsonl is append-only, so only lines added
// since the last request are read (with the manifests they name); result files are read once each.
// Loading a runs zip or deleting a campaign forgets what was kept (forgetSummaries).

/** A frozen campaign file as last read, by its size, modification time and inode. */
const campaignFiles = new Map<string, { stamp: string; campaign: Campaign | null }>();
const designKeys = new WeakMap<Campaign, string>();
/** listCampaigns, reading a campaign.json again only when it changed on disk. The objects are shared: read only. */
async function campaignsKept(id: string): Promise<Campaign[]> {
  const dir = join(workspaceDir(id), "campaigns");
  if (!existsSync(dir)) return [];
  const list: Campaign[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name, "campaign.json");
    let st;
    try {
      st = await stat(path);
    } catch {
      continue;
    }
    const stamp = `${st.size} ${st.mtimeMs} ${st.ino}`;
    let kept = campaignFiles.get(path);
    if (!kept || kept.stamp !== stamp) {
      kept = { stamp, campaign: await readJsonFile<Campaign>(path) };
      campaignFiles.set(path, kept);
    }
    // A campaign lives in the folder named after its ID; a copy under another name is not listed.
    if (kept.campaign?.id === name) list.push(kept.campaign);
  }
  return list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
const designKeyOf = (c: Campaign) => {
  let k = designKeys.get(c);
  if (k === undefined) designKeys.set(c, (k = sameDesignKey(c)));
  return k;
};
/** What a campaign's run folder holds, counted so far (see readRunTally). */
interface RunTally {
  /** receipts.jsonl: inode and the bytes read so far (whole lines only). */
  ino: number;
  offset: number;
  completed: Set<string>;
  tried: Set<string>;
  cost: number | null;
  /** Attempts whose cost is unknown, and their tokens. */
  unknownCost: UnknownCost;
  /**
   * results/: per file, its session, whether its run is simulated and whether it is incomplete
   * (forecast accepted before every required task was finished), read once (null: not readable
   * yet, read again next time).
   */
  results: Map<string, { jobId: string; synthetic: boolean; incomplete: boolean } | null>;
  resultsStamp: string;
}
/** A job's frozen protocol as far as incompleteness needs it (see unfinishedTasks). */
type ProtocolOf = (jobId: string) => { tools: string[]; requiredCaseIds: string[] } | null;
const tallies = new Map<string, RunTally>();
/** One reading of a run folder at a time (the live and the plain summaries may ask together). */
const tallyTurns = new Map<string, Promise<unknown>>();
/** For the tests: how many receipt lines, manifests and result files the summaries have read. */
export const summaryReads = { receiptLines: 0, manifests: 0, results: 0, computations: 0 };
/** Forget what the summaries kept of a study's campaigns, or of one (after a runs zip was loaded into it, or it was deleted). */
export function forgetSummaries(id: string, campaignId?: string) {
  const root = workspaceDir(id);
  const runs = join(root, "runs"),
    campaigns = join(root, "campaigns");
  for (const key of [...tallies.keys()]) if (dirname(key) === runs && (!campaignId || basename(key) === campaignId)) tallies.delete(key);
  for (const key of [...campaignFiles.keys()]) if (dirname(dirname(key)) === campaigns && (!campaignId || basename(dirname(key)) === campaignId)) campaignFiles.delete(key);
}
function readRunTally(dir: string, protocolOf: ProtocolOf): Promise<RunTally> {
  const turn = (tallyTurns.get(dir) ?? Promise.resolve()).then(
    () => tallyNow(dir, protocolOf),
    () => tallyNow(dir, protocolOf),
  );
  tallyTurns.set(dir, turn);
  void turn
    .finally(() => {
      if (tallyTurns.get(dir) === turn) tallyTurns.delete(dir);
    })
    .catch(() => undefined);
  return turn;
}
/** f over the items, at most 16 at a time, with the results in the items' order. */
async function inTurns<T, R>(items: T[], f: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, items.length) }, worker));
  return out;
}
async function statOrNull(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}
async function tallyNow(dir: string, protocolOf: ProtocolOf): Promise<RunTally> {
  let t = tallies.get(dir);
  const receiptsPath = join(dir, "receipts.jsonl");
  const st = await statOrNull(receiptsPath);
  // A new or replaced receipts file (another inode, or shorter than what was read): count again.
  if (!t || (st && (st.ino !== t.ino || st.size < t.offset)) || (!st && t.offset > 0)) {
    t = { ino: st?.ino ?? 0, offset: 0, completed: new Set(), tried: new Set(), cost: null, unknownCost: { attempts: 0, tokens: 0, unpriced: 0 }, results: t?.results ?? new Map(), resultsStamp: t?.resultsStamp ?? "" };
    tallies.set(dir, t);
  }
  if (st && st.size > t.offset) {
    const handle = await open(receiptsPath, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(st.size - t.offset);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, t.offset);
      chunk = chunk.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
    // Only whole lines: a line being written now is read next time. Every line is parsed before
    // anything is counted, so a line that does not parse fails the request, as before, every time.
    const end = chunk.lastIndexOf(0x0a);
    if (end >= 0) {
      const lines = chunk.subarray(0, end).toString("utf8").split("\n").filter((l) => l.trim());
      const receipts = lines.map((l) => JSON.parse(l) as CampaignReceipt);
      const withManifest = receipts.filter((r) => r.executionManifest);
      summaryReads.manifests += withManifest.length;
      const costs = await inTurns(withManifest, async (r) => {
        const m = await json<NonNullable<CostManifest>>(runRecordPath(dir, r.executionManifest!.path));
        return { usd: typeof m?.costUsd === "number" ? m.costUsd : null, unknown: unknownCostOf(m) };
      });
      summaryReads.receiptLines += receipts.length;
      for (const r of receipts) {
        t.tried.add(r.jobId);
        if (r.status === "completed") t.completed.add(r.jobId);
      }
      // Added in receipt order, as reading the whole file adds them.
      for (const c of costs) {
        if (c.usd !== null) t.cost = (t.cost ?? 0) + c.usd;
        else if (c.unknown) (t.unknownCost.attempts += 1), (t.unknownCost.tokens += c.unknown.tokens), (t.unknownCost.unpriced += c.unknown.unpriced ? 1 : 0);
      }
      t.offset += end + 1;
    }
  }
  // Result files: the folder is listed again only when it changed (a file added, removed or renamed).
  const resultsDir = join(dir, "results");
  const rs = await statOrNull(resultsDir);
  const stamp = rs ? `${rs.mtimeMs} ${rs.ino}` : "";
  const tally = t;
  const readResult = async (f: string) => {
    summaryReads.results++;
    const run = await json<RunResult>(join(resultsDir, f));
    tally.results.set(f, run ? { jobId: String(run.jobId), synthetic: !!run.execution?.synthetic, incomplete: unfinishedTasks(protocolOf(String(run.jobId)), run).length > 0 } : null);
  };
  if (stamp !== t.resultsStamp) {
    const names = rs ? await readdir(resultsDir) : [];
    const now = new Set(names);
    for (const f of [...t.results.keys()]) if (!now.has(f)) t.results.delete(f);
    await inTurns(names.filter((f) => !tally.results.has(f)), readResult);
    t.resultsStamp = stamp;
  } else await inTurns([...t.results].filter(([, kind]) => kind === null).map(([f]) => f), readResult);
  return t;
}

/**
 * Progress, results and cost of every campaign. `live` gives the session statuses of a campaign
 * whose executor is open (see liveStatuses in the executor), so these counts match the executor
 * table exactly, also for attempts that failed before they could write a receipt. Otherwise the
 * receipts count: a session with only failed attempts is failed, one without any is not run yet.
 *
 * Requests that arrive while the summaries are being computed share the next computation (which
 * starts after the current one), so at most one runs per study at a time and every caller gets
 * counts from after its request.
 */
export function campaignSummaries(id: string, live?: (campaignId: string) => Map<string, string> | null): Promise<CampaignSummary[]> {
  const key = `${workspaceDir(id)}|${live ? "live" : "files"}`;
  let line = summaryLines.get(key);
  if (!line) summaryLines.set(key, (line = { tail: Promise.resolve(), next: null }));
  if (line.next) return line.next;
  const l = line;
  const run = () => {
    l.next = null;
    return computeSummaries(id, live);
  };
  const next = l.tail.then(run, run);
  l.next = next;
  l.tail = next.catch(() => undefined);
  return next;
}
const summaryLines = new Map<string, { tail: Promise<unknown>; next: Promise<CampaignSummary[]> | null }>();
async function computeSummaries(id: string, live?: (campaignId: string) => Map<string, string> | null): Promise<CampaignSummary[]> {
  summaryReads.computations++;
  const campaigns = await campaignsKept(id);
  const labels = await readLabels(id);
  const byDigest = new Map(campaigns.map((c) => [c.digest, c.id]));
  const out: CampaignSummary[] = [];
  for (const c of campaigns) {
    const dir = runDir(id, c.id);
    // Each job's frozen protocol (its configuration's), to tell incomplete sessions apart.
    const recipes = new Map(c.suite.conditions.map((x) => [x.id, x.recipe.protocol ?? null]));
    const jobsById = new Map(c.jobs.map((j) => [j.id, j]));
    const tally = await readRunTally(dir, (jobId) => recipes.get(jobsById.get(jobId)?.conditionId ?? "") ?? null);
    const llm = c.jobs.filter((j) => j.kind === "llm");
    const { completed, tried } = tally;
    const incomplete = new Set([...tally.results.values()].filter((r) => r?.incomplete).map((r) => r!.jobId));
    const statuses = live?.(c.id) ?? null;
    const status = (jobId: string) => statuses?.get(jobId) ?? (completed.has(jobId) ? (incomplete.has(jobId) ? "incomplete" : "done") : tried.has(jobId) ? "failed" : "not-started");
    const fresh = llm.filter((j) => !j.inheritedFrom).map((j) => status(j.id));
    // Configurations dropped on purpose by a continuation of this campaign or of an ancestor.
    const chain = [...(c.lineage ?? []).map((d) => campaigns.find((x) => x.digest === d)), c];
    const present = new Set(c.suite.conditions.map((x) => x.id));
    const dropped = [...new Set(chain.flatMap((x) => x?.continuation?.dropConditions ?? []))].filter((x) => !present.has(x));
    let real = 0,
      simulated = 0;
    for (const r of tally.results.values()) if (r !== null) r.synthetic ? simulated++ : real++;
    const cost = tally.cost;
    const byCondition = new Map<string, typeof llm>();
    for (const j of llm) {
      const list = byCondition.get(j.conditionId);
      if (list) list.push(j);
      else byCondition.set(j.conditionId, [j]);
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
      incomplete: fresh.filter((s) => s === "incomplete").length,
      failed: fresh.filter((s) => s === "failed" || s === "stopped").length,
      notStarted: fresh.filter((s) => s === "not-started").length,
      running: fresh.filter((s) => s === "running" || s === "queued").length,
      dropped,
      real,
      simulated,
      costUsd: cost,
      unknownCost: { ...tally.unknownCost },
      models: Object.fromEntries(c.suite.conditions.map((x) => [x.id, conditionModel(c, x.id)])),
      configs: c.suite.conditions
        .filter((x) => x.kind === "llm")
        .map((x) => {
          const jobs = byCondition.get(x.id) ?? [];
          return { id: x.id, label: x.label, individual: jobs.some((j) => j.participantId), runs: jobs.reduce((m, j) => Math.max(m, j.repetition), 0) };
        }),
      designKey: designKeyOf(c),
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
  const job = campaign.jobs.find((j) => j.id === jobId)!;
  const protocol = campaign.suite.conditions.find((c) => c.id === job.conditionId)?.recipe.protocol ?? null;
  const attempts = [];
  for (const n of numbers) {
    const r = receipts.find((x) => x.attempt === n);
    const a = join(jobDir, `a${n}`);
    const calls = existsSync(join(a, "calls.log")) ? (await readFile(join(a, "calls.log"), "utf8")).split("\n").filter((l) => l && l !== "submit_forecast").length : 0;
    const manifest = await json<NonNullable<CostManifest>>(join(a, "execution-manifest.json"));
    // The attempt's own result, or for the attempt that counts the selected output (results/<job>.json).
    const result = (await json<RunResult>(join(a, "result.json"))) ?? (n === selected ? await json<RunResult>(join(dir, "results", `${jobId}.json`)) : null);
    // Tokens: the session's totals, else the live count the executor kept (usage.json).
    const live = await json<{ input?: number; output?: number }>(join(a, "usage.json"));
    const e = result?.execution;
    const real = e ? !e.synthetic : !!live;
    const tokensIn = e && !e.synthetic ? [e.inputTokens, e.cacheReadTokens, e.cacheWriteTokens].reduce<number | null>((s, x) => (typeof x === "number" ? (s ?? 0) + x : s), null) : live?.input ?? null;
    const tokensOut = e && !e.synthetic ? e.outputTokens : live?.output ?? null;
    const costUsd = typeof manifest?.costUsd === "number" ? manifest.costUsd : null;
    // How long it ran: its model wall time; without a result, from its start until its stream's last line.
    const marker = await json<{ startedAt?: string }>(join(a, "attempt.json"));
    const streamEnd = existsSync(join(a, "stream.jsonl")) ? (await stat(join(a, "stream.jsonl"))).mtimeMs : NaN;
    const ranMs = typeof e?.inferenceWallTimeMs === "number" ? e.inferenceWallTimeMs : streamEnd - Date.parse(marker?.startedAt ?? "");
    attempts.push({
      attempt: n,
      status: !r || r.error === "Stopped by you." ? "stopped" : r.status === "completed" && result && unfinishedTasks(protocol, result).length ? "incomplete" : r.status,
      error: r?.error ?? (r ? null : "Stopped before it finished; no result was recorded."),
      toolCalls: calls,
      tokensIn,
      tokensOut,
      costUsd,
      // The manifest's own label (stopped, or a model without a price), else unknown for a real attempt with tokens.
      cost: costUsd !== null ? null : manifest?.cost === COST_UNPRICED ? COST_UNPRICED : real && (tokensIn !== null || tokensOut !== null) ? COST_UNKNOWN : null,
      simulated: e?.synthetic ?? null,
      durationMs: Number.isFinite(ranMs) && ranMs >= 0 ? Math.round(ranMs) : null,
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
