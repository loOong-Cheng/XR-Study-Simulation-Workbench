// A registry suite (v0.3 format) with the condition design of the synthetic VR temperature example.
// Used as a fixture for campaign freezing, continuation and preflight tests.
import { hash } from "./planner.js";
import {
  validateSuite,
  type CampaignAsset,
  type CampaignRecipe,
  type CampaignSuite,
  type CampaignTemplateJob,
} from "./campaign.js";

export const populationConditions = ["A", "B", "C", "D", "F"] as const;
export const individualConditions = [
  "U1",
  "UD",
  "UDO",
  "UDOT",
  "UDOT-full",
  "UDOT-full-reason",
] as const;
const standardLimits = {
  maxTurns: 127,
  maxToolCalls: 127,
  maxProjectReads: 40,
  maxPIEActions: 72,
  maxEvidenceCalls: 15,
  minimumTourCases: 12,
  nominalWallSeconds: 3600,
};
export function registryRecipe(id: string): CampaignRecipe {
  const base = id.replace(/-Dem$/, "");
  const individual = individualConditions.includes(
    base as (typeof individualConditions)[number],
  );
  const full = base.startsWith("UDOT-full");
  return {
    files: base !== "A" && !["E", "E0", "U0"].includes(base),
    pie: ["C", "D"].includes(base) || individual,
    evidence: ["D", "F", "E", "E0"].includes(base) || individual,
    personalInformation: id.endsWith("-Dem")
      ? ["cohort-demographics"]
      : base === "U1"
      ? ["individual-design-order", "planned-trial-context"]
      : individual
      ? [
          "individual-design-order",
          "planned-trial-context",
          "demographics",
          ...(["UDO", "UDOT"].includes(base) || full
            ? ["measured-objective-data"]
            : []),
          ...(base === "UDOT" ? ["compact-main-trajectory"] : []),
          ...(full
            ? ["full-main-and-practice-trajectory", "practice-feedback"]
            : []),
        ]
      : [],
    workflow:
      base === "UDOT-full-reason"
        ? "full-trajectory-plus-programmatic-analysis-and-challenge"
        : full
        ? "full-trajectory-exploration"
        : individual
        ? "D-base-individual-inference"
        : base === "U0"
        ? "derive-from-new-model-D-matched-repetition"
        : ["E", "E0"].includes(base)
        ? "verify-deterministic-reference"
        : "population-forecast",
    limits: full
      ? {
          maxTurns: null,
          maxToolCalls: null,
          maxProjectReads: null,
          maxPIEActions: null,
          maxEvidenceCalls: null,
          maxScreenshots: null,
          maxTrajectoryQueries: null,
          taskWallSeconds: null,
          jobWallSeconds: null,
          minimumTourCases: 12,
          technicalStallSeconds: 1800,
          ...(base.endsWith("reason")
            ? {
                investigationRounds: 8,
                challengeRounds: 1,
                pythonSecondsPerCall: 300,
                pythonOutputCharacters: 60000,
              }
            : {}),
        }
      : base === "A"
      ? { maxTurns: 0, maxToolCalls: 0, nominalWallSeconds: 0 }
      : base === "B"
      ? { maxTurns: 40, maxToolCalls: 40, nominalWallSeconds: 1800 }
      : base === "C"
      ? {
          ...standardLimits,
          maxTurns: 112,
          maxToolCalls: 112,
          maxEvidenceCalls: 0,
        }
      : base === "F"
      ? {
          maxTurns: 55,
          maxToolCalls: 55,
          maxProjectReads: 40,
          maxEvidenceCalls: 15,
          nominalWallSeconds: 1800,
        }
      : ["E", "E0", "U0"].includes(base)
      ? {}
      : {
          ...standardLimits,
          ...(individual
            ? { maxTurns: 131, packetReads: 4, transportTimeoutSeconds: 2400 }
            : {}),
        },
    instructions: [
      "Restore the recorded condition-specific prompts, tools and numerical limits. The condition catalogue is descriptive; frozen source/config files remain authoritative.",
      "Each new model session has independent context, PIE state and captures. Never share screenshots, prior predictions or scores.",
      ...(individual
        ? [
            "Infer subjective experience after the complete four-design human session. Preserve that person's actual design and trial order. Your PIE elapsed time is not their response time.",
            "No measured subjective inputs, including baseline or earlier-block SSQ, TLX, BeauVis, confidence or preferences.",
          ]
        : []),
      ...(full
        ? [
            "Practice and main tasks both matter; permit recorded-pose PIE replay, independent screenshots and full trajectory queries. Do not add a scientific time/action/screenshot cap.",
          ]
        : []),
      ...(base.endsWith("reason")
        ? [
            "Retain the programmatic-analysis sandbox, iterative investigation, one challenge round, structured analysis, relative judgments and predefined consistency check. A high reasoning-effort flag alone does not implement this condition.",
          ]
        : []),
    ],
  };
}
export interface RegistrySuiteInput {
  participants: string[];
  repeatParticipants: string[];
  assets: CampaignAsset[];
  jobs?: Record<string, CampaignTemplateJob[]>;
  commonAssets?: Record<string, string[]>;
  scoringAssets?: string[];
  synthetic?: boolean;
}
export function makeRegistrySuite(input: RegistrySuiteInput): CampaignSuite {
  const conditions: CampaignSuite["conditions"] = [];
  for (const id of [
    ...populationConditions,
    "E",
    "E0",
    ...populationConditions.map((c) => c + "-Dem"),
    ...individualConditions,
  ]) {
    const individual = individualConditions.includes(
      id as (typeof individualConditions)[number],
    );
    const kind = ["E", "E0"].includes(id)
      ? ("rules" as const)
      : ("llm" as const);
    const common = input.commonAssets?.[id] ?? [];
    const jobs =
      input.jobs?.[id] ??
      (individual
        ? input.participants.flatMap((person) =>
            Array.from(
              {
                length:
                  id.startsWith("UDOT-full") ||
                  !input.repeatParticipants.includes(person)
                    ? 1
                    : 3,
              },
              (_, i) => ({
                id: `${person}-${id}-r${i + 1}`,
                participantId: person,
                repetition: i + 1,
                assetIds: [...common],
              }),
            ),
          )
        : Array.from({ length: kind === "rules" ? 1 : 10 }, (_, i) => ({
            id: `${id}-r${i + 1}`,
            repetition: i + 1,
            assetIds: [...common],
          })));
    conditions.push({
      id,
      label: id,
      stage: individual ? "individual" : "population",
      kind,
      recipe: registryRecipe(id),
      jobs,
    });
  }
  conditions.push({
    id: "U0",
    label: "U0 — new model D reference",
    stage: "individual",
    kind: "derived",
    sourceConditionId: "D",
    recipe: registryRecipe("U0"),
    jobs: input.participants.flatMap((person) =>
      Array.from(
        { length: input.repeatParticipants.includes(person) ? 3 : 1 },
        (_, i) => ({
          id: `${person}-U0-r${i + 1}`,
          participantId: person,
          repetition: i + 1,
          assetIds: [],
          sourceJobId: `D-r${i + 1}`,
        }),
      ),
    ),
  });
  return validateSuite({
    schemaVersion: "xr-campaign-suite/1",
    id: "registry-all-conditions",
    title: "Registry suite: VR temperature design, complete model rerun",
    synthetic: input.synthetic ?? false,
    conditions,
    assets: input.assets,
    scoring: {
      adapter: "external-scoring",
      assetIds: input.scoringAssets ?? [],
      notes: [
        "Score with the frozen external adapter, its human reference, target definitions, family weights, tie rule and uncertainty procedure. Keep its unit counts and per-run distributions; do not collapse them into generic outcomes.",
        "Keep every preference question separate. Any known mismatch between human and forecast instruments must be carried over as a report note unless the output contract is amended before new runs.",
        "Demographic outcomes and participant-order inputs stay at their original levels.",
      ],
    },
    notes: [
      "New model only: retain all listed agent conditions, recorded participant inputs, schedules, prompts, budgets and scoring. Do not redesign agents with the new model.",
      "Default coverage includes A–F, E0, all five population Dem methods, U0, U1, UD, UDO, UDOT, UDOT-full and UDOT-full-reason.",
      "E and E0 have no model calls. Verify the unchanged reference bytes or recompute using the same evidence/rules. U0 is derived from this campaign's D repetitions 1–3, never from the historical model.",
      "The catalogue does not replace condition-specific execution freezes. The executing machine must verify the original source, runtime, model availability and effective settings before paid runs.",
    ],
  });
}
export function syntheticCampaignSuite(): CampaignSuite {
  const participants = Array.from(
    { length: 24 },
    (_, i) => `P${String(i + 1).padStart(2, "0")}`,
  );
  const asset = {
    id: "synthetic-protocol",
    label: "Invented protocol fixture",
    sha256: hash({ synthetic: true }),
    verification: "file" as const,
    pathHint: "synthetic-only",
    access: "controller" as const,
  };
  return makeRegistrySuite({
    participants,
    repeatParticipants: participants.slice(0, 8),
    assets: [asset],
    synthetic: true,
  });
}
