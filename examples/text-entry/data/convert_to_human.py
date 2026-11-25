#!/usr/bin/env python3
"""Converts suite 7's raw files to ../human.json: one record per participant x keyboard x outcome.

  wpm          entry speed: mean over the ten scored phrases of (|T| - 1) / S x 60 / 5, where T is the
               transcribed phrase and S the seconds from the first key (or gesture) to Enter
  error-rate   uncorrected error rate: mean over the ten phrases of MSD(P, T) / max(|P|, |T|), the
               minimum string distance (Levenshtein) between presented and transcribed phrase
  entry-time   geometric mean of the ten phrases' seconds (practice is not logged)
  tlx          the six raw NASA-TLX items, 0-100 (the composite is their mean)
  arm-comfort  1-7
  preference   rank after all four keyboards, 1 = first
IDs and every person's keyboard order must match ../study.json.
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


def msd(a, b):
    """Minimum string distance (Levenshtein): insertions, deletions and substitutions."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


orders = {p["id"]: p["conditionOrder"] for p in study["participants"]}
keyboards = {c["id"] for c in study["conditions"]}
for p in rows("participants.csv"):
    assert orders.get(p["participant"]) == p["order"].split(), p
records = []
add = lambda o, c, p, **v: records.append({"outcomeId": o, "conditionId": c, "participantId": p, **v})

phrases = defaultdict(list)
for r in rows("phrases.csv"):
    phrases[(r["participant"], r["keyboard"])].append(r)
for (p, kb), ps in sorted(phrases.items()):
    assert p in orders and kb in keyboards and len(ps) == 10, (p, kb, len(ps))
    seconds = [float(r["seconds"]) for r in ps]
    add("wpm", kb, p, value=sum((len(r["transcribed"]) - 1) / s * 60 / 5 for r, s in zip(ps, seconds)) / len(ps))
    add("error-rate", kb, p, value=sum(msd(r["presented"], r["transcribed"]) / max(len(r["presented"]), len(r["transcribed"])) for r in ps) / len(ps))
    add("entry-time", kb, p, value=math.exp(sum(math.log(s) for s in seconds) / len(seconds)))
for q in rows("questionnaire.csv"):
    add("tlx", q["keyboard"], q["participant"], components={k: float(q[f"tlx_{k}"]) for k in ["mental", "physical", "temporal", "performance", "effort", "frustration"]})
    add("arm-comfort", q["keyboard"], q["participant"], value=float(q["arm_comfort"]))
for r in rows("ranking.csv"):
    add("preference", r["keyboard"], r["participant"], value=int(r["rank"]))

out = {"schemaVersion": "1.0", "studyId": study["id"], "synthetic": True, "measurements": records}
with open(os.path.join(here, "..", "human.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
print(f"wrote {len(records)} records to human.json")
