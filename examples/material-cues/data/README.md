# About this dataset

**Every participant and every value in this folder is invented.** `generate_synthetic.py` draws them with a fixed seed (`SEED = 20261133`: the first seed from 20261125 upward whose 16-person sample shows every invented effect in its direction), and `convert_to_human.py` turns them into `../human.json`. To regenerate, run `python3 data/generate_synthetic.py && python3 data/convert_to_human.py` from the suite folder; the rerun reproduces the committed files byte for byte. The recording procedures below are invented too. They describe the study the data pretend to come from, so that every column has a defined meaning. The app in `../webxr-app/` is real and runs; nobody was measured with it.

## Apparatus and stimuli

**Hardware.** Participants wore a standalone headset and pointed with a controller ray; the trigger selects. The same WebXR page (`../webxr-app/`) also runs in a desktop browser. App configurations of agents see it there, at 1280 × 720, through screenshots.

**The room.** A wooden table (1.8 × 0.9 m) stands in a room with a plank floor, a brick back wall and plaster side walls. On it are nine objects:

- **Six look-alikes in three pairs.** Each pair shares its shape and almost its colour; each material keeps its own slight tint, mostly along the red–green axis.
  - Mugs (about 9 cm across, 10 cm tall): glossy ceramic (greenish white) and matte ceramic (pinkish white).
  - Bowls (16 cm across): brushed metal (greenish grey) and plastic (pinkish grey).
  - Vases (about 25 cm tall): glass (pale aqua) and plastic (pale blue).
- **Three others:** a wooden box, a fabric cushion and a plant in a terracotta pot.

**What a material cue is.** A material cue is the visual information that tells what an object is made of, as opposed to its shape:

- **Specular highlights and gloss:** bright highlights, sharp on smooth surfaces and broad and dim on rough ones.
- **Reflections:** mirror images of the surroundings in polished metal, glass and glaze.
- **Transparency and refraction:** seeing through glass, with the background bent by it.
- **Surface roughness and texture:** fine bumps, grain, pores and specks.
- **Anisotropic brushing:** highlights stretched across the direction of the brush marks on brushed metal.
- **Translucency and sheen:** light passing into a material, or a soft glow along the fibres of fabric.
- **Shading and shadows:** how light falls across the shape, and the shadow an object casts on the table.
- **Colour and tint.**

**What each rendering quality keeps.** The scene content is identical in both qualities; only the rendering changes (`../webxr-app/main.js`, `QUALITY` and `material()`).

| Cue | Low: flat, unlit colours | High: physically based materials |
| --- | --- | --- |
| Lighting and shading | None: every surface is drawn unlit in one flat colour, so a shape shows only by its outline | A hemisphere light and one directional light; ambient-occlusion maps |
| Colour and tint | Kept: each material's average colour, the slight tint that tells a pair apart | Kept, inside the full texture |
| Specular highlights and gloss | None | Per-material roughness maps: glossy ceramic about 0.06, matte ceramic 0.78, plastic about 0.45, brushed metal 0.18–0.43. The glossy mug (and the table) also get a clear-coat glaze. |
| Environment reflections | None | A room environment map reflected by every material; strongest on the metal and the glaze |
| Transparency and refraction | None: the glass vase is an opaque pale-aqua silhouette | Glass transmission (index of refraction 1.5, roughness 0.04) |
| Surface texture | None | Procedural colour, normal, roughness, metalness, ambient-occlusion and height maps for every material; real displacement of the brick wall and the floor |
| Anisotropic brushing | None | Brushed-metal anisotropy (0.8), with streaks in the roughness and height maps |
| Translucency and sheen | None | Fabric sheen on the cushion. Glass transmission is the only light passing through a material. |
| Shadows | None | Soft shadows from the directional light (2048-pixel shadow map) |
| Image quality | 0.7 of the screen's pixel density, no antialiasing, coarse geometry (16 segments around round objects) | Full pixel density (up to 2×), antialiasing, ACES filmic tone mapping, 64 segments |

So at low quality the slight tint is the only cue that tells the two members of a pair apart. At high quality highlights, reflections, transmission, anisotropy and texture show the material as well.

**The tasks** (the same in both qualities). Instructions appear on a panel behind the table.

1. **Practice trial** (not scored): "Select the wooden box."
2. **Four search trials:** "Select the glossy ceramic mug, the brushed-metal bowl and the glass vase."
   - Before every trial the six look-alikes swap places among six fixed spots on the table.
   - A selected object flashes for 0.6 s with a ring at its foot: green for a target still to be found, red for anything else. Re-selecting a target already found also counts as red.
   - A trial ends when the third target is selected. The experimenter stops a trial at 120 s.
3. **Six identification trials:**
   - The look-alikes swap places once more. Then a yellow ring on the table and a small yellow cone above the object mark one look-alike; each is marked once, in a random order.
   - The participant names its material by pointing at one of five answer tiles under the panel: glossy ceramic, matte ceramic, brushed metal, plastic or glass.
   - There is no feedback on the answer.
4. **Questionnaire** on that quality, then a short break.

The layouts and the order of the marked objects come from a fresh random seed in every session and are written to the app's log. The app keeps an event log of every trial start (with the layout), selection, identification and trial end, with time stamps in milliseconds. At the end of each design it is saved as `log-<participant>-<quality>.json`. The raw tables below are tabulated from these logs and the questionnaires.

## Participants and how their information was recorded

16 invented adults, P01–P16. Before the session each answered a short background questionnaire on paper, and the experimenter ran a colour-vision screening (`raw/background.csv`, source `background`; individual configurations get the person's row, population configurations a cohort summary).

| Field | Meaning, unit or categories | How it was recorded |
| --- | --- | --- |
| `age_band` | `18-24`, `25-34`, `35-44` or `45-54` | Self-report, one band ticked |
| `vision_correction` | `none`, `glasses` or `contacts`: what the person wore during the session | Self-report, checked by the experimenter when fitting the headset. Glasses were worn inside the headset. |
| `color_vision` | `normal` or `deficient` | A screening test with pseudoisochromatic plates of the Ishihara type: 13 screening plates, read at about 75 cm under a daylight lamp, 3 s per plate. Normal = at most two plates misread; deficient = three or more. The screening does not tell the type of deficiency. |
| `art_or_design_training` | `none`: no training beyond school; `some`: courses, an evening class or a minor in art, design, photography or 3D graphics; `professional`: a degree in one of these fields, or working in one (designer, 3D artist, photographer, architect) | Self-report, one of the three |
| `vr_hours_total` | Estimated total hours of VR headset use before the study, whole hours (0–120 here) | Self-report: "About how many hours in total have you used a VR headset before today?" When people were unsure, the experimenter helped by asking how often and how long they had used one. |

## Data files

**`raw/participants.csv`**: one row per participant.

| Column | Values | Meaning |
| --- | --- | --- |
| `participant` | P01–P16 | Participant ID |
| `order` | `low\|high` or `high\|low` | The order of the two designs: odd participants low first, even participants high first. Must match `conditionOrder` in `../study.json`. |

**`raw/background.csv`**: see the table above.

**`raw/search_trials.csv`**: one row per practice or search trial: 16 people × 2 designs × (1 + 4) = 160 rows. From the app's log.

| Column | Unit or values | Meaning and how it was recorded |
| --- | --- | --- |
| `participant` | P01–P16 | |
| `quality` | `low` or `high` | The design |
| `block` | 1 or 2 | The design's place in the session |
| `phase` | `practice` or `main` | The practice trial (never scored) or a search trial |
| `trial` | 0 (practice) or 1–4 | The search trial's number |
| `seconds` | s, two decimals | From the trial's start (the task text appears; the look-alikes have swapped places) to the selection of its last target (for the practice trial, the wooden box). Wrong selections are part of the time. A trial stopped at 120 s would be logged as 120; none was (3.6–24.2 s here). |
| `wrong_selections` | count (0–4 here) | Selections of anything other than a target still to be found: the look-alike partner, another object, or a target selected again. 0 in every practice trial here. |

**`raw/identification.csv`**: one row per identification trial: 16 × 2 × 6 = 192 rows. From the app's log.

| Column | Unit or values | Meaning and how it was recorded |
| --- | --- | --- |
| `participant`, `quality`, `block` | as above | |
| `item` | 1–6 | The trial's place in the order of marking |
| `object` | `glossy-mug`, `matte-mug`, `metal-bowl`, `plastic-bowl`, `glass-vase`, `plastic-vase` | Which look-alike was marked (what it really is) |
| `answer` | `glossy ceramic`, `matte ceramic`, `brushed metal`, `plastic`, `glass` | The tile the participant chose |
| `correct` | 1 or 0 | 1 when `answer` is the marked object's material (both plastic objects have the answer `plastic`) |

The app accepts any of the five answers. In this invented data every wrong answer names the material of the marked object's look-alike partner, for example a glass vase called plastic. The app also logs how long each answer took; that time is not kept here.

**`raw/questionnaire.csv`**: one row per participant and design (32 rows), answered on a tablet with the headset off, right after the design's last identification trial.

| Column | Scale | Item |
| --- | --- | --- |
| `block` | 1 or 2 | The design's place in the session |
| `presence_general` | 1–7 | General presence: "I had a sense of being in the room" (1 = not at all, 7 = completely) |
| `presence_spatial` | 1–7 | Spatial presence: "I felt that the table and the objects were around me in space" |
| `presence_involvement` | 1–7 | Involvement: "I was absorbed in the room and hardly noticed the real surroundings" |
| `presence_realness` | 1–7 | Realness: "The room seemed as real as a real room" |
| `appeal` | 1–7 | "How visually appealing was the room?" (1 = not at all, 7 = very) |

The four presence items follow the four aspects of the Igroup Presence Questionnaire (general presence, spatial presence, involvement, experienced realism), one item each; the wording here is this study's own.

**`raw/preferences.csv`**: one row per participant (16 rows), asked at the end of the session after the second design's questionnaire: "Which of the two versions of the room did you prefer?"

| Column | Values | Meaning |
| --- | --- | --- |
| `rank_low` | 1 or 2 | 1 = preferred low quality |
| `rank_high` | 1 or 2 | 1 = preferred high quality; always the other value |

## From raw data to the measures in human.json

`convert_to_human.py` writes one record per participant × design × measure (16 × 2 × 6 = 192). It first checks the orders against `../study.json` and that every person and design has four search trials and six identification trials. Practice trials are left out.

| Measure (`study.json`) | Computation |
| --- | --- |
| `search-time` | Geometric mean of `seconds` over the four search trials (`phase` = `main`): exp(mean(ln `seconds`)), rounded to 4 decimals |
| `wrong-selections` | Sum of `wrong_selections` over the four search trials (a whole number) |
| `identification-accuracy` | Sum of `correct` / 6, rounded to 4 decimals |
| `presence` | The four `presence_*` items as components (`general`, `spatial`, `involvement`, `realness`); `study.json` declares `"componentRule": "mean"`, so the workbench scores their mean (1–7) |
| `appeal` | `appeal` as given |
| `preference` | `rank_low` for low, `rank_high` for high |

## What the invented effects are

How the background and the rendering quality drive these numbers, and the averages that result, are in [`../README.md`](../README.md), section "Participant information and the invented ground truth".
