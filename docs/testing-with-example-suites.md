# Testing the workbench with the example suites

This guide is for testing XR Study Sim on a machine from a **git clone**: set it up, try each of the seven synthetic example suites and the variants inside them (suite 3-a: suite 3 on Apple Vision Pro; suites 5-w, 6-w and 7-w: suites 5–7 with a WebXR app), and report what you find. Every suite ships a ready-made **starter campaign**, so you can press **Simulate** or **Start** right after setup, without approving or freezing anything first.

All participants and data in `examples/` are invented. **Simulated runs test the pipeline, not prediction quality.**

## 1 · Get the repository

The repository is private, so log in to GitHub first (`gh auth login`, or a Git credential).

```bash
gh repo clone loOong-Cheng/XR-Study-Simulation-Workbench xr-study-sim -- --branch workbench-iteration
# or
git clone --branch workbench-iteration https://github.com/loOong-Cheng/XR-Study-Simulation-Workbench.git xr-study-sim
cd xr-study-sim
```

On Windows, clone into a short folder that is not under OneDrive, for example `C:\xr-study-sim`. Engine runs write files nested deep inside the study folder.

You need:
- Node.js 22.13 or newer;
- for real sessions, [Claude Code](https://claude.com/claude-code), logged in;
- for the WebXR suites (3, 4, 5-w, 6-w and 7-w), Google Chrome;
- for suite 2's Unity bridge and for regenerating data, Python 3;
- for suite 3-a (Apple Vision Pro), a Mac with Xcode and its visionOS simulator runtime (Xcode → Settings → Components → visionOS, about 8 GB).

Setup says what is missing.

## 2 · Set up and start the website

```bash
node scripts/setup.mjs --test    # install, build, find Claude Code, Chrome and Python, install starters, run the tests
npm start                        # http://127.0.0.1:4317 (XR_STUDY_PORT=<port> npm start for another port)
```

**Setup:**
- installs the dependencies and builds;
- writes this machine's paths into `private/settings.json`;
- lists the engine runtimes and the local MCP servers Claude Code knows;
- **installs the starter campaigns**;
- runs the tests (`--test`).

Fix every `PROBLEM` line and run it again until it prints **Setup complete**. The `Note:` lines are worth reading. Keep the whole output: it is the first thing to send back (section 7).

**What setup installs.** Each suite keeps its starter in git, in `examples/<suite>/starter/`:
- `campaign.json`, frozen from the suite's `study.json` and `agents.json` at 1 run per participant, exactly as **Freeze & campaigns → Freeze campaign** would freeze them;
- `sources.json`, the fingerprints of the files its agents read;
- `starter.json`, its label, its sessions per configuration and what each configuration needs.

Setup copies the starter into the study's `campaigns/` with the label *Starter · 1 run per participant*. The output shows a line per suite under *Starter campaigns*. Opening a suite in the website does the same, so a suite you skipped (or one added by a later `git pull`) gets its starter the first time you open it.

**How starters behave:**
- **Once per study.** A starter is installed only into an example study that has no campaign yet. `campaigns/.starters.json` records it, so a starter you delete stays deleted. **Freeze campaign** makes an equivalent campaign at any time; it asks first, because the starter has exactly these configurations and sessions.
- **Never into your work.** Starters are never installed over campaigns of your own, and never into `private/studies/`. Everything the workbench writes in a study is git-ignored: `campaigns/`, `runs/`, `deleted/`, `campaign-labels.json` and approvals. Your runs never become git changes.
- **The same on every machine.** The starter has a fixed ID and date, so every machine gets the same campaign. Runs zips of one starter from different machines therefore load into each other.

**The website.** It runs at `http://127.0.0.1:4317`, or at the port in `XR_STUDY_PORT` if 4317 is taken or a second checkout runs. Open a suite under **Open study**, or directly, for example `http://127.0.0.1:4317/?study=examples%2Fgraphics-quality`.

To stop it, press Ctrl+C in its terminal. Or stop the process named in `private/server.pid` by its ID (`kill <pid>`; on Windows `taskkill /PID <pid> /T /F`). Never stop processes by name (`node`, `claude`, `chrome`): that ends other workbenches and sessions too.

## 3 · Real data stays out of git

The real Ecolar study (`private/studies/…`) is **not** in the repository: git ignores `private/`. To test it on another machine:
- Copy its folder `private/studies/<name>/` separately, for example on an encrypted drive. Include its `runtime/` bridge if it has one.
- Do not copy `private/settings.json`. Setup writes this machine's paths.
- Never commit anything under `private/`, and never move real data into `examples/`.

Private studies get no starter. Review, approve and freeze them yourself (AGENTS.md, "Workflow for a new study").

## 4 · First steps in any suite

The starter is already frozen, so you can skip **Study & variables**, **Agent configurations** and **Freeze**. To test those pages too, review the configurations, press **Approve study and configurations**, then **Freeze campaign** to make a campaign of your own.

1. **Run agents** shows the starter. Its table lists every session.
2. **Simulate everything (free).** Set **Mode** to *Simulate* and press **Start all not run yet**. Invented forecasts fill every session within minutes; no model is called. Then:
   - **Compare agents** (needs no human data);
   - **Compare with humans** → **Show human data**, or **Analyze campaign**, tick configurations and choose views (Agreement, Agent vs human, Correlation, Population vs individual, Participants); **Save SVG / PNG**.
3. **One real session.** Set **Mode** to *Run agents*, select one session of a text-only configuration and press **Run this session only**. Watch its progress. Every real session uses your Claude Code login.
   - Simulated sessions are never turned into real ones. After simulating everything, use **Continue / rerun**: continue from the starter with **Keep simulated runs** off (the default) and press **Create continuation**. Its sessions start as not run, so you can run real ones there. Alternatively, run your real pilot in the starter before you simulate it.
   - Real and simulated runs of one configuration are never pooled.
4. **A small pilot.** **Choose sessions to run** selects the first *k* sessions of chosen configurations; **Start selected** runs only those. Start always shows the number of sessions and a cost estimate first, based on earlier real sessions of the same configuration and model.

## 5 · The suites

Each starter's `starter.json` lists its sessions per configuration and what each one needs.

### Suite 1 · Ecolar (Unreal), `examples/ecolar`

| | |
| --- | --- |
| Exercises | Unreal runtime through a study bridge. Within-subjects: 4 temperature visualizations, 24 participants in Williams-square orders, 14 measures (including rankings). 10 population configurations (A–F, with and without demographics) and 6 individual ones (U-series). Measured objective data as inputs (UDO and later), movement recordings (UDOT, compact and full). |
| Needs | **Nothing** for A, A-Dem, B, B-Dem, F and F-Dem (app-free). **An Unreal study bridge** for C, C-Dem, D, D-Dem and the U-series (`examples/ecolar/UNREAL_SETUP.md`; a lab bridge may be kept under `private/studies/<name>/runtime/`). Without one, those can only be simulated. |
| Starter | 436 sessions: agents.json fixes the run counts here (10 runs per population configuration; 3 per person for U1, UD, UDO and UDOT; 1 per person for the two full-movement ones). |
| Try first | Simulate all. One real session of *A · Direct forecast*. Compare with humans → Agreement for A–F, Population vs individual (one population and one U configuration), Participants (a U configuration). |
| Expect | Without a bridge, starting an Unreal configuration as an agent is refused with "Unreal MCP runtime is not configured …" and the app-free ones still run. Measures a configuration receives as inputs are never scored for it. |

### Suite 2 · Selecting and placing objects (Unity), `examples/selection`

| | |
| --- | --- |
| Exercises | Unity runtime with the included Python bridge (`runtime/bridge.py`). Within-subjects: 3 selection techniques, 12 participants whose background drives the invented outcomes. 4 population and 2 individual configurations. |
| Needs | **Nothing** for Text only, Reads the project files, Reads the project + your evidence, and Text + participant background. **Unity 6 with the project open, plus the bridge set in Settings → Runtimes → unity** for Uses the app and Uses the app + knows the participant (`examples/selection/UNITY_SETUP.md`; setup prints the command to enter). Without it, those can only be simulated. |
| Starter | 36 sessions (3 runs per population configuration, 1 per person for the individual ones). |
| Try first | Simulate all. One real *Text only* session. With Unity ready, one *Uses the app* session; select it in the table to see its latest screenshot. Compare with humans → Agent vs human, Population vs individual. |
| Expect | Without the bridge, the app configurations are named as blocked ("Unity MCP runtime is not configured …"). An engine session takes much longer than a text session. Engine runtimes run one session at a time, each with a time limit of at least 90 minutes. |

### Suite 3 · Graphics quality (WebXR), `examples/graphics-quality`

| | |
| --- | --- |
| Exercises | The built-in WebXR runtime (headless Chrome) with its own app. Within-subjects: 3 quality levels, 18 participants, 7 measures. 5 population configurations (text, project files, the app, evidence, measured task data as input) and 2 individual ones. |
| Needs | **Chrome** for Uses the app and Uses the app + knows the participant; **nothing** for the others. |
| Starter | 126 sessions (18 runs per population configuration, 1 per person for the individual ones). |
| Try first | Simulate all. One real *Text only* session, then one *Uses the app* session; watch its latest screenshot. Compare agents (tool calls, time, cost), then Compare with humans → Agreement, Agent vs human (Visual discomfort), Correlation. |
| Expect | App sessions open the app in headless Chrome, look around, take screenshots and do the tasks before they submit. *Text + measured task data* gets the measured search time and errors and predicts only the experience measures. Chrome renders the app in software: a screenshot of the high design takes a few seconds, and by default one WebXR session runs per 4 logical cores (Settings → Runtimes). The website stays usable while they run. |

### Suite 3-a · Graphics quality on Apple Vision Pro (visionOS), `examples/graphics-quality/apple-vision-pro`

| | |
| --- | --- |
| Exercises | The **visionOS runtime**: suite 3's study (same designs, participants, synthetic data and configurations) with an Apple Vision Pro app (SwiftUI + RealityKit, `visionos-app/`) and a study bridge (`runtime/bridge.mjs`) that plays it in the visionOS simulator. The bridge offers the WebXR runtime's tools, so suites 3 and 3-a compare the two runtimes on one study. |
| Needs | **A Mac** with Xcode and the visionOS simulator runtime, for Uses the app and Uses the app + knows the participant: build the app with `node examples/graphics-quality/apple-vision-pro/runtime/build.mjs`, set Settings → Runtimes → visionos (command `node`, arguments `examples/graphics-quality/apple-vision-pro/runtime/bridge.mjs {jobFile}`, capabilities `screenshot, look, pointer-select, phase-events, quality-lock`), and check it with `node examples/graphics-quality/apple-vision-pro/runtime/check.mjs`. **Nothing** for the other configurations. See `VISIONOS_SETUP.md`. |
| Starter | 126 sessions (as suite 3). |
| Try first | Simulate all. Run `check.mjs` and look at its screenshots. Then one real *Uses the app* session; select it to see what the headset showed. Compare its agreement and tool calls with suite 3's *Uses the app*. |
| Expect | The bridge boots a dedicated simulator, "XR Study Sim (Apple Vision Pro)", on the first session (a minute or two) and leaves it running for the next. Each design starts the app afresh and calibrates the view (a few seconds). Screenshots are mono (one view, no left/right pair). Like other engines, one visionOS session runs at a time. On Windows or without the simulator, the app configurations can only be simulated. |

### Suite 4 · Material cues (WebXR), `examples/material-cues`

| | |
| --- | --- |
| Exercises | A second WebXR app with a declared action (`identify` a material). Within-subjects: low vs high rendering quality, 16 participants with background (vision correction, colour vision, design training, VR hours). 5 population and 2 individual configurations. **App only vs uses app**: *Uses the app only* gets the brief and the running app; *Uses the app + project files* also reads the project. |
| Needs | **Chrome** for the two app configurations; **nothing** for the others. Before the first real app session, run `node dist/cli.js app-check examples/material-cues`: it opens both designs without an agent and reports what would break sessions. |
| Starter | 112 sessions. |
| Try first | app-check. Simulate all. One real *Text only* session and one *Uses the app only* session. Compare with humans → Agreement (Uses the app only vs Text only, a planned comparison), Agent vs human (identification accuracy). |
| Expect | app-check ends with "Every design opened, and the runtime could read the app" and saves a screenshot per design. In identification trials the agent answers with `act identify`. |

### Suite 5 · Haptic buttons, `examples/haptic-buttons`

| | |
| --- | --- |
| Exercises | No app: three press-feedback designs (visual only, vibrotactile buzz, patterned pulse). Within-subjects: 18 participants with background (handedness, hand length, tactile sensitivity, gaming, VR experience). 3 population and 3 individual configurations. Practice-only movement recordings (`"phases": ["practice"]`) and measured task data as inputs for individual configurations. |
| Needs | **Nothing** (every configuration is app-free). |
| Starter | 108 sessions. |
| Try first | Simulate all. One real *Text only* session and one *Participant background + practice movement* session. Compare with humans → Population vs individual, Participants. |
| Expect | **Agents read about the feedback; they cannot feel it.** The brief describes the actuator, its timing and the visual feedback in words. Movement reaches individual configurations only, and only from the practice phase. |

### Suite 5-w · Haptic buttons in WebXR, `examples/haptic-buttons/webxr`

| | |
| --- | --- |
| Exercises | Suite 5's study, with the same designs, participants, synthetic data and six configurations, plus a runnable **WebXR keypad app** and two app configurations: *Uses the app* (population) and *Uses the app + participant background* (individual). It tests **pointer input** (`pointer-xy`): the agent clicks keys on the screenshot like a fingertip press, and a press in a gap between keys is refused. |
| Needs | **Chrome** for the two app configurations; **nothing** for the others. Check with `node dist/cli.js app-check examples/haptic-buttons/webxr`. |
| Starter | 144 sessions. |
| Try first | app-check. Simulate all. One real *Uses the app* session: about 165 tool calls, about $1.15 with Opus 5.5. Then Compare with humans → Agreement (*Uses the app* vs *Text only*, a planned comparison). |
| Expect | Every press replies with what the participant would see and feel, in words, because agents cannot feel the buzz. The agent types 13 sequences per design. |

### Suite 6 · Haptic buttons, between subjects, `examples/haptic-buttons-between`

| | |
| --- | --- |
| Exercises | The between-subjects analysis: 3 groups × 12 people, each person one design. 4 population configurations (text, evidence, cohort background, measured task data as input). |
| Needs | **Nothing.** |
| Starter | 144 sessions (36 runs per configuration). |
| Try first | Simulate all. One real *Text only* session. Compare with humans → Show human data, then Analyze campaign → Agreement, Agent vs human. |
| Expect | **Group tests, no rankings.** Groups are compared with Mann–Whitney U (Holm). Design differences count only where the human groups differ significantly, and each configuration's absolute values are checked against each group's 95% interval. There are no preference rankings and no individual configurations, so the views that need one (Population vs individual, Participants) have nothing to draw. Agents read about the feedback; they cannot feel it. |

### Suite 6-w · Haptic buttons, between subjects, in WebXR, `examples/haptic-buttons-between/webxr`

| | |
| --- | --- |
| Exercises | Suite 6's study with suite 5-w's keypad app in its `codes` task, and *Uses the app* (population). The agent uses **declared actions with arguments**: `press-key` takes one `key` or several `keys`, and `confirm-code` presses Enter. The analysis is between subjects, as in suite 6. |
| Needs | **Chrome** for *Uses the app*; **nothing** for the others. Check with `node dist/cli.js app-check examples/haptic-buttons-between/webxr`. |
| Starter | 180 sessions (36 runs per configuration). |
| Try first | app-check. Simulate all. Run one real *Uses the app* session (about 93 tool calls, about $0.70 with Opus 5.5). Press **Stop** during it, then run it again: the rerun starts in a fresh attempt. |
| Expect | Agents usually type a whole code with one `press-key` call that gives several `keys`. |

### Suite 7 · Mid-air text entry, `examples/text-entry`

| | |
| --- | --- |
| Exercises | **Forecasts made before the study** (`"predictionTiming": "before-experience"`): 4 keyboards, 24 participants in a balanced Latin square, background (typing speed, swipe use, first language, arm length). 4 population and 2 individual configurations, including a **second-model arm** (*Text only — claude-sonnet-5-5*). |
| Needs | **Nothing.** The model arm needs `claude-sonnet-5-5` in your Claude Code. |
| Starter | 144 sessions. |
| Try first | Simulate all. One real *Text only* session and one session of the model arm. Compare agents (the two models side by side), then Compare with humans → Population vs individual. |
| Expect | **No measured inputs**: Give as input is disabled, and configurations get only what is known before anyone types. If the model arm's model is not available, its first session fails with "Claude Code does not know the model …". Change the model on Agent configurations, then freeze a new campaign (the starter keeps the model it was frozen with). |

### Suite 7-w · Mid-air text entry in WebXR, `examples/text-entry/webxr`

| | |
| --- | --- |
| Exercises | Suite 7's study with a **WebXR app of the four keyboards**, plus two app configurations. The app **adds actions at run time**: while the swipe keyboard is open, it lists `swipe`, `choose-word` and `delete-word` through `actions()`. Forecasts are still made before the study: the agent tries the keyboards like a pilot participant. Individual jobs carry the participant into the app: their own keyboard order and phrases. |
| Needs | **Chrome** for the two app configurations; **nothing** for the others. Check with `node dist/cli.js app-check examples/text-entry/webxr`. The model arm needs what it needs in suite 7. |
| Starter | 192 sessions. |
| Try first | app-check. Simulate all. One real *Uses the app* session: about 106 tool calls, about $1.02 with Opus 5.5. Then Compare with humans → Agreement (*Uses the app* vs *Text only*). |
| Expect | Replies say what each keyboard took: trigger pulls, drum strikes or thumbstick tilts. Two swipe strokes with identical paths can swap words ("soon" comes out as "son"). The agent sees the swap in the reply and fixes it with `choose-word`. |

## 6 · Cost of real sessions

**Simulate is free:** no model is called. Real sessions use your Claude Code usage, so start small:
- **Text-only sessions first.** They are the cheapest: one session reads the brief and submits. Select one and press **Run this session only**. The job table then shows its tokens and cost.
- **App sessions cost more and take longer.** They make many tool calls and take screenshots. WebXR sessions take minutes; engine sessions can take much longer.
- **Do not press Start all not run yet in Run agents mode** unless you mean it: a starter has 36 to 436 sessions.
- Use **Choose sessions to run** for a pilot. Start shows the number of sessions and an estimate from earlier real sessions first; **Pause** and **Stop** work at any time.

## 7 · Report back

Send:
- **Findings:** what you did, what you expected and what happened, with the suite, the configuration and the session (job ID), and the machine (OS, Node and Claude Code versions; setup prints them).
- **`node scripts/setup.mjs --test` output**, complete.
- **Runs:** **Save runs as zip** on Run agents. The zip holds the campaign, its receipts and every recorded attempt. Paths of this machine are written as `<repo>` and `~`.
- **For a failed or odd session:** its folder `examples/<suite>/runs/<campaign>/jobs/<job>/a<n>/` (`stream.jsonl`, `trace.jsonl`, `execution-manifest.json`, `attempt.json`, screenshots), and the website's terminal output.

Open an **issue** on the repository with these files, or a **pull request** with a fix. CI (`.github/workflows/ci.yml`, Ubuntu and Windows) runs on pull requests and on `main` only, not on every push to a working branch; open a pull request to have a branch tested.

Never attach anything from `private/` or runs of the real study to an issue or pull request.

## 8 · Updating

```bash
git pull
node scripts/setup.mjs           # reinstalls dependencies if needed, rebuilds, installs starters a study does not have yet
```

`npm run build` alone also rebuilds.

**When suites change.** The starters in git are rebuilt from the suites' files with `npm run starters` and committed with the change. `npm test` fails while a starter is out of date, and names the suite and the source that changed. `npm run starters -- --check` lists them without writing.

**A starter you already installed is never replaced.** If a pull changed a file its configurations read, real sessions of those configurations are refused with "… changed after this campaign was frozen". Simulating still works. Then do one of these:
- **Freeze campaign** for a fresh campaign;
- **Continue / rerun** from the old starter, which runs those configurations again with the new files.
