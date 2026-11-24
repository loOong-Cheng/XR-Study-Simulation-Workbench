"""Convert the raw (synthetic) Ecolar study files into the workbench's human reference.

This is the study adapter: it decides which trials count and how items are combined, then
writes one record per participant x design x outcome. IDs must match ../study.json.

Decisions:
  place-accuracy, zone-accuracy      proportion correct over the 8 place / 4 zone trials
  place-time, zone-time              median seconds per person and design
  place-confidence, zone-confidence  mean 1-5 confidence over the same trials
  workload, beauvis                  questionnaire scores (1-7)
  ssq                                SSQ total score = raw score (N + O + D subscale sums) x 3.74, 0-235.62
  rank-*                             final ranks, 1 = best

Usage: python3 convert_to_human.py   -> ../human.json
"""
import csv
import json
import os
import statistics
from collections import defaultdict

here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
study = json.load(open(os.path.join(here, "..", "study.json")))


def rows(name):
    with open(os.path.join(raw, name)) as f:
        return list(csv.DictReader(f))


orders = {p["id"]: "|".join(p["conditionOrder"]) for p in study["participants"]}
for p in rows("participants.csv"):
    if orders.get(p["participant"]) != p["order"]:
        raise SystemExit(f"Order mismatch for {p['participant']}: update the study definition.")

out = []
add = lambda pid, d, outcome, value: out.append({"participantId": pid, "conditionId": d, "outcomeId": outcome, "value": round(value, 4)})

by = defaultdict(list)
for t in rows("trials.csv"):
    by[(t["participant"], t["design"], t["task"])].append(t)
for (pid, d, task), ts in sorted(by.items()):
    add(pid, d, f"{task}-accuracy", sum(int(t["correct"]) for t in ts) / len(ts))
    add(pid, d, f"{task}-time", statistics.median(float(t["seconds"]) for t in ts))
    add(pid, d, f"{task}-confidence", sum(int(t["confidence"]) for t in ts) / len(ts))
for q in rows("questionnaire.csv"):
    add(q["participant"], q["design"], "workload", float(q["workload"]))
    add(q["participant"], q["design"], "beauvis", float(q["beauvis"]))
    add(q["participant"], q["design"], "ssq", int(q["ssq_raw"]) * 3.74)
for r in rows("rankings.csv"):
    for d in ("SP", "VO", "PP", "HP"):
        add(r["participant"], d, f"rank-{r['question']}", int(r[d]))

json.dump({"schemaVersion": "1.0", "studyId": study["id"], "synthetic": True, "measurements": out}, open(os.path.join(here, "..", "human.json"), "w"), indent=1)
print(f"Wrote {len(out)} measurements to ../human.json")
