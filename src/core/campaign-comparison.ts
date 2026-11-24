import { hash } from "./planner.js";
import {
  conditionModel,
  describeModel,
  modelDifferences,
  scoringDigest,
  verifyCampaign,
  type Campaign,
  type CampaignCondition,
  type CampaignModel,
} from "./campaign.js";
import { requireThat } from "./validation.js";

export interface CampaignScorecard {
  schemaVersion: "xr-campaign-scores/1";
  campaignDigest: string;
  scoringDigest: string;
  humanReferenceDigest: string;
  coverageDigest: string;
  rows: {
    conditionId: string;
    domain: "objective" | "subjective";
    agreement: number | null;
    ci95?: { low: number; high: number } | null;
    nHumans: number;
    nRuns: number;
    /**
     * Returned real and simulated runs behind the score. The built-in analyzer fills them; an
     * external adapter may leave them out (then the kind of runs is unknown).
     */
    real?: number;
    simulated?: number;
  }[];
}
/** Which runs a scorecard row rests on: real runs win (simulated ones are then left out). */
export type RunBasis = "real" | "simulated" | "none" | "unknown";
function basisOf(row: CampaignScorecard["rows"][number] | undefined): RunBasis {
  if (!row) return "none";
  if (typeof row.real !== "number" || typeof row.simulated !== "number") return "unknown";
  return row.real > 0 ? "real" : row.simulated > 0 ? "simulated" : "none";
}
export type ComparisonStatus =
  | "comparable"
  | "added"
  | "removed"
  | "setup-changed"
  | "real-vs-simulated";
const objectiveIsInput = (c: CampaignCondition) =>
  c.recipe.personalInformation.includes("measured-objective-data");
/** Setup identity of a condition, independent of its model and repetition count. */
function setupKey(campaign: Campaign, c: CampaignCondition): string {
  return hash({
    stage: c.stage,
    kind: c.kind,
    recipe: c.recipe.protocol
      ? { ...c.recipe, protocol: { ...c.recipe.protocol, label: null } }
      : c.recipe,
    sourceConditionId: c.sourceConditionId ?? null,
    outcomes: campaign.suite.study?.outcomes ?? null,
  });
}
export function compareCampaignScores(
  before: Campaign,
  oldScores: CampaignScorecard,
  after: Campaign,
  newScores: CampaignScorecard,
) {
  verifyCampaign(before);
  verifyCampaign(after);
  requireThat(
    scoringDigest(before.suite) === scoringDigest(after.suite),
    "Scoring definitions differ; scores are not comparable across these campaigns.",
  );
  for (const [campaign, card] of [
    [before, oldScores],
    [after, newScores],
  ] as const) {
    requireThat(
      card.schemaVersion === "xr-campaign-scores/1" &&
        card.campaignDigest === campaign.digest,
      "Scorecard does not match its campaign.",
    );
    requireThat(
      card.scoringDigest === scoringDigest(campaign.suite) &&
        /^[a-f0-9]{64}$/.test(card.humanReferenceDigest) &&
        /^[a-f0-9]{64}$/.test(card.coverageDigest),
      "Scorecard must identify the frozen scoring contract, human reference and evaluated coverage.",
    );
    const seen = new Set<string>();
    for (const r of card.rows) {
      const condition = campaign.suite.conditions.find(
        (c) => c.id === r.conditionId,
      );
      requireThat(
        condition && ["objective", "subjective"].includes(r.domain),
        "Unknown scorecard condition/domain.",
      );
      requireThat(
        !objectiveIsInput(condition) || r.domain === "subjective",
        "Measured objective data were inputs, not new objective prediction targets.",
      );
      requireThat(
        !seen.has(`${r.conditionId}/${r.domain}`),
        "Duplicate scorecard row.",
      );
      seen.add(`${r.conditionId}/${r.domain}`);
      requireThat(
        (r.agreement === null ||
          (Number.isFinite(r.agreement) &&
            r.agreement >= 0 &&
            r.agreement <= 1)) &&
          Number.isInteger(r.nHumans) &&
          r.nHumans >= 0 &&
          Number.isInteger(r.nRuns) &&
          r.nRuns >= 0 &&
          [r.real, r.simulated].every(
            (n) => n === undefined || (Number.isInteger(n) && n >= 0),
          ),
        "Invalid scorecard values.",
      );
    }
  }
  requireThat(
    oldScores.humanReferenceDigest === newScores.humanReferenceDigest &&
      oldScores.coverageDigest === newScores.coverageDigest,
    "Human reference or evaluated coverage differs; do not compare unmatched scores.",
  );
  const ids = [
    ...after.suite.conditions.map((c) => c.id),
    ...before.suite.conditions
      .map((c) => c.id)
      .filter((id) => !after.suite.conditions.some((c) => c.id === id)),
  ];
  const model = (x: Campaign, cond?: CampaignCondition) =>
    cond && cond.kind === "llm" ? conditionModel(x, cond.id) : null;
  const rows = ids.flatMap((id) => {
    const b = before.suite.conditions.find((c) => c.id === id);
    const a = after.suite.conditions.find((c) => c.id === id);
    const c = (a ?? b)!;
    const setup: ComparisonStatus = !b
      ? "added"
      : !a
      ? "removed"
      : setupKey(before, b) !== setupKey(after, a)
      ? "setup-changed"
      : "comparable";
    const beforeSettings = model(before, b);
    const afterSettings = model(after, a);
    const modelChanges =
      beforeSettings && afterSettings
        ? modelDifferences(beforeSettings, afterSettings)
        : [];
    return (
      objectiveIsInput(c)
        ? (["subjective"] as const)
        : (["objective", "subjective"] as const)
    ).map((domain) => {
      const old = b
        ? oldScores.rows.find((r) => r.conditionId === id && r.domain === domain)
        : undefined;
      const next = a
        ? newScores.rows.find((r) => r.conditionId === id && r.domain === domain)
        : undefined;
      requireThat(
        setup !== "comparable" || !old || !next || old.nHumans === next.nHumans,
        "Human denominators differ across model scorecards.",
      );
      const beforeBasis = b ? basisOf(old) : "none";
      const afterBasis = a ? basisOf(next) : "none";
      // Invented forecasts are never compared with real ones.
      const mixed =
        setup === "comparable" &&
        [beforeBasis, afterBasis].includes("real") &&
        [beforeBasis, afterBasis].includes("simulated");
      const status: ComparisonStatus = mixed ? "real-vs-simulated" : setup;
      const notes: string[] = [];
      if (mixed)
        notes.push(
          `Not comparable: ${beforeBasis} runs before, ${afterBasis} runs after. Simulated runs are invented, so no change is computed.`,
        );
      else if (status === "comparable" && beforeBasis === "simulated" && afterBasis === "simulated")
        notes.push("Simulated (invented) runs on both sides: this tests the pipeline, not prediction quality.");
      if (modelChanges.length) {
        const show = (m: CampaignModel) =>
          modelChanges.includes("provider") ? `${m.provider} ${describeModel(m)}` : describeModel(m);
        notes.push(
          `Changed ${modelChanges.join(" and ")}: ${show(beforeSettings!)} → ${show(afterSettings!)}.`,
        );
      }
      if (setup === "setup-changed")
        notes.push("The setup changed (what the configuration gets or does), so no change is computed.");
      const comparable = status === "comparable";
      return {
        conditionId: id,
        domain,
        status,
        comparable,
        beforeLabel: b?.label ?? null,
        afterLabel: a?.label ?? null,
        /** The model for people, with its effort: "claude-sonnet-5-5, effort high". */
        beforeModel: beforeSettings ? describeModel(beforeSettings) : null,
        afterModel: afterSettings ? describeModel(afterSettings) : null,
        beforeSettings: beforeSettings ? { ...beforeSettings } : null,
        afterSettings: afterSettings ? { ...afterSettings } : null,
        /** Provider, model or effort differ (an effort written "high" or "effort=high" is the same). */
        modelChanged: modelChanges.length > 0,
        modelChanges,
        beforeRunKind: beforeBasis,
        afterRunKind: afterBasis,
        before: old?.agreement ?? null,
        after: next?.agreement ?? null,
        changePercentagePoints:
          comparable && old?.agreement != null && next?.agreement != null
            ? (next.agreement - old.agreement) * 100
            : null,
        nHumans: next?.nHumans ?? old?.nHumans ?? 0,
        beforeRuns: old?.nRuns ?? 0,
        afterRuns: next?.nRuns ?? 0,
        note: notes.length ? notes.join(" ") : null,
      };
    });
  });
  const kinds = new Set(rows.flatMap((r) => [r.beforeRunKind, r.afterRunKind]));
  const models = { before: modelsOf(before), after: modelsOf(after) };
  return {
    // One model for the whole campaign, or null when its configurations use different ones.
    beforeModel: models.before.size === 1 ? [...models.before][0] : null,
    afterModel: models.after.size === 1 ? [...models.after][0] : null,
    protocolDigest: before.protocolDigest,
    sameProtocol: before.protocolDigest === after.protocolDigest,
    rows,
    notes: [
      "Descriptive model differences only. No p-values or superiority claims are inferred from summary scores.",
      "Only rows with status 'comparable' (same setup, scoring, human reference and coverage, and real or simulated runs on both sides) have a change value. Added, removed or changed setups, and real runs set against simulated ones, are listed without a change.",
      "Calculate paired human/run uncertainty using the frozen scoring adapter and original result-level data. Missing rows remain null; no zero filling or favorable coverage selection.",
      "Reused runs are identical in both campaigns; a change in a comparable row with reused runs reflects only the newly executed runs.",
      ...(kinds.has("simulated")
        ? ["Some scores rest on simulated (invented) runs; they test the pipeline, not prediction quality."]
        : []),
      ...(kinds.has("unknown")
        ? ["A scorecard does not say whether its runs were real or simulated; check this before reading a change."]
        : []),
      ...(models.before.size > 1 || models.after.size > 1
        ? ["Configurations use different models; each row names its own."]
        : []),
    ],
  };
}
/** The models a campaign's configurations use, as described for people. */
const modelsOf = (x: Campaign) =>
  new Set(
    x.suite.conditions
      .filter((c) => c.kind === "llm")
      .map((c) => describeModel(conditionModel(x, c.id))),
  );
