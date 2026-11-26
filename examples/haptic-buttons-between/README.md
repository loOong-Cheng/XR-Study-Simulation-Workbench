# Suite 6: haptic feedback for mid-air buttons, between subjects (synthetic)

A synthetic **between-subjects** study: 36 invented people type 4-digit codes on a keypad floating in mid-air in VR, each with **one** of three kinds of button feedback (12 people per design). It is the workbench's example of a between-subjects study. **All participants and their data are invented.**

There is **no study app** in this suite: the keypad is described in the brief, and every configuration is app-free (`runtime: none`), so they all run with Claude Code right away.

## What a between-subjects suite shows

Each person experienced one design, so the designs are compared as **independent groups** (see `docs/methodology.md`, "Within- and between-subjects studies"):

- **Group differences.** For every pair of designs and every measure, the analyzer tests the two human groups with a Mann–Whitney U test (on the log scale for the geometric code entry time), Holm-adjusted over the three design pairs of each measure, α = .05. Agents are scored only on the pairs where the human groups differ significantly; the other pairs are listed with their p-values and not scored. A measure without any significant pair is excluded for every configuration.
- **Absolute values.** For every configuration, measure and design, the analyzer reports whether the mean forecast lies inside the human group's 95% t interval (clipped to the measure's declared range) and the signed error. Between subjects, these group values are what the study compares.
- **The bootstrap** resamples whole people within their group (the strata `group-visual`, `group-buzz`, `group-pulse`).

**Why there are no rankings and no individual configurations.** Nobody saw more than one design, so nobody can rank them: study validation refuses `"scale": "rank"` in a between-subjects study, and this suite measures a rating per design instead. Individual configurations are refused too: an individual forecast is scored by how it orders the designs within one person, and one design per person leaves nothing to order. All four configurations are therefore population configurations.

**Sample size.** With 12 people per group, the smallest exact two-sided Mann–Whitney p is 2 / C(24, 12) ≈ 7 × 10⁻⁷, far below what Holm needs, so `study-check` gives no small-sample warning. (With two people per group, no pair could reach significance.)

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | 3 designs, 5 measures (with ranges), 36 participants (p01–p36), each with a single-design order, sources |
| `agents.json` | 4 population configurations (below) |
| `human.json` | Invented human reference, written by `data/convert_to_human.py` (36 people × 5 measures, each for the person's own design) |
| `data/generate_synthetic.py`, `data/raw/` | Invented raw data: assignment, background, every typed code, questionnaires |
| `agent-brief.md` | What every agent is told: keypad, task, designs, procedure, measures; no results |
| `evidence/tactile-feedback-note.md` | A short, neutral, invented note on tactile feedback; written without the data (leak check: no participant IDs, no number equal to a group mean, no sentence flagged as a prediction) |
| `comparisons.json` | Two planned comparisons between configurations |
| `workspace.json` | Title, suite name and where each source lives |
| `starter/` | The starter campaign: this suite frozen at 1 run per participant (`starter.json` lists its sessions), installed into `campaigns/` the first time the study opens without a campaign; rebuilt with `npm run starters` ([testing with the example suites](../../docs/testing-with-example-suites.md)) |
| `webxr/` | **Suite 6-w**: this study with a WebXR keypad app, a study of its own (see the end of this page) |

To regenerate the data: `python3 data/generate_synthetic.py && python3 data/convert_to_human.py`. Both are seeded and write UTF-8 with LF line ends, so rerunning reproduces the committed files byte for byte.

About this dataset: apparatus, stimuli, what every data column means: [`data/README.md`](data/README.md).

## Participants and their background

Before the task, every person answered a short background questionnaire (`data/raw/background.csv`, complete for all 36):

| Field | Values |
| --- | --- |
| `age` | years (19–46 here) |
| `vr_experience` | none, occasional, regular |
| `prior_haptic_devices` | none, controller rumble, haptic gloves |
| `motion_sickness_susceptibility` | low, medium, high (banded score of a short susceptibility questionnaire) |
| `dominant_hand` | right, left |

People were assigned in order of arrival in permuted blocks of three (each block covers every design once). VR experience and prior haptic devices are stratified: each group has a fixed number of people per combination of the two, so the groups are roughly balanced but not identical. Age, susceptibility and dominant hand are drawn at random.

| Group | n | Age (mean) | VR experience none / occasional / regular | Haptic devices none / rumble / gloves | Susceptibility low / medium / high | Left-handed |
| --- | --- | --- | --- | --- | --- | --- |
| Visual only | 12 | 31.2 | 4 / 5 / 3 | 4 / 5 / 3 | 7 / 3 / 2 | 1 |
| Buzz | 12 | 32.3 | 5 / 4 / 3 | 5 / 5 / 2 | 5 / 6 / 1 | 0 |
| Pulse | 12 | 34.0 | 4 / 4 / 4 | 3 / 6 / 3 | 8 / 3 / 1 | 1 |

*Text + cohort background* receives a summary of these fields over all 36 people (counts and means), never anyone's answers and not split by group.

## The invented effects (ground truth)

The generator's effects, none of them a real finding:

- **Feedback design.** Both vibration designs speed up code entry and raise presence compared with visual feedback only; the patterned pulse also halves wrong presses. Workload and comfort barely depend on the design.
- **VR experience.** Regular users are faster and make fewer wrong presses; newcomers are slower, make more and report more workload. Regular users rate presence a little lower.
- **Age.** About 0.7 % slower per year above 30.
- **Haptic gloves × pulse.** People who have used haptic gloves profit more from the patterned pulse (faster, fewer wrong presses, higher presence) and not from the buzz.
- **Motion-sickness susceptibility** lowers comfort (strongly when high) and slightly raises workload. In this sample the effect shows for the four highly susceptible people, not between low and medium.
- **Dominant hand** has no effect (the keypad and the ring follow the dominant hand), so a forecast that leans on it leans on nothing.

The effect sizes were chosen, before looking at the test results, so that with 12 people per group some group differences reach significance and some do not. Group means of the invented data (code entry time: geometric mean):

| Measure | Visual only | Buzz | Pulse |
| --- | ---: | ---: | ---: |
| Code entry time (s per code) | 6.12 | 5.01 | 4.51 |
| Error rate (of digit presses) | 0.136 | 0.083 | 0.041 |
| Presence (1–7) | 3.08 | 4.58 | 4.92 |
| Perceived workload (Raw TLX, 0–100) | 44.6 | 41.9 | 36.5 |
| Comfort (1–7) | 4.83 | 5.00 | 4.67 |

Group differences as the analyzer tests them (Mann–Whitney U, Holm within each measure):

| Measure | Visual – buzz | Visual – pulse | Buzz – pulse | Scored pairs |
| --- | --- | --- | --- | --- |
| Code entry time | **p = .014** | **p = .014** | p = .44 | 2 |
| Error rate | p = .078 | **p < .001** | p = .078 | 1 |
| Presence | **p = .002** | **p = .001** | p = .43 | 2 |
| Perceived workload | p = .58 | p = .24 | p = .31 | 0: excluded |
| Comfort | p = 1 | p = 1 | p = 1 | 0: excluded |

So agents are scored on 5 of the 15 design pairs. Workload and comfort have no significant pair and drop out of the agreement scores for every configuration; their absolute values are still compared with each group's 95% interval. The two buzz–pulse differences in time and presence are not significant although the means differ: nonsignificance is not equivalence, and agents are neither rewarded nor penalised for them.

## Agent configurations

All four are population configurations with the same model (`claude-opus-5-5`, effort default) and the same budgets (5 tool calls, 32,000 output tokens, 150,000 tokens per session). Each adds one ingredient to *Text only*, and its description names it. Everything an agent gets is placed in its prompt; nothing needs the app.

| Configuration | The agent gets | Predicts |
| --- | --- | --- |
| Text only (`text-only`) | The brief | All five measures |
| Text + evidence note (`reads-evidence`) | Brief + the evidence note | All five measures |
| Text + cohort background (`knows-cohort`) | Brief + a summary of the 36 people's background | All five measures |
| Text + measured task data (`measured-inputs`) | Brief + each group's measured code entry time and error rate (attached by the framework from `human.json`) | Presence, workload, comfort (after the experience) |

Planned comparisons (`comparisons.json`): *Text + evidence note* − *Text only* on the objective measures, and *Text + measured task data* − *Text only* on the subjective measures.

At 1 run per participant, each population configuration gets 36 runs: 4 × 36 = 144 sessions. To try a few first, type fewer runs in a configuration's Runs box, or use **Choose sessions to run** in the executor.

## Running it

```bash
node dist/cli.js study-check examples/haptic-buttons-between/study.json \
  --agents examples/haptic-buttons-between/agents.json --human examples/haptic-buttons-between/human.json
npm start      # then open the study: ?study=examples%2Fhaptic-buttons-between
```

1. **Study & variables**, **Agent configurations:** review, then **Approve study and configurations**.
2. **Freeze & campaigns:** **Freeze campaign**.
3. **Run agents:** Mode *Simulate* tries the pipeline at no cost; Mode *Run agents* starts real Claude Code sessions (no app, Chrome or engine needed).
4. **Compare with humans:** **Show human data** shows the groups with their Mann–Whitney brackets; **Analyze campaign** shows the significant pairs, the scores on them, and each configuration's absolute values against the groups' 95% intervals.

Simulated runs and invented participants show how the method behaves, not how good agents are.

## Suite 6-w: the same study with a WebXR app

[`webxr/`](webxr/README.md) holds **suite 6-w**: this study (the same designs, participants, synthetic data and configurations) with suite 5-w's keypad app in a code-entry task, driven by declared key actions (`press-key`, `confirm-code`), and *Uses the app*. It runs with Claude Code and the built-in WebXR runtime in Chrome. It is a study of its own (ID `examples/haptic-buttons-between/webxr`, with its own campaigns, runs and starter) that sits inside this folder; this study's sources never include it, and this suite's configurations stay app-free.
