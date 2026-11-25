# About this dataset

**Every participant and every value in this folder is invented.** `generate_synthetic.py` draws them with a fixed seed (`random.Random(20261125)`), and `convert_to_human.py` turns them into `../human.json`. To regenerate, run `python3 data/generate_synthetic.py && python3 data/convert_to_human.py` from the suite folder; the rerun reproduces the committed files byte for byte. The keyboard dimensions and the recording procedures below are invented too. They describe the study the data pretend to come from, so that every column has a defined meaning. There is no keyboard app in this suite, and nobody typed anything.

## Apparatus and stimuli

**Hardware and room.** A Meta Quest 3 with its two controllers (hand tracking off). Participants sit on a chair without armrests in a plain, evenly lit grey virtual room. Above each keyboard a panel shows the phrase to type, with the text typed so far directly below it. No keyboard completes words or corrects automatically, apart from the swipe keyboard's recogniser. All four keyboards use the QWERTY letter layout (lowercase letters only) plus Space, Backspace and Enter.

| | Raycast QWERTY (`raycast`) | Drum-like (`drum`) | Swipe (`swipe`) | Split (`split`) |
| --- | --- | --- | --- | --- |
| Where | A flat panel about 1 m wide, 1.5 m in front at chest height, facing the participant | Pads on a curved surface (radius 45 cm, centred on the chest), 45 cm in front of the chest, 25 cm below shoulder height, tilted 30° towards the participant; the same place for everyone | The raycast panel, at the same place | Two small grids, each floating about 8 cm above one controller and moving with it; the arms can rest low or in the lap |
| Keys | 8 cm squares with 1.5 cm gaps, rows offset as on a keyboard (about 3° of visual angle each at 1.5 m); a Space bar five keys wide; Backspace and Enter at the right | 5 cm pads with 1 cm gaps, about 60 cm across; Space, Backspace and Enter are pads too | As raycast, plus a Delete-word key and three word suggestions above the keyboard | 2 cm squares. Left half q–t / a–g / z–b (15 keys), right half y–p / h–l / n–m (11 keys) |
| How a character is entered | Point a controller's ray at a key and pull the trigger; either hand, alternating as the person likes | Strike a pad downwards with the tip of a 20 cm virtual drumstick that extends from each controller; a pad is typed when the tip enters it from above and can be typed again once the tip has left it upwards | Hold the trigger and draw the ray through a word's letters in one stroke, then release. The recogniser matches the stroke's shape and position against an English dictionary, inserts the closest word and a space, and shows the three next-best words above the keyboard; pointing at one replaces the inserted word. Delete-word removes the last word. Single letters can be pointed and clicked as on the raycast keyboard. | Each thumbstick moves a highlight over its half, one key per tilt; the lower face button (A right, X left) types the highlighted key, and the highlight returns to the half's middle key (d on the left, j on the right). Grip buttons: Space. Upper face buttons (B, Y): Backspace. A trigger: Enter. |
| Feedback | A white ray with a dot where it hits; the key under the ray is outlined; a typed key fills light blue for 150 ms and a click plays from the panel | The pad lights up for 150 ms, the same click plays, and the controller that struck it vibrates for 20 ms | The stroke leaves a light-blue trail on the panel until release; the inserted word appears in the text; clicked letters as on raycast | The highlighted key has a yellow outline; a typed key flashes light blue for 150 ms and the same click plays |

**Phrases.** A pool of 40 invented phrases in the style of the MacKenzie and Soukoreff (2003) phrase set: lowercase letters and spaces only, 18–36 characters, 4–7 words (the list is in `generate_synthetic.py`). Each participant gets all 40 in a random order, ten per keyboard, so no phrase is typed twice. Practice uses phrases from outside the pool.

**What agents get.** Agents read about the keyboards in the brief; no configuration can try them. Forecasts are made before the study, so no measured outcome is ever an input.

## Participants and how their information was recorded

24 invented adults, P01–P24. Before the headset went on, each answered a short background questionnaire on a tablet, took a one-minute typing test, and had their arm length measured (`raw/background.csv`, source `background`; individual configurations get the person's row, population configurations a cohort summary).

| Field | Meaning, unit or categories | How it was recorded |
| --- | --- | --- |
| `age_band` | `18-24`, `25-34`, `35-44` or `45+` | Self-report, one band ticked |
| `desktop_typing_wpm` | Desktop typing speed in words per minute, whole numbers (28–106 here) | A one-minute copy-typing test on a full-size physical desktop keyboard in the person's usual layout, with short English sentences not from the study's pool. Net speed: correctly typed characters, spaces included, divided by 5 per minute. Mistakes corrected during the test cost time only; mistakes left in add nothing. |
| `smartphone_swipe_use` | `never`; `sometimes` (not every day: for example weekly or monthly); `daily` | Self-report: "How often do you type by swiping (gesture typing) on a phone?" |
| `first_language_english` | `yes` or `no` | Self-report: "Is English the first language you learned?" Everyone read English fluently enough to copy the phrases. |
| `wears_glasses` | `yes` or `no` | Whether the person wore glasses inside the headset during the session (contact lenses count as no) |
| `handedness` | `right` or `left` | Self-report: the hand the person writes with. Every keyboard can be used with either hand. |
| `arm_length_cm` | Arm length in whole cm (62–79 here) | Measured by the experimenter with a tape measure: the arm of the writing hand held straight out to the side at shoulder height, palm down, from the bony tip of the shoulder (acromion) to the tip of the middle finger |

## Data files

**`raw/participants.csv`**: one row per participant.

| Column | Values | Meaning |
| --- | --- | --- |
| `participant` | P01–P24 | Participant ID |
| `order` | Four keyboard IDs, space-separated | The order of the keyboards: a balanced 4 × 4 Latin square, four orders, six people each (`ORDERS[i % 4]` in the generator). Must match `conditionOrder` in `../study.json`. |

**`raw/background.csv`**: see the table above.

**`raw/phrases.csv`**: one row per scored phrase: 24 people × 4 keyboards × 10 phrases = 960 rows. Logged by the study app. Practice phrases are not logged.

| Column | Unit or values | Meaning and how it was recorded |
| --- | --- | --- |
| `participant` | P01–P24 | |
| `keyboard` | `raycast`, `drum`, `swipe`, `split` | |
| `position` | 1–4 | The keyboard's place in the person's order |
| `phrase` | 1–10 | The phrase's number within the keyboard's block |
| `presented` | text | The phrase shown on the panel |
| `transcribed` | text | The text as submitted with Enter, after any corrections the person made, exactly as typed (it may contain a missing or doubled space) |
| `seconds` | s, two decimals | From the first key (or the first stroke) to Enter. A phrase not finished after 180 s would be ended and logged with the text typed so far; none was (8.8–83.4 s here). |

The file keeps only what the measures need. A real log would also list every keystroke, stroke and correction; without it, corrected errors and keystrokes per character cannot be computed from this file. In the generator, `seconds` follows from the person's speed on that phrase and `transcribed` comes from slips on single keys (a neighbouring key, a missed key, an extra key) or, for swipe, from whole words replaced by similar words.

**`raw/questionnaire.csv`**: one row per participant and keyboard (96 rows), answered on a tablet with the headset off, right after the keyboard's ten scored phrases.

| Column | Scale | Item |
| --- | --- | --- |
| `tlx_mental`, `tlx_physical`, `tlx_temporal`, `tlx_effort`, `tlx_frustration` | 0–100 in steps of 5 | Raw NASA-TLX items (mental, physical and temporal demand, effort, frustration), each marked on a 21-step line from low to high |
| `tlx_performance` | 0–100 in steps of 5 | Raw NASA-TLX performance, 0 = perfect, 100 = failure, so a higher mark is worse, like the other items |
| `arm_comfort` | 1–7 | "My arms and shoulders felt comfortable while typing with this keyboard" (1 = strongly disagree, 7 = strongly agree) |

**`raw/ranking.csv`**: one row per participant and keyboard (96 rows), after all four keyboards: "Which keyboard would you choose to enter text in VR?"

| Column | Values | Meaning |
| --- | --- | --- |
| `rank` | 1–4, no ties | 1 = first choice |

## From raw data to the measures in human.json

`convert_to_human.py` writes one record per participant × keyboard × measure (24 × 4 × 6 = 576). It checks the orders against `../study.json` and that every person and keyboard has ten phrases. With T the transcribed and P the presented phrase, |·| the length in characters and S the phrase's `seconds`:

| Measure (`study.json`) | Computation |
| --- | --- |
| `wpm` (entry speed) | Per phrase (\|T\| − 1) / S × 60 / 5, then the mean over the ten phrases. The first character is not counted, because timing starts with it; a word is five characters. |
| `error-rate` (uncorrected) | Per phrase MSD(P, T) / max(\|P\|, \|T\|), then the mean over the ten phrases. MSD is the minimum string distance (Levenshtein: insertions, deletions and substitutions of single characters). |
| `entry-time` | Geometric mean of `seconds` over the ten phrases: exp(mean(ln `seconds`)) |
| `tlx` (workload) | The six `tlx_*` items as components (`mental`, `physical`, `temporal`, `performance`, `effort`, `frustration`); `study.json` declares `"componentRule": "mean"`, so the workbench scores their unweighted mean (0–100) |
| `arm-comfort` | `arm_comfort` as given |
| `preference` | `rank` as given |

## What the invented effects are

How the background drives these numbers, the averages over the 24 people and which differences are significant are in [`../README.md`](../README.md), section "Participant information and the invented effects".
