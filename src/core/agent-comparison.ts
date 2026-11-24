// Compare agent configurations with each other, without human data: how consistent each
// configuration is from run to run, how far configurations agree on the design pattern, and what
// they cost (tool calls, time, money, protocol deviations). Useful while piloting.
//
// Directional agreement between two forecasts: for every pair of designs, do both put them in the
// same order? Same order = 1, one tie = 0.5, opposite = 0, both tied = 1 (two forecasts that both
// see no difference agree; against humans, tied human pairs are left out instead). A tie is a
// difference within the study's tie tolerance. Averaged over design pairs, then over the outcomes
// both forecasts cover with the study's family and outcome weights (as the analyzer's scores),
// separately per domain. Real and simulated runs are never pooled: a configuration with real runs
// is described by those only.
import { outcomeWeights } from "./analyzer.js";
import { describeModel } from "./campaign.js";
import { agentLevel, agentTargets } from "./planner.js";
import { auditRun } from "./protocol.js";
import type { Domain, Plan, RunResult, Study } from "./types.js";
import { measurementValue } from "./validation.js";

export interface RunExtras {
  /** Reported session cost in USD, when known. */
  costUsd?: number | null;
}
export interface AgentComparison {
  configs: {
    id: string;
    label: string;
    level: "population" | "individual";
    model: string;
    assigned: number;
    real: number;
    simulated: number;
    /** Which runs the rows below describe. */
    basis: "real" | "simulated" | "none";
    deviations: number;
    meanToolCalls: number | null;
    meanWallMinutes: number | null;
    meanCostUsd: number | null;
    totalCostUsd: number | null;
    /** Run-to-run directional agreement (population: all run pairs; individual: pairs of the same person). */
    consistency: Record<Domain, number | null>;
    consistencyPairs: number;
  }[];
  /** Agreement between configurations' mean design patterns, over the outcomes both predict. */
  pairs: { a: string; b: string; domain: Domain; agreement: number | null; outcomes: number }[];
  notes: string[];
}

/** Sign of a difference; |x| ≤ tolerance is a tie, as in the analyzer. */
const sign = (x: number, tolerance: number) => (Math.abs(x) <= tolerance ? 0 : x > 0 ? 1 : -1);
/**
 * Directional agreement of two value vectors over the same designs; null if fewer than two designs.
 * Both tied on a pair counts as agreement (1). The tolerance is the study's tieTolerance.
 */
export function directional(a: number[], b: number[], tolerance = 1e-8): number | null {
  let sum = 0,
    n = 0;
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      if (![a[i], a[j], b[i], b[j]].every(Number.isFinite)) continue;
      const sa = sign(a[i] - a[j], tolerance),
        sb = sign(b[i] - b[j], tolerance);
      sum += sa === sb ? 1 : sa === 0 || sb === 0 ? 0.5 : 0;
      n++;
    }
  return n ? sum / n : null;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
/**
 * Directional agreement of two forecasts (outcome → design values, log scale for geometric
 * measures) over the outcomes of one domain both cover, weighted with the study's family and
 * outcome weights exactly as the analyzer weights its scores.
 */
export function agreementBetween(
  study: Study,
  p: Map<string, number[]>,
  q: Map<string, number[]>,
  domain: Domain,
): { score: number | null; outcomes: number } {
  const scores = study.outcomes.map((o) =>
    o.domain === domain && p.has(o.id) && q.has(o.id) ? directional(p.get(o.id)!, q.get(o.id)!, study.analysis.tieTolerance) : null,
  );
  const weights = outcomeWeights(study, domain, scores.map((s) => s !== null));
  const score = weights.size ? [...weights].reduce((s, [i, w]) => s + scores[i]! * w, 0) : null;
  return { score, outcomes: weights.size };
}

export function compareAgents(plan: Plan, runs: RunResult[], extras: Record<string, RunExtras> = {}): AgentComparison {
  const study = plan.study;
  const designs = study.conditions.map((c) => c.id);
  const jobs = new Map(plan.jobs.map((j) => [j.id, j]));
  const byAgent = new Map<string, RunResult[]>();
  for (const r of runs) {
    const j = jobs.get(r.jobId);
    if (j && r.status === "completed") byAgent.set(j.agentId, [...(byAgent.get(j.agentId) ?? []), r]);
  }
  /** outcome → design values for one run (geometric outcomes on the log scale, so means are geometric). */
  const profile = (r: RunResult) => {
    const out = new Map<string, number[]>();
    for (const o of study.outcomes) {
      const values = designs.map((d) => {
        const m = r.measurements.find((x) => x.outcomeId === o.id && x.conditionId === d);
        if (!m) return NaN;
        try {
          const v = measurementValue(study, m);
          return o.aggregation === "geometric" ? Math.log(v) : v;
        } catch {
          return NaN;
        }
      });
      if (values.some(Number.isFinite)) out.set(o.id, values);
    }
    return out;
  };
  const domains: Domain[] = ["objective", "subjective"];
  const agree = (p: Map<string, number[]>, q: Map<string, number[]>, domain: Domain) => agreementBetween(study, p, q, domain);

  const notes: string[] = [];
  const meanProfiles = new Map<string, Map<string, number[]>>();
  const configs = plan.agents.map((a) => {
    const level = agentLevel(study, a);
    const all = byAgent.get(a.id) ?? [];
    const real = all.filter((r) => !r.execution?.synthetic);
    const sim = all.filter((r) => r.execution?.synthetic);
    const basis: "real" | "simulated" | "none" = real.length ? "real" : sim.length ? "simulated" : "none";
    const used = real.length ? real : sim;
    if (real.length && sim.length) notes.push(`${a.label}: ${real.length} real + ${sim.length} simulated runs; described by the real ones only.`);
    const deviations = used.filter((r) => !auditRun(plan, jobs.get(r.jobId)!, r).compliant).length;
    const profiles = used.map((r) => ({ r, p: profile(r), person: jobs.get(r.jobId)!.participantId ?? null }));
    // Run-to-run consistency.
    const consistency = {} as Record<Domain, number | null>;
    let pairCount = 0;
    for (const d of domains) {
      const scores: number[] = [];
      for (let i = 0; i < profiles.length; i++)
        for (let j = i + 1; j < profiles.length; j++) {
          if (level === "individual" && profiles[i].person !== profiles[j].person) continue;
          const s = agree(profiles[i].p, profiles[j].p, d).score;
          if (s !== null) scores.push(s);
        }
      consistency[d] = mean(scores);
      pairCount = Math.max(pairCount, scores.length);
    }
    // Mean design profile of this configuration (individual: averaged over people to the cohort).
    const targets = agentTargets(study, a);
    const avg = new Map<string, number[]>();
    for (const o of targets) {
      const rows = profiles.map((x) => x.p.get(o)).filter((v): v is number[] => !!v);
      if (rows.length) avg.set(o, designs.map((_, i) => mean(rows.map((r) => r[i]).filter(Number.isFinite)) ?? NaN));
    }
    meanProfiles.set(a.id, avg);
    const costs = used.map((r) => extras[r.jobId]?.costUsd).filter((x): x is number => typeof x === "number");
    return {
      id: a.id,
      label: a.label,
      level,
      /** With its effort: "claude-sonnet-5-5, effort high". */
      model: describeModel(a.model),
      assigned: plan.jobs.filter((j) => j.agentId === a.id).length,
      real: real.length,
      simulated: sim.length,
      basis,
      deviations,
      meanToolCalls: basis === "real" ? mean(used.map((r) => r.execution.toolCalls)) : null,
      meanWallMinutes: basis === "real" ? mean(used.map((r) => r.execution.inferenceWallTimeMs / 60000)) : null,
      meanCostUsd: mean(costs),
      totalCostUsd: costs.length ? costs.reduce((s, x) => s + x, 0) : null,
      consistency,
      consistencyPairs: pairCount,
    };
  });
  const pairs: AgentComparison["pairs"] = [];
  for (let i = 0; i < plan.agents.length; i++)
    for (let j = i + 1; j < plan.agents.length; j++)
      for (const d of domains) {
        const a = plan.agents[i].id,
          b = plan.agents[j].id;
        const r = agree(meanProfiles.get(a)!, meanProfiles.get(b)!, d);
        pairs.push({ a, b, domain: d, agreement: r.score, outcomes: r.outcomes });
      }
  if (configs.some((c) => c.basis === "real") && configs.some((c) => c.basis === "simulated"))
    notes.push(`Described by simulated (invented) runs: ${configs.filter((c) => c.basis === "simulated").map((c) => c.label).join(", ")}. Comparisons with them compare invented with real forecasts.`);
  notes.push(
    "Directional agreement: for each pair of designs, whether two forecasts order them the same way (1), opposite (0), one ties (0.5) or both tie (1, within the study's tie tolerance), averaged over design pairs and over the outcomes both cover with the study's family and outcome weights. It needs no human data and says nothing about accuracy.",
    "Tool calls, time and cost describe real sessions only; simulated runs have none.",
  );
  return { configs, pairs, notes };
}
