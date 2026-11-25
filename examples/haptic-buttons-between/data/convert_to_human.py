#!/usr/bin/env python3
"""Converts suite 6's raw files to ../human.json: one record per participant x outcome, for the one
design that participant used (between subjects).

  completion-time  geometric mean seconds per code over the 12 scored codes (practice excluded;
                   correcting wrong presses is part of the time)
  error-rate       wrong presses / all digit presses in the scored codes
  presence         1-7 ("the keypad felt as if it were really there")
  workload         Raw TLX: the six 0-100 items (mental, physical, temporal, performance, effort,
                   frustration), unweighted mean
  comfort          1-7
IDs must match ../study.json, and each participant's design must be the one study.json assigns.
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


assigned = {p["id"]: p["conditionOrder"][0] for p in study["participants"]}
for p in rows("participants.csv"):
    assert assigned.get(p["participant"]) == p["design"], p
records = []
add = lambda o, c, p, **v: records.append({"outcomeId": o, "conditionId": c, "participantId": p, **v})

codes = defaultdict(list)
for t in rows("trials.csv"):
    if t["block"] == "scored":
        codes[(t["participant"], t["design"])].append(t)
for (p, design), ts in sorted(codes.items()):
    assert assigned.get(p) == design, (p, design)
    add("completion-time", design, p, value=math.exp(sum(math.log(float(t["seconds"])) for t in ts) / len(ts)))
    add("error-rate", design, p, value=sum(int(t["wrong_presses"]) for t in ts) / sum(int(t["digit_presses"]) for t in ts))
TLX = ["mental", "physical", "temporal", "performance", "effort", "frustration"]
for q in rows("questionnaire.csv"):
    assert assigned.get(q["participant"]) == q["design"], q
    add("presence", q["design"], q["participant"], value=float(q["presence"]))
    add("workload", q["design"], q["participant"], components={k: float(q[k]) for k in TLX})
    add("comfort", q["design"], q["participant"], value=float(q["comfort"]))

out = {"schemaVersion": "1.0", "studyId": study["id"], "synthetic": True, "measurements": records}
with open(os.path.join(here, "..", "human.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"wrote {len(records)} records to human.json")
