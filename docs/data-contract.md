# Data exchange

The authoritative, strict contracts are `src/core/types.ts` and `validation.ts`. `npm run build` also generates declarations in `dist/core/`. Study, plan, human and result files use `schemaVersion: "1.0"`. Campaign files have their own versions: `xr-campaign/1` (`campaign.json`), `xr-campaign-suite/1` (suites) and `xr-campaign-scores/1` (`scorecard.json`); the review approval uses `xr-study-approval/1` and a runs zip's manifest `xr-study-runs/1`. `agents.json` and `comparisons.json` are plain lists without a version.

## Study and agent proposals

Start with `examples/selection/study.json`. Replace identifiers, participant/order metadata, phases, cases, outcome definitions and predictor sources. Participant entries contain **only** an ID, stratum and assigned condition order. They contain no ratings or demographics. Strict keys reject accidentally nested answer records and credential fields. Participant-specific sources (`demographics`, `trajectory`) must cover every participant: a background CSV has exactly one row per participant ID and no empty value in its allowed `fields` (empty, NA, N/A, NaN, null and ? count as missing); a movement source has rows (or a file) for every participant. For participant background, population configurations receive a summary of the cohort and individual configurations the person's own entry. Movement recordings reach individual configurations only; population jobs get none. In a between-subjects study (`"design": "between-subjects"`), each participant's `conditionOrder` holds one design, and outcomes with `"scale": "rank"` are refused: nobody can rank designs they did not experience; measure a rating per design instead. A case may declare `minActions`, the fewest scored actions (task answers) a participant-like run needs in that task (for example one answer per trial); the agent configuration page uses it to show the minimum tool budget, and the audit checks it. `"observeBeforeEachAction": true` requires an observation in the task before each scored action (a deviation otherwise), so an agent cannot answer from memory.

`researchQuestion` holds the human study's research questions and is sent to every agent. Questions about the agents go to the optional `agentQuestions`, which agents never get, and agents see the optional `agentTitle` (default "An XR user study"), never `title` (see "Prompts and fairness" in methodology.md).

`sources` describes what the worker may supply; it contains no actual source data. Each participant-related source must declare its exact permitted `fields`. Target outcome IDs cannot occur in those field lists. This syntactic check cannot detect aliases, information embedded in prose or semantically equivalent leakage: researchers must review the real supplied packets. A movement source (`trajectory`) may declare `"phases": ["practice"]` (known phase IDs): only rows whose `phase` column is one of them are delivered, and a table without that column is incomplete. Objective records and trajectories from the target experience are disallowed for a before-experience forecast in this version. Prior longitudinal records need a future explicit availability-time extension.

Import LLM-generated proposals as `AgentProtocol[]`. Proposals are data, not executable code. Unknown fields, invalid permissions, missing sources and inconsistent observation modes are rejected. Real study plans require explicit provider/model/reasoning settings. No API credentials belong in the plan.

## Frozen plan and handoff

`freezePlan` records the study, protocols, repetitions and exact job schedule. The website and `plan` first write each configuration's default run count into it (`withDefaultRuns`): runs per participant for individual configurations, participants × that for population configurations. Any subsequent edit invalidates its digest. `manifest.json` hashes the handoff files. Verify the manifest **and** the plan digest on the worker.

`plan`, `campaign-from-plan`, `campaign-new`, `campaign-rerun` and `campaign-continue` write these files into a new folder, with `manifest.json`; `campaign-verify` checks a campaign folder against its manifest. The website has no package download. A single-file package container `{ "files": { "plan.json": "...", ... } }` (as earlier versions' local API returned it; the website no longer makes one) is checked and written out with `unpack`. The global plan and manifest are controller-only. Give a forecaster only its own `jobs/<job-id>.json`, permitted source content and permitted tools. Per-job packets omit the analysis plan, other agent recipes and human answers. Population packets include cohort size and order frequencies; individual packets include the assigned person's order. Required cases are resolved to that order when `caseOrder` is `as-listed`.

The planner does not bundle source files from arbitrary local paths. The external controller must resolve the allowed sources, record their content hashes, and bind the approved input snapshot before execution. The workbench's plan hash by itself does not commit to bytes that have not yet been supplied on the worker.

## Human reference

```json
{
  "schemaVersion": "1.0",
  "studyId": "your-study",
  "synthetic": false,
  "measurements": [
    {
      "participantId": "p01",
      "conditionId": "ray",
      "outcomeId": "completion-time",
      "value": 12.4
    }
  ]
}
```

Each entry is one participant × design × outcome summary over the declared phase window. For geometric aggregation, supply a positive per-person geometric mean. For accuracy, supply a proportion. For individual preferences, supply the assigned rank (mean ranks are allowed for explicit ties); for population analysis, the analyzer derives the population mean rank from those human records. Correctness scoring, trial filters and phase attribution belong in the study adapter and must be documented.

A retained-item composite supplies the original item values, not an approximate total:

```json
{
  "participantId": "p01",
  "conditionId": "ray",
  "outcomeId": "workload",
  "components": {
    "mental": 3,
    "physical": 2,
    "temporal": 3,
    "effort": 4,
    "frustration": 2
  }
}
```

The same retained-item requirement applies to forecasts. An optional numeric `value` must equal the derived composite. Extra components are ignored rather than silently folded into it. Missing components make that output invalid.

How the composite follows from its items is declared on the measure. `componentRule` is `"mean"` (the default, as above) or `"sum"`; optional `componentWeights` give every item a positive weight (a weighted mean divides by the sum of the weights). A Simulator Sickness Questionnaire total, for example, is the sum of the raw nausea, oculomotor and disorientation sums times 3.74:

```json
{
  "id": "ssq",
  "label": "SSQ total",
  "unit": "0–235.62",
  "scale": "continuous",
  "range": [0, 235.62],
  "components": ["nausea", "oculomotor", "disorientation"],
  "componentRule": "sum",
  "componentWeights": { "nausea": 3.74, "oculomotor": 3.74, "disorientation": 3.74 }
}
```

Only the composite is scored; its items (subscales) are not scored separately. To score a subscale, declare it as a measure of its own (in the same family, so that the family's weight is shared rather than counted twice).

**Scales and ranges.** `scale` is `continuous`, `proportion` (0–1), `ordinal` (ratings), `rank` (preference ranks, 1 = first) or `count` (a whole, non-negative number per person and design, for example collisions; averaged arithmetically, never geometrically, because counts include zeros). A forecast of a count may have decimals (an expected count); a human value may not. A per-trial average of a count is `continuous`, with a range.

An optional `range: [lowest, highest]` declares the values a measure can take, for example `[1, 7]` for a 1–7 rating or `[0, 100]` for a 0–100 score. Lowest must be below highest; a proportion's range lies within 0–1, a count's starts at 0 or above, and a ranking takes none (its range is always 1 to the number of designs). Human values and forecasts outside the range are refused with a message naming the measure, the participant and the design (a composite is checked after its items are combined). The analyzer clips the human 95% intervals to it, simulated runs invent values on it, and the forecasting agents see it in their task. Studies without a range work as before. The examples declare it where the unit states it.

Missing human values are absent records, never zero. Missing human condition summaries or all-tied profiles are disclosed; direction support is shared across agent methods. Within-subject resampling uses complete participant records, preserving cross-outcome dependence. Between-subject resampling keeps assigned groups intact through the declared strata.

## Result bundle

Return `{schemaVersion, studyId, runs: RunResult[]}`. `npm run demo` produces a complete synthetic example. A result identifies the scheduled job, plan digest, status, independent session, execution details, forecast measurements and trace.

Population forecasts omit `participantId`; individual forecasts must match their scheduled participant. Each complete result contains **every** design × each measure the configuration predicts (its `targets`, never its `inputs`). Duplicate job outputs are rejected: retain retries in a separate attempt ledger and return the selected first complete valid job output once. Failed jobs retain their identity and error. Missing jobs are also visible in the audit.

Record actual engine, runtime, connector and provider versions, provider/model/reasoning settings, start time, observation mode, capabilities and budgets. Unavailable input/cache/reasoning counters are `null`. Do not add cache counters a second time to input if the provider's input total already includes them, or reasoning again to output if it is a subset. Keep the counter semantics in the worker metadata.

`execution.designOrder` (optional) is the design order the session was given at launch: the participant's order, or for population sessions the human orders in rotation over repetitions. The audit checks the visits against it; without it, the protocol's order applies.

Three time concepts are distinct: `inferenceWallTimeMs`, `simulationTimeMs`, and `humanTimeEstimateMs` (nullable). The latter is a prediction, not an observation from the other two clocks.

## Trace events

Record source delivery, phase changes, case starts, observations, completed actions, submissions and exactly one forecast boundary. Action events may carry `scored` (a task answer), `result` (the app's reply) and `args`; observations may name their clock (`"clock": "app"` or `"wall"`). `ProtocolGate` prevents forecasting before mandatory evidence is recorded. It does not impose a scientific per-task time limit.

Stereo observations contain left/right captures from the same frame and simulation time, eye separation in metres, and 16-element finite column-major view and projection matrices. Eye transforms must differ. Identical image bytes can occur for a valid stereo scene, so image inequality is **not** used as a depth test. Frame IDs must be namespaced to the session and cannot be reused across cases/jobs. Keep original capture artifacts and verify their hashes on the worker; the analyzer receives receipts, not image pixels.

Numeric target measurements and runtime traces are different artifacts: traces demonstrate recorded protocol behavior; target measurements remain forecasts of human outcomes. The analyzer does not equate agent actions or simulated elapsed time with human behavior.

## Campaign results

For a planner-derived campaign, a worker returns the same `ResultBundle`/`RunResult` format. `jobId` is the campaign-qualified job ID from `run-queue.jsonl` and `planDigest` is that campaign's digest. Each job packet's `planDigest` field already carries it. Reused jobs keep the result they produced in the campaign that executed them. `campaign-analyze` maps each one onto the new job ID through `inheritedFrom`, so earlier bundles are passed in unchanged and never relabelled by hand. Each reused run's start time is checked against the freeze time of its own executing campaign.

The website writes one `RunResult` per job to `runs/<campaign>/results/<job>.json`. `campaign-analyze` accepts such a folder (or `runs/<campaign>`) as one bundle, as well as bundle files; give one per campaign in the lineage, for example `campaign-analyze campaigns/<new>/campaign.json human.json <new-dir> runs/<new>/results runs/<parent>/results`. When the results of a campaign whose runs are reused are missing, it warns and names that campaign.

## Campaign asset bindings

`campaign-preflight <suite-or-campaign.json> <bindings.local.json>` checks a suite's asset files on the worker. The bindings file maps asset IDs to local files and keeps machine paths out of the suite:

```json
{
  "roots": { "lab": "/data/lab-export" },
  "files": { "<asset-id>": { "root": "lab", "path": "logs/p01.csv" } },
  "attestations": { "<asset-id>": { "sha256": "<hash>", "evidence": "<how the worker checked it>" } }
}
```

Assets with `"verification": "file"` need an entry in `files` whose file has the frozen SHA-256 and stays inside its root; assets with `"verification": "worker-attestation"` need an attestation with the same digest and a note on how it was checked. Sections you do not need may be left out. Keep the file under `private/` or outside the repository.
