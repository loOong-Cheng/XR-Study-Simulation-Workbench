# Overview

A workbench for HCI researchers who finished an XR user study and want to know **how well AI agents forecast its results**, and which information helps: a text description, the project files, actually using the app, evidence, or knowledge about the participants.

It does not claim that an agent experiences VR like a person, or that simulation replaces participants.

**Status: research prototype, v0.4.**

## How it works

| Step | Where | What happens |
| --- | --- | --- |
| **Planner** | 1 Study, E Evidence, 2 Agent configurations, 3 Freeze | Understand the study from your protocol or manuscript: designs (independent variable), measures (dependent variables), participants and orders, and participant information agents may get. Read and manage the evidence agents may get, with an outcome-blind check. Configure agents: level (population or individual), model, runtime, runs, what each gets, which measures it predicts and which measured ones it may use as inputs. Freeze a campaign; every campaign is listed with its label, parent, progress and cost. |
| **Executor** | 4 Run agents | Each session is a fresh headless Claude Code agent with only its configuration's information and an MCP runtime for the XR app (WebXR built in; Unreal, Unity and visionOS through a study bridge you configure). Live progress, a next-step line, pilot runs of chosen sessions with a cost estimate, every attempt of a session, real token use and cost per configuration, pause, resume, rerun failed, save runs as a zip. |
| **Analyzer** | 5 Compare agents, 6 Compare with humans | **Compare agents** (no human data): run-to-run agreement, agreement between configurations, tool calls, time, cost, deviations. **Compare with humans:** the human data alone (per design, with the design's test), agreement with the human design differences per run and participant, agent vs human values per measure, correlation, population vs individual, participant lines. Box, violin and line plots with Holm-corrected rank-test brackets; save figures as SVG or PNG. |
| **Planner** | 7 Continue / rerun | New models or setups as a continuation that reuses finished runs. |

**Reference answers are withheld:** neither you nor the agents see human results while planning. Measured values reach an agent only as inputs you declare, and you see them only in the analyzer.

## Try the example suites

```bash
node scripts/setup.mjs   # installs, builds, finds Claude Code, Chrome and Python, writes private/settings.json
npm start                # http://127.0.0.1:4317 → Open study (XR_STUDY_PORT=<port> for another port)
```

Setup prints any `PROBLEM` to fix and the address the website will use. Ctrl+C stops the website and any agent sessions it runs.

Every suite comes with a ready-made **starter campaign** (frozen at 1 run per participant), installed by setup or when you first open the suite: go straight to **Run agents** and **Simulate** (free) or run one real session. To test the workbench on another machine from a git clone, and to report back, follow [Testing with the example suites](testing-with-example-suites.md).

| Suite | Study | What you can do here |
| --- | --- | --- |
| 1 · Unreal | [VR temperature visualization](../examples/ecolar/README.md) (synthetic version of the Ecolar study: 24 invented participants, 16 configurations at population and individual level) | Simulate; run the app-free configurations with Claude Code; app configurations need an Unreal study bridge |
| 2 · Unity | [Selecting and placing objects](../examples/selection/README.md) (synthetic: 12 invented participants with background, population and individual configurations; Unity app and bridge included) | Simulate; run the app-free configurations with Claude Code; app configurations run with Unity 6 and the included bridge |
| 3 · WebXR | [Graphics quality](../examples/graphics-quality/README.md) (synthetic) | Real agent runs with Claude Code in your Chrome, or simulate |
| 3-a · visionOS | [Graphics quality on Apple Vision Pro](../examples/graphics-quality/apple-vision-pro/README.md) (inside suite 3: the same study and synthetic data, with an Apple Vision Pro app) | Real runs in the visionOS simulator through the included bridge (a Mac with Xcode); compare with suite 3's WebXR runs |
| 4 · WebXR | [Material cues at two rendering qualities](../examples/material-cues/README.md) (synthetic: 16 participants; vision, colour vision, design training, VR hours) | Real runs with its own WebXR app (search and identify actions), app-only vs uses-app, individual configurations |
| 5 · No app | [Haptic buttons](../examples/haptic-buttons/README.md) (synthetic: 18 participants; hand size, tactile sensitivity, gaming, VR experience, practice movement) | Individual forecasts with background and movement data, measured task data as input |
| 6 · No app | [Haptic buttons, between subjects](../examples/haptic-buttons-between/README.md) (synthetic: 3 groups × 12; VR experience, haptic devices, motion sickness) | Between-subjects analysis: group tests, absolute values, no rankings or individual forecasts |
| 7 · No app | [Mid-air text entry](../examples/text-entry/README.md) (synthetic: 24 participants; typing speed, swipe use, first language, arm length) | Forecasts made before the study (no measured inputs), a second-model arm |

**Without a coding agent**, read [Start your own study](getting-started.md).

## Requirements

- Node.js 22.13+ and npm.
- For real agent runs: [Claude Code](https://claude.com/claude-code), logged in. No API key is stored anywhere.
- For WebXR runs: Google Chrome.
- Unreal, Unity or Apple Vision Pro runs need a study bridge (a stdio MCP server that offers participant tools, see [runtime adapters](runtime-adapters.md#study-bridge-contract)) on the machine that runs the engine, set in **Settings**. An engine's own MCP server (editor tools) is not enough on its own; a bridge can drive it. Suite 2 includes a bridge for its Unity app (Python 3).

The website runs locally on the loopback address (port 4317, or `XR_STUDY_PORT`) and is not a hosted service. Settings live in `private/settings.json` (or the file `XR_STUDY_SETTINGS` names); real studies in `private/studies/`. Both are git-ignored. Coding agents can call the same [local API](api.md) as the website.

## Analysis scope

- **Population:** score each independent forecast run against human design summaries, then average run scores. Resample whole humans within declared order/design strata and whole model runs independently within each method.
- **Individual:** compare each participant's design ordering with their corresponding primary forecast. Repetition 1 is primary; later repetitions are retained as diagnostics and never silently replace it. Bootstrap whole participants. This version does not estimate individual generation uncertainty or implement person-identity permutation tests.
- **Design support:** within- and between-subjects designs. Between subjects, design differences count only where the human groups differ significantly (Mann–Whitney U, Holm), preference rankings and individual configurations are refused, and each configuration's absolute values are checked against the human group's 95% CI. Within subjects, the main scores use every difference of the means, with a second view on significant paired differences (Wilcoxon signed-rank). See [methodology](methodology.md). The current analysis assumes a complete condition profile for each selected forecast; missing human profiles or tied directions are disclosed explicitly.
- **Directional agreement:** correct direction = 1; reversed = 0; forecast tie = 0.5. Exact human ties are omitted. Random directions have expectation 50%. This measures agreement with the ordering of a raw measure, not whether higher is desirable.
- **Uncertainty:** seeded, order-stratified participant-cluster bootstrap. Population resampling fixes the original non-tied human-pair mask and treats bootstrap-created ties neutrally. These approximate intervals are fragile near ties and in small samples; they are not proof of equivalence or an externally validated quality threshold.
- **Weights:** declared family budgets prevent repeated items from dominating by their count. Within a family, explicit outcome weights apply. Objective and subjective budgets normalize separately. Declare correlated groups before evaluation; there is no automatic GT-driven clustering, fitted weighting or favorable-outcome selection.
- **Composites:** named retained-item means are derived from those items on both sides. A five-item workload score cannot be substituted by multiplying a six-item total by 5/6. The framework cannot resolve ambiguous questionnaire responses without researcher evidence.
- **Absolute diagnostics:** optional native-unit MAE per outcome. Geometric-mean outcomes use log aggregation and return MAE to their native units. Absolute errors in different units are not averaged into the directional index. Distributional calibration and psychometric thresholds are not implemented.
- **Inference:** candidate-minus-baseline comparisons between agent methods are chosen at analysis (`--comparisons`, or the website), not frozen with the study, because they are not needed to collect data. They use approximate two-sided centered-bootstrap p-values and one Holm family. Choosing them changes no other number. The report marks each one as stored with the study or chosen at analysis, so analysis-time choices can be reported as exploratory. Empirically degenerate contrasts have no p-value. No automatic above-chance significance or claim of method superiority is made.
- **Levels and targets:** population and individual configurations are analysed separately, each with its own resampling, under one Holm family. Each configuration is scored only on the measures it predicts. Measures given as inputs are never scored for that configuration. A comparison between two configurations is computed over the measures both predict.
- **Figures:** brackets use rank tests:
  - Mann–Whitney U between configurations' independent population runs;
  - Wilcoxon signed-rank for participants paired across individual configurations;
  - Holm across the brackets of a figure.

  Marks above boxes test against 50% (Wilcoxon, Holm). Agent-vs-human views compare each configuration's predictions with the participants' values per design (Mann–Whitney U, Holm).
- **Failures:** complete predictions with protocol deviations remain in the main score. An adherence-only sensitivity is separate and potentially selected. Missing, failed or malformed outputs are not zero-filled; denominators remain visible. Differential failures can bias comparisons. Missing an individual primary makes that agent's complete-cohort score unavailable.

Model wall time, environment simulation time and predicted human time are separate fields. Desktop frame rate, stereo rendering or an agent's response latency cannot be substituted for a person's response time or sickness score.

## Command line

Every step also works from the command line, which is what coding agents use. Run `node dist/cli.js` (or `node dist/cli.js help`) for the full list of commands with their options. See [AGENTS.md](../AGENTS.md) for the workflow, [model reruns and continuations](model-reruns.md), [runtime adapters](runtime-adapters.md) and the [data contract](data-contract.md).

## Open research and publication

MIT licensed. The source, tests and synthetic example can be shared independently of any study's private data. No files from the temperature study were copied into this project. The license covers this source, not vendor SDKs or researchers' datasets. Model/provider terms and runtime licenses remain separate.

The freeze digest is an integrity mechanism, not proof of prospective registration. Preserve an independently timestamped registration or archive when that matters. Report actual versions, deviations, repetition policy, failures, uncertainty and limitations with a paper.

To cite the workbench, use [`CITATION.cff`](../CITATION.cff) (GitHub shows it as "Cite this repository"). Add the public repository URL, an immutable release or archive and the paper's DOI to it when they exist; none is invented here.
