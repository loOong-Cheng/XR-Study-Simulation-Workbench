# Local API (for coding agents)

The website at `http://127.0.0.1:<port>` (`XR_STUDY_PORT`, default 4317) uses these routes; a coding agent can call them too, for example to check a frozen campaign or read an analysis. Code: `src/routes.ts` (study-folder routes) and `src/server.ts` (the page and the guards). Field types are checked by `src/request.ts`: a wrong type gets a plain message, never a conversion.

**Rules for every request**
- `Host` must be `127.0.0.1`, `localhost` or `[::1]` (any port); others get 403.
- A POST with an `Origin` header must come from the workbench's own origin. Without one (curl, Node), it is accepted.
- POST bodies are one JSON object, at most 12 MB (400 MB for `runs/import` and `assistant/understand`).
- Errors come back as `{"error": "<plain message>"}` with 400 (a request the workbench refuses), 403, 404, 413, or 500 (`Something went wrong: …`; the details are in the server's terminal).
- `id` is a study ID, exactly `examples/<name>` or `private/studies/<name>`, or `<that>/<variant>` for a study one level inside another (suite 3-a: `examples/graphics-quality/apple-vision-pro`). `campaign` / `campaignId` is a campaign ID of that study.

**Never start real agent sessions** (`executor/start` with `"mode": "agent"`) without the researcher's OK: they use the researcher's Claude usage.

## Reading (GET, parameters in the query)

| Route | Query | Returns |
| --- | --- | --- |
| `/api/workspaces` | | every study: `id`, `title`, engine, campaigns, human data or not |
| `/api/workspace` | `id` | study, agent configurations (templates if none are saved), approval, sources, campaigns, a `problem` if the files disagree, and `warnings` (what the agents get; also a study device that the WebXR runtime does not report, which would make every app session a protocol deviation). An example suite with no campaign gets its starter campaign (`starter/`) installed first, once per study (`src/starters.ts`) |
| `/api/workspace/campaigns` | `id` | every campaign with label, parent, progress and cost: `costUsd` adds up reported costs only; `unknownCost` counts the real attempts left out because they stopped before Claude Code reported a cost, with their tokens |
| `/api/workspace/campaign-inputs` | `id`, `campaign` | the frozen sources the campaign's agents get, and whether each still exists |
| `/api/workspace/evidence` | `id` | brief, general knowledge and participant knowledge, with the outcome-blind check |
| `/api/workspace/source` | `id`, `source` | one source as plain text (never human data) |
| `/api/settings` | | `private/settings.json` (or `XR_STUDY_SETTINGS`) |
| `/api/runtimes` | `id` | each runtime: available, capabilities, message, and `maxParallel` for WebXR (its sessions at the same time on this computer) |
| `/api/executor/state` | `id`, `campaign` | the executor's snapshot: mode, paused, counts, every session (status, tokens, cost, error) |
| `/api/executor/events` | `id`, `campaign` | server-sent events: a snapshot, then `jobs` (session changes gathered for at most a quarter second, each entry `{jobId, …}` with only the fields that changed), `log` and `state` events (`state` carries the executor's state: mode, paused, running, queued, waiting, counts) |
| `/api/executor/attempts` | `id`, `campaign`, `job` | every attempt of one session |
| `/api/workspace/file` | `id`, `campaign`, `path` | a screenshot `jobs/<job>/a<n>/screenshots/<name>.jpg|png`; 404 otherwise |
| `/api/runs/export` | `id`, `campaign` | the runs zip (*Save runs as zip*) |

## Changing (POST, JSON body)

| Route | Body | Does |
| --- | --- | --- |
| `/api/workspace/create` | `{name?}` | a new study under `private/studies/` |
| `/api/workspace/save` | `{id, study?, agents?, comparisons?}` | saves study, configurations, comparisons (validated) |
| `/api/workspace/approve` | `{id, note?}` | records the researcher's approval of the saved files |
| `/api/workspace/freeze` | `{id, repetitions?, label?, check?}` | freezes a campaign and returns `{campaignId, jobs, warnings}` (`warnings`: a study device the WebXR runtime does not report); `repetitions` = runs per participant (1–50, default 1). `check: true` freezes nothing and returns `{duplicates, jobs}` |
| `/api/workspace/brief-save` | `{id, text}` | writes the study brief (outcome-blind check) |
| `/api/workspace/knowledge-draft` | `{id, name, base64}` | drafts knowledge from a file (the assistant reads documents); nothing is saved |
| `/api/workspace/knowledge-save` | `{id, study, agents, write?: [{sourceId, path, text}], unmap?: [sourceId]}` | saves reviewed knowledge files and their sources |
| `/api/workspace/campaign-label` | `{id, campaignId, label?}` | names a campaign (`campaign-labels.json`) |
| `/api/workspace/campaign-delete` | `{id, campaignId}` | moves a campaign and its runs to `deleted/`; refused while its sessions run |
| `/api/workspace/continue` | `{id, campaignId, changes, preview?, keepSimulated?}` | a continuation from the receipts: finished sessions are reused, failed, stopped and never-started ones run again (simulated ones too unless `keepSimulated`). `preview: true` saves nothing and returns what would happen: `sessions` (`total`, `new`, `reused`), `conditions` (`id`, `label`, `model`, `sessions`, `reused`), `continuation`, `simulated` and `sourceChanges`; with `full: true` also the whole `campaign`. `changes`: `model`, `conditionModels`, `cloneConditions`, `addConditions`, `repetitions`, `dropConditions`, `rerunConditions`, `retryJobs`, `labels`, `note` ([model reruns](model-reruns.md)) |
| `/api/executor/start` | `{id, campaignId, mode?, jobIds?}` | queues sessions; `mode` `"simulate"` (default) or `"agent"`; without `jobIds`, every session not run yet |
| `/api/executor/blockers` | `{id, campaignId, jobIds?}` | why sessions cannot run as agents (runtime, sources, Claude Code), per message with the configurations |
| `/api/executor/estimate` | `{id, campaignId, jobIds}` | cost estimate from earlier sessions with the same model settings |
| `/api/executor/pause`, `/resume`, `/stop` | `{id, campaignId}` | pause (running sessions finish), resume, stop (running sessions end as *stopped*) |
| `/api/runs/import` | `{id, base64}` | loads a runs zip (checked completely before anything is written) |
| `/api/workspace/analyze` | `{id, campaignId, comparisons?}` | scores against `human.json`: summaries, contrasts, audits, progress, exclusions (failed sessions with their error), notes |
| `/api/workspace/figure` | `{id, campaignId, agentIds, kind, domain?, outcomeId?, comparisons?}` | one figure's data; `kind`: `agreement`, `agent-vs-human`, `correlation`, `population-vs-individual`, `trajectories` |
| `/api/workspace/human-figure` | `{id, campaignId, outcomeId?}` | the human data alone (only once a campaign is frozen) |
| `/api/workspace/compare-agents` | `{id, campaignId}` | configurations against each other, without human data |
| `/api/workspace/compare` | `{id, before, after, comparisons?}` | two campaigns' scores side by side (`before`/`after` are campaign IDs) |
| `/api/assistant/understand` | `{id?, name, base64, participantsCsv?}` | the assistant drafts a study and an outcome-blind brief from a document (uses the researcher's assistant) |
| `/api/assistant/explain` | `{id, campaignId, comparisons?}` | the assistant explains an analysis in words |
| `/api/propose` | `{study}` | configuration templates for a study |
| `/api/settings` | `{settings}` | writes settings (validated) |

`comparisons` is a list of `{candidate, baseline, domain}` with `domain` `"objective"` or `"subjective"`, chosen at analysis.

Earlier versions also had routes that no page used (`/api/proposal/*`, `/api/handoff`, `/api/campaign/*`, `/api/demo`, `/api/analyze`, `/api/report`, `/api/review*`, `/api/example`, `/api/brief`, `/api/freeze`); they are removed. Their work is done by the routes above or by the command line (`node dist/cli.js help`).
