# Suite 7: mid-air text entry with four virtual keyboards (synthetic)

A synthetic within-subjects study of four VR keyboards (raycast QWERTY, drum-like, swipe and split) with 24 invented participants who transcribe short phrases. **All participants and their data are invented.**

**What the suite shows: forecasts made before the study.** The study is declared `"predictionTiming": "before-experience"`. Agents get only what is known before anyone types: the brief, a background note and the participants' background, recorded before the session. No measured outcome is ever an input. The website disables **Give as input** on Agent configurations, and a configuration with `inputs` is refused ("uses measured outcomes as inputs, which requires an after-experience forecast"). Objective records and movement recordings are refused too. The forecasts are then scored against the (invented) results, as for any other study.

**No runnable app.** There is no app or engine project in this suite. Every configuration is app-free (runtime `none`) and runs with Claude Code alone. Nothing else needs to be set up.

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | 4 keyboards, 6 measures with declared ranges, 24 participants (P01–P24) in a balanced 4 × 4 Latin square, sources, 3 planned comparisons |
| `agents.json` | 6 configurations (below) |
| `comparisons.json` | The 3 planned comparisons (also stored with the study, so the analysis labels them "in plan") |
| `human.json` | Invented human reference, written by `data/convert_to_human.py` |
| `data/generate_synthetic.py`, `data/raw/` | Invented raw data: background, scored phrases (presented and transcribed text, seconds), questionnaires, rankings |
| `agent-brief.md` | What every agent is told: the task, the keyboards, the phrases, the procedure and the measures; no results |
| `evidence/text-entry-in-vr.md` | A short, neutral background note on text entry in VR (measures, keyboard families, arm fatigue), with references; no results of this study |
| `workspace.json` | Where each source lives |

To regenerate the data: `python3 data/generate_synthetic.py && python3 data/convert_to_human.py`. Both are seeded and write UTF-8 with LF line endings, so rerunning them reproduces the committed files byte for byte.

## The study

- **Keyboards:**
  - **Raycast QWERTY:** a flat panel 1.5 m away; point with a controller ray and pull the trigger.
  - **Drum-like:** keys struck with virtual sticks; the keyboard sits at a fixed place in front of the chest.
  - **Swipe:** a word-gesture stroke over the raycast panel, decoded against a dictionary.
  - **Split:** two half keyboards above the controllers; keys reached with the thumbsticks.
- **Procedure:**
  - Participants sit without armrests and wear a Meta Quest 3 with its controllers.
  - Per keyboard: two minutes of practice, ten scored phrases from a pool of 40 invented phrases (lowercase, in the style of the MacKenzie and Soukoreff phrase set), a questionnaire and a two-minute break.
  - After all four keyboards: a ranking.
- **Orders:** a balanced Latin square (Williams design). There are four orders, each used by six people; every keyboard comes once in every position and directly follows every other keyboard once.
- **Measures:**

  | Measure | Scale and range | Family |
  | --- | --- | --- |
  | Entry speed (WPM) | continuous, 0–60; mean over the phrases | entry-speed |
  | Uncorrected error rate | proportion, 0–1; minimum string distance over the longer string, per phrase | accuracy |
  | Entry time per phrase (s) | continuous, 1–180; geometric mean | entry-speed |
  | Workload (raw NASA-TLX) | composite of six items, mean rule, 0–100 | workload |
  | Arm and shoulder comfort | ordinal, 1–7 | comfort |
  | Preference | rank 1–4 | preference |

  Entry speed and entry time per phrase describe nearly the same thing, so they share one family (and one weight) instead of counting twice.

## Participant information and the invented effects

`data/raw/background.csv` has a complete row for every participant. Its seven fields are what agents may get as participant background:

| Field | Values (this cohort) |
| --- | --- |
| `desktop_typing_wpm` | Words per minute in a one-minute typing test on a desktop keyboard before the study (28–106) |
| `smartphone_swipe_use` | never (7), sometimes (9), daily (8) |
| `first_language_english` | yes (15), no (9) |
| `wears_glasses` | yes (9), no (15) |
| `handedness` | right (21), left (3) |
| `age_band` | 18-24 (7), 25-34 (9), 35-44 (5), 45+ (3) |
| `arm_length_cm` | Shoulder to fingertip (62–79) |

**Invented ground truth.** The background drives the invented outcomes, so person-level forecasts have something to find. The effects are moderate and come with noise:

- **Desktop typing speed** makes people faster with the raycast and split keyboards (correlation with entry speed .70 and .75), a little with the drum keyboard (.22), and hardly with swipe.
- **Daily swipe users** are much faster with the swipe keyboard: 18.5 WPM, against 13.0 for people who swipe sometimes and 10.2 for those who never do. They also leave fewer errors with it (0.024 against 0.035 and 0.076) and report less workload with it.
- **Longer arms** mean less strain with the drum keyboard, whose keys sit at a fixed place: higher arm and shoulder comfort (correlation .57) and a lower physical-demand item.
- **First language** other than English slows people by 5% on every keyboard and adds word substitutions with swipe. The slowdown is smaller than the other differences between people, so it hardly shows in this sample.
- **Age band, glasses and handedness** have no effect.
- **Position:** a small learning effect follows each keyboard's position in a person's order.

Averages over the 24 people:

| Measure | Raycast | Drum | Swipe | Split |
| --- | ---: | ---: | ---: | ---: |
| Entry speed (WPM) | 14.0 | 14.6 | 14.0 | 8.0 |
| Uncorrected error rate | 0.013 | 0.018 | 0.043 | 0.007 |
| Entry time per phrase (s, geometric mean) | 23.9 | 22.9 | 24.4 | 42.0 |
| Workload (raw TLX, 0–100) | 43.4 | 52.1 | 51.3 | 54.3 |
| Arm and shoulder comfort (1–7) | 4.63 | 3.21 | 4.54 | 5.63 |
| Preference (mean rank, 1 = first) | 1.83 | 2.88 | 2.54 | 2.75 |

**Not every difference is significant.** These are paired Wilcoxon tests, Holm-adjusted within each measure, α = .05:

- Entry speed and entry time differ only between split and the other three keyboards; raycast, drum and swipe do not differ.
- Workload differs for raycast against drum and against split only.
- Comfort differs for every pair except raycast and swipe.
- No pair of preference ranks differs.
- All six error-rate pairs differ.

The swipe keyboard's mean speed matches the raycast keyboard's while its spread between people is large. A forecast of the population means alone misses that spread, and the individual configurations can find it.

## Agent configurations

All configurations use Claude Code, model `claude-opus-5-5` with default effort, except the model arm. Each one has a token budget (100,000–200,000) and no runtime.

| Configuration | Level | The agent gets | The single ingredient it adds |
| --- | --- | --- | --- |
| Text only (`text-only`) | population | The brief | Baseline |
| Text + background note on text entry (`reads-evidence`) | population | Brief + evidence note | The evidence note, added to Text only |
| Text + the cohort's background (`knows-cohort`) | population | Brief + a summary of the cohort's background (counts and means) | The cohort's background, added to Text only |
| Text + participant background (`knows-participant`) | individual | Brief + that person's own background | The person's background, added to Text only (one forecast per person) |
| Text + participant background + note (`knows-participant-evidence`) | individual | Brief + the person's background + evidence note | The evidence note, added to Text + participant background |
| Text only — claude-sonnet-5-5 (`text-only-sonnet`) | population | The brief | A model arm: Text only on `claude-sonnet-5-5` (a comparison of models, not methods) |

**Planned comparisons** (`comparisons.json`, also stored with the study). Each pair is at one level and differs in one ingredient, with the same model:

1. Evidence note − Text only, objective measures.
2. Cohort background − Text only, objective measures.
3. Participant background + note − participant background (individual), subjective measures.

The model arm is for **Compare agents** and for an analysis-time comparison with Text only. Population against individual forecasts (`knows-cohort` against `knows-participant`) is the **Population vs individual** view, not a comparison.

At 1 run per participant (the default), the population configurations get 24 runs each, so every order is used as often as the humans used it. The individual configurations get one session per person. That makes 4 × 24 + 2 × 24 = 144 sessions. To save usage, type 4, 8 or 12 in a population configuration's **Runs** box; those numbers still use each of the four orders equally often.

## Running it

1. **Check:** `node dist/cli.js study-check examples/text-entry/study.json --agents examples/text-entry/agents.json --human examples/text-entry/human.json` reports "Study is valid."
2. **Start the website:** run `npm start` and open http://127.0.0.1:4317/?study=examples%2Ftext-entry (or the port of `XR_STUDY_PORT`).
3. **Agent configurations:** review the configurations, then **Approve study and configurations**. The **Give as input** column is disabled: forecasts are made before the study.
4. **Freeze & campaigns:** **Freeze campaign**.
5. **Run agents:**
   - **Simulate** fills every session with invented forecasts in about a minute, to try the pipeline.
   - **Run agents** starts real Claude Code sessions. They need no app or bridge. Each session reads its injected sources and submits. Try one session first with **Run this session only**.
   - If `claude-sonnet-5-5` is not available to your Claude Code, change the model arm's model on Agent configurations, or remove the arm.
6. **Compare agents**, then **Compare with humans:** **Analyze campaign**. The views are Agreement, Agent vs human (for example Entry speed), Correlation, Population vs individual, and Participants (participant lines for the two individual configurations).

Simulated runs and invented participants show how the method behaves, not how good agents are.
