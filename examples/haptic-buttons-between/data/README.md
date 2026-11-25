# About this dataset

**Every participant and every value in this folder is invented.** `generate_synthetic.py` draws them with a fixed seed (`random.Random(20261125)`), and `convert_to_human.py` turns them into `../human.json`. To regenerate, run `python3 data/generate_synthetic.py && python3 data/convert_to_human.py` from the suite folder; the rerun reproduces the committed files byte for byte. The apparatus, the stimulus parameters and the recording procedures below are invented too. They describe the study the data pretend to come from, so that every column has a defined meaning. Nobody was measured and no vibration was ever played.

## Apparatus and stimuli

**Headset and hand tracking.** A Meta Quest 3 with hand tracking, no controllers. The study app runs at 90 Hz and reads the tracked index fingertip once per displayed frame (every 11 ms). It logs every key event with the frame's time stamp. The tracked fingertip lags the real one by a few tens of milliseconds; that lag is the same in all three designs.

**Keypad.** Twelve keys in a 3 × 4 grid (1–9, then Delete, 0 and Enter) float at chest height, about 40 cm in front of the participant, tilted 15° towards them. Keys are 4 cm squares with 1 cm gaps. Participants type with the index finger of the dominant hand, the one that wears the ring.

- A key is touched when the tracked fingertip reaches its resting surface. From then on the key moves in with the fingertip.
- At 1.5 cm depth the key registers and stops moving; the finger can go on through it.
- On the way out the key follows the fingertip back to rest. The fingertip leaves the key when it is back at the resting surface.
- A key registers once per press. To register it again, the fingertip has to leave it and press again.
- Delete and Enter give the same feedback as the digit keys. Delete removes the last digit; Enter submits the code.

A panel above the keypad shows the code and the digits typed so far. The room is plain and evenly lit, and there is no sound.

**The ring.** A 3D-printed open ring (three sizes, chosen for a snug fit) is worn on the outermost segment of the dominant index finger, just behind the fingertip. It holds a coin-type linear resonant actuator (LRA), 8 mm across, against the finger pad. A small driver board and battery in a wrist pod take commands from the headset over Bluetooth Low Energy. Everyone wears the ring in every design, so the equipment is the same for all; with visual feedback only it stays off.

| Parameter | Value (invented) |
| --- | --- |
| Drive | Sine at the actuator's resonant frequency, 190 Hz, kept on resonance by the driver |
| Full drive (100 %) | About 1.2 g (12 m/s²) peak acceleration at the skin, measured once with a small accelerometer on a fingertip model |
| Rise and fall | Overdrive at the start and active braking at the end: full amplitude within about 4 ms, still within about 4 ms after the burst ends |
| Latency | 20 ms on average (14–28 ms) from the tracking frame that triggers a vibration to the start of the vibration at the skin (app and radio link about 15 ms, actuator start about 5 ms) |
| Visual latency, for comparison | A key changes on the next displayed frame, within 11 ms of the triggering frame |

**Visual feedback (the same in all three designs).** At rest a key is mid-grey with a white digit. On touch it turns light blue on the next displayed frame and moves in with the fingertip. When it registers it turns dark blue, the darker shade, and the digit appears on the panel. It stays dark blue until the fingertip leaves; then it springs back to rest over 50 ms and turns grey again.

**Vibrotactile buzz.** One 20 ms burst at full drive (about 1.2 g), starting about 20 ms after the registration frame. Nothing on touch and nothing when the finger leaves the key.

**Patterned pulse.** Three parts per press, each starting about 20 ms after the frame that triggers it:

| Event | Vibration |
| --- | --- |
| Touch: the fingertip reaches the key's resting surface | Faint tick: one 10 ms burst at 35 % of full drive (about 0.4 g) |
| Registration at 1.5 cm depth | Double pulse: a 15 ms burst at full drive, a 25 ms pause, another 15 ms burst at full drive (55 ms in all) |
| Release: the fingertip leaves the key | Faint tick: one 10 ms burst at 35 % of full drive |

The double pulse and the buzz reach the same peak amplitude; the ticks are weaker and shorter.

**One press in each design.** The fingertip touches the key at t = 0 and pushes it in at 8 cm/s. The key registers at 1.5 cm depth at about 190 ms. The fingertip goes 0.7 cm deeper (about 330 ms) and leaves the key at about 600 ms. Times are for the tracked fingertip.

```text
Visual feedback only (the ring stays off)
  t (ms)   tracked fingertip                    seen                                     felt
     0     touches the key                      –                                        –
    11                                          key turns light blue, moves in with
                                                the fingertip
   190     key at 1.5 cm depth: registers       key stops moving                         –
   201                                          key turns dark blue; digit appears
   330     deepest point, 2.2 cm
   600     leaves the key                       –                                        –
   611                                          key springs back (50 ms), turns grey
```

```text
Vibrotactile buzz
  t (ms)   tracked fingertip                    seen                                     felt
     0     touches the key                      –                                        –
    11                                          key turns light blue, moves in
   190     key at 1.5 cm depth: registers       key stops moving
   201                                          key turns dark blue; digit appears
   210                                                                                   burst, 20 ms, full drive
   230                                                                                   vibration ends
   330     deepest point, 2.2 cm
   600     leaves the key                       –                                        –
   611                                          key springs back (50 ms), turns grey
```

```text
Patterned pulse
  t (ms)   tracked fingertip                    seen                                     felt
     0     touches the key                      –
    11                                          key turns light blue, moves in
    20                                                                                   touch tick, 10 ms, 35 %
   190     key at 1.5 cm depth: registers       key stops moving
   201                                          key turns dark blue; digit appears
   210                                                                                   burst 1, 15 ms, full drive
   225                                                                                   pause, 25 ms
   250                                                                                   burst 2, 15 ms, full drive
   265                                                                                   vibration ends
   330     deepest point, 2.2 cm
   600     leaves the key
   611                                          key springs back (50 ms), turns grey
   620                                                                                   release tick, 10 ms, 35 %
```

**What agents get.** Agents can only read about the feedback. Every configuration gets the brief, whose paragraph "The feedback in detail" gives the main parameters above. No configuration can feel a vibration or see the keypad: there is no app in this suite.

## Participants and how their information was recorded

36 invented adults, p01–p36, each using one design. Before putting on the headset and the ring, each answered a short background questionnaire on a tablet (`raw/background.csv`, source `demographics`; the population configuration *Text + cohort background* gets a summary over all 36 people, never anyone's row).

| Field | Meaning, unit or categories | How it was recorded |
| --- | --- | --- |
| `age` | Age in whole years (19–46 here) | Self-report |
| `vr_experience` | `none`: never used a VR headset, or only a short demo; `occasional`: has used VR several times, but less than once a month over the past year; `regular`: at least once a month over the past year | Self-report, one of the three |
| `prior_haptic_devices` | The most advanced haptic device the person has used: `none` (nothing beyond a phone's vibration), `controller rumble` (vibrating game or VR controllers), `haptic gloves` (has worn vibrotactile or force-feedback gloves, for example in a lab or at a demo) | Self-report: a checklist of device types; the most advanced one ticked is kept |
| `motion_sickness_susceptibility` | `low`, `medium` or `high` | A six-item questionnaire in the style of the short Motion Sickness Susceptibility Questionnaire: how often the person has felt sick in cars, buses or coaches, boats, fairground rides, video games and VR (0 = never, 1 = rarely, 2 = sometimes, 3 = often; items never experienced are left out and the sum is scaled to six items). The sum runs from 0 to 18: low 0–4, medium 5–9, high 10–18. Only the band is kept. |
| `dominant_hand` | `right` or `left` | Self-report: the hand the person writes with. The ring goes on this hand's index finger, and the person types with it. |

How the three groups were filled: in order of arrival, in permuted blocks of three (each block of three consecutive people covers every design once), with a fixed number of places per combination of VR experience and prior haptic devices in each group. The group profiles are in [`../README.md`](../README.md), "Participants and their background".

## Data files

**`raw/participants.csv`**: one row per participant.

| Column | Values | Meaning |
| --- | --- | --- |
| `participant` | p01–p36 | Participant ID, in order of arrival |
| `design` | `visual`, `buzz` or `pulse` | The one design this person used. Must match the participant's `conditionOrder` in `../study.json`. |

**`raw/background.csv`**: see the table above.

**`raw/trials.csv`**: one row per typed code, practice and scored: 36 people × (2 + 12) = 504 rows. Logged by the study app.

| Column | Unit or values | Meaning and how it was recorded |
| --- | --- | --- |
| `participant` | p01–p36 | |
| `design` | `visual`, `buzz`, `pulse` | The person's design |
| `block` | `practice` or `scored` | Two practice codes (never scored), then twelve scored codes |
| `code_index` | 1–2 (practice) or 1–12 (scored) | The code's number within its block |
| `code` | Four digits, 0–9 | The code shown on the panel. Digits may repeat and the code may start with 0; read the column as text to keep a leading zero. |
| `seconds` | s, two decimals | From the frame in which the code appears to the registration of Enter. Wrong presses, Delete and the retyping are part of the time. No time limit (2.2–15.8 s here). |
| `digit_presses` | count (4–8 here) | Registrations of digit keys in the code, wrong ones included: 4 when nothing went wrong. Delete and Enter are not counted. |
| `wrong_presses` | count (0–4 here) | Digit registrations that were not the next digit of the code: a wrong key, or one key registered twice (unless the next digit is the same). In this data every wrong digit was deleted and typed again before Enter, so `digit_presses` = 4 + `wrong_presses` and every code was submitted correct. |

**`raw/questionnaire.csv`**: one row per participant (36 rows), answered on a tablet with the headset off, right after the twelve scored codes.

| Column | Scale | Item |
| --- | --- | --- |
| `presence` | 1–7 | "The keypad felt as if it were really there in front of me" (1 = not at all, 7 = completely) |
| `mental`, `physical`, `temporal`, `effort`, `frustration` | 0–100 in steps of 5 | Raw NASA-TLX items (mental, physical and temporal demand, effort, frustration), each marked on a 21-step line from low to high |
| `performance` | 0–100 in steps of 5 | Raw NASA-TLX performance, 0 = perfect, 100 = failure, so a higher mark is worse, like the other items |
| `comfort` | 1–7 | "How comfortable was typing on the keypad?" (1 = very uncomfortable, 7 = very comfortable) |

There is no ranking: nobody used more than one design.

## From raw data to the measures in human.json

`convert_to_human.py` writes one record per participant × measure, for the participant's own design (36 × 5 = 180). Only rows with `block` = `scored` are scored. The converter checks that every participant's design matches `../study.json`.

| Measure (`study.json`) | Computation |
| --- | --- |
| `completion-time` (code entry time) | Geometric mean of `seconds` over the twelve scored codes: exp(mean(ln `seconds`)) |
| `error-rate` | Sum of `wrong_presses` / sum of `digit_presses` over the twelve scored codes |
| `presence` | `presence` as given |
| `workload` | The six TLX columns as components (`mental`, `physical`, `temporal`, `performance`, `effort`, `frustration`); the workbench scores their unweighted mean (0–100), its default rule for components |
| `comfort` | `comfort` as given |

## What the invented effects are

How the design and the background drive these numbers, the group means and which group differences are significant are in [`../README.md`](../README.md), section "The invented effects (ground truth)".
