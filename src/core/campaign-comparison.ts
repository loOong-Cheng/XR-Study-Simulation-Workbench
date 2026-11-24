import { hash } from "./planner.js";
import {
  conditionModel,
  scoringDigest,
  verifyCampaign,
  type Campaign,
  type CampaignCondition,
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
  }[];
}
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
          r.nRuns >= 0,
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
  const rows = ids.flatMap((id) => {
    const b = before.suite.conditions.find((c) => c.id === id);
    const a = after.suite.conditions.find((c) => c.id === id);
    const c = (a ?? b)!;
    const status = !b
      ? "added"
      : !a
      ? "removed"
      : setupKey(before, b) !== setupKey(after, a)
      ? "setup-changed"
      : "comparable";
    const model = (x: Campaign, cond?: CampaignCondition) =>
      cond && cond.kind === "llm" ? conditionModel(x, cond.id) : null;
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
        status !== "comparable" || !old || !next || old.nHumans === next.nHumans,
        "Human denominators differ across model scorecards.",
      );
      return {
        conditionId: id,
        domain,
        status,
        beforeModel: model(before, b)?.model ?? null,
        afterModel: model(after, a)?.model ?? null,
        modelChanged:
          !!b && !!a && hash(model(before, b)) !== hash(model(after, a)),
        before: old?.agreement ?? null,
        after: next?.agreement ?? null,
        changePercentagePoints:
          status === "comparable" &&
          old?.agreement != null &&
          next?.agreement != null
            ? (next.agreement - old.agreement) * 100
            : null,
        nHumans: next?.nHumans ?? old?.nHumans ?? 0,
        beforeRuns: old?.nRuns ?? 0,
        afterRuns: next?.nRuns ?? 0,
      };
    });
  });
  return {
    beforeModel: before.model,
    afterModel: after.model,
    protocolDigest: before.protocolDigest,
    sameProtocol: before.protocolDigest === after.protocolDigest,
    rows,
    notes: [
      "Descriptive model differences only. No p-values or superiority claims are inferred from summary scores.",
      "Only rows with status 'comparable' (same setup, scoring, human reference and coverage) have a change value. Added, removed or changed setups are listed without a delta.",
      "Calculate paired human/run uncertainty using the frozen scoring adapter and original result-level data. Missing rows remain null; no zero filling or favorable coverage selection.",
      "Reused runs are identical in both campaigns; a change in a comparable row with reused runs reflects only the newly executed runs.",
    ],
  };
}
