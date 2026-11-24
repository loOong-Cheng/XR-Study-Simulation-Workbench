# Instructions for coding agents (Codex, Claude Code and others)

This repository tests how well AI agents forecast the results of a **finished** XR user study. Researchers work with you, a coding agent, in this repository:

- **You** read, draft and write code.
- **The framework** checks, freezes, runs and scores.
- **The local website** is where the researcher reviews and approves, watches runs and looks at results.

## Roles: who does what

| You (coding agent) | The framework | The researcher (website) |
| --- | --- | --- |
| Read the protocol or manuscript, research questions, data and XR project | Validates files; checks quotes against the document | Reviews the study and agent configurations as tables, tunes, approves |
| Draft `study.json`, `agents.json`, the human-data converter, `workspace.json`, and a runtime (MCP server) if one is missing | Freezes campaigns; runs agent sessions (headless Claude Code) with only their permitted information; streams progress | Starts, pauses and resumes runs; saves runs as a zip |
| Run commands; explain output plainly | Scores with fixed statistics (rank tests, Holm); compares campaigns | Chooses which configurations to compare; saves figures |
| **Never forecast yourself** | Keeps reference answers out of planning | Decides on new models or setups (continue / rerun) |

## Hard rules

1. **You are not a forecaster.** Never write predictions of human outcomes. Forecasts come only from executor sessions, which receive one job's information.
2. **Reference answers stay hidden while planning.** Never show the researcher human results during planning, and never put them into study sources or agent inputs. The only exception is a measured outcome the researcher explicitly declares as an **input** of a configuration (a dependent variable used as a predictor). The framework attaches those values itself; you do not copy them anywhere.
3. **Freeze before scoring; never tune afterwards.** Methods, measures and weights are fixed before results exist. Changes after seeing scores become a continuation, and you tell the researcher it is post hoc. Comparisons between configurations are chosen at analysis and are labelled as such.
4. **Never edit frozen files** (`campaigns/*/campaign.json`, `runs/*`). Use the executor or `campaign-continue`.
5. **The researcher approves before freezing a real study.**
6. **Real data stays private.** Real studies live in `private/studies/<name>/`, which git ignores. Only invented data goes in `examples/`, marked `"synthetic": true`.
7. **No credentials in files.** Agent sessions use the researcher's own Claude Code login.
8. **Report honestly.** Simulated runs test the pipeline, not prediction quality. Say so whenever you show them.

## New machine: set everything up for the researcher

The researcher copies this folder to a machine and asks you to set it up. Do the whole setup yourself. Their part is only to review in the website, press run, watch and analyze.

1. **Node.js.** Run `node --version`. If it is missing or older than 22.13, install the current LTS, with the researcher's OK:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS: `brew install node`

   Then open a new shell so PATH updates.
2. **Run `node scripts/setup.mjs --test`.** It does the following:
   - installs dependencies and builds;
   - finds Claude Code (the native `claude.exe` on Windows) and Chrome;
   - writes them into `private/settings.json`;
   - lists the MCP servers Claude Code already knows, and the studies;
   - runs the tests.

   Fix every `PROBLEM` line and rerun until it says **Setup complete**. Do not copy `private/settings.json` from another machine; setup writes this machine's paths.
3. **Engine runtime** (Unreal, Unity, visionOS), only if a study's configurations use the app:
   - **What exists.** An engine MCP the researcher configured may appear in the setup list (`claude mcp get <name>` shows its command), or only in the engine project's own `.mcp.json`. On its own it offers editor tools, not a participant session.
   - **Write a study bridge.** This is a stdio MCP server, in any language, that drives the engine (through its MCP or an endpoint in the project) and offers participant-like tools, following the [bridge contract](docs/runtime-adapters.md#study-bridge-contract). It reports itself with a `runtime` trace event, draws fresh neutral object IDs per design, and answers `tools/list` before connecting to the engine. Put it in the study folder, for example `private/studies/<name>/runtime/`.
   - **Learn how designs load.** Read the study's project: levels, console commands or Blueprint switches.
   - **Test it yourself first.** Open each design, take one screenshot and complete one task. Check that `trace.jsonl` gets `runtime`, `case-start`, `observation`, `action` and `case-end` lines.
   - **Configure it in Settings.** Set:
     - the command (`node`, `python`, …);
     - arguments `<bridge path> {jobFile}`;
     - the capabilities it really provides;
     - a short line on how to use its tools.

     Use the website's Settings page, or `private/settings.json`.
4. **Study sources.** Every source in `workspace.json` that a configuration reads (`brief`, `project`, `evidence`, `demographics`) must point at a file or folder on this machine. Participant-specific knowledge (`demographics`, `trajectory`) must also be complete: a row for every participant and no empty allowed field; otherwise the configurations that get it are blocked. Ask the researcher where anything is that you cannot find. Never point a source at human results.
5. **Start the website** with `npm start`. In the Claude desktop app, preview `xr-workbench` from `.claude/launch.json`. Give the researcher the link and the next steps:
   1. **Study & variables**, **Agent configurations**: review, then **Approve**.
   2. **Freeze & campaigns**.
   3. **Run agents**. For a new runtime or model, select one session and press **Run this session only** before **Start**. For a pilot, **Choose sessions to run** selects the first *k* sessions of chosen configurations; only those start.
   4. **Compare agents**, then **Compare with humans** (two analyzer pages; human data alone is shown there too).
6. **Never start real agent sessions yourself** without the researcher's explicit OK. They use the researcher's Claude usage. The website asks before starting.

## "Test this suite and set it up"

When the researcher asks you to test an example suite (or "suite 1/2/3"), prepare everything; the researcher reviews, clicks run and analyses.

1. **Machine.** If `node scripts/setup.mjs` has not completed on this machine, do "New machine" above first.
2. **Runtime for the suite:**

   | Suite | Folder | What to prepare |
   | --- | --- | --- |
   | 1 | `examples/ecolar` | Unreal configurations (C, D, U-series) need a study bridge over the Unreal project (`UNREAL_SETUP.md`). A bridge built for a specific lab project is kept under `private/studies/<name>/runtime/`; use it if one exists there. A, B, F and the -Dem configurations need nothing. |
   | 2 | `examples/selection` | "Uses the app" needs the Unity project and the bridge `examples/selection/runtime/bridge.py` (Python, standard library). The other configurations need nothing. |
   | 3 | `examples/graphics-quality` | Nothing beyond Chrome; the WebXR runtime is built in. |

   If an engine part is not ready, say which configurations can run now and which cannot. Do not fake a runtime.
3. **Check:** `node dist/cli.js study-check <folder>/study.json --agents <folder>/agents.json --human <folder>/human.json`.
4. **Start the website** (`npm start`, or preview `xr-workbench`) and give the researcher the link to the study, for example `http://127.0.0.1:4317/?study=examples%2Fgraphics-quality`.
5. **Hand over** with the clicks they make:
   1. **Agent configurations:** review, then **Approve**.
   2. **Freeze & campaigns:** check the session table, then **Freeze campaign**.
   3. **Run agents:** choose *Run agents*. Select one session, press **Run this session only** and watch it; for a small pilot use **Choose sessions to run**; then **Start** the rest (or *Simulate* to try the pipeline at no cost). Real and simulated runs of one configuration are never pooled in the analysis.
   4. **Compare agents** (no human data), then **Compare with humans**: **Show human data** for the participants alone, or **Analyze campaign**, choose configurations and views, and save figures.

   Do not freeze or start real sessions yourself.
6. **When something fails,** read the job's folder (`runs/<campaign>/jobs/<job>/a<n>/`: `stream.jsonl`, `trace.jsonl`, `execution-manifest.json`) and the website log, fix the cause, and tell the researcher what changed.

## A study is a folder

```
private/studies/<name>/            (or examples/<name>/ for synthetic studies)
  study.json        designs (independent variable), measures (dependent variables), participants and orders, sources
  agents.json       agent configurations: level, model, runtime, runs, what they get, targets, inputs
  workspace.json    title, where each source lives, and for WebXR apps: {"app": {"serve": "<folder>", "query": "?design={condition}&participant={participant}"}} ({participant} is "population" for population jobs)
  human.json        human reference (one record per participant × design × measure)
  comparisons.json  configurations to test against each other (chosen at analysis)
  campaigns/  runs/ written by the workbench
```

**Where sources may point (enforced; configurations that break it are blocked):**
- Every source in `workspace.json` resolves (symlinks followed) **inside the study folder**. It may not be the study folder itself (`"project": "."`), a folder around it, `human.json`, `campaigns/`, `runs/` or `deleted/`.
- Only a **project** folder may live elsewhere on the machine (an engine project). Write it as an **absolute path** outside this repository, and not a folder that holds a `study.json` or `human.json`. A relative path that leaves the study folder is refused.
- As a second guard, the study MCP server never hands an agent a file named `human.json`, nor anything in a study's `campaigns/`, `runs/` or `deleted/`. A symlink that leads out of the permitted folder is refused too.

**Study IDs** are exactly `examples/<name>` or `private/studies/<name>`, with the folder's own letter case. Other spellings (`./`, `//`, a trailing `/`) are refused.

**The website** answers only requests addressed to `localhost`, `127.0.0.1` or `[::1]`. It accepts changes (POST) only from its own page. Runs zips are checked completely before anything is written:
- Sizes: at most 2 GB unpacked in total and 500 MB per file.
- Names: no `..`, backslashes, drive letters or absolute names.
- Contents: only the files *Save runs as zip* writes. Each campaign must be in the folder named after its ID and belong to this study.
- Merging: `receipts.jsonl` and `events.jsonl` gain the lines they lack. A different record for the same session attempt refuses the zip.

Templates: `examples/graphics-quality/` (WebXR, runnable), `examples/ecolar/` (Unreal; mixed levels, measured inputs, movement data), `examples/selection/` (Unity app and bridge; participant background). Contracts: `src/core/types.ts`, `docs/data-contract.md`.

## Workflow for a new study

Setup: `npm ci && npm run build`. Commands are `node dist/cli.js <command>`.

1. **Collect inputs.** Ask the researcher for:
   - the protocol, documentation or manuscript;
   - the research questions;
   - the XR project (engine, where it runs);
   - the study data: logs, questionnaires, participant IDs and design orders;
   - the models to test.
2. **Understand the study.**
   1. Create `private/studies/<name>/`.
   2. Run `proposal <doc> <dir>` to extract the text locally.
   3. Write `reading.json` with facts and exact quotes, then run `proposal-check <doc> reading.json`.
   4. Draft `study.json`. RQs about designs become conditions and measures; RQs about agents become configurations.

   Alternatively, the researcher can press **Understand study** in the website, which uses the configured assistant.
3. **Draft agent configurations.**
   1. Run `agents-draft study.json agents.json`.
   2. For each configuration, set:
      - `level` (`population` or `individual`);
      - `repetitions`: individual = runs per person; population = runs in total. Leave it out to use the default: *runs per participant* chosen at freeze (default 1), and participants × that for population configurations. Set fewer population runs only when the researcher wants to save usage;
      - `model` (default: Claude Code, `claude-opus-5-5`);
      - `runtime` (`none`, `webxr`, `unreal`, `unity` or `visionos`);
      - `targets`;
      - `inputs`, for measured outcomes used as predictors (needs `predictionTiming: "after-experience"`).
   3. Write `workspace.json` with source locations.
4. **Human data.** Write a converter from the raw data to `human.json` (see `examples/graphics-quality/data/convert_to_human.py`). Then run `study-check study.json --agents agents.json --human human.json` until there are no problems.
5. **Review.** Run `review private/studies/<name>` and give the researcher the link. They check the tables, tune them, save and approve. Afterwards, `study-check` must report **Approved**. Re-read the files, because the researcher may have changed them.
6. **Freeze** in the website (**Freeze & campaigns**), or run `plan` + `campaign-from-plan`. Summarise the campaign with `explain <campaign.json>`.
7. **Execute** in the website (**Run agents**):
   - Each job is a fresh headless `claude -p` session with `--tools ""`, a strict MCP config, a study MCP server (permitted files, `submit_forecast`) and the configuration's runtime MCP server.
   - The researcher confirms before real sessions start.
   - **Runtimes:**
     - **WebXR** is built in. The app must expose `window.xrStudy`; see `examples/graphics-quality/webxr-app/main.js`.
     - **Unreal, Unity and visionOS** need a study bridge command in Settings (any language; see the bridge contract). Suite 2 ships one for its Unity app. If a runtime is missing, the executor names it ("Unity MCP runtime is not configured") and lets the other configurations run. Engine runtimes run one session at a time and up to 90 minutes each by default.
     - If no runtime exists, offer to write one with the same tool shape.
   - **Simulate** produces labelled, invented runs for trying the pipeline. They are never pooled with real runs of the same configuration.
8. **Analyze** in the website (**Compare with humans**, which also shows the human data alone; **Compare agents** needs no human data), or with `campaign-analyze <campaign.json> human.json <dir> <results…> --comparisons comparisons.json`. The website draws the following, with Holm-adjusted rank-test brackets, and saves them as SVG or PNG:
   - agreement distributions;
   - agent vs human per measure;
   - correlation;
   - population vs individual;
   - participant lines.
9. **Continue or rerun.** Use **Continue / rerun** in the website (new models, model arms, more runs, retries) or `campaign-continue … --receipts …`. Unchanged finished runs are reused. **Rerun failed** in the executor retries failed sessions in the same campaign.

## Commands at a glance

| Step | Command |
| --- | --- |
| Website | `npm start` → http://127.0.0.1:4317, or `review <study-folder>` |
| Proposal reading | `proposal <doc> <dir>`, `proposal-check <doc> <reading.json>` |
| Draft and check | `agents-draft <study.json> <agents.json>`, `study-check <study.json> [--agents a.json] [--human h.json]`, `explain <file>` |
| Freeze | `plan <study.json> <dir> --agents a.json`, `campaign-from-plan <plan.json> <dir>` |
| Score and compare | `campaign-status`, `campaign-analyze … [--comparisons c.json]`, `campaign-compare` |
| Continue | `campaign-continue <campaign.json> <changes.json> <dir> --receipts …` |
| Verify | `campaign-verify`, `npm test` |

## Example suites

1. **Ecolar (Unreal), `examples/ecolar/`.** A synthetic version of the VR temperature study:
   - the same designs, measures, Williams-square orders and 16 configurations (population A–F with and without demographics; individual U-series with measured inputs and movement);
   - invented participants and data.

   App-free configurations run with Claude Code. App configurations need an Unreal study bridge.
2. **Selection (Unity).** Synthetic: 12 invented participants whose background drives the invented outcomes, 4 population and 2 individual configurations. The Unity study app is in `examples/selection/unity-project/` and its Python bridge in `runtime/bridge.py` (see `UNITY_SETUP.md`); app configurations run once the bridge is set in Settings → Runtimes → unity, otherwise they can only be simulated.
3. **Graphics quality (WebXR).** Synthetic and fully runnable with Claude Code and the built-in WebXR runtime.

## Changing the framework

The code lives in these places:
- `src/core/`: contracts, validation, planner, analyzer, campaigns, figure statistics;
- `src/executor/`: runner, runtimes, zip;
- `src/runtimes/`: MCP servers;
- `src/web/`: website, SVG plots;
- `src/routes.ts`, `src/server.ts`: API.

Run `npm test` before and after changes. Do not change the analyzer's statistics or the campaign hashing without new tests and a note in `docs/methodology.md`.
