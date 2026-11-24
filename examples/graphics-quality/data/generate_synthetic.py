"""Generate an invented (synthetic) user study for the graphics-quality toy example.

18 participants try the WebXR room at three graphics-quality levels (low, medium,
high) in a fully counterbalanced within-subjects design. The script writes the
kind of raw files a real study produces:

  raw/participants.csv   participant ID and the order in which they saw the levels
  raw/demographics.csv   age band, XR experience, gaming hours (allowed agent input)
  raw/trials.csv         one row per trial: time and wrong selections
  raw/questionnaire.csv  one row per participant x level: presence items, realism,
                         appeal and visual discomfort
  raw/preferences.csv    final ranking of the three levels (1 = best)

Nothing here comes from real people. The built-in effects are a toy assumption:
higher quality makes material cues visible (faster, fewer errors) and raises
presence, realism and appeal; visual discomfort is lowest at medium.

Usage: python3 generate_synthetic.py   (deterministic; seed below)
"""
import csv
import itertools
import math
import os
import random

SEED = 2026
LEVELS = ["low", "medium", "high"]
ORDERS = list(itertools.permutations(LEVELS))  # all 6 orders
N = 18  # 3 participants per order
MAIN_TRIALS = 4

# Toy population means per level (1-7 scales unless noted).
PRESENCE = {"low": 3.6, "medium": 4.4, "high": 5.0}
REALNESS_BONUS = {"low": -0.4, "medium": 0.0, "high": 0.5}  # realness item reacts most
REALISM = {"low": 2.5, "medium": 4.3, "high": 5.7}
APPEAL = {"low": 3.4, "medium": 4.7, "high": 5.3}
DISCOMFORT = {"low": 2.4, "medium": 2.0, "high": 2.6}  # 0-10 scale
TIME_FACTOR = {"low": 1.25, "medium": 1.08, "high": 1.0}
ERROR_RATE = {"low": 0.9, "medium": 0.45, "high": 0.25}  # wrong selections per trial
BLOCK_FACTOR = {1: 1.0, 2: 0.92, 3: 0.86}  # learning across blocks

rng = random.Random(SEED)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)


def likert(mean, lo=1, hi=7):
    return max(lo, min(hi, round(rng.gauss(mean, 0.8))))


def poisson(lam):
    # Knuth's method; small lambdas only.
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


participants, demographics, trials, questionnaire, preferences = [], [], [], [], []
for i in range(N):
    pid = f"p{i + 1:02d}"
    order = ORDERS[i % len(ORDERS)]
    participants.append({"participant": pid, "order": "|".join(order)})
    experience = rng.choice(["none", "some", "some", "frequent"])
    gaming = {"none": 0, "some": 3, "frequent": 8}[experience] + rng.randint(0, 4)
    demographics.append(
        {
            "participant": pid,
            "age_band": rng.choice(["18-24", "25-34", "25-34", "35-44"]),
            "xr_experience": experience,
            "gaming_hours_per_week": gaming,
        }
    )
    # Person-level tendencies.
    speed = math.exp(rng.gauss(0, 0.2))
    presence_bias = rng.gauss(0, 0.5)
    taste = rng.gauss(0, 0.4)
    sickness = rng.gauss(0, 0.8) - (0.6 if experience == "frequent" else 0)

    appeal_scores = {}
    for block, level in enumerate(order, start=1):
        # Practice trial (not scored) plus scored main trials.
        for t in range(MAIN_TRIALS + 1):
            phase = "practice" if t == 0 else "main"
            base = 9.0 if phase == "practice" else 22.0
            seconds = base * TIME_FACTOR[level] * BLOCK_FACTOR[block] * speed * math.exp(rng.gauss(0, 0.15))
            errors = poisson(ERROR_RATE[level] * (0.5 if phase == "practice" else 1.0))
            trials.append(
                {
                    "participant": pid,
                    "quality": level,
                    "block": block,
                    "phase": phase,
                    "trial": t,
                    "seconds": round(seconds, 2),
                    "errors": errors,
                }
            )
        p = PRESENCE[level] + presence_bias - 0.1 * (block - 1)
        row = {
            "participant": pid,
            "quality": level,
            "block": block,
            "ipq_general": likert(p),
            "ipq_spatial": likert(p + 0.2),
            "ipq_involvement": likert(p - 0.2),
            "ipq_realness": likert(p + REALNESS_BONUS[level]),
            "realism": likert(REALISM[level] + 0.5 * presence_bias),
            "appeal": likert(APPEAL[level] + taste),
            "discomfort": likert(DISCOMFORT[level] + sickness, 0, 10),
        }
        questionnaire.append(row)
        appeal_scores[level] = row["appeal"] + rng.gauss(0, 0.6)
    ranked = sorted(LEVELS, key=lambda lv: -appeal_scores[lv])
    preferences.append({"participant": pid, **{f"rank_{lv}": ranked.index(lv) + 1 for lv in LEVELS}})


def write(name, rows):
    with open(os.path.join(raw, name), "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


write("participants.csv", participants)
write("demographics.csv", demographics)
write("trials.csv", trials)
write("questionnaire.csv", questionnaire)
write("preferences.csv", preferences)
print(f"Wrote synthetic raw data for {N} participants to {raw}")
