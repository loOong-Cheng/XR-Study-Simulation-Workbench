// Plain-language summaries for coding agents and researchers. Every command
// that checks a file prints one of these, so a reader sees what the framework
// understood, not only whether the JSON validated.
import type { AgentProtocol, HumanData, Plan, Study } from "./types.js";
import { methodGets } from "./planner.js";
import {
  campaignSummary,
  conditionModel,
  type Campaign,
} from "./campaign.js";

const table = (head: string[], rows: (string | number)[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map((c) => String(c).replace(/\|/g, "/")).join(" | ")} |`),
  ].join("\n");

export function explainStudy(study: Study, agents?: AgentProtocol[]): string {
  const orders = new Map<string, string[]>();
  study.participants.forEach((p) => {
    const k = p.conditionOrder.join(" → ");
    orders.set(k, [...(orders.get(k) ?? []), p.id]);
  });
  const parts = [
    `# ${study.title}${study.synthetic ? " (synthetic)" : ""}`,
    `**Research question:** ${study.researchQuestion}`,
    `**Design:** ${study.design}; **prediction:** ${study.predictionLevel}, ${study.predictionTiming}; **runtime:** ${study.runtime.engine} / ${study.runtime.backend}, ${study.runtime.observation}, ${study.runtime.deviceProfile}`,
    "## Designs (conditions)",
    table(
      ["ID", "Label", "Cases"],
      study.conditions.map((c) => [
        c.id,
        c.label,
        study.cases.filter((x) => x.conditionId === c.id).map((x) => x.phaseId).join(", ") || "—",
      ]),
    ),
    `## Participants and orders (${study.participants.length})`,
    table(
      ["Order", "Participants"],
      [...orders].map(([o, ids]) => [o, `${ids.length}: ${ids.join(", ")}`]),
    ),
    "## Outcomes",
    table(
      ["ID", "Label", "Domain", "Unit", "Scale", "Family (weight)", "Phases"],
      study.outcomes.map((o) => [
        o.id,
        o.label + (o.components ? ` [items: ${o.components.join(", ")}]` : ""),
        o.domain,
        o.unit,
        o.scale,
        `${o.family} (${study.analysis.familyWeights[o.family]})`,
        o.phaseIds.join(", "),
      ]),
    ),
    "## Information agents may receive",
    table(
      ["ID", "Kind", "Label", "Allowed fields"],
      study.sources.map((s) => [s.id, s.kind, s.label, s.fields?.join(", ") ?? "—"]),
    ),
    ...(study.analysis.contrasts.length ? ["## Comparisons stored with the study (optional; usually chosen at analysis)"] : []),
    study.analysis.contrasts.length
      ? table(
          ["ID", "Candidate − baseline", "Domain"],
          study.analysis.contrasts.map((c) => [
            c.id,
            `${agents?.find((a) => a.id === c.candidate)?.label ?? c.candidate} − ${agents?.find((a) => a.id === c.baseline)?.label ?? c.baseline}`,
            c.domain,
          ]),
        )
      : "",
  ];
  if (agents)
    parts.push(
      "## Agent methods",
      table(
        ["ID", "Method", "The agent gets", "What it tests", "Model"],
        agents.map((a) => [
          a.id,
          a.label,
          methodGets(a, study).join("; "),
          a.rationale,
          `${a.model.provider} / ${a.model.model} (${a.model.reasoning})`,
        ]),
      ),
    );
  return parts.join("\n\n") + "\n";
}

export function explainPlan(plan: Plan): string {
  return (
    explainStudy(plan.study, plan.agents) +
    `\n## Frozen plan\n\nDigest \`${plan.digest}\`, frozen ${plan.frozenAt}: ${plan.repetitions} repetition(s), ${plan.jobs.length} jobs.\n`
  );
}

export function explainCampaign(c: Campaign): string {
  const s = campaignSummary(c);
  const head = c.suite.study
    ? explainStudy(c.suite.study)
    : `# ${c.suite.title}${c.suite.synthetic ? " (synthetic)" : ""}\n`;
  return (
    head +
    `\n## Campaign\n\n\`${c.id}\`, digest \`${c.digest}\`${c.parentDigest ? `, continues \`${c.parentDigest.slice(0, 12)}…\`` : ""}. ` +
    `${s.llmSessions} model sessions (${s.newLlmSessions} new, ${s.reusedJobs} reused jobs), ${s.rulesChecks} rule checks, ${s.derivedProfiles} derived profiles.\n\n` +
    table(
      ["Condition", "Kind", "Model", "Jobs", "Reused"],
      c.suite.conditions.map((x) => [
        x.id,
        x.kind,
        x.kind === "llm" ? conditionModel(c, x.id).model : "—",
        x.jobs.length,
        c.jobs.filter((j) => j.conditionId === x.id && j.inheritedFrom).length,
      ]),
    ) +
    "\n"
  );
}

/** Explains mismatches between a study and a human reference before analysis. */
export function humanCoverage(study: Study, human: HumanData) {
  const people = new Set(study.participants.map((p) => p.id));
  const outcomes = new Set(study.outcomes.map((o) => o.id));
  const conditions = new Set(study.conditions.map((c) => c.id));
  const seen = new Set(human.measurements.map((m) => `${m.participantId}|${m.conditionId}|${m.outcomeId}`));
  const unknownPeople = [...new Set(human.measurements.map((m) => m.participantId ?? "(none)"))].filter((p) => !people.has(p));
  const unknownOutcomes = [...new Set(human.measurements.map((m) => m.outcomeId))].filter((o) => !outcomes.has(o));
  const unknownConditions = [...new Set(human.measurements.map((m) => m.conditionId))].filter((c) => !conditions.has(c));
  const missing: string[] = [];
  for (const p of study.participants)
    for (const c of p.conditionOrder)
      for (const o of study.outcomes)
        if (!seen.has(`${p.id}|${c}|${o.id}`)) missing.push(`${p.id}|${c}|${o.id}`);
  return {
    records: human.measurements.length,
    expected: study.participants.reduce((n, p) => n + p.conditionOrder.length, 0) * study.outcomes.length,
    unknownPeople,
    unknownOutcomes,
    unknownConditions,
    missing,
    synthetic: human.synthetic,
  };
}
