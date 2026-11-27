import { analyzeVerifiedPlan, type AnalysisMemo } from "./analyzer.js";
import {
  campaignPlan,
  conditionModel,
  lineageJobIndex,
  modelDifferences,
  scoringDigest,
  type Campaign,
  type CampaignModel,
  type CampaignReceipt,
} from "./campaign.js";
import type { CampaignScorecard } from "./campaign-comparison.js";
import { syntheticResults } from "./example.js";
import { hash } from "./planner.js";
import { modelConfoundWarnings } from "./fairness.js";
import type {
  AnalysisOptions,
  AnalysisReport,
  Comparison,
  HumanData,
  ResultBundle,
  RunResult,
} from "./types.js";
import { requireThat } from "./validation.js";

export interface CampaignProvenance {
  jobId: string;
  executedIn: string;
  executedJobId: string;
}
/**
 * Merge result bundles from a campaign lineage into one bundle keyed by THIS
 * campaign's job IDs. New jobs must come from this campaign; reused jobs must
 * come from the exact campaign/job that executed them.
 */
export function mergeCampaignResults(
  c: Campaign,
  bundles: ResultBundle[],
): {
  bundle: ResultBundle;
  reused: CampaignProvenance[];
  ignoredRuns: number;
} {
  const plan = campaignPlan(c);
  requireThat(
    Array.isArray(bundles) && bundles.length > 0,
    "Supply at least one result bundle.",
  );
  const lineage = new Set([...(c.lineage ?? []), c.digest]);
  const byKey = new Map<string, RunResult>();
  for (const b of bundles) {
    requireThat(
      b?.schemaVersion === "1.0" &&
        b.studyId === plan.study.id &&
        Array.isArray(b.runs),
      "Results do not match the campaign study.",
    );
    for (const r of b.runs) {
      requireThat(
        r && typeof r.jobId === "string" && lineage.has(r.planDigest),
        "Result belongs to a campaign outside this lineage.",
      );
      const key = `${r.planDigest}/${r.jobId}`;
      requireThat(
        !byKey.has(key),
        `Duplicate output for ${r.jobId}: return one selected result per scheduled job.`,
      );
      byKey.set(key, r);
    }
  }
  const used = new Set<string>();
  const reused: CampaignProvenance[] = [];
  const runs: RunResult[] = [];
  for (const job of c.jobs) {
    if (job.kind !== "llm") continue;
    const origin = job.inheritedFrom;
    const key = origin
      ? `${origin.campaignDigest}/${origin.jobId}`
      : `${c.digest}/${job.id}`;
    const run = byKey.get(key);
    if (!run) continue;
    used.add(key);
    runs.push({ ...structuredClone(run), jobId: job.id, planDigest: c.digest });
    if (origin)
      reused.push({
        jobId: job.id,
        executedIn: origin.campaignId,
        executedJobId: origin.jobId,
      });
  }
  return {
    bundle: { schemaVersion: "1.0", studyId: plan.study.id, runs },
    reused,
    ignoredRuns: byKey.size - used.size,
  };
}
/**
 * Jobs of this campaign whose output is a simulated (invented) run, their own or reused, looked up
 * in the result bundles of the lineage. Unknown or superseded records are ignored.
 */
export function simulatedJobIds(c: Campaign, bundles: ResultBundle[]): Set<string> {
  const index = lineageJobIndex(c);
  const out = new Set<string>();
  for (const b of bundles)
    for (const r of Array.isArray(b?.runs) ? b.runs : []) {
      const jobId = index.get(`${r?.planDigest}/${r?.jobId}`);
      if (jobId && r.status === "completed" && (r.execution as { synthetic?: unknown } | undefined)?.synthetic === true)
        out.add(jobId);
    }
  return out;
}
export interface CampaignAnalysis {
  campaignDigest: string;
  models: Record<string, CampaignModel>;
  reused: CampaignProvenance[];
  ignoredRuns: number;
  report: AnalysisReport;
  scorecard: CampaignScorecard;
}
/**
 * Why sessions of this campaign have no accepted forecast, from the executor's receipts: each one
 * whose last attempt failed is named with its error in the report's exclusions, and its audit says
 * "Failed (attempt n): <error>" instead of only that the run was not returned. Text only: no score,
 * denominator or digest changes. Sessions never started have no receipt and are not listed.
 */
export function addFailureReasons(c: Campaign, report: AnalysisReport, receipts: CampaignReceipt[]): void {
  const mine = receipts.filter((r) => r.campaignDigest === c.digest);
  const completed = new Set(mine.filter((r) => r.status === "completed").map((r) => r.jobId));
  const label = new Map(c.suite.conditions.map((x) => [x.id, x.label]));
  const failed = c.jobs.flatMap((job) => {
    if (job.kind !== "llm" || job.inheritedFrom || completed.has(job.id)) return [];
    const last = mine.filter((r) => r.jobId === job.id && r.status === "failed" && r.error).at(-1);
    return last ? [{ job, last }] : [];
  });
  if (!failed.length) return;
  const byJob = new Map(failed.map((f) => [f.job.id, f.last]));
  for (const a of report.audits) {
    const f = byJob.get(a.jobId);
    if (f && !a.completed) a.issues = [`Failed (attempt ${f.attempt}): ${f.error}`, ...a.issues.filter((i) => !/was not returned/i.test(i))];
  }
  const shown = failed.slice(0, 100);
  report.exclusions.push(
    ...shown.map(({ job, last }) => `${label.get(job.conditionId) ?? job.conditionId}, session ${job.id}: no accepted forecast, so it is not scored (failed, attempt ${last.attempt}: ${last.error})`),
  );
  if (failed.length > shown.length) report.exclusions.push(`${failed.length - shown.length} more failed session(s) are not scored; each one's audit names its error.`);
}
/** Planner → campaign → worker → analyzer, across a whole lineage of continuations. */
export function analyzeCampaign(
  c: Campaign,
  human: HumanData,
  bundles: ResultBundle[],
  comparisons?: Comparison[],
  receipts?: CampaignReceipt[],
  /** Scores kept from an analysis of the same campaign, human data and results with other comparisons. */
  memo?: AnalysisMemo,
  /** Analysis choices, e.g. leaving out incomplete sessions. */
  options: AnalysisOptions = {},
): CampaignAnalysis {
  const plan = campaignPlan(c);
  const merged = mergeCampaignResults(c, bundles);
  const report = analyzeVerifiedPlan(plan, human, merged.bundle, comparisons, memo, options);
  // Incomplete sessions (forecast accepted before every required task was finished): said in a
  // note, scored or left out as chosen.
  const incomplete = report.audits.filter((a) => a.unfinishedTasks?.length).length;
  if (incomplete)
    report.notes.push(
      options.excludeIncomplete
        ? `${incomplete} incomplete session(s) left out at your choice: their forecast was accepted before every required task was finished.`
        : `${incomplete} scored session(s) are incomplete: their forecast was accepted before every required task was finished (the audit lists them). Leave them out to score complete sessions only.`,
    );
  if (receipts) addFailureReasons(c, report, receipts);
  if (merged.reused.length)
    report.notes.push(
      `${merged.reused.length} forecast run(s) were reused from earlier campaigns with an identical setup and model; their original session and output are scored once, not regenerated.`,
    );
  if (c.conditionModels) {
    // Say what differs: the model (or provider), or only the effort the same model spends.
    const models = c.suite.conditions.map((x) => conditionModel(c, x.id));
    const differs = new Set(models.flatMap((m) => modelDifferences(models[0], m)));
    if (differs.has("model") || differs.has("provider"))
      report.notes.push(
        `Conditions use different forecasting models${differs.has("effort") ? " and efforts" : ""}. A between-condition difference confounds method and model unless the contrast holds the method fixed.`,
      );
    else if (differs.has("effort"))
      report.notes.push(
        "Conditions use the same model with different effort (how much it thinks before answering). A between-condition difference confounds method and effort unless the contrast holds the method fixed.",
      );
  }
  // Which compared configurations differ in what they get and also in model or effort.
  report.notes.push(...modelConfoundWarnings(plan.study, plan.agents, comparisons));
  return {
    campaignDigest: c.digest,
    models: Object.fromEntries(
      c.suite.conditions.map((x) => [x.id, conditionModel(c, x.id)]),
    ),
    reused: merged.reused,
    ignoredRuns: merged.ignoredRuns,
    report,
    scorecard: campaignScorecard(c, report, human),
  };
}
export function campaignScorecard(
  c: Campaign,
  report: AnalysisReport,
  human: HumanData,
): CampaignScorecard {
  requireThat(report.planDigest === c.digest, "Report is for another campaign.");
  const study = c.suite.study!;
  const humans = (domain: string) =>
    new Set(
      human.measurements
        .filter(
          (m) =>
            study.outcomes.find((o) => o.id === m.outcomeId)?.domain === domain,
        )
        .map((m) => m.participantId ?? ""),
    ).size;
  return {
    schemaVersion: "xr-campaign-scores/1",
    campaignDigest: c.digest,
    scoringDigest: scoringDigest(c.suite),
    humanReferenceDigest: hash(human),
    coverageDigest: hash({
      outcomes: study.outcomes.map((o) => o.id),
      exclusions: report.exclusions,
    }),
    rows: report.summaries.map((s) => ({
      conditionId: s.agentId,
      domain: s.domain,
      agreement: s.agreement,
      ci95: s.ci95,
      nHumans: humans(s.domain),
      nRuns: s.scoreable,
      // Which kind of runs the score rests on (real and simulated are never pooled).
      real: s.real ?? 0,
      simulated: s.simulated ?? 0,
    })),
  };
}
/**
 * Mock worker for synthetic planner-derived campaigns: executes only the jobs
 * that are not reused, with model-dependent invented forecasts, and returns
 * receipts plus a result bundle exactly like a real worker would.
 */
export function syntheticCampaignExecution(
  c: Campaign,
  options: { failJobIds?: string[] } = {},
): { receipts: CampaignReceipt[]; results: ResultBundle } {
  const plan = campaignPlan(c);
  requireThat(
    plan.study.synthetic && c.suite.synthetic,
    "The mock worker only runs synthetic campaigns.",
  );
  const fresh = c.jobs.filter((j) => j.kind === "llm" && !j.inheritedFrom);
  const runs: RunResult[] = [];
  const byModel = new Map<string, typeof fresh>();
  fresh.forEach((j) => {
    const k = hash(conditionModel(c, j.conditionId));
    byModel.set(k, [...(byModel.get(k) ?? []), j]);
  });
  for (const [modelHash, jobs] of byModel) {
    const ids = new Set(jobs.map((j) => j.id));
    const subplan = {
      ...plan,
      frozenAt: c.createdAt,
      jobs: plan.jobs.filter((j) => ids.has(j.id)),
    };
    const seed = parseInt(modelHash.slice(0, 8), 16);
    runs.push(...syntheticResults(subplan, false, seed).runs);
  }
  const sessionKey = new Map(c.jobs.map((j) => [j.id, j.sessionKey]));
  runs.forEach((r) => {
    r.sessionId = sessionKey.get(r.jobId)!;
    if (options.failJobIds?.includes(r.jobId)) {
      r.status = "failed";
      r.error = "Synthetic worker failure.";
      r.measurements = [];
    }
  });
  const receipts: CampaignReceipt[] = runs.map((r) => {
    const job = c.jobs.find((j) => j.id === r.jobId)!;
    return {
      campaignDigest: c.digest,
      jobId: r.jobId,
      attempt: 1,
      status: r.status,
      actualModel: { ...conditionModel(c, job.conditionId) },
      sessionId: r.sessionId,
      freshSession: true,
      freshPIE: true,
      freshScreenshots: true,
      assetHashes: Object.fromEntries(
        job.assetIds.map((id) => [
          id,
          c.suite.assets.find((a) => a.id === id)!.sha256,
        ]),
      ),
      output: r.status === "completed" ? { path: `results/${r.jobId}.json`, sha256: hash(r) } : null,
      executionManifest: {
        path: "execution-manifest.json",
        sha256: hash({ synthetic: true, campaign: c.digest }),
      },
      usage: {
        inputTokens: r.execution.inputTokens,
        outputTokens: r.execution.outputTokens,
      },
      ...(r.error ? { error: r.error } : {}),
    };
  });
  return {
    receipts,
    results: { schemaVersion: "1.0", studyId: plan.study.id, runs },
  };
}
