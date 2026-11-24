# Unreal project for suite 1 (temperature visualization)

This is what an Unreal project needs so that agents can play suite 1 like participants, in Play In Editor (PIE), through an MCP runtime. It follows `study.json` and the outcome-blind description in `project-snapshot/`.

**Which project.** The synthetic suite has the same design as the real study. The **same Unreal project** can therefore serve both `examples/ecolar` (invented humans) and a private real-data study. Only the human reference differs. No Unreal project is included in this repository.

## What the study asks for

| `study.json` says | Meaning for the project |
| --- | --- |
| Designs `SP`, `VO`, `PP`, `HP` | Spheres, Volume, Probe Plane, Handheld Probe, switchable at start-up (`study.Design <ID>`) |
| Phases `practice` → `main` → `questionnaire` | Per design: 3 practice questions with feedback (2 place, 1 zone), then 8 place comparisons and 4 zone questions, then the questionnaire panel |
| Cases `<design>-practice`, `<design>-main`, each requiring `complete-task` | A case is complete when its block of trials has been answered |
| Measures: place/zone accuracy and time, confidence, workload, BeauVis, SSQ, five rankings | Logged for real participants. Agents never fill in questionnaires; they forecast them |
| Runtime: `unreal`, `editor`, observation `mono` | Agents see single desktop screenshots from PIE (no headset, no stereo) |
| Required capabilities: none | Declare what the bridge really provides, for example `screenshot, phase-events` |
| Configurations C, D and the U-series use the app | A, B, F and the -Dem variants need no Unreal at all |

## 1 · Editor and plugins

- Unreal Engine 5.x with the **OpenXR** plugin (for participants with a headset) and a VR pawn. Agents use desktop PIE, not VR Preview.
- **Remote Control API** plugin (built in). It serves UFUNCTIONs of actors over HTTP on `127.0.0.1` (default port 30010) while PIE runs. This is the simplest transport for the study API (step 3).
- **Python Editor Script Plugin** (optional). It is useful for Editor automation such as opening the map and starting or stopping PIE, if your MCP does not cover it.
- **Editor settings for unattended runs:**
  - Editor Preferences → General → Performance: turn **Use Less CPU when in Background** off;
  - PIE in a fixed-size **New Editor Window** (for example 1280 × 720), so screenshots are consistent.

## 2 · The virtual environment

- **Map:** one map, for example `L_OfficeBuilding`: a three-storey building with rooms, glass partitions and a stairwell. Start on the ground floor.
- **Temperature field:**
  - a fixed field per trial, stored with the project, for example a data table or a texture volume;
  - some place pairs differ by only 0.4 K, so hard comparisons exist in every design.
- **The four designs:**
  - one actor per design, enabled by the console variable or by the study API;
  - visual parameters as in `project-snapshot/Config/StudyDesigns.ini`;
  - PP moves its plane with the controller (and with the API); HP reads the value at its tip.
- **Locomotion:** room-scale plus teleport. Count completed teleports.
- **Trial content:** markers for place comparisons (two numbered markers) and four colored zones per floor for zone questions. Identical for every participant and every agent run, from fixed trial definitions with a seed.

## 3 · The study API inside the project

This is the equivalent of `window.xrStudy` in the WebXR example.

**If your project already has automation for its study** (functions that load a participant's trial schedule, set a trial, take an answer, adjust a design's tool, and a Play-In-Editor harness that moves a simulated participant), reuse it: the bridge can call those directly, for example through the engine plugin's script or HTTP endpoint, and nothing below has to be added. Keep such a project-specific bridge with the private study (`private/studies/<name>/runtime/`), and run it against an **isolated copy** of the project, never the lab copy that holds participant logs.

**For a new project**, add a `StudyController` actor with BlueprintCallable UFUNCTIONs, reachable through Remote Control, a small HTTP/WebSocket listener, or your MCP's "call function" tool:

| Function | Does |
| --- | --- |
| `GetState()` | Design, phase, trial number, instruction text, answered trials, teleports |
| `StartDesign(Design, Phase)` | Resets to a fresh state, switches the visualization, starts the practice or main block |
| `ListTargets()` | Neutral IDs of the current markers or zones with screen positions; no temperatures and no "correct" flag |
| `Look(Yaw, Pitch)` / `MoveTo(X, Y, Floor)` / `Teleport(X, Y)` | Moves the viewpoint the way a participant can. Teleports are counted |
| `MovePlane(Height)` (PP) / `PointProbe(X, Y, Z)` (HP) | Design-specific interaction. Readouts appear in the view as participants see them, not as returned numbers |
| `Answer(TargetId)` | Answers the current place or zone trial; advances to the next |
| `Capture()` | Writes a mono screenshot of the PIE viewport (for example with `HighResShot` or a `SceneCaptureComponent2D`) and returns its path |

**Rules:**
- No function may return temperatures, correctness, participants' answers or results.
- Design-specific readouts must be visible only in the image, exactly as a participant would see them.
- Shortcuts that bypass the interaction would change the study. Document any you add as a different interaction policy.

## 4 · Editor control and the MCP

The bridge (step 5) needs to:
- open the map, start and stop PIE;
- run console commands (`study.Design SP`);
- read the output log.

Use the Unreal MCP you already configured, if it covers these. It may be registered in Claude Code (setup lists it) or only in the project's own `.mcp.json`; a bridge can also talk to the engine plugin's endpoint directly.

**Make it MCP-independent:** expose two Editor utility functions, `StudyPlay(Design)` and `StudyStop()`, as an Editor Utility Blueprint or Python. Any MCP that can run a console command, a Python snippet or an editor function can then drive PIE.

## 5 · The study bridge and Settings

The bridge is a stdio MCP server in any language (Node, Python, …) following the [bridge contract](../../docs/runtime-adapters.md#study-bridge-contract). Keep it in the study folder, for example `private/studies/<name>/runtime/`. It is not included here.

1. **Start of a session.** Answer `initialize` and `tools/list` at once; connect to the editor on the first tool call. Read `XR_STUDY_JOB_FILE`: `app.designs` lists the designs in the participant's order for individual configurations, and `app.cases` lists the cases. Start a fresh PIE for every session.
2. **Report the runtime.** Write one `runtime` trace event: engine `unreal` and the editor's version, backend `editor`, observation `mono`, the capabilities really provided, and the device profile the bridge provides. That device profile must equal `study.json` → `runtime.deviceProfile`, or the audit lists a deviation.
3. **Participant tools for the agent:**
   - `open_design`, for practice, then main;
   - moving the viewpoint (`look`, `go_to`, `teleport`);
   - the design tools (fog for Volume, moving the plane for Probe Plane, pointing the probe for Handheld Probe);
   - `screenshot`, `answer`, `task_state`.

   Return the new view after every action, so the agent needs few separate screenshots.
4. **Trace.** Write to `XR_STUDY_TRACE`: `phase`, `case-start`; `observation` (mono capture hash); `action` `complete-task` with `completed: true` once the block is answered; `case-end` (`submitted: false` if left unfinished). Save screenshots to `screenshots/`, preferably as JPEG.
5. **Robustness.** Serialize calls and time out engine calls. Stop PIE when stdin closes. Never write to the project's own participant log folder.

Then, in **Settings → Runtimes → unreal**:
- **command:** the interpreter, for example `python` or `node`;
- **arguments:** `<bridge path> {jobFile}` plus what your bridge needs (project path, port, device profile). Relative paths are resolved against the repository;
- **capabilities:** what the bridge provides, for example `screenshot, phase-events`;
- **time limit** and **sessions at the same time:** the Unreal defaults (90 minutes, 1) fit. A full session answers 60 questions (4 × (3 practice + 12 main)); the configuration page shows the fewest tool calls this needs (74) against the budget (200);
- **guidance:** for example "Open the designs in the order given; each has 3 practice questions with feedback and 12 main questions, and every question needs an answer. Every action returns your new view. Your tool budget is shared by all calls: about two actions per question leave room to finish all four designs."

Also check `workspace.json` → `sources.project`. For real runs it may point at a read-only snapshot of the project's study code instead of `project-snapshot/`. Never point it at logs.

## 6 · Check before real runs

1. Test the bridge yourself (a scripted client is enough): open each design, take one capture, finish one practice and one main block, and check `trace.jsonl` (`runtime`, `phase`, `case-start`, `observation`, `action`, `case-end`).
2. In the workbench: **Freeze**, then **Run agents**. Select one session of configuration **C** and press **Run this session only**.
3. Then start the rest. A, B, F and the -Dem configurations can run at any time, since they need no Unreal.

The humans in `examples/ecolar` are invented, so real runs there test the pipeline and agent behaviour. For prediction accuracy, run the same configurations against a private study with real data.
