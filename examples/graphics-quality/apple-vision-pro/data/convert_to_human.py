"""Convert the raw (synthetic) study files into the workbench's human reference.

This is the "study adapter" every project writes once: it decides which trials
count and how questionnaire items are combined, then writes one record per
participant x design x outcome. Outcome and design IDs must match the study
definition (../study.json).

Decisions made here (document yours the same way):
  search-time       geometric mean of the 4 scored main trials; practice excluded
  selection-errors  mean wrong selections per main trial
  presence          four items kept separately as components (the workbench averages them)
  realism, appeal   single 1-7 items
  visual-discomfort single 0-10 item
  preference        final rank, 1 = best

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


def rows(name):
    with open(os.path.join(raw, name), encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


# Check that the recorded orders match the study definition.
orders = {p["id"]: "|".join(p["conditionOrder"]) for p in study["participants"]}
for p in rows("participants.csv"):
    if orders.get(p["participant"]) != p["order"]:
        raise SystemExit(f"Order mismatch for {p['participant']}: update the study definition.")

measurements = []
times, errors = defaultdict(list), defaultdict(list)
for t in rows("trials.csv"):
    if t["phase"] != "main":
        continue
    key = (t["participant"], t["quality"])
    times[key].append(float(t["seconds"]))
    errors[key].append(int(t["errors"]))
for (pid, level), values in sorted(times.items()):
    measurements.append(
        {
            "participantId": pid,
            "conditionId": level,
            "outcomeId": "search-time",
            "value": round(math.exp(sum(math.log(v) for v in values) / len(values)), 4),
        }
    )
    measurements.append(
        {
            "participantId": pid,
            "conditionId": level,
            "outcomeId": "selection-errors",
            "value": round(sum(errors[(pid, level)]) / len(errors[(pid, level)]), 4),
        }
    )
for q in rows("questionnaire.csv"):
    base = {"participantId": q["participant"], "conditionId": q["quality"]}
    measurements.append(
        {
            **base,
            "outcomeId": "presence",
            "components": {
                "general": int(q["ipq_general"]),
                "spatial": int(q["ipq_spatial"]),
                "involvement": int(q["ipq_involvement"]),
                "realness": int(q["ipq_realness"]),
            },
        }
    )
    measurements.append({**base, "outcomeId": "realism", "value": int(q["realism"])})
    measurements.append({**base, "outcomeId": "appeal", "value": int(q["appeal"])})
    measurements.append({**base, "outcomeId": "visual-discomfort", "value": int(q["discomfort"])})
for p in rows("preferences.csv"):
    for level in ("low", "medium", "high"):
        measurements.append(
            {
                "participantId": p["participant"],
                "conditionId": level,
                "outcomeId": "preference",
                "value": int(p[f"rank_{level}"]),
            }
        )

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
