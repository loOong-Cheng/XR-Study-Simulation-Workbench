// Campaign history for the workbench: labels, lineage, progress and cost per campaign, and every
// attempt of a session. Labels live beside the frozen campaigns (campaign-labels.json), so frozen
// files are never edited.
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { conditionModel, type Campaign, type CampaignModel } from "./core/campaign.js";
import { hash } from "./core/planner.js";
import type { RunResult } from "./core/types.js";
import { requireThat } from "./core/validation.js";
import { listCampaigns, readReceipts, runDir, workspaceDir } from "./workspace.js";

const labelsPath = (id: string) => join(workspaceDir(id), "campaign-labels.json");
export async function readLabels(id: string): Promise<Record<string, string>> {
  return existsSync(labelsPath(id)) ? JSON.parse(await readFile(labelsPath(id), "utf8")) : {};
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

async function json<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
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
  failed: number;
  notStarted: number;
  real: number;
  simulated: number;
  /** Total of real sessions' reported cost (all attempts), null when none reported one. */
  costUsd: number | null;
  models: Record<string, CampaignModel>;
  designKey: string;
}
export async function campaignSummaries(id: string): Promise<CampaignSummary[]> {
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
        const m = await json<{ costUsd?: number | null }>(join(dir, r.executionManifest.path));
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
      done: llm.filter((j) => !j.inheritedFrom && completed.has(j.id)).length,
      failed: llm.filter((j) => !j.inheritedFrom && tried.has(j.id) && !completed.has(j.id)).length,
      notStarted: llm.filter((j) => !j.inheritedFrom && !tried.has(j.id)).length,
      real,
      simulated,
      costUsd: cost,
      models: Object.fromEntries(c.suite.conditions.map((x) => [x.id, conditionModel(c, x.id)])),
      designKey: sameDesignKey(c),
    });
  }
  return out;
}

/** Every attempt of one session, including stopped ones that left no receipt, and which one counts. */
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
    attempts.push({
      attempt: n,
      status: r ? r.status : "stopped",
      error: r?.error ?? (r ? null : "Stopped before it finished; no result was recorded."),
      toolCalls: calls,
      costUsd: typeof manifest?.costUsd === "number" ? manifest.costUsd : null,
      simulated: result?.execution?.synthetic ?? null,
      counts: n === selected,
    });
  }
  return { jobId, attempts, selected };
}

/**
 * Delete a campaign: its campaign file and runs move to <study>/deleted/<time>-<campaign>/, so
 * nothing is lost by mistake (remove that folder to free the space). Refused for a campaign that
 * another campaign continues from (its runs are reused there).
 */
export async function deleteCampaign(id: string, campaignId: string) {
  const campaigns = await listCampaigns(id);
  const c = campaigns.find((x) => x.id === campaignId);
  requireThat(c, "Unknown campaign.");
  const children = campaigns.filter((x) => x.id !== campaignId && (x.parentDigest === c!.digest || (x.lineage ?? []).includes(c!.digest)));
  requireThat(!children.length, `Other campaigns continue from this one and reuse its runs (${children.map((x) => x.id.slice(9, 17)).join(", ")}). Delete those first.`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const target = join(workspaceDir(id), "deleted", `${stamp}-${campaignId}`);
  await mkdir(target, { recursive: true });
  await rename(join(workspaceDir(id), "campaigns", campaignId), join(target, "campaign"));
  if (existsSync(runDir(id, campaignId))) await rename(runDir(id, campaignId), join(target, "runs"));
  const labels = await readLabels(id);
  if (labels[campaignId]) {
    delete labels[campaignId];
    await writeFile(labelsPath(id), JSON.stringify(labels, null, 2) + "\n");
  }
  return { deleted: campaignId, movedTo: target.slice(workspaceDir(id).length + 1) };
}
