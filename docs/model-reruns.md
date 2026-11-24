# Continue or rerun: new models and setups

The campaign layer saves the **entire set of agent conditions**: their job schedules, input hashes, protocol references and scoring definition. A model rerun clones this frozen suite, changes the requested model identity and settings, and creates new campaign, session and output identities. It does not ask the new model to redesign the experiment.

## Use the workbench

Open a study, then go to **7 · Continue / rerun**:
- Choose the campaign to continue from.
- For each configuration you can:
  - raise the **Runs** (only the extra runs are new);
  - to change its model, change it on **Agent configurations**: Continue lists the change and runs that configuration again in full with the new model;
  - **Add model**: append a model; the configuration stays as it is (finished runs reused) and a copy with the added model joins it, to compare both models with the method held fixed;
  - **Rerun**: fresh sessions with the same setup;
  - **Drop** it.
- **Keep simulated runs** (off by default): whether sessions that were only simulated are reused. Off, they run again like sessions that never ran; leave it off before running real agents.
- **Preview** shows new and reused sessions, and how many reused runs are simulated. **Create continuation** freezes it and opens the executor.

The website always continues from what actually happened: only sessions with an accepted forecast are reused. Failed, stopped and never-started sessions run again. A campaign made by an earlier version may list never-run sessions as reused; continuing from it runs them. To retry only failed sessions within the same campaign, use **Rerun failed** in the executor.

**Names of added models.** A copy made by **Add model** is named after its model and effort ("Text only — claude-sonnet-5-5, effort high"; a default effort is not named) and gets "(2)", "(3)" … if that name is taken. A name you type must be unique. When a continuation changes the model of a configuration whose name ends with " — <old model>", the name follows the new model; other names stay. Names are not part of the setup, so a new name never stops runs from being reused.

The API (`POST /api/workspace/continue`) takes `{ id, campaignId, changes, keepSimulated?, preview? }`. `useReceipts` is no longer needed: receipts and results are always read.

## Continue a campaign with new models or setups

`campaign-rerun` repeats everything with one new model. `campaign-continue` derives the next campaign from a change set and **reuses every job whose setup is unchanged**. A test can grow over time without paying for or regenerating runs that already exist:

```json
{
  "note": "Add a second model as a new arm; more repetitions for D",
  "model": { "provider": "claude-code", "model": "NEW_DEFAULT_MODEL", "reasoning": "effort=high" },
  "conditionModels": { "E": null, "D": { "provider": "claude-code", "model": "KEEP_OLD_MODEL", "reasoning": "effort=high" } },
  "cloneConditions": [{ "from": "D", "id": "D-modelB", "model": { "provider": "p", "model": "MODEL_B", "reasoning": "r" } }],
  "addConditions": [],
  "repetitions": { "D": 12 },
  "dropConditions": [],
  "rerunConditions": [],
  "addContrasts": []
}
```

Every field is optional; at least one change is required.

| Field | Effect |
| --- | --- |
| `model` | New default model for every model-run condition without an override. |
| `conditionModels` | Per-condition model; `null` removes an override. Receipts are checked against the effective per-condition model. |
| `cloneConditions` | Copy an existing model-run condition under a new ID, usually with another model, so models become arms of one analysis. |
| `addConditions` | Entirely new setups (full `CampaignCondition` objects). |
| `repetitions` | Ensure at least N repetitions (per participant for individual conditions). Frozen repetitions are never removed. Derived references can be extended after their source. |
| `dropConditions` | Remove conditions. Derived conditions must be dropped together with their source. Contrasts naming them are removed. |
| `rerunConditions` | Force fresh sessions even where nothing changed. |
| `addContrasts` | New planned contrasts (planner-derived suites only). |
| `retryJobs` | Parent template jobs to run again. Normally filled automatically from receipts. |
| `labels` | New names for conditions (must be unique). Filled automatically when a model change updates a generated name; generated names of `cloneConditions` are recorded there too, so the change set replays exactly. |

**When a job is reused:**
- A job is reused only if all of these are identical: its condition recipe (its name aside), job template, input-asset bytes, effective model and, for planner suites, the study outcomes.
- A reused job records `inheritedFrom`: the campaign that actually executed it, never an intermediate one. It is left out of `run-queue.jsonl` and the job packets.
- A derived reference is reused only together with its source.
- Rule-based conditions are reused even after a model change, because they make no model calls.

Pass the parent's receipts to make the continuation failure-aware:

```bash
node dist/cli.js campaign-continue old/campaign.json changes.json artifacts/next \
  --receipts old/receipts.jsonl
```

**What the receipts change:**
- Failed and never-started parent jobs get fresh jobs.
- Completions held for audit are reused, not retried automatically, to keep the first-valid-output rule.
- The command refuses if a reused job's receipts from an earlier campaign are missing.

Without `--receipts`, `campaign-continue` cannot tell finished jobs from unfinished ones and reuses every unchanged job. Pass the receipts unless nothing has run yet.

In code, `continueFromStatus(previous, receipts, changes, id, createdAt, options)` also takes `simulatedJobIds` (previous jobs whose output is simulated; they run again unless `keepSimulated`) and `receiptsComplete` (the receipts of the whole lineage are given, so a reused job without one never ran and runs again instead of refusing). The website uses both.

**Verifying a continuation.** The change set is stored in the new campaign. `campaign-verify new/campaign.json old/campaign.json` recomputes it from the parent, which catches forged or edited reuse claims.

Status and analysis read the whole lineage. Concatenate or list every campaign's receipts and result bundles:

```bash
node dist/cli.js campaign-status next/campaign.json next/receipts.jsonl old/receipts.jsonl
node dist/cli.js campaign-analyze next/campaign.json human.json artifacts/next-report \
  next/results.json old/results.json
```

**Which records count:**
- Receipts or results from ancestors that the new campaign does not reuse, such as superseded failures or old-model runs, are counted and ignored.
- Records from unrelated campaigns are rejected.

**Comparing campaigns.** `campaign-compare` (and **Compare two campaigns** on Freeze & campaigns) accepts campaigns from the same lineage with different setups:
- It reports every condition as `comparable`, `added`, `removed`, `setup-changed` or `real-vs-simulated`, with a `note` saying why when that matters.
- Each side names its model with its effort (`beforeModel`, `afterModel`: "claude-sonnet-5-5, effort high"; exact settings in `beforeSettings`, `afterSettings`) and the kind of runs its score rests on (`beforeRunKind`, `afterRunKind`: `real`, `simulated`, `none`, or `unknown` for an external scorecard that does not say).
- `modelChanged` is true only when provider, model or effort differ; `modelChanges` says which ("high" and "effort=high" are the same effort).
- Real runs are never set against simulated ones: such a row is `real-vs-simulated` and has no change. Rows with simulated runs on both sides keep their change and say that it tests the pipeline only.
- It computes changes only for comparable rows; a fully reused condition shows a zero change by construction.
- The top-level `beforeModel`/`afterModel` name the one model of a campaign, or are null when its configurations use different models.

## From the planner to analysis on the command line

```bash
node dist/cli.js plan study.json artifacts/plan --repetitions 1   # runs per participant; population = participants × 1 unless a configuration sets its own
node dist/cli.js campaign-from-plan artifacts/plan/plan.json artifacts/c1 PROVIDER MODEL "REASONING"
# ...the executor (or an external worker) runs artifacts/c1/run-queue.jsonl using jobs/<job-id>.json packets...
node dist/cli.js campaign-analyze artifacts/c1/campaign.json human.json artifacts/c1-report results.json
```

- **What a planner-derived suite holds:** the study and every agent protocol.
- **Scoring:** the built-in analyzer scores them directly and writes `scorecard.json` (`xr-campaign-scores/1`) for `campaign-compare`.
- **Models:** without explicit model arguments, each agent keeps its planned model as a per-condition model.
- **Mock worker:** for synthetic suites, `campaign-mock <campaign.json> <dir>` executes only the non-reused jobs with model-dependent invented forecasts, and writes receipts plus a result bundle.

## Registry suites and external workers

A **registry suite** (`xr-campaign-suite/1`) describes conditions, job templates and input assets by hash, without embedding the study. It is for studies whose forecasting and scoring already run elsewhere, for example an existing runner on an engine machine.

Start a campaign from a registry suite, or repeat a saved one with only the model changed:

```bash
node dist/cli.js campaign-new suite.json artifacts/my-new-model claude-code MODEL_ID "effort=high"
node dist/cli.js campaign-rerun artifacts/my-new-model/campaign.json artifacts/next-model claude-code NEXT_MODEL_ID "effort=high"
```

**Provider IDs** above are recorded transport labels, not automatic adapters:
- Use the actual transport the external worker supports.
- A model name is not proof that the model is available.
- Switching providers may change system prompts, image handling or tool behavior. Record these differences rather than attributing every change to model quality.

**Output packages:**
- Every output directory must be new.
- Each package includes `campaign.json`, `queue.jsonl`, all condition recipes, checksums, a workload summary and worker instructions.
- The `campaign-…` commands write these files into the new folder; `campaign-verify <folder>` checks `campaign.json` and every file listed in `manifest.json`. The website has no package download. A single-file package container `{"files": {…}}` (as the local API's `/api/campaign/handoff` returns it) is unpacked with `node dist/cli.js unpack package.json artifacts/unpacked-campaign`, which verifies checksums and campaign integrity before writing files.

Check integrity before execution and inspect returned progress:

```bash
node dist/cli.js campaign-preflight artifacts/my-new-model/campaign.json bindings.local.json
node dist/cli.js campaign-status artifacts/my-new-model/campaign.json receipts.jsonl
```

`campaign-status` needs no receipts file before anything has run. The bindings format is in [the data contract](data-contract.md#campaign-asset-bindings) and in `node dist/cli.js help`.

**Preflight** checks asset integrity:
- It returns a nonzero exit code for missing or changed files, or for unresolved external attestations.
- A passing asset check does not prove model availability, API compatibility, live engine integration, truly independent exposure or a complete scoring adapter.

**Private paths and data:**
- Local file paths live in `bindings.local.json`, not in source code.
- Keep bindings, real registries, participant packets and movement recordings under `private/` or outside the repository.
- Never expose a whole research workspace to a prediction agent.

## Resume and evaluation

**Receipts** use `CampaignReceipt` in [the contract](../src/core/campaign.ts):
- **Contents:** campaign, job, attempt, effective model, independent session, input hashes, execution manifest, output hash, and known or unknown token usage.
- **The checker rejects** cross-campaign records and repeated attempt IDs.
- **It flags** changed models, reused session identities, missing fresh-session declarations and changed assets. It checks declarations, not the truth of self-reported experience.
- **The worker** must verify result-file hashes and preserve trace and capture evidence.

**Which output counts:**
- Keep the first completed output for audit.
- Failed attempts remain visible, and a complete output with deviations is never replaced by a more favorable attempt.
- The status report's `runnable` list contains pending and failed worker tasks. It excludes derived references and audit-held completions.

**External scoring.** An external scoring adapter can return a `CampaignScorecard`. It holds the campaign digest, frozen scoring hash, human-reference hash, coverage hash and per-condition objective and subjective directional scores, optionally with the number of real and simulated runs behind each score (`real`, `simulated`; the built-in analyzer fills them). Compare matching campaigns with:

```bash
node dist/cli.js campaign-compare old/campaign.json old/scores.json \
  new/campaign.json new/scores.json artifacts/model-comparison
```

**Output of the comparison:**
- It produces descriptive JSON and CSV changes. `comparison.csv` gives agreement in percent and its change in percentage points (`before_agreement_pct`, `after_agreement_pct`, `change_pp`), then `n_humans`, the run counts, `status`, both models, `model_changed`, both run kinds and the `note`.
- It rejects mismatched protocols, references, coverage or human denominators.
- Missing outcomes remain missing.
- It does not invent p-values from aggregate scores. Calculate paired uncertainty from the original participant and run data with the frozen scoring adapter.
