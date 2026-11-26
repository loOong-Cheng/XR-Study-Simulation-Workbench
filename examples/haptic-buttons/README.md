# Suite 5: haptic feedback for mid-air buttons (synthetic, no app)

A synthetic within-subjects study of three kinds of press feedback for a keypad floating in mid-air in VR, with 18 invented participants, three objective and four subjective measures, and two kinds of participant-specific information. **All participants and their data are invented.** The idea and some wording come from a test study a tester made up; no data were taken from it.

**What the suite shows.** How well agents forecast a haptics study from the description alone, from a neutral background note, from the cohort's background (population level), and for each person from their own background, from their hand movement during practice, and from their measured task performance used as inputs (individual level). The invented background really drives the invented outcomes, so individual forecasts have something to find.

**There is no app.** The study's runtime is `custom` and no app comes with it: every configuration is app-free (`"runtime": "none"`, no `xr-interact`) and runs with Claude Code alone. Nothing needs to be installed or configured beyond the workbench.

**Research questions**

- **About the designs** (`researchQuestion`, sent to every agent): how do visual feedback only, a vibrotactile buzz and a patterned vibrotactile pulse differ in entry time, errors, overshoot, confidence, workload, presence and preference?
- **About the agents** (`agentQuestions`, never sent to agents): which configurations reproduce those differences, and do background, practice movement or measured performance improve the forecasts for each person?

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | 3 designs, 7 measures, 18 participants (P01–P18, a balanced Latin square: all six orders, three people each), 4 sources |
| `agents.json` | 6 configurations (below), all app-free |
| `comparisons.json` | 3 planned comparisons, each within one level |
| `human.json` | Invented human reference, written by `data/convert_to_human.py` |
| `data/generate_synthetic.py`, `data/raw/` | Invented raw data: orders, background, practice movement, sequences, questionnaires, rankings |
| `data/convert_to_human.py` | Converts the raw files to `human.json` (practice excluded) |
| `agent-brief.md` | What every agent is told: setup, keypad, task, designs, procedure, measures; no results |
| `evidence/haptics-evidence.md` | A short, neutral background note on haptic feedback for mid-air buttons; no results of this study |
| `workspace.json` | Title, suite name and where each source lives |
| `starter/` | The starter campaign: this suite frozen at 1 run per participant (`starter.json` lists its sessions), installed into `campaigns/` the first time the study opens without a campaign; rebuilt with `npm run starters` ([testing with the example suites](../../docs/testing-with-example-suites.md)) |
| `webxr/` | **Suite 5-w**: this study with a WebXR keypad app, a study of its own (see the end of this page) |

To regenerate the data: `python3 data/generate_synthetic.py && python3 data/convert_to_human.py`. Both are deterministic (seeded) and write UTF-8 with LF line endings, so a rerun reproduces the committed files byte for byte.

About this dataset: apparatus, stimuli, what every data column means: [`data/README.md`](data/README.md).

## Designs and task

Participants stand in a headset with hand tracking and type 4-digit sequences on a phone-style keypad floating at chest height, pressing with the right index finger, which wears a small vibration actuator. A key activates when the fingertip crosses its activation plane, 1 cm behind the key face; nothing stops the finger.

| ID | Design | Feedback at a press |
| --- | --- | --- |
| `visual` | Visual feedback only | The key lights up and its face moves back |
| `buzz` | Vibrotactile buzz | The same, plus one short burst (about 20 ms) at activation |
| `pulse` | Patterned pulse | The same, plus ticks from touching the key face, faster towards the plane, and a stronger double pulse at activation |

Per design: three practice sequences, ten scored sequences, a questionnaire and a break. A ranking of the three designs at the end.

## Measures

| ID | Measure | Scale | How it is computed (converter) |
| --- | --- | --- | --- |
| `completion-time` | Completion time per sequence | seconds, geometric, range 1–60 | Geometric mean over the ten scored sequences |
| `error-rate` | Error rate | proportion, 0–1 | Wrong digit presses / all digit presses in the scored sequences |
| `overshoot` | Overshoot depth | mm, range 0–40 | Mean depth past the activation plane over all scored digit presses |
| `confidence` | Press confidence | 1–7 | Single item after each design |
| `workload` | Workload (raw NASA-TLX) | 0–100 | Six 0–100 items as components, combined by the **mean** rule (`"componentRule": "mean"`): the unweighted raw TLX. Performance is scored 0 = perfect, so all items point the same way. The mean keeps the 0–100 range of the items; a sum would run to 600. |
| `presence` | Presence (the buttons felt real) | 1–7 | Single item after each design |
| `preference` | Overall preference | rank, 1 = best | Final ranking |

## Participant information

Both kinds are complete for all 18 participants; a gap would block the configurations that get them.

1. **Background** (`data/raw/demographics.csv`, source `demographics`): `age` (19–54), `handedness` (14 right, 3 left, 1 ambidextrous), `hand_length_cm` (wrist crease to middle fingertip), `tactile_sensitivity_2pd_mm` (two-point discrimination threshold at the index fingertip; larger = less sensitive), `gaming_hours_per_week`, `vr_experience` (none, occasional, regular; one of each in every order). Individual configurations get the person's own row; population configurations get a cohort summary (means, ranges, counts).
2. **Practice movement** (`data/raw/movement_practice.csv`, source `trajectory`): one row per practice sequence of each design (`design`, `phase`, `trial`, `path_length_cm`, `mean_speed_cm_s`, `overshoot_mm`). The source declares `"phases": ["practice"]`, so only practice rows are ever delivered and the recordings cannot stand in for the scored main-phase measures. Movement reaches individual configurations only.

## The invented effects (ground truth)

The generator builds every outcome from the design, the person and noise. Effects are moderate; the numbers below are the generator's settings, not estimates.

- **Tactile sensitivity moderates every vibrotactile benefit.** A person's benefit factor is `1 − 0.3 × (2PD − 2.5 mm)`, clipped to 0.15–1.15: at 2.5 mm a person gets the full benefit of the buzz and the pulse, at 4.5 mm less than half. Coarser thresholds come with age.
- **Design effects at full benefit:** both vibrotactile designs save about 11% of the time per sequence (the same for buzz and pulse); the buzz removes about 22% of the overshoot and the pulse about 42% (the approach ticks tell people where the plane is); both lower the share of presses made unsure of whether the key registered; confidence +1.3 (buzz) and +1.45 (pulse) points; TLX −8 and −7 points (the pattern needs some attention); presence +0.9 and +1.2 points.
- **Speed:** gaming hours make people faster (1.2% per weekly hour, at most 20%); no VR experience is 14% slower and regular experience 10% faster than occasional; left-handed people, pressing with their non-dominant hand, are 10% slower (ambidextrous 3%); age adds 0.4% per year.
- **Overshoot:** about 1.8 mm more per centimetre of hand length above 18.5 cm.
- **Errors:** more for no VR experience (×1.3) and left-handed people (×1.3), and with overshoot past 8 mm.
- **Learning:** the second and third design in a person's order are about 5% and 9% faster.
- **Subjective measures** also follow the person's own errors and time; preference follows confidence, presence and workload.
- **Practice movement** comes from the same person and design (with a first-contact penalty), so it carries information about the scored phase without being part of it.

Design averages that result (geometric mean for time):

| Measure | Visual | Buzz | Pulse |
| --- | ---: | ---: | ---: |
| Completion time (s) | 4.63 | 4.15 | 4.26 |
| Error rate | 0.053 | 0.038 | 0.035 |
| Overshoot (mm) | 11.2 | 9.1 | 7.1 |
| Press confidence (1–7) | 3.72 | 5.39 | 5.22 |
| Workload (0–100) | 38.4 | 28.5 | 29.2 |
| Presence (1–7) | 3.33 | 4.00 | 4.33 |
| Preference rank | 2.83 | 1.72 | 1.44 |

With Wilcoxon signed-rank tests and Holm within each measure (as **Show human data** draws them), visual differs from both vibrotactile designs on every measure except error rate, and the buzz and the pulse differ only on overshoot. Not significant: every error-rate difference, and buzz vs pulse on completion time, confidence, workload, presence and preference.

## Agent configurations

All use Claude Code with `claude-opus-5-5` at default effort, a token budget of 200,000 per session and no app.

| Configuration | Level | The agent gets | The one ingredient it adds |
| --- | --- | --- | --- |
| `text-only` · Text only | population | The brief | (baseline) |
| `reads-evidence` · Text + evidence | population | Brief + evidence note | The background note on haptic feedback |
| `cohort-background` · Text + cohort background | population | Brief + cohort summary of the background | The cohort's background |
| `knows-participant` · Text + participant background | individual | Brief + the person's background | The person's own background |
| `knows-participant-and-movement` · … + practice movement | individual | Brief + background + the person's practice movement | The person's practice movement |
| `knows-participant-and-task-data` · … + measured task data | individual | Brief + background; the person's completion time, error rate and overshoot as inputs | The measured objective performance (after-experience); it predicts only the four subjective measures |

At 1 run per participant: 3 population configurations × 18 runs + 3 individual configurations × 18 participants = 108 sessions.

**Comparisons** (`comparisons.json`, each within one level): Text + evidence vs Text only (objective), practice movement vs background only (objective, individual), measured task data vs background only (subjective, individual).

## Running it

1. **Check:** `node dist/cli.js study-check examples/haptic-buttons/study.json --agents examples/haptic-buttons/agents.json --human examples/haptic-buttons/human.json` reports a valid study without warnings.
2. **Website:** `npm start`, then open `http://127.0.0.1:4317/?study=examples%2Fhaptic-buttons` (or the port in `XR_STUDY_PORT`). **Agent configurations:** review and **Approve study and configurations**; **Freeze & campaigns:** **Freeze campaign**.
3. **Simulate** (no cost): **Run agents** in Simulate mode, then **Compare agents** and **Compare with humans** (Agreement, Agent vs human, Correlation, Population vs individual, Participants).
4. **Real agents:** every configuration runs with Claude Code right away; there is no runtime to set up. Run one session first (**Run this session only**), then the rest.

Simulated runs and invented participants show how the method behaves, not how good agents are.

## Suite 5-w: the same study with a WebXR app

[`webxr/`](webxr/README.md) holds **suite 5-w**: this study (the same designs, participants, synthetic data and configurations) with a WebXR keypad app the agent clicks like a fingertip press, and two app configurations (*Uses the app*, *Uses the app + participant background*). It runs with Claude Code and the built-in WebXR runtime in Chrome. It is a study of its own (ID `examples/haptic-buttons/webxr`, with its own campaigns, runs and starter) that sits inside this folder; this study's sources never include it, and this suite's configurations stay app-free.
