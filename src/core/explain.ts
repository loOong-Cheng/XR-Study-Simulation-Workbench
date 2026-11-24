// Plain-language summaries for coding agents and researchers. Every command
// that checks a file prints one of these, so a reader sees what the framework
// understood, not only whether the JSON validated.
import type { AgentProtocol, Comparison, HumanData, Plan, Study } from "./types.js";
import { agentLevel, agentTargets, methodGets } from "./planner.js";
import { compositeRule, measurementValue, mixedLevelsMessage } from "./validation.js";
import { smallestMannWhitneyP, smallestWilcoxonP } from "./rank-tests.js";
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

const pText = (p: number) => String(Number(p.toPrecision(2)));
/**
 * Warnings about the study as planned (no human values are read): whether any human design
 * difference can reach p < .05 at all with this many people, under the analyzer's rules (exact
 * Wilcoxon signed-rank within subjects, exact Mann–Whitney U between independent groups, Holm
 * over the design pairs of a measure). The smallest adjusted p is the number of pairs times the
 * smallest p the test can give.
 */
export function studyWarnings(study: Study): string[] {
  const alpha = 0.05;
  const k = study.conditions.length;
  const pairs = (k * (k - 1)) / 2;
  if (pairs < 1 || !study.participants.length) return [];
  const holmText = (p: number) => (pairs > 1 ? `; Holm over the ${pairs} design pairs of a measure makes it ${pText(Math.min(1, pairs * p))}` : "");
  if (study.design === "within-subjects") {
    const n = study.participants.length;
    const p = smallestWilcoxonP(n);
    if (pairs * p < alpha) return [];
    let need = Math.max(2, n);
    while (pairs * smallestWilcoxonP(need) >= alpha) need++;
    return [
      `With ${n} ${n === 1 ? "person" : "people"}, no design difference can reach p < .05: the smallest p the Wilcoxon signed-rank test can give is ${pText(p)}${holmText(p)}. The significant-only view will be empty; the main scores (every difference of the design means) are not affected. At least ${need} people are needed for a difference to be able to reach significance.`,
    ];
  }
  const size = new Map(study.conditions.map((c) => [c.id, 0]));
  for (const person of study.participants) for (const c of person.conditionOrder) size.set(c, (size.get(c) ?? 0) + 1);
  let best = 1;
  for (let i = 0; i < k; i++)
    for (let j = i + 1; j < k; j++)
      best = Math.min(best, smallestMannWhitneyP(size.get(study.conditions[i].id)!, size.get(study.conditions[j].id)!));
  if (pairs * best < alpha) return [];
  const sizes = [...new Set(size.values())].sort((a, b) => a - b);
  return [
    `With ${sizes.length === 1 ? sizes[0] : `${sizes[0]}–${sizes.at(-1)}`} ${sizes.at(-1) === 1 ? "person" : "people"} per design, no difference between the groups can reach p < .05: the smallest p the Mann–Whitney U test can give is ${pText(best)}${holmText(best)}. Agents are scored on significant group differences only, so nothing can be scored against the human data. Add people to the groups.`,
  ];
}

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
        o.label + (o.components ? ` [items, ${compositeRule(o)}: ${o.components.join(", ")}]` : ""),
        o.domain,
        o.unit,
        o.scale + (o.range ? ` ${o.range[0]}–${o.range[1]}` : ""),
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
  const warnings = studyWarnings(study);
  if (warnings.length) parts.push("## Warnings", warnings.map((w) => `- ${w}`).join("\n"));
  if (agents) parts.push(explainAgents(study, agents));
  return parts.join("\n\n") + "\n";
}

/** The agent configurations as one table: level, what each gets, what it predicts and which measured outcomes it receives. */
export function explainAgents(study: Study, agents: AgentProtocol[]): string {
  return (
    "## Agent methods\n\n" +
    table(
      ["ID", "Method", "Level", "Runtime", "The agent gets", "Predicts", "Inputs (measured)", "What it tests", "Model"],
      agents.map((a) => [
        a.id,
        a.label,
        agentLevel(study, a),
        a.runtime ?? "none",
        methodGets(a, study).join("; "),
        agentTargets(study, a).join(", ") || "—",
        a.inputs?.length ? a.inputs.join(", ") : "—",
        a.rationale,
        `${a.model.provider} / ${a.model.model} (${a.model.reasoning})`,
      ]),
    )
  );
}

/** Comparisons chosen at analysis, and what is wrong with any of them (IDs, domain, levels). */
export function explainComparisons(comparisons: Comparison[], study?: Study, agents?: AgentProtocol[]) {
  const problems: string[] = [];
  const name = (id: string) => agents?.find((a) => a.id === id)?.label ?? id;
  comparisons.forEach((c, i) => {
    const where = `Comparison ${i + 1} (${c?.candidate} − ${c?.baseline})`;
    if (!c || typeof c.candidate !== "string" || typeof c.baseline !== "string") {
      problems.push(`${where}: give "candidate" and "baseline" configuration IDs.`);
      return;
    }
    if (!["objective", "subjective"].includes(c.domain))
      problems.push(`${where}: domain "${c.domain}" is not allowed; use "objective" or "subjective".`);
    if (c.candidate === c.baseline) problems.push(`${where}: candidate and baseline are the same configuration.`);
    if (agents) {
      const unknown = [c.candidate, c.baseline].filter((id) => !agents.some((a) => a.id === id));
      if (unknown.length)
        problems.push(
          `${where}: ${unknown.join(", ")} ${unknown.length === 1 ? "is not a configuration" : "are not configurations"} here (configurations: ${agents.map((a) => a.id).join(", ")}).`,
        );
      else if (study) {
        const [x, y] = [c.candidate, c.baseline].map((id) => agentLevel(study, agents.find((a) => a.id === id)!));
        if (x !== y) problems.push(mixedLevelsMessage(c.candidate, c.baseline));
      }
    }
  });
  const text =
    "## Comparisons chosen at analysis\n\n" +
    (comparisons.length
      ? table(
          ["Candidate − baseline", "Domain"],
          comparisons.map((c) => [`${name(c?.candidate)} − ${name(c?.baseline)}`, String(c?.domain)]),
        )
      : "None. Without comparisons the analyzer reports each configuration on its own.") +
    "\n";
  return { text, problems };
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
  const list = Array.isArray(human?.measurements) ? human.measurements.filter((m) => m && typeof m === "object") : [];
  const people = new Set(study.participants.map((p) => p.id));
  const outcomes = new Set(study.outcomes.map((o) => o.id));
  const conditions = new Set(study.conditions.map((c) => c.id));
  const counts = new Map<string, number>();
  list.forEach((m) => {
    const k = `${m.participantId}|${m.conditionId}|${m.outcomeId}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });
  const unknownPeople = [...new Set(list.map((m) => m.participantId ?? "(none)"))].filter((p) => !people.has(p));
  const unknownOutcomes = [...new Set(list.map((m) => m.outcomeId))].filter((o) => !outcomes.has(o));
  const unknownConditions = [...new Set(list.map((m) => m.conditionId))].filter((c) => !conditions.has(c));
  // A known participant and design, but a design this person did not experience.
  const outsideOrder = [
    ...new Set(
      list
        .filter((m) => people.has(m.participantId ?? "") && conditions.has(m.conditionId) && outcomes.has(m.outcomeId))
        .filter((m) => !study.participants.find((p) => p.id === m.participantId)!.conditionOrder.includes(m.conditionId))
        .map((m) => `${m.participantId}|${m.conditionId}`),
    ),
  ];
  const missing: string[] = [];
  let present = 0;
  for (const p of study.participants)
    for (const c of p.conditionOrder)
      for (const o of study.outcomes)
        if (counts.has(`${p.id}|${c}|${o.id}`)) present++;
        else missing.push(`${p.id}|${c}|${o.id}`);
  const duplicates = [...counts].filter(([, n]) => n > 1);
  return {
    hasMeasurements: Array.isArray(human?.measurements),
    records: list.length,
    expected: study.participants.reduce((n, p) => n + p.conditionOrder.length, 0) * study.outcomes.length,
    /** Expected participant × design × measure records that human.json has, each counted once. */
    present,
    unknownPeople,
    unknownOutcomes,
    unknownConditions,
    outsideOrder,
    duplicates: duplicates.map(([k, n]) => `${k} (${n}×)`),
    /** Records beyond the expected ones: duplicates and records that match no expected record. */
    extra: list.length - present,
    missing,
    synthetic: human?.synthetic,
  };
}

/**
 * The human reference checked against the study: a short text and a list of problems. Only counts
 * and IDs are shown, never values, so reference answers stay hidden while planning.
 */
const records = (n: number) => `${n} record${n === 1 ? "" : "s"}`;
export function explainHuman(study: Study, human: HumanData): { text: string; problems: string[] } {
  const problems: string[] = [];
  const cov = humanCoverage(study, human);
  if (!cov.hasMeasurements) {
    problems.push(
      'human.json has no list of measurements. It needs {"schemaVersion": "1.0", "studyId": "…", "synthetic": true|false, "measurements": [{"participantId", "conditionId", "outcomeId", "value"}, …]} (see docs/data-contract.md).',
    );
    return { text: "## Human reference\n\nNo list of measurements.\n", problems };
  }
  if (human.studyId !== study.id)
    problems.push(`human.json belongs to study "${human.studyId}", but this study's ID is "${study.id}". Check that it is the right file.`);
  if (human.schemaVersion !== "1.0") problems.push(`human.json needs "schemaVersion": "1.0" (it has ${JSON.stringify(human.schemaVersion)}).`);
  if (human.synthetic !== study.synthetic)
    problems.push(
      `human.json is marked ${human.synthetic ? "synthetic (invented)" : "real"}, but the study is marked ${study.synthetic ? "synthetic" : "real"}. Both must say the same.`,
    );
  if (cov.missing.length) {
    const byPerson = new Map<string, string[]>();
    cov.missing.forEach((k) => {
      const [p, c, o] = k.split("|");
      byPerson.set(p, [...(byPerson.get(p) ?? []), `${c}/${o}`]);
    });
    const expectedFor = (id: string) => (study.participants.find((p) => p.id === id)?.conditionOrder.length ?? 0) * study.outcomes.length;
    const people = [...byPerson].map(([p, ks]) =>
      ks.length === expectedFor(p) ? `${p}: all ${ks.length}` : `${p}: ${ks.length} (${ks.slice(0, 3).join(", ")}${ks.length > 3 ? ", …" : ""})`,
    );
    problems.push(
      `Missing ${records(cov.missing.length)} of ${cov.expected} expected (participant × design × measure): ${people.slice(0, 8).join("; ")}${people.length > 8 ? `; and ${people.length - 8} more participants` : ""}. Add them; if a value was really never measured, tell the researcher: the analyzer leaves it out and never counts it as zero.`,
    );
  }
  const count = (pred: (m: HumanData["measurements"][number]) => boolean) => human.measurements.filter((m) => m && pred(m)).length;
  if (cov.unknownPeople.length)
    problems.push(
      `Participant IDs not in the study: ${cov.unknownPeople.join(", ")} (${records(count((m) => cov.unknownPeople.includes(m.participantId ?? "(none)")))}). Add them to study.json, or remove their records.`,
    );
  if (cov.unknownConditions.length)
    problems.push(
      `Design IDs not in the study: ${cov.unknownConditions.join(", ")} (designs: ${study.conditions.map((c) => c.id).join(", ")}). If a design was renamed, rename it in human.json too.`,
    );
  if (cov.unknownOutcomes.length)
    problems.push(
      `Measure IDs not in the study: ${cov.unknownOutcomes.join(", ")} (${records(count((m) => cov.unknownOutcomes.includes(m.outcomeId)))}, not used). If a measure was renamed, rename it in human.json too.`,
    );
  if (cov.outsideOrder.length)
    problems.push(`Records for a design outside the participant's order: ${cov.outsideOrder.slice(0, 8).join(", ")}${cov.outsideOrder.length > 8 ? ", …" : ""}.`);
  if (cov.duplicates.length)
    problems.push(`Duplicate records: ${cov.duplicates.slice(0, 8).join(", ")}${cov.duplicates.length > 8 ? ", …" : ""}. Keep one record per participant × design × measure.`);
  // Values: every record of a known design and measure must be usable (numbers, retained items, ranges).
  const invalid = new Map<string, string[]>();
  for (const m of human.measurements) {
    if (!m || !study.outcomes.some((o) => o.id === m.outcomeId) || !study.conditions.some((c) => c.id === m.conditionId)) continue;
    try {
      measurementValue(study, m);
    } catch (e) {
      const message = (e as Error).message;
      invalid.set(message, [...(invalid.get(message) ?? []), `${m.participantId}/${m.conditionId}`]);
    }
  }
  for (const [message, where] of invalid)
    problems.push(`${message.replace(/\.$/, "")}: ${where.slice(0, 5).join(", ")}${where.length > 5 ? `, … (${where.length} records)` : ""}.`);
  const text =
    "## Human reference\n\n" +
    `${cov.present} of ${cov.expected} expected records present` +
    (cov.missing.length ? `, ${cov.missing.length} missing` : "") +
    (cov.extra > 0 ? `; ${records(cov.extra)} more that match no expected record (unknown IDs or duplicates)` : "") +
    `. ${human.synthetic ? "Synthetic (invented) data." : "Real data."} Values are not shown: reference answers stay hidden while planning.\n`;
  return { text, problems };
}
