# About this dataset

**Every participant and every value in this folder is invented.** `generate_synthetic.py` draws them with a fixed seed (`SEED = 20261125`), and `convert_to_human.py` turns them into `../human.json`. To regenerate, run `python3 data/generate_synthetic.py && python3 data/convert_to_human.py` from the suite folder; the rerun reproduces the committed files byte for byte. The apparatus, the stimulus parameters and the recording procedures below are invented too. They describe the study the data pretend to come from, so that every column has a defined meaning. Nobody was measured and no vibration was ever played.

## Apparatus and stimuli

**Headset and hand tracking.** A standalone VR headset tracks the bare hands with its cameras. The study app reads the tracked index fingertip once per displayed frame, at 90 Hz (every 11 ms), and logs every key event with the frame's time stamp. The tracked fingertip lags the real one by a few tens of milliseconds; that lag is the same in all three designs.

**Keypad.** A phone-style keypad (1–9, then Delete, 0 and a blank key) floats at chest height, about 40 cm in front of the participant, tilted 15° towards them. Keys are 3 cm squares with 1 cm gaps. A key activates when the tracked fingertip crosses its activation plane, 1 cm behind the key face. It can activate again only after the fingertip has moved back in front of the face. The blank key does nothing and is not logged. Delete gives the same feedback as a digit key in every design. Participants see their tracked hand as a plain grey hand model. There is no sound.

**Actuator.** A coin-type linear resonant actuator (LRA), 10 mm across and 3 mm thick, sits on the pad of the right index finger, over a thin silicone pad, held by a 12 mm elastic hook-and-loop strap. Its cable runs along the back of the hand to a driver board and battery in a wristband, which take commands from the headset over Bluetooth Low Energy. The actuator is worn in all three designs, so the hand looks and feels the same to the participant and to the tracker; with visual feedback only it stays silent.

| Parameter | Value (invented) |
| --- | --- |
| Drive | Sine at the actuator's resonant frequency, 175 Hz, kept on resonance by the driver |
| Full drive (100 %) | About 1.5 g (15 m/s²) peak acceleration at the skin, measured once with a small accelerometer on a fingertip model |
| Rise and fall | Overdrive at the start and active braking at the end: full amplitude within about 4 ms, still within about 4 ms after the burst ends |
| Latency | 18 ms on average (12–26 ms) from the tracking frame that triggers a vibration to the start of the vibration at the skin (app and radio link about 13 ms, actuator start about 5 ms) |
| Visual latency, for comparison | The key changes on the next displayed frame, within 11 ms of the triggering frame |

**Visual feedback (the same in all three designs).** At rest a key face is mid-grey with a dark digit. At activation, on the next displayed frame, the face turns a bright light blue (about three times as bright) and moves 3 mm back over 30 ms. The digit appears on the panel above the keypad in the same frame. The highlight holds for 200 ms and fades back to grey over 100 ms. The face returns to rest over 50 ms once the fingertip is back in front of it. Nothing changes when the fingertip only touches the face.

**Vibrotactile buzz.** One 20 ms burst at full drive (about 1.5 g), starting about 18 ms after the activation frame. Nothing at touch and nothing while the finger moves back out.

**Patterned pulse.**

- *Approach ticks.* From the frame in which the fingertip touches a key face (any key, the intended one or not) until it reaches the activation plane: ticks of 8 ms at 30 % of full drive (about 0.45 g). The interval from one tick's start to the next shrinks linearly with depth: 120 ms at the face (0 mm), 120 − 10 × depth (mm) ms in between, 30 ms from 9 mm until the plane at 10 mm. The app checks this every tracking frame: a tick starts as soon as the time since the last tick reaches the interval for the current depth. A fingertip that crosses the 10 mm in 125 ms gets three ticks; one that takes 250 ms gets five. If the fingertip leaves the key before the plane, the ticks stop.
- *Activation double pulse.* At activation any tick in progress is cut off and two 15 ms bursts at full drive (about 1.5 g) play, 25 ms apart: burst, pause, burst, 55 ms in all.
- Nothing vibrates while the fingertip is past the plane or moving back out. The next press starts again with a tick when the fingertip touches a key face.

The double pulse and the buzz reach the same peak amplitude; the ticks are weaker and shorter.

**One press in each design.** The fingertip touches the key face at t = 0, moves in at 8 cm/s, crosses the plane at 125 ms, stops 9 mm past it at about 350 ms and is back in front of the face at about 560 ms. Times are for the tracked fingertip; ticks start on the next tracking frame, so real times differ by up to 11 ms.

```text
Visual feedback only
  t (ms)   tracked fingertip                 seen                                       felt
     0     touches the key face              –                                          –
   125     crosses the activation plane      –                                          –
   136                                       key lights up, face starts 3 mm back;      –
                                             digit appears on the panel
   166                                       face 3 mm back
   336                                       highlight starts to fade (100 ms)
   350     deepest point, 9 mm past plane
   560     back in front of the face         face returns to rest (50 ms)               –
```

```text
Vibrotactile buzz
  t (ms)   tracked fingertip                 seen                                       felt
     0     touches the key face              –                                          –
   125     crosses the activation plane      –
   136                                       key lights up, face starts 3 mm back;
                                             digit appears on the panel
   143                                                                                  burst, 20 ms, full drive
   163                                                                                  vibration ends
   336                                       highlight starts to fade (100 ms)
   350     deepest point, 9 mm past plane
   560     back in front of the face         face returns to rest (50 ms)               –
```

```text
Patterned pulse
  t (ms)   tracked fingertip                 seen                                       felt
     0     touches the key face              –
    18                                                                                  tick 1, 8 ms, 30 %
    67     5.3 mm into the key (tick due)
    85                                                                                  tick 2, 8 ms, 30 %
   104     8.3 mm into the key (tick due)
   122                                                                                  tick 3, 8 ms, 30 %
   125     crosses the activation plane      –
   136                                       key lights up, face starts 3 mm back;
                                             digit appears on the panel
   143                                                                                  burst 1, 15 ms, full drive
   158                                                                                  pause, 25 ms
   183                                                                                  burst 2, 15 ms, full drive
   198                                                                                  vibration ends
   336                                       highlight starts to fade (100 ms)
   350     deepest point, 9 mm past plane
   560     back in front of the face         face returns to rest (50 ms)               –
```

**What agents get.** Agents can only read about the feedback. Every configuration gets the brief, whose paragraph "The feedback in detail" gives the main parameters above. No configuration can feel a vibration or see the keypad: there is no app in this suite.

## Participants and how their information was recorded

18 invented adults, P01–P18. Before the headset went on, each answered a short background questionnaire on a tablet, and the experimenter took two measurements of the right hand.

**Background** (`raw/demographics.csv`, source `demographics`; individual configurations get the person's row, population configurations a cohort summary):

| Field | Meaning, unit or categories | How it was recorded |
| --- | --- | --- |
| `age` | Age in whole years (19–54 here) | Self-report |
| `handedness` | `right`, `left` or `ambidextrous` | A four-item handedness questionnaire in the style of the short Edinburgh Handedness Inventory (writing, throwing, toothbrush, spoon; each always left, usually left, both, usually right, always right). The answers give a laterality quotient from −100 to +100: right from +61, left up to −61, ambidextrous in between. Everyone pressed with the right index finger, whatever their handedness. |
| `hand_length_cm` | Length of the right hand in cm, to 0.1 cm (16.0–20.3 here) | Measured by the experimenter with a ruler: palm flat on the table, fingers together, from the most distal wrist crease to the tip of the middle finger |
| `tactile_sensitivity_2pd_mm` | Static two-point discrimination threshold at the pad of the right index finger (where the actuator sits), in mm, to 0.1 mm (1.4–4.7 here). Larger = the person needs two touches further apart to feel them as two, i.e. coarser spatial acuity, less sensitive | Measured by the experimenter with a two-point discriminator (blunt tips, 0.5 mm steps), the participant's eyes closed, touching just hard enough to blanch the skin. Method of limits: three ascending and three descending series, each ending when the answer ("one" or "two") changes. The threshold is the mean of the six separations at which it changed. |
| `gaming_hours_per_week` | Hours of video games in a typical week, whole hours (0–16 here) | Self-report: "In a typical week, how many hours do you play video games (any device)?" |
| `vr_experience` | `none`: never used a VR headset, or only a short demo; `occasional`: has used VR several times, but less than once a month over the past year; `regular`: at least once a month over the past year | Self-report, one of the three |

**Practice movement** (`raw/movement_practice.csv`, source `trajectory`; individual configurations only, and only practice rows are ever delivered). One row per practice sequence (three per design), computed by the study app from the tracked index fingertip, read every frame (90 Hz):

| Field | Meaning, unit | How it was recorded |
| --- | --- | --- |
| `design` | `visual`, `buzz` or `pulse` | The design of that block |
| `phase` | Always `practice` | The practice sequences are the first three of each block |
| `trial` | 1–3, the practice sequence | Counted by the app |
| `path_length_cm` | Distance travelled by the tracked index fingertip while typing the sequence, in cm, to 0.1 cm | Sum of the distances between successive tracked fingertip positions, from the sequence appearing to its last correct digit |
| `mean_speed_cm_s` | Average fingertip speed while typing, in cm/s, to 0.1 | `path_length_cm` / (the sequence's seconds − 1 s). The first second after a sequence appears is taken as reading time and left out (at least 1 s remains). |
| `overshoot_mm` | Mean overshoot of the sequence's digit presses, in mm, to 0.1 mm | As `overshoot_mm` in `trials.csv` (below); the same value as that sequence's practice row there |

In the generator the path is built from the presses (in and out of each key from about 3 cm in front of the face, plus the overshoot, and about 4.5 cm across the keypad between presses), and the practice rows come from the same person and design as the scored rows, with a first-contact slowdown.

## Data files

**`raw/participants.csv`**: one row per participant.

| Column | Values | Meaning |
| --- | --- | --- |
| `participant` | P01–P18 | Participant ID |
| `order` | Three design IDs, space-separated | The order of the three blocks: a balanced Latin square, all six orders, three people each (`ORDERS[i % 6]` in the generator). Must match `conditionOrder` in `../study.json`. |

**`raw/demographics.csv`** and **`raw/movement_practice.csv`**: see the tables above.

**`raw/trials.csv`**: one row per typed sequence, practice and scored: 18 people × 3 designs × (3 + 10) = 702 rows. Logged by the study app.

| Column | Unit or values | Meaning and how it was recorded |
| --- | --- | --- |
| `participant` | P01–P18 | |
| `design` | `visual`, `buzz`, `pulse` | |
| `position` | 1–3 | The block's place in the person's order |
| `phase` | `practice` or `main` | Practice (sequences 1–3, never scored) or scored (sequences 1–10) |
| `sequence` | 1–3 (practice) or 1–10 (main) | Sequence number within the phase. Every sequence is new; the digits themselves are not kept in this file. |
| `seconds` | s, two decimals | From the frame in which the sequence appears on the panel to the activation of its last correct digit. Wrong presses, the Delete presses and the retyping are part of the time. No time limit (2.3–9.3 s here). |
| `digit_presses` | count (4–6 here) | Activations of digit keys in the sequence, wrong ones included: 4 when nothing went wrong. Delete presses are not counted. |
| `wrong_presses` | count (0–2 here) | Digit activations that were not the next digit of the sequence: a wrong key, or an unintended second activation of the same key (unless the next digit is the same). Each was deleted and typed again, so `digit_presses` = 4 + `wrong_presses` here. |
| `overshoot_mm` | mm, to 0.1 | Mean overshoot over the sequence's digit presses. A press's overshoot is the deepest point the tracked fingertip reached past the activation plane, measured along the key's normal, between the activation and the frame in which the fingertip starts moving back out. |

**`raw/questionnaire.csv`**: one row per participant and design (54 rows), answered on a tablet with the headset off, right after the block's ten scored sequences and before the break.

| Column | Scale | Item |
| --- | --- | --- |
| `confidence` | 1–7 | "I was confident that each press registered" (1 = not at all, 7 = completely) |
| `tlx_mental`, `tlx_physical`, `tlx_temporal`, `tlx_effort`, `tlx_frustration` | 0–100 in steps of 5 | Raw NASA-TLX items (mental, physical and temporal demand, effort, frustration), each marked on a 21-step line from low to high |
| `tlx_performance` | 0–100 in steps of 5 | Raw NASA-TLX performance, 0 = perfect, 100 = failure, so a higher mark is worse, like the other items |
| `presence` | 1–7 | "I felt the buttons were really there" (1 = not at all, 7 = completely) |

**`raw/rankings.csv`**: one row per participant and design (54 rows). After the third block's questionnaire the experimenter named the three designs in the order the person had used them, and the person ranked them on the tablet.

| Column | Values | Meaning |
| --- | --- | --- |
| `preference_rank` | 1–3, no ties | Overall preference, 1 = best |

## From raw data to the measures in human.json

`convert_to_human.py` writes one record per participant × design × measure (18 × 3 × 7 = 378). Only rows with `phase` = `main` are scored; practice rows and `movement_practice.csv` never enter `human.json`.

| Measure (`study.json`) | Computation |
| --- | --- |
| `completion-time` | Geometric mean of `seconds` over the ten scored sequences: exp(mean(ln `seconds`)) |
| `error-rate` | Sum of `wrong_presses` / sum of `digit_presses` over the ten scored sequences |
| `overshoot` | Mean over all digit presses of the ten scored sequences: sum(`overshoot_mm` × `digit_presses`) / sum(`digit_presses`), so each sequence counts by its number of presses |
| `confidence` | `confidence` as given |
| `workload` | The six `tlx_*` items as components (`mental`, `physical`, `temporal`, `performance`, `effort`, `frustration`); `study.json` declares `"componentRule": "mean"`, so the workbench scores their unweighted mean (0–100) |
| `presence` | `presence` as given |
| `preference` | `preference_rank` as given |

## What the invented effects are

How the background and the designs drive these numbers, and the design averages that result, are in [`../README.md`](../README.md), section "The invented effects (ground truth)".
