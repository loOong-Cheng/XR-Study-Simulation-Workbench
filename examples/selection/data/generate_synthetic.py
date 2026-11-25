#!/usr/bin/env python3
"""Invented raw data for suite 2 (selecting and placing objects). Deterministic; no real people.

Writes raw/ files like a lab's logs and questionnaires:
  raw/participants.csv   participant, order (Williams-style: all six orders, two people each)
  raw/demographics.csv   participant, age_band, xr_experience, gaming_hours_per_week, handedness
  raw/trials.csv         one row per scored task: seconds, pickups, wrong pickups, teleports
  raw/questionnaire.csv  per technique: five workload items (1-7) and visual appeal (1-7)
  raw/rankings.csv       per technique: interaction and overall preference rank (1 = first)

The participant background really drives the invented outcomes, so person-level forecasts have
something to find: XR experience speeds people up and lowers workload (most for direct touch, which
needs walking and teleporting), gaming hours help with the ray, and left-handed people are slower with
direct touch and hybrid (the controller is in the right hand). Then convert_to_human.py builds
../human.json. All effects are invented for this example.
"""
import csv
import math
import os
import random

rng = random.Random(20261124)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)

TECHNIQUES = ["ray", "direct", "hybrid"]
ORDERS = [
    ["ray", "direct", "hybrid"],
    ["direct", "hybrid", "ray"],
    ["hybrid", "ray", "direct"],
    ["ray", "hybrid", "direct"],
    ["hybrid", "direct", "ray"],
    ["direct", "ray", "hybrid"],
]
# Six scored tasks: two near-row objects, two far-row objects, two on the shelf (about 3 m away).
TASKS = ["near", "near", "far", "far", "shelf", "shelf"]
BASE_SECONDS = {  # technique x location
    "ray": {"near": 5.5, "far": 6.5, "shelf": 8.0},
    "direct": {"near": 5.0, "far": 9.5, "shelf": 15.0},
    "hybrid": {"near": 5.2, "far": 7.0, "shelf": 8.8},
}
BASE_TELEPORTS = {"ray": {"near": 0, "far": 0, "shelf": 0.1}, "direct": {"near": 0, "far": 1.0, "shelf": 2.2}, "hybrid": {"near": 0, "far": 0.1, "shelf": 0.3}}
WRONG_RATE = {"ray": {"near": 0.12, "far": 0.22, "shelf": 0.3}, "direct": {"near": 0.03, "far": 0.05, "shelf": 0.06}, "hybrid": {"near": 0.04, "far": 0.14, "shelf": 0.2}}
WORKLOAD = {"ray": 2.6, "direct": 3.7, "hybrid": 2.8}
APPEAL = {"ray": 4.5, "direct": 5.2, "hybrid": 5.5}
EXPERIENCE = {"none": {"speed": 1.25, "workload": 0.6, "teleport": 0.4, "wrong": 1.3}, "some": {"speed": 1.0, "workload": 0.0, "teleport": 0.1, "wrong": 1.0}, "frequent": {"speed": 0.85, "workload": -0.4, "teleport": 0.0, "wrong": 0.8}}
LEARNING = [1.0, 0.94, 0.9]  # first, second, third technique in a person's order

clip = lambda x, lo, hi: max(lo, min(hi, x))

participants, demographics, trials, questionnaire, rankings = [], [], [], [], []
for i in range(12):
    pid = f"P{i + 1:02d}"
    order = ORDERS[i % 6]
    participants.append({"participant": pid, "order": " ".join(order)})
    xr = ["none", "some", "frequent"][i % 3] if i < 9 else rng.choice(["none", "some", "frequent"])
    gaming = clip(int(rng.gauss({"none": 2, "some": 6, "frequent": 11}[xr], 3)), 0, 20)
    hand = "left" if i in (4, 9) else "right"
    age = rng.choice(["18-24", "25-34", "25-34", "35-44"])
    demographics.append({"participant": pid, "age_band": age, "xr_experience": xr, "gaming_hours_per_week": gaming, "handedness": hand})
    e = EXPERIENCE[xr]
    utilities = {}
    for pos, tech in enumerate(order):
        speed = e["speed"] * LEARNING[pos] * (1 + rng.gauss(0, 0.06))
        if tech == "ray":
            speed *= 1 - min(0.15, 0.01 * gaming)
        if tech != "ray" and hand == "left":
            speed *= 1.08
        if tech == "direct" and xr == "none":
            speed *= 1.1
        errors_total = 0
        for t, where in enumerate(TASKS):
            seconds = BASE_SECONDS[tech][where] * speed * math.exp(rng.gauss(0, 0.18))
            p_wrong = clip(WRONG_RATE[tech][where] * e["wrong"] * (1 - (0.01 * gaming if tech == "ray" else 0)), 0.01, 0.6)
            wrong = 0
            while rng.random() < p_wrong and wrong < 4:
                wrong += 1
            errors_total += wrong
            seconds += wrong * 2.5
            lam = max(0.0, BASE_TELEPORTS[tech][where] + (e["teleport"] if tech == "direct" and where != "near" else 0))
            teleports = sum(1 for _ in range(6) if rng.random() < lam / 6)
            trials.append({"participant": pid, "technique": tech, "position": pos + 1, "task": t + 1, "location": where, "seconds": round(seconds, 2), "pickups": wrong + 1, "wrong_pickups": wrong, "teleports": teleports})
        load = WORKLOAD[tech] + e["workload"] + 0.15 * errors_total + rng.gauss(0, 0.35)
        items = {
            "mental": load + rng.gauss(0, 0.3),
            "physical": load + (0.9 if tech == "direct" else 0) + rng.gauss(0, 0.3),
            "temporal": load - 0.2 + rng.gauss(0, 0.3),
            "effort": load + (0.4 if tech == "direct" else 0) + rng.gauss(0, 0.3),
            "frustration": load - 0.4 + 0.25 * errors_total + rng.gauss(0, 0.3),
        }
        appeal = APPEAL[tech] + (0.03 * gaming if tech == "ray" else 0) + rng.gauss(0, 0.5)
        questionnaire.append({"participant": pid, "technique": tech, **{k: int(round(clip(v, 1, 7))) for k, v in items.items()}, "appeal": int(round(clip(appeal, 1, 7)))})
        utilities[tech] = appeal - load + rng.gauss(0, 0.4)
    inter = sorted(TECHNIQUES, key=lambda t: -utilities[t])
    overall = sorted(TECHNIQUES, key=lambda t: -(utilities[t] + rng.gauss(0, 0.5)))
    for tech in TECHNIQUES:
        rankings.append({"participant": pid, "technique": tech, "interaction_rank": inter.index(tech) + 1, "overall_rank": overall.index(tech) + 1})


def write(name, rows):
    with open(os.path.join(raw, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


write("participants.csv", participants)
write("demographics.csv", demographics)
write("trials.csv", trials)
write("questionnaire.csv", questionnaire)
write("rankings.csv", rankings)
print(f"wrote {len(participants)} participants, {len(trials)} scored tasks to {raw}")
