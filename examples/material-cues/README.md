# Suite 4: material cues at two rendering qualities (synthetic, WebXR)

A synthetic within-subjects study with a runnable WebXR app: 16 invented participants find and identify objects by their material in a small room rendered at low and at high quality. Their invented background (colour vision, art or design training, VR experience, age, vision correction) drives the invented outcomes, so individual forecasts have something to find. **All participants and their data are invented.** The app is adapted from suite 3.

**Research questions**

- **RQ1 (about the XR design, sent to every agent):** How does the rendering quality of a WebXR room (low: flat, unlit colours; high: physically based materials) affect how quickly and accurately people find objects defined by their material, how well they identify materials, how present they feel, how visually appealing they find the room, and which quality they prefer?
- **RQ2 and RQ3 (about the agents, `agentQuestions`, never sent to agents):** Which agent methods reproduce the human differences between the two qualities? Does knowing each participant's background, with or without general evidence about observer differences, give useful individual forecasts?

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | 2 designs, 6 measures, 16 participants (P01–P16, 8 low → high and 8 high → low), sources |
| `agents.json` | 7 configurations (below) |
| `comparisons.json` | 3 planned comparisons for the analyzer |
| `workspace.json` | Where each source lives; how to serve the app (`?quality={condition}&study=1&participant={participant}`), its capabilities and its `identify` action |
| `human.json` | Invented human reference, written by `data/convert_to_human.py`; never given to agents |
| `data/generate_synthetic.py`, `data/raw/` | Seeded generator and the invented raw data: background, search trials, identification trials, questionnaires, preferences |
| `agent-brief.md` | What every agent is told: room, designs, procedure, measures (no results) |
| `evidence/` | Two invented, literature-style background notes (rendering and material perception; observer differences), written without the data |
| `webxr-app/` | The app; exposes `window.xrStudy` for the built-in WebXR runtime; three.js 0.160.0 vendored (MIT), runs offline |

## The app and the task

Two mugs, two bowls and two vases come in pairs that share shape and almost share colour: each material keeps a slight tint of its own, mostly along the red–green axis. They differ in material: glossy vs matte ceramic, brushed metal vs plastic, glass vs plastic. A wooden box, a cushion and a plant stand beside them.

- **Low:** flat, unlit colours. Every material is drawn in its average colour, at reduced resolution and without antialiasing, so the slight tint is the only cue that tells a pair apart.
- **High:** physically based materials from procedural texture sets (`webxr-app/pbr.js`), environment reflections, glass transmission, clear-coat glaze, brushed-metal anisotropy, fabric sheen, soft shadows, tone mapping.

In each design: one practice trial (select the wooden box); then the main task: four **search trials** (select the glossy ceramic mug, the brushed-metal bowl and the glass vase; a selection flashes green or red) and six **identification trials** (a yellow ring and cone mark one look-alike; name its material from five options, without feedback). The look-alikes swap places before every trial. Layouts and the order of the marked objects are drawn from a fresh random seed in every session and written to the app's log, so the project files hold no answers.

The app declares `look`, `pointer-select`, `actions` (the `identify` action), `phase-events` and `quality-lock` in `workspace.json`. App sessions get `open_design`, `screenshot`, `app_state`, `look`, `list_objects`, `select` and `act` (`identify`, with `{"material": "glass"}` and so on). In the identification trials `list_objects` marks the marked object (`public.marked`), as the participant sees it. Each main task needs at least 18 scored actions (12 correct selections and 6 answers).

To see the app yourself: `cd examples/material-cues/webxr-app && python3 -m http.server 8124 --bind 127.0.0.1`, then open http://127.0.0.1:8124/?quality=low (or `high`).

## Measures

| ID | Measure | Scale | How it is computed (`data/convert_to_human.py`) |
| --- | --- | --- | --- |
| `search-time` | Search time | continuous, s, range 0–120, geometric | Geometric mean of the four search trials; practice excluded |
| `wrong-selections` | Wrong selections | count | Non-target selections summed over the four search trials |
| `identification-accuracy` | Material identification accuracy | proportion, 0–1 | Correct answers / 6 |
| `presence` | Presence (4 items) | ordinal 1–7, mean of items | Components: general, spatial, involvement, realness |
| `appeal` | Visual appeal | ordinal 1–7 | One item |
| `preference` | Preference | rank, 1 = preferred | Asked at the end of the session |

## Participant information and the invented ground truth

`data/raw/background.csv` (source `background`, kind demographics) is complete for all 16 people:

| Field | Values in the cohort |
| --- | --- |
| `age_band` | 18-24 (5), 25-34 (6), 35-44 (3), 45-54 (2) |
| `vision_correction` | none (8), glasses (5), contacts (3) |
| `color_vision` | normal (14), deficient (2: P05, P12) |
| `art_or_design_training` | none (7), some (5), professional (4) |
| `vr_hours_total` | 0 to 120 hours |

Population configurations get a cohort summary of it; individual configurations get the person's own row.

**How the background drives the outcomes (invented, `data/generate_synthetic.py`):**

- **Rendering quality.** At high quality, highlights, reflections and transmission show the material, so wrong selections are fewer and identification is better. At low quality a pick within a pair is a guess until the observer has learnt from the green/red feedback which tint goes with which material. Search time hardly differs: at low quality people pick quickly and correct their mistakes; at high quality they inspect each candidate for longer.
- **Colour-vision deficiency.** The tint is the only cue at low quality and deficient observers cannot see it: they stay at chance there (more wrong selections, identification about 0.5). At high quality the effect is small.
- **Art or design training.** Better identification and fewer wrong selections at high quality (some < professional). Professionals also like the clean flat look more (higher appeal of low).
- **VR hours.** Faster search in both designs (log of hours), and slightly lower presence (less novelty).
- **Age 45–54:** slower search. **Glasses:** slightly lower presence. **Second design of a session:** about 10% faster search.
- Person-level noise on speed, skill, presence, taste and preference; moderate effects. The seed is the first one from 20261125 upward whose 16-person sample shows each of these effects in its direction (with two colour-deficient people, noise can hide a moderate effect).

**Averages in the invented data** (as the analyzer computes them, with its paired Wilcoxon test):

| Measure | Low | High | Difference |
| --- | ---: | ---: | --- |
| Search time (s, geometric mean) | 9.3 | 8.9 | not significant (p = 0.43) |
| Wrong selections (4 search trials) | 4.5 | 1.25 | significant (p < 0.001) |
| Identification accuracy | 0.58 | 0.81 | significant (p = 0.02) |
| Presence (1–7) | 4.17 | 4.17 | not significant (p = 0.87) |
| Visual appeal (1–7) | 3.9 | 5.5 | significant (p < 0.001) |
| Preference (mean rank) | 1.69 | 1.31 | not significant (p = 0.21; 11 of 16 prefer high) |

An agent that assumes "better rendering improves everything" gets search time, presence and the strength of the preference wrong.

## Agent configurations

All use Claude Code with `claude-opus-5-5` at default effort. Each adds one ingredient to a neighbour:

| Configuration | Level | The agent gets | The one ingredient it adds |
| --- | --- | --- | --- |
| `text-only` | population | the brief | baseline |
| `reads-evidence` | population | brief + both evidence notes | the general evidence (vs Text only) |
| `app-only` | population | brief + the running app | experiencing the app like a participant (vs Text only) |
| `uses-app` | population | brief + project files + the running app | the project files (vs Uses the app only) |
| `text-with-task-data` | population | brief + measured search time, wrong selections and identification accuracy (cohort means); predicts presence, appeal and preference only | measured task performance as inputs (vs Text only) |
| `knows-participant` | individual | brief + the person's background | the person's background, per participant |
| `knows-participant-evidence` | individual | brief + background + both evidence notes | the general evidence (vs Text + participant background) |

**Token budgets** follow the planner's estimate (`docs/methodology.md` → "Budgets"). An app session needs at least 46 tool calls (2 designs to open, 40 task actions, 4 views; 47 with the project files), about 1.4 million tokens; the app configurations get 3 million, about 73 calls under the estimate, and up to 150 tool calls. Configurations without the app get 100,000 tokens (150,000 with the evidence notes, which are part of the prompt).

At 1 run per participant: 5 population configurations × 16 runs + 2 individual configurations × 16 people = 112 sessions, 32 of them in the app.

**Planned comparisons** (`comparisons.json`): Uses the app only vs Text only (objective), Text + general evidence vs Text only (objective), and Text + background + evidence vs Text + background (objective, individual).

## How to run

```bash
npm ci && npm run build
node dist/cli.js study-check examples/material-cues/study.json --agents examples/material-cues/agents.json --human examples/material-cues/human.json
node dist/cli.js app-check examples/material-cues     # opens both designs through the WebXR runtime, no agent
npm start                                              # http://127.0.0.1:4317/?study=examples%2Fmaterial-cues (or XR_STUDY_PORT)
```

In the website: **Agent configurations** → review → **Approve study and configurations**; **Freeze & campaigns** → **Freeze campaign**; **Run agents** in *Simulate* mode to try the pipeline at no cost, or *Run agents* for real sessions (run one session first with **Run this session only**); then **Compare agents** and **Compare with humans**. The suite needs only Google Chrome: the WebXR runtime is built in.

To regenerate the data (deterministic; the test checks that the committed files come out byte for byte):

```bash
python3 examples/material-cues/data/generate_synthetic.py && python3 examples/material-cues/data/convert_to_human.py
```

## What a simulated run does and does not show

Simulated runs test the pipeline, not prediction quality: their numbers are invented without looking at the app. Only real agent runs say anything about agents, and since the participants are invented too, even real runs only show how the method behaves.
