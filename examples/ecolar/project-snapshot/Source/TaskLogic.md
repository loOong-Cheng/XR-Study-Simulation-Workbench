# Task logic (synthetic example project)

**Sequence per design:** practice block, then main block, then the questionnaire panel. Designs follow the participant's order from `participants.csv`.

**Practice block:** two place comparisons and one zone question. The app shows "correct" or "incorrect" after each answer. Practice is not logged as scored data.

**Place comparison (8 per design):**
- Two numbered markers appear in different rooms, at least one floor or 8 m apart.
- The participant points at the marker they think is warmer and confirms with the trigger.
- Logged per trial: chosen marker, correct, response time from the markers appearing to the confirmation, and confidence (1–5, asked on a wrist panel).

**Zone question (4 per design):**
- A floor is divided into four colored zones.
- The participant names the warmest zone on the wrist panel.
- Logged per trial: answer, correct, response time and confidence.

**Temperature field:**
- One field per trial, sampled from the building simulation.
- Differences between compared places range from 0.4 K to 3 K, so some comparisons are hard in every design.

**Logging:**
- `Saved/StudyLogs/<participant>/trials.csv`;
- head and hand pose at 30 Hz in `poses.csv`;
- teleports in `events.csv`.
