# Unreal project snapshot (synthetic example)

This is an outcome-blind description of the study app, written for this example. A real study would give agents a read-only allowlist of the project's own files instead. It contains no participant data.

- `Config/StudyDesigns.ini`: the four visualization designs and their parameters.
- `Source/TaskLogic.md`: how trials, practice, scoring and logging work.
- `Source/Building.md`: the building model and the temperature field.

**Engine:** Unreal Engine 5, OpenXR, one map (`L_OfficeBuilding`). The design is chosen at start-up with the console variable `study.Design` (SP, VO, PP or HP).
