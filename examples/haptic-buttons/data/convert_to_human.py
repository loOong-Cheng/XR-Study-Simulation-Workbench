#!/usr/bin/env python3
"""Converts suite 5's raw files to ../human.json: one record per participant x design x outcome.

Decisions made here (the study adapter):
  completion-time  geometric mean seconds over the ten scored sequences (phase "main"); practice excluded
  error-rate       wrong digit presses / all digit presses in the scored sequences (delete presses not counted)
  overshoot        mean overshoot past the activation plane over all digit presses in the scored sequences
                   (each sequence's mean weighted by its number of presses)
  confidence       single 1-7 item
  workload         the six raw NASA-TLX items (0-100) as components; study.json declares the rule
                   ("componentRule": "mean"), so the workbench takes their unweighted mean (0-100)
  presence         single 1-7 item
  preference       final rank, 1 = best
IDs must match ../study.json. The practice rows (and data/raw/movement_practice.csv) are never scored.
"""
import csv
import json
import math
import os
from collections import defaultdict

here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "..", "study.json"), encoding="utf-8") as f:
    study = json.load(f)


def rows(name):
    with open(os.path.join(here, "raw", name), encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


ids = {p["id"] for p in study["participants"]}
designs = {c["id"] for c in study["conditions"]}
TLX = ["mental", "physical", "temporal", "performance", "effort", "frustration"]
records = []
add = lambda o, c, p, **v: records.append({"outcomeId": o, "conditionId": c, "participantId": p, **v})

scored = defaultdict(list)
for t in rows("trials.csv"):
    if t["phase"] == "main":
        scored[(t["participant"], t["design"])].append(t)
for (p, design), ts in sorted(scored.items()):
    assert p in ids and design in designs, (p, design)
    assert len(ts) == 10, (p, design, len(ts))
    presses = sum(int(t["digit_presses"]) for t in ts)
    add("completion-time", design, p, value=math.exp(sum(math.log(float(t["seconds"])) for t in ts) / len(ts)))
    add("error-rate", design, p, value=sum(int(t["wrong_presses"]) for t in ts) / presses)
    add("overshoot", design, p, value=sum(float(t["overshoot_mm"]) * int(t["digit_presses"]) for t in ts) / presses)
for q in rows("questionnaire.csv"):
    add("confidence", q["design"], q["participant"], value=float(q["confidence"]))
    add("workload", q["design"], q["participant"], components={k: float(q[f"tlx_{k}"]) for k in TLX})
    add("presence", q["design"], q["participant"], value=float(q["presence"]))
for r in rows("rankings.csv"):
    add("preference", r["design"], r["participant"], value=int(r["preference_rank"]))

out = {"schemaVersion": "1.0", "studyId": study["id"], "synthetic": True, "measurements": records}
with open(os.path.join(here, "..", "human.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"wrote {len(records)} records to human.json")
