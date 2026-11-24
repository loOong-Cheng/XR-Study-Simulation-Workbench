"""Generate an invented (synthetic) version of the Ecolar VR temperature-visualization study.

The study design mirrors the published setup:
- 24 participants and four designs (Spheres, Volume, Probe Plane, Handheld Probe), within subjects;
- a 4x4 Williams square, six participants per order;
- per design, a practice task, then 8 place-comparison and 4 zone trials, then questionnaires;
- a final ranking of the four designs on five questions.

EVERY NUMBER HERE IS INVENTED. Nothing was taken or fitted from the real participants. The design
effects below are arbitrary choices made to give the example a clear but imperfect pattern. They
do not reproduce (and are not meant to resemble) the real study's results.

The script writes the kind of raw files a real study produces:

  raw/participants.csv   participant ID and design order
  raw/demographics.csv   age, gender, education, field, handedness, VR experience (allowed agent input)
  raw/trials.csv         one row per trial: task, correct, seconds, confidence 1-5
  raw/questionnaire.csv  one row per participant x design: workload 1-7, BeauVis 1-7, SSQ raw score 0-63
  raw/rankings.csv       one row per participant x question: rank of each design (1 = best)
  raw/trajectories.csv   movement summary per participant x design x phase (practice and main; agent input)
  raw/trajectories_main.csv  the same for the main task only (compact agent input)

Usage: python3 generate_synthetic.py   (deterministic; seed below), then python3 convert_to_human.py
"""
import csv
import math
import os
import random

SEED = 4711
DESIGNS = ["SP", "VO", "PP", "HP"]
# 4x4 Williams square (balanced for first-order carry-over), six participants per row.
WILLIAMS = [["SP", "VO", "HP", "PP"], ["VO", "PP", "SP", "HP"], ["PP", "HP", "VO", "SP"], ["HP", "SP", "PP", "VO"]]
N = 24
PLACE_TRIALS, ZONE_TRIALS = 8, 4

# Invented design effects (see the note above).
PLACE_P = {"SP": 0.72, "VO": 0.60, "PP": 0.81, "HP": 0.77}  # chance of a correct place comparison
ZONE_P = {"SP": 0.52, "VO": 0.74, "PP": 0.66, "HP": 0.48}  # chance of a correct zone judgement
PLACE_S = {"SP": 9.0, "VO": 11.5, "PP": 8.0, "HP": 13.0}  # typical seconds per place trial
ZONE_S = {"SP": 15.0, "VO": 10.0, "PP": 12.5, "HP": 17.0}  # typical seconds per zone trial
WORKLOAD = {"SP": 3.3, "VO": 4.1, "PP": 3.1, "HP": 3.9}  # 1-7, higher = more demanding
BEAUVIS = {"SP": 4.7, "VO": 5.3, "PP": 4.3, "HP": 4.0}  # 1-7, higher = more appealing
SSQ_RAW = {"SP": 4.0, "VO": 6.0, "PP": 3.0, "HP": 7.0}  # mean SSQ raw score (N + O + D subscale sums, 0-63)
# Utilities behind the five final rankings (higher = ranked better).
RANK_UTILITY = {
    "places": {"SP": 0.4, "VO": -0.6, "PP": 0.8, "HP": 0.2},
    "zones": {"SP": -0.2, "VO": 0.9, "PP": 0.3, "HP": -0.5},
    "interaction": {"SP": 0.0, "VO": -0.3, "PP": 0.2, "HP": 0.7},
    "building": {"SP": 0.1, "VO": 0.8, "PP": 0.0, "HP": -0.6},
    "overall": {"SP": 0.2, "VO": 0.4, "PP": 0.5, "HP": -0.1},
}
POSITION_SPEED = {1: 1.0, 2: 0.93, 3: 0.88, 4: 0.85}  # learning across blocks

rng = random.Random(SEED)
here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
os.makedirs(raw, exist_ok=True)


def clip(x, lo, hi):
    return max(lo, min(hi, x))


def write(name, rows):
    with open(os.path.join(raw, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()), lineterminator="\n")
        w.writeheader()
        w.writerows(rows)


participants, demographics, trials, questionnaire, rankings, trajectories = [], [], [], [], [], []
for i in range(N):
    pid = f"P{i + 1:02d}"
    order = WILLIAMS[i % 4]
    participants.append({"participant": pid, "order": "|".join(order)})
    vr = rng.choice(["none", "some", "some", "regular"])
    age = rng.randint(20, 41)
    demographics.append(
        {
            "participant": pid,
            "age": age,
            "gender": rng.choice(["woman", "man", "man", "woman", "non-binary"]),
            "education": rng.choice(["bachelor", "master", "master", "doctorate"]),
            "field": rng.choice(["engineering", "architecture", "computer science", "natural sciences"]),
            "handedness": rng.choice(["right"] * 9 + ["left"]),
            "vr_experience": vr,
        }
    )
    # Person-level tendencies (invented).
    skill = rng.gauss(0, 0.35) + (0.25 if vr == "regular" else 0)
    speed = math.exp(rng.gauss(0, 0.18) + 0.006 * (age - 28)) * (0.9 if vr == "regular" else 1.0)
    strain = rng.gauss(0, 0.5)
    susceptibility = max(0.2, math.exp(rng.gauss(0, 0.5)) * (0.6 if vr == "regular" else 1.0))
    taste = {d: rng.gauss(0, 0.35) for d in DESIGNS}
    explorer = math.exp(rng.gauss(0, 0.25))

    for position, d in enumerate(order, start=1):
        pace = speed * POSITION_SPEED[position]
        logit = lambda p: math.log(p / (1 - p))
        for task, count, p, seconds in (("place", PLACE_TRIALS, PLACE_P[d], PLACE_S[d]), ("zone", ZONE_TRIALS, ZONE_P[d], ZONE_S[d])):
            prob = 1 / (1 + math.exp(-(logit(p) + skill)))
            for t in range(1, count + 1):
                correct = 1 if rng.random() < prob else 0
                trials.append(
                    {
                        "participant": pid,
                        "design": d,
                        "position": position,
                        "task": task,
                        "trial": t,
                        "correct": correct,
                        "seconds": round(seconds * pace * math.exp(rng.gauss(0, 0.25)), 2),
                        "confidence": int(clip(round(rng.gauss(2.6 + 2.0 * prob + 0.4 * correct, 0.7)), 1, 5)),
                    }
                )
        questionnaire.append(
            {
                "participant": pid,
                "design": d,
                "workload": round(clip(WORKLOAD[d] + strain + rng.gauss(0, 0.5), 1, 7), 2),
                "beauvis": round(clip(BEAUVIS[d] + taste[d] + rng.gauss(0, 0.5), 1, 7), 2),
                "ssq_raw": int(clip(round(SSQ_RAW[d] * susceptibility + rng.gauss(0, 1.5)), 0, 63)),
            }
        )
        for phase, minutes in (("practice", 1.5), ("main", 6.0)):
            trajectories.append(
                {
                    "participant": pid,
                    "design": d,
                    "phase": phase,
                    "duration_s": round(minutes * 60 * pace * math.exp(rng.gauss(0, 0.15)), 1),
                    "head_path_m": round(minutes * 9 * explorer * (1.4 if d == "HP" else 1.0) * math.exp(rng.gauss(0, 0.2)), 1),
                    "head_turn_deg": round(minutes * 700 * explorer * (1.3 if d in ("HP", "PP") else 1.0) * math.exp(rng.gauss(0, 0.2))),
                    "teleports": max(0, round(minutes * 3 * explorer * (0.6 if d == "VO" else 1.0) + rng.gauss(0, 1.5))),
                    "hand_path_m": round(minutes * (7 if d in ("HP", "PP") else 3) * explorer * math.exp(rng.gauss(0, 0.25)), 1),
                }
            )
    for question, utility in RANK_UTILITY.items():
        score = {d: utility[d] + taste[d] + rng.gauss(0, 0.6) for d in DESIGNS}
        ordered = sorted(DESIGNS, key=lambda d: -score[d])
        rankings.append({"participant": pid, "question": question, **{d: ordered.index(d) + 1 for d in DESIGNS}})

write("participants.csv", participants)
write("demographics.csv", demographics)
write("trials.csv", trials)
write("questionnaire.csv", questionnaire)
write("rankings.csv", rankings)
write("trajectories.csv", trajectories)
write("trajectories_main.csv", [t for t in trajectories if t["phase"] == "main"])
print(f"Wrote {N} invented participants to {raw}")
