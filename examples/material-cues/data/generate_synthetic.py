#!/usr/bin/env python3
"""Invented raw data for suite 4 (material cues at two rendering qualities). Deterministic; no real people.

16 invented participants try the WebXR room at two rendering qualities (low: flat, unlit colours;
high: physically based materials) in a within-subjects design, 8 in the order low -> high and 8 in
the order high -> low. In each design: one practice trial, four search trials (select the glossy
ceramic mug, the brushed-metal bowl and the glass vase among look-alikes), six identification
trials (name the material of the marked look-alike), then a questionnaire; at the end they say
which design they preferred. The script writes raw files like a lab's logs and questionnaires:

  raw/participants.csv    participant, order of the designs
  raw/background.csv      participant, age_band, vision_correction, color_vision,
                          art_or_design_training, vr_hours_total (the allowed agent input)
  raw/search_trials.csv   one row per practice or search trial: seconds and wrong selections
  raw/identification.csv  one row per identification trial: marked object, answer, correct
  raw/questionnaire.csv   per design: four presence items (1-7) and visual appeal (1-7)
  raw/preferences.csv     per participant: rank of each design (1 = preferred)

The invented ground truth (README.md lists it):
  - At low quality the look-alikes differ only by a slight tint, which observers learn to read
    from the green/red feedback over the search trials; at high quality highlights, reflections
    and transmission show the material. So identification is better and wrong selections are
    fewer at high quality. Search time hardly differs: at low quality people pick
    quickly and correct their mistakes, at high quality they inspect each candidate for longer.
  - Colour-vision deficiency: the tint is the only cue at low quality, so deficient observers make
    more wrong selections and identify fewer materials there; at high quality the effect is small.
  - Art or design training: better identification and fewer wrong selections at high quality;
    professionals also find the flat low-quality look more appealing.
  - VR hours: faster search in both designs, and slightly lower presence (less novelty).
  - Age 45-54: slower search. Glasses: slightly lower presence (frames inside the headset).
  - The second design of a session is searched a little faster (learning).
Presence differs little between the designs. Then convert_to_human.py builds ../human.json.
All effects are invented for this example.

Usage: python3 generate_synthetic.py   (deterministic; seed below)
"""
import csv
import math
import os
import random

# In a sample of 16 (two colour-deficient, four professionals) noise can hide a moderate effect, so
# SEED is the first seed from 20261125 upward whose sample shows every invented effect above in its
# direction (and leaves search time and presence without a significant design difference).
SEED = 20261133
rng = random.Random(SEED)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)

DESIGNS = ["low", "high"]
ORDERS = [["low", "high"], ["high", "low"]]  # odd participants low first, even high first
SEARCH_TRIALS = 4

# Invented cohort: complete for everyone, varied on purpose (two colour-deficient observers,
# four professionals in art or design, VR experience from none to a lot).
BACKGROUND = [
    # participant, age_band, vision_correction, color_vision, art_or_design_training, vr_hours_total
    ("P01", "18-24", "none", "normal", "none", 8),
    ("P02", "25-34", "glasses", "normal", "some", 2),
    ("P03", "35-44", "none", "normal", "professional", 0),
    ("P04", "18-24", "contacts", "normal", "none", 45),
    ("P05", "25-34", "none", "deficient", "none", 15),
    ("P06", "45-54", "glasses", "normal", "some", 1),
    ("P07", "25-34", "none", "normal", "professional", 6),
    ("P08", "18-24", "glasses", "normal", "none", 120),
    ("P09", "35-44", "contacts", "normal", "some", 4),
    ("P10", "25-34", "none", "normal", "none", 0),
    ("P11", "18-24", "none", "normal", "some", 30),
    ("P12", "35-44", "glasses", "deficient", "professional", 3),
    ("P13", "45-54", "none", "normal", "none", 10),
    ("P14", "25-34", "contacts", "normal", "professional", 2),
    ("P15", "18-24", "glasses", "normal", "some", 70),
    ("P16", "25-34", "none", "normal", "none", 5),
]

# The six look-alikes: three pairs of the same shape and nearly the same colour.
LOOKALIKES = ["glossy-mug", "matte-mug", "metal-bowl", "plastic-bowl", "glass-vase", "plastic-vase"]
SHAPE = {"glossy-mug": "mug", "matte-mug": "mug", "metal-bowl": "bowl", "plastic-bowl": "bowl", "glass-vase": "vase", "plastic-vase": "vase"}
MATERIAL = {"glossy-mug": "glossy ceramic", "matte-mug": "matte ceramic", "metal-bowl": "brushed metal", "plastic-bowl": "plastic", "glass-vase": "glass", "plastic-vase": "plastic"}
PARTNER = {"glossy-mug": "matte-mug", "matte-mug": "glossy-mug", "metal-bowl": "plastic-bowl", "plastic-bowl": "metal-bowl", "glass-vase": "plastic-vase", "plastic-vase": "glass-vase"}

# Low quality: the only cue is a slight tint. Without it a pick within a pair is a guess (0.5).
# Observers with normal colour vision learn which tint goes with which material from the feedback
# (green/red flash) over the search trials; colour-deficient observers cannot see the tint.
TINT_LEARNED = [0.0, 0.6, 0.85, 1.0]  # share of the tint cue learned, by search trial
TINT_CUE = 0.28  # how much the fully learned tint lowers the chance of a wrong first pick
TINT_IDENTIFY = 0.18  # and raises the chance of a correct identification (after the search trials)
# High quality: chance that the first pick of a pair is the look-alike (before person effects).
CONFUSE_HIGH = {"mug": 0.10, "bowl": 0.08, "vase": 0.22}
# High quality: chance of naming a marked object's material correctly (before person effects).
IDENTIFY_HIGH = {"mug": 0.86, "bowl": 0.88, "vase": 0.66}
# Seconds a search trial takes without wrong selections; each wrong selection adds SECONDS_PER_WRONG.
INSPECT = {"low": 9.0, "high": 10.3}
SECONDS_PER_WRONG = 1.8
AGE_FACTOR = {"18-24": 0.96, "25-34": 1.0, "35-44": 1.07, "45-54": 1.16}
LEARNING = {1: 1.0, 2: 0.9}  # first and second design of a session
PRESENCE = {"low": 4.45, "high": 4.55}
REALNESS = {"low": -0.15, "high": 0.25}  # the realness item reacts most to rendering
APPEAL = {"low": 3.5, "high": 5.2}

logit = lambda p: math.log(p / (1 - p))
expit = lambda x: 1 / (1 + math.exp(-x))
clip = lambda x, lo, hi: max(lo, min(hi, x))
rating = lambda x: int(clip(round(x), 1, 7))


def confusion(design, shape, color, training, skill, trial):
    """Chance that the first pick of a pair in search trial `trial` (1-4) is the look-alike."""
    if design == "low":
        cue = 0.0 if color == "deficient" else TINT_LEARNED[trial - 1]
        return expit(logit(0.5 - TINT_CUE * cue) - skill * cue)
    x = logit(CONFUSE_HIGH[shape]) - skill - {"none": 0.0, "some": 0.3, "professional": 0.6}[training]
    return expit(x + (0.2 if color == "deficient" else 0))


def identification(design, shape, color, training, skill):
    """Chance of naming the marked object's material correctly."""
    if design == "low":
        if color == "deficient":
            return 0.5
        return expit(logit(0.5 + TINT_IDENTIFY) + skill + (0.1 if training == "professional" else 0))
    x = logit(IDENTIFY_HIGH[shape]) + skill + {"none": 0.0, "some": 0.4, "professional": 0.9}[training]
    return expit(x - (0.15 if color == "deficient" else 0))


participants, background, search, ident, questionnaire, preferences = [], [], [], [], [], []
for i, (pid, age, vision, color, training, hours) in enumerate(BACKGROUND):
    order = ORDERS[i % 2]
    participants.append({"participant": pid, "order": "|".join(order)})
    background.append({"participant": pid, "age_band": age, "vision_correction": vision, "color_vision": color, "art_or_design_training": training, "vr_hours_total": hours})
    # Person-level tendencies.
    speed = math.exp(rng.gauss(0, 0.18)) * math.exp(-0.035 * math.log(1 + hours)) * AGE_FACTOR[age]
    skill = rng.gauss(0, 0.3)
    presence_bias = rng.gauss(0, 0.55) - (0.35 if vision == "glasses" else 0) - 0.35 * math.log(1 + hours) / math.log(121)
    taste = rng.gauss(0, 0.45)
    # A liking for the clean, flat look (stronger in professionals): raises appeal and preference of low quality.
    flat_taste = rng.gauss(0, 0.5) + (0.8 if training == "professional" else 0)
    utility = {}
    for block, design in enumerate(order, start=1):
        # Practice: select the wooden box (not scored).
        search.append({"participant": pid, "quality": design, "block": block, "phase": "practice", "trial": 0, "seconds": round(6.5 * speed * math.exp(rng.gauss(0, 0.2)), 2), "wrong_selections": 0})
        for t in range(1, SEARCH_TRIALS + 1):
            wrong = sum(1 for shape in ("mug", "bowl", "vase") if rng.random() < confusion(design, shape, color, training, skill, t))
            wrong += 1 if rng.random() < 0.02 else 0  # an occasional slip onto another object
            seconds = (INSPECT[design] + SECONDS_PER_WRONG * wrong) * speed * LEARNING[block] * math.exp(rng.gauss(0, 0.18))
            search.append({"participant": pid, "quality": design, "block": block, "phase": "main", "trial": t, "seconds": round(clip(seconds, 1, 120), 2), "wrong_selections": wrong})
        marked = LOOKALIKES[:]
        rng.shuffle(marked)
        correct_total = 0
        for item, obj in enumerate(marked, start=1):
            ok = rng.random() < identification(design, SHAPE[obj], color, training, skill)
            correct_total += ok
            ident.append({"participant": pid, "quality": design, "block": block, "item": item, "object": obj, "answer": MATERIAL[obj] if ok else MATERIAL[PARTNER[obj]], "correct": int(ok)})
        p = PRESENCE[design] + presence_bias + rng.gauss(0, 0.35) - 0.1 * (block - 1)
        appeal = APPEAL[design] + taste + (flat_taste if design == "low" else 0) + rng.gauss(0, 0.6)
        questionnaire.append(
            {
                "participant": pid,
                "quality": design,
                "block": block,
                "presence_general": rating(p + rng.gauss(0, 0.6)),
                "presence_spatial": rating(p + 0.2 + rng.gauss(0, 0.6)),
                "presence_involvement": rating(p - 0.15 + rng.gauss(0, 0.6)),
                "presence_realness": rating(p + REALNESS[design] + rng.gauss(0, 0.6)),
                "appeal": rating(appeal),
            }
        )
        utility[design] = 0.6 * appeal + correct_total / len(marked) + (flat_taste if design == "low" else 0) + rng.gauss(0, 1.0)
    ranked = sorted(DESIGNS, key=lambda d: -utility[d])
    preferences.append({"participant": pid, **{f"rank_{d}": ranked.index(d) + 1 for d in DESIGNS}})


def write(name, rows):
    with open(os.path.join(raw, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


write("participants.csv", participants)
write("background.csv", background)
write("search_trials.csv", search)
write("identification.csv", ident)
write("questionnaire.csv", questionnaire)
write("preferences.csv", preferences)
print(f"Wrote synthetic raw data for {len(participants)} participants to {raw}")
