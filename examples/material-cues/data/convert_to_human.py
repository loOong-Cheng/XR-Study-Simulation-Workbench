#!/usr/bin/env python3
"""Convert the raw (synthetic) study files of suite 4 into the workbench's human reference.

This is the "study adapter" every project writes once: it decides which trials count and how
questionnaire items are combined, then writes one record per participant x design x outcome.
Outcome and design IDs must match the study definition (../study.json).

Decisions made here:
  search-time              geometric mean of the four search trials; practice excluded
  wrong-selections         wrong selections summed over the four search trials (a count)
  identification-accuracy  correct answers / six identification trials
  presence                 four items kept separately as components (the workbench averages them)
  appeal                   single 1-7 item
  preference               rank at the end of the session, 1 = preferred

Usage: python3 convert_to_human.py   -> ../human.json
"""
import csv
import json
import math
import os
from collections import defaultdict

here = os.path.dirname(os.path.abspath(__file__))
raw = os.path.join(here, "raw")
with open(os.path.join(here, "..", "study.json"), encoding="utf-8") as f:
    study = json.load(f)
designs = [c["id"] for c in study["conditions"]]


def rows(name):
    with open(os.path.join(raw, name), encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


# The recorded orders must match the study definition.
orders = {p["id"]: "|".join(p["conditionOrder"]) for p in study["participants"]}
for p in rows("participants.csv"):
    if orders.get(p["participant"]) != p["order"]:
        raise SystemExit(f"Order mismatch for {p['participant']}: update the study definition.")

measurements = []
times, wrong = defaultdict(list), defaultdict(int)
for t in rows("search_trials.csv"):
    if t["phase"] != "main":
        continue
    key = (t["participant"], t["quality"])
    times[key].append(float(t["seconds"]))
    wrong[key] += int(t["wrong_selections"])
answers = defaultdict(list)
for a in rows("identification.csv"):
    answers[(a["participant"], a["quality"])].append(int(a["correct"]))
for (pid, design), values in sorted(times.items()):
    base = {"participantId": pid, "conditionId": design}
    if len(values) != 4 or len(answers[(pid, design)]) != 6:
        raise SystemExit(f"{pid} {design}: expected 4 search trials and 6 identification trials.")
    measurements.append({**base, "outcomeId": "search-time", "value": round(math.exp(sum(math.log(v) for v in values) / len(values)), 4)})
    measurements.append({**base, "outcomeId": "wrong-selections", "value": wrong[(pid, design)]})
    correct = answers[(pid, design)]
    measurements.append({**base, "outcomeId": "identification-accuracy", "value": round(sum(correct) / len(correct), 4)})
for q in rows("questionnaire.csv"):
    base = {"participantId": q["participant"], "conditionId": q["quality"]}
    measurements.append(
        {
            **base,
            "outcomeId": "presence",
            "components": {
                "general": int(q["presence_general"]),
                "spatial": int(q["presence_spatial"]),
                "involvement": int(q["presence_involvement"]),
                "realness": int(q["presence_realness"]),
            },
        }
    )
    measurements.append({**base, "outcomeId": "appeal", "value": int(q["appeal"])})
for p in rows("preferences.csv"):
    for design in designs:
        measurements.append({"participantId": p["participant"], "conditionId": design, "outcomeId": "preference", "value": int(p[f"rank_{design}"])})

out = {
    "schemaVersion": "1.0",
    "studyId": study["id"],
    "synthetic": True,
    "measurements": measurements,
}
path = os.path.join(here, "..", "human.json")
with open(path, "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=1)
    f.write("\n")
print(f"Wrote {len(measurements)} human records to {path}")
