#!/usr/bin/env python3
"""Converts suite 2's raw files to ../human.json: one record per participant x technique x outcome.

  completion-time        geometric mean seconds over the six scored tasks (practice excluded)
  accuracy               correct pickups / all pickups in the scored tasks
  teleports              completed teleports per scored task
  workload               five 1-7 items (mental, physical, temporal, effort, frustration)
  appeal                 1-7
  interaction-preference rank, 1 = preferred to interact with
  overall-preference     rank, 1 = preferred overall
IDs must match ../study.json.
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
techniques = {c["id"] for c in study["conditions"]}
records = []
add = lambda o, c, p, **v: records.append({"outcomeId": o, "conditionId": c, "participantId": p, **v})

tasks = defaultdict(list)
for t in rows("trials.csv"):
    tasks[(t["participant"], t["technique"])].append(t)
for (p, tech), ts in sorted(tasks.items()):
    assert p in ids and tech in techniques, (p, tech)
    add("completion-time", tech, p, value=math.exp(sum(math.log(float(t["seconds"])) for t in ts) / len(ts)))
    pickups = sum(int(t["pickups"]) for t in ts)
    add("accuracy", tech, p, value=len(ts) / pickups)
    add("teleports", tech, p, value=sum(int(t["teleports"]) for t in ts) / len(ts))
for q in rows("questionnaire.csv"):
    add("workload", q["technique"], q["participant"], components={k: float(q[k]) for k in ["mental", "physical", "temporal", "effort", "frustration"]})
    add("appeal", q["technique"], q["participant"], value=float(q["appeal"]))
for r in rows("rankings.csv"):
    add("interaction-preference", r["technique"], r["participant"], value=int(r["interaction_rank"]))
    add("overall-preference", r["technique"], r["participant"], value=int(r["overall_rank"]))

out = {"schemaVersion": "1.0", "studyId": study["id"], "synthetic": True, "measurements": records}
with open(os.path.join(here, "..", "human.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"wrote {len(records)} records to human.json")
