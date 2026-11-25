#!/usr/bin/env python3
"""Invented raw data for suite 5 (haptic feedback for mid-air buttons). Deterministic; no real people.

18 invented participants type 4-digit sequences on a keypad floating in mid-air in VR, with three
kinds of press feedback (visual only, a vibrotactile buzz, a patterned pulse). Within subjects, in a
balanced Latin square: all six orders of the three designs, three people each. Per design: three
practice sequences, ten scored sequences, a questionnaire; a ranking at the end.

Writes raw/ files like a lab's logs and questionnaires:
  raw/participants.csv       participant, order of the three designs
  raw/demographics.csv       participant, age, handedness, hand_length_cm, tactile_sensitivity_2pd_mm,
                             gaming_hours_per_week, vr_experience (allowed agent input)
  raw/movement_practice.csv  one row per practice sequence: index-fingertip path length, mean speed
                             and overshoot past the activation plane (practice phase only; allowed
                             agent input for individual configurations)
  raw/trials.csv             one row per sequence (practice and scored): seconds, digit presses,
                             wrong presses, mean overshoot of its presses
  raw/questionnaire.csv      per design: confidence (1-7), six raw NASA-TLX items (0-100), presence (1-7)
  raw/rankings.csv           per design: overall preference rank (1 = best)

The participant background drives the invented outcomes, so person-level forecasts have something to
find (README.md, "The invented effects"): a coarser fingertip two-point discrimination threshold
(less tactile sensitivity) shrinks every benefit of the two vibrotactile designs; gaming hours and
VR experience make people faster; longer hands overshoot more; left-handed people (the actuator is
on the right index finger) are slower and make more errors. The buzz and the pulse save the same
time; the pulse mainly cuts overshoot. Practice movement follows the same person and design, so it
carries information about the scored phase without being part of it. Then convert_to_human.py
builds ../human.json. All effects are invented for this example.
"""
import csv
import math
import os
import random

SEED = 20261125
rng = random.Random(SEED)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)

DESIGNS = ["visual", "buzz", "pulse"]
# Balanced Latin square (Williams design) for three designs: both 3x3 squares, so every design is
# in every position twice and follows every other design twice.
ORDERS = [
    ["visual", "buzz", "pulse"],
    ["buzz", "pulse", "visual"],
    ["pulse", "visual", "buzz"],
    ["visual", "pulse", "buzz"],
    ["pulse", "buzz", "visual"],
    ["buzz", "visual", "pulse"],
]
N = 18  # three people per order
PRACTICE, MAIN, DIGITS = 3, 10, 4

BASE_SECONDS = 4.6  # one sequence, visual feedback, a typical person, before corrections
TIME_SAVED = {"visual": 0.0, "buzz": 0.11, "pulse": 0.11}  # share of time saved at full tactile benefit
OVERSHOOT_CUT = {"visual": 0.0, "buzz": 0.22, "pulse": 0.42}  # share of overshoot removed at full benefit
CONFIDENCE_GAIN = {"visual": 0.0, "buzz": 1.3, "pulse": 1.45}
LOAD_DROP = {"visual": 0.0, "buzz": 8.0, "pulse": 7.0}  # TLX points (the pulse pattern needs some attention)
PRESENCE_GAIN = {"visual": 0.0, "buzz": 0.9, "pulse": 1.2}
LEARNING_TIME = [1.0, 0.95, 0.91]  # first, second, third design in a person's order
LEARNING_ERRORS = [1.0, 0.92, 0.88]
EXPERIENCE = {
    "none": {"speed": 1.14, "errors": 1.3, "load": 6.0, "confidence": -0.3},
    "occasional": {"speed": 1.0, "errors": 1.0, "load": 0.0, "confidence": 0.0},
    "regular": {"speed": 0.9, "errors": 0.85, "load": -5.0, "confidence": 0.3},
}
HANDED = {"right": {"speed": 1.0, "errors": 1.0}, "ambidextrous": {"speed": 1.03, "errors": 1.1}, "left": {"speed": 1.1, "errors": 1.3}}

clip = lambda x, lo, hi: max(lo, min(hi, x))
tlx = lambda x: int(clip(5 * round(x / 5), 0, 100))  # TLX items are marked in steps of 5
rating = lambda x: int(round(clip(x, 1, 7)))

participants, demographics, movement, trials, questionnaire, rankings = [], [], [], [], [], []
for i in range(N):
    pid = f"P{i + 1:02d}"
    order = ORDERS[i % 6]
    participants.append({"participant": pid, "order": " ".join(order)})
    # Every order gets one person of each VR-experience level.
    xp = ["none", "occasional", "regular"][(i // 6 + i) % 3]
    hand = "left" if i in (3, 10, 15) else "ambidextrous" if i == 7 else "right"
    age = int(round(clip(rng.gauss(33, 11), 19, 64)))
    hand_length = round(clip(rng.gauss(18.6, 1.3), 16.0, 21.5), 1)
    # Two-point discrimination threshold at the index fingertip (mm): larger = less sensitive; rises with age.
    two_point = round(clip(1.8 + 0.05 * (age - 20) + rng.gauss(0, 0.8), 1.4, 6.0), 1)
    gaming = int(clip(round(rng.gauss({"none": 2, "occasional": 5, "regular": 10}[xp], 3)), 0, 25))
    demographics.append({
        "participant": pid,
        "age": age,
        "handedness": hand,
        "hand_length_cm": hand_length,
        "tactile_sensitivity_2pd_mm": two_point,
        "gaming_hours_per_week": gaming,
        "vr_experience": xp,
    })

    # How much of the vibrotactile benefit this person gets (1 = a typical fingertip at 2.5 mm).
    benefit = clip(1 - 0.3 * (two_point - 2.5), 0.15, 1.15)
    e = EXPERIENCE[xp]
    speed = math.exp(rng.gauss(0, 0.1)) * e["speed"] * HANDED[hand]["speed"] * (1 - min(0.2, 0.012 * gaming)) * (1 + 0.004 * (age - 30))
    slips = e["errors"] * HANDED[hand]["errors"]
    overshoot_person = clip(11 + 1.8 * (hand_length - 18.5) + rng.gauss(0, 2.0), 4, 30)
    load_person, confidence_person, presence_person = rng.gauss(0, 8), rng.gauss(0, 0.5), rng.gauss(0, 0.7)

    utilities = {}
    for pos, design in enumerate(order):
        haptic = design != "visual"
        time_factor = speed * LEARNING_TIME[pos] * (1 - TIME_SAVED[design] * benefit) * math.exp(rng.gauss(0, 0.05))
        overshoot = overshoot_person * (1 - OVERSHOOT_CUT[design] * benefit) * math.exp(rng.gauss(0, 0.08))
        # Slips plus presses made unsure of whether the key registered (double activations, retries).
        unsure = clip(1 - 0.65 * benefit, 0.2, 1.0) if haptic else 1.0
        p_wrong = clip(slips * (0.02 + 0.03 * unsure) * LEARNING_ERRORS[pos] + 0.0012 * max(0.0, overshoot - 8), 0.003, 0.35)
        main_seconds, main_presses, main_wrong, main_depth = [], 0, 0, []
        for phase, count in (("practice", PRACTICE), ("main", MAIN)):
            first = 1.12 if phase == "practice" else 1.0  # first contact with the design
            for s in range(count):
                presses, wrong, depths = 0, 0, []
                for _ in range(DIGITS):
                    while True:
                        presses += 1
                        depths.append(max(0.3, rng.gauss(overshoot * first, 3.0)))
                        if wrong < 6 and rng.random() < p_wrong * first:
                            wrong += 1  # corrected with the delete key, then the digit again
                            continue
                        break
                seconds = BASE_SECONDS * time_factor * first * math.exp(rng.gauss(0, 0.15)) + 1.4 * wrong
                depth = sum(depths) / len(depths)
                trials.append({
                    "participant": pid,
                    "design": design,
                    "position": pos + 1,
                    "phase": phase,
                    "sequence": s + 1,
                    "seconds": round(seconds, 2),
                    "digit_presses": presses,
                    "wrong_presses": wrong,
                    "overshoot_mm": round(depth, 1),
                })
                if phase == "practice":
                    # Fingertip path: in and out of each key (3 cm approach plus the overshoot), and across the keypad.
                    path = sum(2 * (3.0 + d / 10) for d in depths) + (presses - 1) * 4.5 * math.exp(rng.gauss(0, 0.1))
                    movement.append({
                        "participant": pid,
                        "design": design,
                        "phase": "practice",
                        "trial": s + 1,
                        "path_length_cm": round(path, 1),
                        "mean_speed_cm_s": round(path / max(1.0, seconds - 1.0), 1),
                        "overshoot_mm": round(depth, 1),
                    })
                else:
                    main_seconds.append(seconds)
                    main_presses += presses
                    main_wrong += wrong
                    main_depth += depths
        error_rate = main_wrong / main_presses
        typical_time = math.exp(sum(math.log(x) for x in main_seconds) / len(main_seconds))
        mean_depth = sum(main_depth) / len(main_depth)
        confidence = 4.0 + CONFIDENCE_GAIN[design] * benefit + e["confidence"] + confidence_person - 8 * (error_rate - 0.05) + rng.gauss(0, 0.6)
        load = 44 - LOAD_DROP[design] * benefit + e["load"] + load_person + 120 * (error_rate - 0.05) + 2.0 * (typical_time - 5) + rng.gauss(0, 4)
        items = {
            "tlx_mental": load + 4,
            "tlx_physical": load - 6 + 0.6 * (mean_depth - 10),
            "tlx_temporal": load - 2,
            "tlx_performance": load - 8 + 150 * (error_rate - 0.05),
            "tlx_effort": load + 3,
            "tlx_frustration": load - 7 + 180 * (error_rate - 0.05),
        }
        presence = 3.4 + PRESENCE_GAIN[design] * benefit + presence_person + rng.gauss(0, 0.5)
        row = {"participant": pid, "design": design, "confidence": rating(confidence)}
        row.update({k: tlx(v + rng.gauss(0, 6)) for k, v in items.items()})
        row["presence"] = rating(presence)
        questionnaire.append(row)
        tlx_mean = sum(row[k] for k in items) / len(items)
        utilities[design] = row["confidence"] + row["presence"] - tlx_mean / 12 + rng.gauss(0, 0.7)
    ranked = sorted(DESIGNS, key=lambda d: -utilities[d])
    for design in DESIGNS:
        rankings.append({"participant": pid, "design": design, "preference_rank": ranked.index(design) + 1})


def write(name, rows):
    with open(os.path.join(raw, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


write("participants.csv", participants)
write("demographics.csv", demographics)
write("movement_practice.csv", movement)
write("trials.csv", trials)
write("questionnaire.csv", questionnaire)
write("rankings.csv", rankings)
print(f"wrote {len(participants)} participants, {len(trials)} sequences, {len(movement)} practice movement rows to {raw}")
