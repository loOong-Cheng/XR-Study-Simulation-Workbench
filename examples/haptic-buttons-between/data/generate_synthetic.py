#!/usr/bin/env python3
"""Invented raw data for suite 6 (haptic feedback for mid-air buttons, between subjects).
Deterministic; no real people.

36 invented people, 12 per design; each person types codes with ONE feedback design only.
Writes raw/ files like a lab's logs and questionnaires:
  raw/participants.csv   participant, design (permuted blocks of three in order of arrival)
  raw/background.csv     participant, age, vr_experience, prior_haptic_devices,
                         motion_sickness_susceptibility, dominant_hand
  raw/trials.csv         one row per typed code: block (practice or scored), seconds, digit presses,
                         wrong presses
  raw/questionnaire.csv  presence (1-7), six Raw TLX items (0-100, steps of 5), comfort (1-7)

Background is stratified on two fields: each group has a fixed number of people per combination
of VR experience and prior haptic devices (COMBOS), shuffled within the group, so the groups are
roughly balanced but not identical. Age, motion-sickness susceptibility and dominant hand are drawn
at random per person.

Invented ground truth (none of it is a real finding):
  - feedback design: both vibration designs speed up code entry and raise presence compared with
    visual feedback only; the patterned pulse also halves wrong presses; workload and comfort barely
    depend on the design;
  - VR experience: regular users are faster and make fewer wrong presses, newcomers are slower,
    make more and report more workload; regular users rate presence a little lower;
  - age: about 0.7 % slower per year above 30;
  - haptic-glove users profit more from the patterned pulse (faster, fewer wrong presses, higher
    presence) and not from the buzz;
  - motion-sickness susceptibility lowers comfort (strongly when high) and slightly raises workload;
  - dominant hand has no effect (keypad and actuator follow the dominant hand).
Then convert_to_human.py builds ../human.json.
"""
import csv
import math
import os
import random

rng = random.Random(20261125)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)

DESIGNS = ["visual", "buzz", "pulse"]
PRACTICE_CODES, SCORED_CODES, DIGITS = 2, 12, 4
# People per group for each (vr_experience, prior_haptic_devices), in the order visual, buzz, pulse.
COMBOS = {
    ("none", "none"): (3, 4, 2),
    ("none", "controller rumble"): (1, 1, 2),
    ("occasional", "none"): (1, 1, 1),
    ("occasional", "controller rumble"): (3, 2, 2),
    ("occasional", "haptic gloves"): (1, 1, 1),
    ("regular", "controller rumble"): (1, 2, 2),
    ("regular", "haptic gloves"): (2, 1, 2),
}
SECONDS = {"visual": 5.4, "buzz": 4.5, "pulse": 4.3}  # per code, occasional VR user aged 30, no wrong press
WRONG = {"visual": 0.10, "buzz": 0.07, "pulse": 0.05}  # chance of a wrong press per digit
PRESENCE = {"visual": 3.4, "buzz": 4.4, "pulse": 4.8}
LOAD = {"visual": 40, "buzz": 38, "pulse": 38}
COMFORT = {"visual": 5.1, "buzz": 5.3, "pulse": 5.1}
VR = {
    "none": {"speed": 1.18, "wrong": 1.3, "load": 7, "presence": 0.0},
    "occasional": {"speed": 1.0, "wrong": 1.0, "load": 0, "presence": 0.0},
    "regular": {"speed": 0.85, "wrong": 0.75, "load": -6, "presence": -0.3},
}
SICKNESS = {"low": {"comfort": 0.0, "load": 0}, "medium": {"comfort": -0.5, "load": 2}, "high": {"comfort": -1.4, "load": 6}}
CORRECTION_SECONDS = 1.1  # delete and press again, per wrong press

clip = lambda x, lo, hi: max(lo, min(hi, x))
step5 = lambda x: int(clip(5 * round(x / 5), 0, 100))

# Assignment in order of arrival: every block of three people covers each design once.
assignment = []
for _ in range(12):
    block = DESIGNS[:]
    rng.shuffle(block)
    assignment += block
pools = {}
for g, design in enumerate(DESIGNS):
    pool = [combo for combo, counts in COMBOS.items() for _ in range(counts[g])]
    rng.shuffle(pool)
    pools[design] = pool

participants, background, trials, questionnaire = [], [], [], []
for i, design in enumerate(assignment):
    pid = f"p{i + 1:02d}"
    xr, devices = pools[design].pop()
    age = int(clip(round(rng.gauss(31, 9)), 19, 62))
    sickness = rng.choices(["low", "medium", "high"], weights=[45, 35, 20])[0]
    hand = "left" if rng.random() < 0.12 else "right"
    participants.append({"participant": pid, "design": design})
    background.append({"participant": pid, "age": age, "vr_experience": xr, "prior_haptic_devices": devices, "motion_sickness_susceptibility": sickness, "dominant_hand": hand})
    gloves_pulse = devices == "haptic gloves" and design == "pulse"
    speed = VR[xr]["speed"] * (1 + 0.007 * (age - 30)) * (0.88 if gloves_pulse else 1) * math.exp(rng.gauss(0, 0.10))
    p_wrong = clip(WRONG[design] * VR[xr]["wrong"] * (0.6 if gloves_pulse else 1) * math.exp(rng.gauss(0, 0.3)), 0.005, 0.4)
    wrong_scored = 0
    for block, n in (("practice", PRACTICE_CODES), ("scored", SCORED_CODES)):
        for c in range(n):
            code = "".join(str(rng.randrange(10)) for _ in range(DIGITS))
            wrong = 0
            for _ in range(DIGITS):
                while rng.random() < p_wrong and wrong < 3 * DIGITS:
                    wrong += 1
            seconds = SECONDS[design] * speed * math.exp(rng.gauss(0, 0.16)) + wrong * CORRECTION_SECONDS * speed
            if block == "practice":
                seconds *= 1.35  # first codes are slower; practice is not scored
            else:
                wrong_scored += wrong
            trials.append({"participant": pid, "design": design, "block": block, "code_index": c + 1, "code": code, "seconds": round(clip(seconds, 1, 60), 2), "digit_presses": DIGITS + wrong, "wrong_presses": wrong})
    error_rate = wrong_scored / (SCORED_CODES * DIGITS + wrong_scored)
    presence = PRESENCE[design] + VR[xr]["presence"] + (0.5 if gloves_pulse else 0) - (0.3 if sickness == "high" else 0) + rng.gauss(0, 0.85)
    load = LOAD[design] + VR[xr]["load"] + SICKNESS[sickness]["load"] + rng.gauss(0, 8)
    items = {
        "mental": load + 4 + rng.gauss(0, 8),
        "physical": load - 4 + rng.gauss(0, 8),
        "temporal": load - 2 + rng.gauss(0, 8),
        "performance": 12 + 250 * error_rate + rng.gauss(0, 8),  # 0 = perfect, 100 = failure
        "effort": load + 3 + rng.gauss(0, 8),
        "frustration": load - 10 + 120 * error_rate + rng.gauss(0, 8),
    }
    comfort = COMFORT[design] + SICKNESS[sickness]["comfort"] + rng.gauss(0, 0.75)
    questionnaire.append({"participant": pid, "design": design, "presence": int(clip(round(presence), 1, 7)), **{k: step5(v) for k, v in items.items()}, "comfort": int(clip(round(comfort), 1, 7))})


def write(name, rows):
    with open(os.path.join(raw, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


write("participants.csv", participants)
write("background.csv", background)
write("trials.csv", trials)
write("questionnaire.csv", questionnaire)
print(f"wrote {len(participants)} participants, {len(trials)} typed codes to {raw}")
