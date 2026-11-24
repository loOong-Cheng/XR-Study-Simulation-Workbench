# External XR execution

The executor runs real agent sessions through the built-in **WebXR** runtime or through a **study bridge** set for an engine runtime in **Settings**, on the machine that runs the engine (see [MCP runtimes used by the executor](#mcp-runtimes-used-by-the-executor)). Suite 2 ships a Unity bridge; no Unreal or visionOS bridge is included, and no headset, OpenXR or Meta runtime connection has been verified. A runtime that is not configured fails explicitly and names itself. **Simulate** produces invented runs (`syntheticResults`), always marked synthetic. `RuntimeAdapter` and `ProtocolGate` in `src/core/protocol.ts` are an optional library contract for a controller of your own; the executor does not use them.

## Engine, runtime and observation are separate

| Axis        | Examples                                                            | What to record                                                                        |
| ----------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Engine      | Unreal, Unity, custom                                               | Engine version, project/build snapshot, study controls                                |
| Runtime     | Meta XR Simulator, compatible OpenXR runtime, editor-only emulation | Runtime/SDK version, device profile, actual supported extensions and capabilities     |
| Observation | Mono image, synchronized stereo pair                                | Delivered eye images, resolution, per-eye geometry, timestamps, screenshot provenance |

Meta XR Simulator is a vendor-specific OpenXR simulation option. It supports Unreal and Unity in documented configurations; do not infer support for every engine, OS or headset. Current Unreal editor integration is Windows-based. Unity documentation includes Windows and Apple Silicon macOS. Confirm pinned versions on the actual machine.

Unreal's editor preview can also use stereo emulation, while Unity has separate facilities for input simulation and mock stereo rendering. A stereo mirror window is not, by itself, evidence that two-eye observations reached the agent. Meta's current recording CLI defaults to one eye unless both are requested. A mock runtime does not reproduce headset optics, physical discomfort or human stereopsis.

Primary documentation reviewed for this design (22 November 2026):

- [Meta XR Simulator for Unreal](https://developers.meta.com/vr/documentation/unreal/xrsim-getting-started/)
- [Meta XR Simulator for Unity](https://developers.meta.com/vr/documentation/unity/unity-simulate-xrsim/)
- [Meta VR CLI](https://github.com/meta-quest/agentic-tools/blob/main/docs/metavr-cli.md)
- [Epic stereo-rendering profiling guide](https://dev.epicgames.com/community/learning/tutorials/bOLv/unreal-engine-profiling-with-stereo-rendering-xr)
- [Unity Mock HMD](https://docs.unity3d.com/Packages/com.unity.xr.mock-hmd@1.3/manual/index.html)
- [Unity XR Device Simulator](https://docs.unity3d.com/Packages/com.unity.xr.interaction.toolkit@3.0/manual/xr-device-simulator-overview.html)

These links document vendor facilities, not successful integration tests performed by this repository.

## MCP runtimes used by the executor

The executor runs each agent session as headless Claude Code with exactly two kinds of MCP server:

- **study** (`src/runtimes/study-mcp.ts`, always): `list_files` / `read_file` limited to the permitted project folder, and `submit_forecast`, which checks that the forecast covers every design × each measure the configuration predicts and ends the session. It enforces the tool budget and writes the audit trace. Paths are checked after resolving symlinks, so a link cannot lead out of the folder. Files named `human.json`, and the `campaigns/`, `runs/` and `deleted/` folders of any study folder, are never listed or read (`src/runtimes/guard.ts`). The built-in WebXR runtime serves its app folder under the same rule. A study bridge that reads files for the agent should do the same.
- **the configuration's runtime**:

| Runtime | Server | Notes |
| --- | --- | --- |
| `webxr` | Built in: `src/runtimes/webxr-mcp.ts` | Serves the app folder from `workspace.json`, drives it in headless Chrome over the DevTools protocol and calls the app's `window.xrStudy` ([contract below](#the-windowxrstudy-contract)). The tools follow what the app declares. Mono screenshots only. |
| `unreal` | Your Unreal MCP, wrapped in a study bridge (below) | Set in Settings on the machine that runs Unreal. |
| `unity` | A study bridge (below), set in Settings → Runtimes → unity | Suite 2 ships one: `examples/selection/runtime/bridge.py` (Python, standard library) drives the included Unity project in Play mode; no third-party Unity MCP is needed (`examples/selection/UNITY_SETUP.md`). Until it is set: "Unity MCP runtime is not configured". |
| `visionos` | A visionOS simulator MCP server | Not configured: Apple Vision Pro needs a visionOS simulator runtime. |

A runtime for another engine should offer participant-like tools:
- open a design (and start its practice task);
- look or move;
- screenshot (mono, or a synchronized left/right pair with per-eye geometry);
- act or select;
- task state.

It should log the audit trace events `runtime`, `phase`, `case-start`, `observation`, `action` and `case-end` to `<job-dir>/trace.jsonl`, in the shape the WebXR server writes (see "What it logs" below).

## The window.xrStudy contract

The built-in WebXR runtime serves a study's app folder, opens it in headless Chrome (1280 × 720) and plays it through one JavaScript object, `window.xrStudy`. Any app works: a three.js scene, a canvas, plain HTML. `examples/graphics-quality/webxr-app/main.js` is a complete example.

### Declare the app in workspace.json

```json
"app": {
  "serve": "app",
  "query": "?width={condition}&study=1&participant={participant}",
  "capabilities": ["pointer-xy", "phase-events", "quality-lock"],
  "actions": [{ "name": "teleport", "description": "Teleport to a marker", "params": { "to": "marker name" }, "scored": true }],
  "instructions": "Targets are small circles on a ring; the blue one is active."
}
```

- `serve`: the app folder (inside the study folder); `query`: the URL per design (`{condition}` is the design ID; `{participant}` the person of an individual job, `population` otherwise).
- `capabilities`: what the app provides. The agent gets only the tools of declared capabilities, the runtime reports them in its `runtime` trace event, and the executor blocks configurations whose study requires a capability (`study.json` → `runtime.requiredCapabilities`) the app does not declare. Without `capabilities`, the app is taken to provide the basic contract: `look`, `pointer-select`, `phase-events`. `screenshot` is always provided (Chrome takes the screenshots).
- `actions`: the app's own task actions (below). Declaring any adds the `actions` capability; an app that lists its actions only at run time (`actions()`) declares `actions` in `capabilities`.
- `instructions`: how to use the app's controls, shown to agents with the tool descriptions (the WebXR runtime has no Settings entry for this).

| Capability | The app implements | The agent gets |
| --- | --- | --- |
| `screenshot` | nothing (always provided) | `screenshot` |
| `look` | `look(azimuth, polar)` | `look` |
| `pointer-select` | `listObjects()`, `select(id)` | `list_objects`, `select(object)` by neutral ID |
| `pointer-xy` | optionally `pointer(x, y, kind)`; otherwise its own mouse handlers | `point_at(x, y)`, `click(x, y)` |
| `actions` | `act(name, args)`, optionally `actions()` | `act(name, args)` |
| `phase-events` | `getState()` with `phase`, `trial`, `done` | (the practice and main tasks are told apart) |
| `quality-lock` | the design is fixed by the URL; the participant cannot switch it | (a promise the runtime cannot check) |

Every app gets `open_design`, `screenshot` and `app_state`. For a pointing study (target width as the design), declare `pointer-xy` and not `pointer-select`: selecting by ID would make the target width irrelevant and a miss impossible.

### Functions

Every function may return a value or a Promise (resolve it when the action is done, for example after an animated walk).

- **`getState()`** (required). Fields the runtime reads:
  - `phase` (string): the phase the participant is in, `"practice"` during practice.
  - `trial` (number): the trial or block counter.
  - `done` (boolean): this design's task is finished.
  - `instruction` (string): the instruction shown to the participant.
  - `timeMs` (number, optional): the app's own clock; observations record it (`clock: "app"`), otherwise wall time since the design opened (`clock: "wall"`).
  - `public` (object, optional): anything else the participant sees (progress, hits and misses in a HUD), at most 4,000 characters as JSON.

  **How tasks advance.** The practice task ends when `phase` leaves `"practice"` if the app reports `"practice"`; otherwise when `trial` increases. The main task ends when `done` becomes true. An app that counts `trial` per target (every click) must therefore report `phase: "practice"` during practice, or the practice task ends after the first click. The runtime reads the state at the start of every tool call and, after every action, until it has not changed for 400 ms (at most 2 s), so delayed transitions (a fade, an animated walk) land in the right task. Keep fast-changing values (clocks, animation progress) out of `public`, or each action waits the full 2 s.
- **`start()`** (required): starts the design's first task. Called once after the page loads.
- **`look(azimuth, polar)`** (`look`): azimuth in degrees around the vertical axis (0 = the starting direction), polar in degrees down from straight up (0 = up, 90 = level, 180 = down). The runtime passes the full range; the app limits it and may return the view it applied (`{azimuth, polar}`), which the agent is told.
- **`listObjects()`** (`pointer-select`, optional otherwise): `[{id, x, y, onScreen, visible, public}]`, with `x`, `y` the screen position from 0 to 1 from the top-left corner. The app decides visibility: an object behind a wall should report `visible: false`, and then its position is not shown. The runtime calls it before `start()`, after it and whenever the agent lists objects. It draws neutral IDs (`obj-1 …`) afresh for every design, in a random order; objects that appear later get the next IDs, and existing IDs never change. The mapping is written to `object-ids.jsonl` in the job folder.
- **`select(id)`** (`pointer-select`): selects an object by the app's own ID.
- **`pointer(x, y, kind)`** (`pointer-xy`, optional): `kind` is `"move"`, `"down"` or `"up"`; `x`, `y` from 0 to 1 from the top-left corner. Reply to `"move"` with `{over: <the app's object ID or null>}` and to `"up"` with the outcome. Without `pointer`, the runtime sends real mouse events (move, press, release, click) at that point, which the app's own handlers for human participants receive; it then records no outcome, and counts the click as an answer when the app's state changed. Either way the runtime draws a crosshair at the pointer, so screenshots show it.
- **`act(name, args)`** (`actions`): performs one of the app's actions. **`actions()`** (optional) lists more actions at run time, in the same shape as `workspace.json` → `app.actions`: `{name, description, params, scored}`. `scored: false` marks an action that is not a task answer (turning, walking); the default is true. Declare required actions in `workspace.json`, so `study-check` can check them before any session.
- **`log()`** (optional): the app's own log, any JSON. The runtime saves it to `app-logs/<n>-<design>.json` in the job folder as `{design, opened, savedAt, entries}` (`entries` is what `log()` returned) when the main task ends, when the agent leaves a design and when the session ends. It never reaches the agent. *Save runs as zip* exports it, and loading a runs zip refuses an app log of another shape.

**Replies.** `select`, `pointer`, `act` (and `look`, see above) may reply with `{accepted, correct, hit, reason, over, public}`. `accepted: false` means the app refused (no active trial, a wall in the way): the action is recorded as not completed and not an answer. `correct` / `hit` is the feedback the participant gets; return them only if the participant perceives them (a flash, a sound).

### What reaches the agent

Only the documented fields above, with object IDs replaced by neutral ones: from `getState` (`phase`, `trial`, `done`, `instruction`, `public`), `listObjects` (`id`, `x`, `y`, `onScreen`, `visible`, `public`) and the replies. Everything else an app returns (internal IDs, answers, materials, layouts, its clock) stays in the browser. The app's code itself is another matter: a configuration that reads the project folder can read the task logic. Give app configurations no project files, or keep the task order and answers in data the agent cannot read; see `docs/methodology.md` (audit).

### What the runtime logs

`trace.jsonl` gets the `runtime`, `phase`, `case-start`, `observation`, `action` and `case-end` events of the [bridge contract](#study-bridge-contract). Action names: `look-around` (`look`), `point` (`point_at`), `select-target` (`select`, `click`), the app's own action names (`act`), and `complete-task` when the app moves on. Each action carries `scored` (a task answer), `completed` (false when the app refused), `result` (the documented reply, or null) and `args` (the neutral object ID, the point or the action's arguments). A task the agent leaves before the app reports it done ends with `submitted: false`. Use these names in the cases' `requiredActions`; `study-check` warns about required actions the runtime never records for the declared app.

**Freezing.** A campaign fingerprints the app folder (every file except dot files and OS clutter such as `Thumbs.db` and `desktop.ini`), the query and the declarations; the runtime serves only those files. If any of them changes after the freeze, app sessions are refused until you freeze a new campaign or continue; a continuation runs the configurations that play the app again (their finished runs played the old version), in the website and with `campaign-continue`.

## Study bridge contract

An engine MCP server (for example ue-mcp) usually offers editor tools: spawn actors, run console commands, take screenshots. A forecasting agent needs a **participant session** instead. A **study bridge** turns one into the other. It is a small stdio MCP server that:
- connects to the engine MCP as a client;
- knows how this study's designs are loaded;
- logs what the agent did.

**How the executor starts it.** The bridge is the runtime's command in Settings: any program, for example `node` with arguments `private/studies/my-study/runtime/bridge.mjs {jobFile}`, or `python` with `examples/selection/runtime/bridge.py {jobFile} …`. A relative path is resolved against the repository. The bridge may talk to an engine MCP server or directly to an endpoint inside the engine project. For every session:
- `{jobDir}`, `{jobFile}` and `{trace}` in the arguments are replaced with that session's paths;
- the same paths arrive as the environment variables `XR_STUDY_JOB_DIR`, `XR_STUDY_JOB_FILE` and `XR_STUDY_TRACE`;
- the agent can call only the bridge's tools, as `mcp__<runtime>__<tool>`, besides the study server's.

**What it reads.** `job.json` → `app` describes the session to play:

```json
{
  "runtime": "unreal",
  "observation": "mono",
  "trace": "<job-dir>/trace.jsonl",
  "screenshots": "<job-dir>/screenshots",
  "designs": [{ "id": "SP", "label": "Spheres", "practice": { "caseId": "SP-practice", "phaseId": "practice" }, "main": { "caseId": "SP-main", "phaseId": "main" } }],
  "cases": [{ "caseId": "SP-practice", "conditionId": "SP", "phaseId": "practice", "requiredActions": ["complete-task"], "minActions": 3 }]
}
```

A case may also carry `"observeBeforeEachAction": true` (see "What it logs").

- **Designs** come in the participant's order for individual configurations, and in study order otherwise.
- **The bridge must refuse designs in the wrong order**, and must refuse anything that would reveal results.
- **Object IDs shown to the agent are neutral and drawn afresh for every design** (for example `obj-1 … obj-N` in a random order). With the same IDs in every design, the agent selects from memory after the first one and its later task experience says nothing about the design. Log the mapping in the job folder for the audit (the built-in WebXR runtime writes `object-ids.jsonl`).

**Tools to offer.** Use participant words, not editor words:

| Tool | Does |
| --- | --- |
| `open_design` | Loads one design in a fresh state and starts its practice task |
| `look` / `move` | Changes the viewpoint the way a participant can |
| `screenshot` | Returns the current view as an image (mono, or a left/right pair for stereo) |
| `act` / `select` | Performs the task's actions; wrong actions count as errors |
| `task_state` | Returns the instruction and progress shown to the participant |

**What it logs.** It appends one JSON line per event to `XR_STUDY_TRACE`, in the form `{"t": <ms>, "server": "<runtime>", "event": {…}}`:

```json
{"type": "runtime", "engine": "unreal", "engineVersion": "5.7.1", "backend": "editor", "deviceProfile": "desktop PIE screenshots", "observation": "mono", "capabilities": ["screenshot", "phase-events"]}
{"type": "phase", "phaseId": "practice"}
{"type": "case-start", "caseId": "SP-practice", "phaseId": "practice"}
{"type": "observation", "caseId": "SP-practice", "phaseId": "practice", "captures": [{"eye": "mono", "sha256": "<hash of the image>", "frameId": "<id>", "simulationTimeMs": 1234}]}
{"type": "action", "caseId": "SP-practice", "phaseId": "practice", "action": "complete-task", "completed": true}
{"type": "case-end", "caseId": "SP-practice", "phaseId": "practice", "submitted": true}
```

- **The `runtime` event** says what the bridge and the engine really provide: engine and its version (asked from the engine), backend, device profile, observation (`mono` or `stereo-pair`) and capabilities. Write it once per session, when the engine is connected. The audit compares it with the study's frozen runtime recipe (`study.json` → `runtime`; `custom` engine or backend there means "not specified"). A session without it, or with a different observation, device profile or missing required capability, is recorded as a protocol deviation. The executor records the report in the run's execution record instead of copying `study.json`.
- **Action names** are the case's `requiredActions`; a missing one is a protocol deviation. Log one action per answer and mark it `"scored": true` (looking, walking and `complete-task` `"scored": false`): the audit checks a case's `minActions` against the scored actions, and with `observeBeforeEachAction` it requires an observation in the case before each of them. A bridge that marks none has every completed action except `complete-task` counted. An action the app refused is `"completed": false`; the app's reply may go in `"result"`.
- **`case-end`** is `"submitted": true` only when the task was finished; a task the agent left is `false` (a deviation).
- **Screenshots** are saved under `screenshots/` so the executor page can show the latest one.

**Settings.** Declare the bridge's real capabilities (for example `screenshot`, `phase-events`). The executor blocks configurations whose study requires a capability the runtime does not declare. A runtime supports stereo configurations only when it declares `stereo-capture`.

- **Time limit per session:** by default 90 minutes for Unreal, Unity and visionOS, or the global limit if that is higher (a full engine session with dozens of answers takes long); otherwise the global limit.
- **Sessions at the same time:** default 1 for Unreal, Unity and visionOS, because one editor hosts one Play session. The queue enforces it whatever the overall number of parallel sessions is; app-free sessions keep running alongside.

**Robustness.**
- Answer `initialize` and `tools/list` at once and connect to the engine on the first tool call. Claude Code starts MCP servers in the background; a server that is still starting shows as "pending" when the model's first turn begins.
- The agent may call tools in parallel, so serialize calls.
- Time out engine calls and say so in the reply instead of hanging.
- Close what you started when stdin closes.

**Token budget.** `job.json` → `tokenBudget` is the session's token budget (all tokens: input including cache, plus output), or null. The executor keeps `<job dir>/usage.json` (`{"tokens": …, "submitNow": …}`) current from the session's stream. Once `submitNow` is true (what is left of the budget is smaller than 10% of it, or than 3.5 × the last turn's input, since the submission, a possibly rejected second one and the closing turn each re-read the context) or `tokens` reaches 90% of the budget, a bridge refuses every further tool call with "Token budget … is nearly used up. Submit your forecast now." (the study server and the WebXR runtime do this too), so the agent submits. A session that is submitting is never stopped for its budget: it has `job.json` → `submitAttempts` (3) submissions and is stopped after the last one is refused. The executor stops a session above 150% only while it still calls other tools, and never once its forecast was accepted (`usage.json` → `tokensAtSubmit`).

**Tool-call limit.** A configuration's tool-call limit (`budget` in `job.json`) is a safety cap shared by every call, including reading files. The agent configuration page shows the fewest calls the protocol needs: each project file to read, each design to open, each required task's actions and one view per task; submitting the forecast is not counted. A task's `minActions` in `study.json` declares how many actions it needs at least (for example one answer per trial).

## Optional library contract: `RuntimeAdapter`

The executor does not use this contract: real runs go through WebXR or a study bridge (above), and a new engine needs only a bridge. For an external controller of your own, `src/core/protocol.ts` offers `RuntimeAdapter`:

1. `describe`: report engine/runtime versions and actually supported capabilities.
2. `reset`: establish a fresh session and the scheduled study state.
3. `perform`: execute approved study-specific controls and return completion events.
4. `observe`: capture the requested observations, their metadata and artifact hashes.
5. `close`: release the session and restore runtime changes.

Use `protocolForJob(plan, job)` for resolved individual ordering and `ProtocolGate(plan, job)` for the transition to forecasting. Expose only the permitted tools. Enforce budgets at the controller, not by asking the model to police itself. Record technical failures/retries separately; do not regenerate valid forecasts because they look inaccurate.

An engine connector cannot know what constitutes a task, a correct selection, an actual teleport, or a meaningful probe manipulation. A **study adapter** supplies those controls and definitions. Preserve natural human interaction paths where they matter; shortcuts that directly place objects at targets must be documented as a different interaction policy.

Verify stereo with a calibration scene and actual per-eye poses/matrices. Also inspect resolution, field of view, spatial units, input fidelity, rendered controller state and the image preprocessing performed by the model provider. State/depth access is privileged information and needs an explicit additional protocol; the mono/stereo image contract does not grant it implicitly.

## Launch checklist

- Resolve and hash approved source bytes before new forecasts. Keep target answers and other methods' conclusions out of forecaster workspaces.
- Record project, engine, runtime, SDK, connector and resolved model versions; configuration alone is not execution proof.
- Verify head and both-hand poses, controller actions, task resets, phase events and the requested observation mode.
- Freeze the case plan, permitted inputs and output definitions. Population agents receive counterbalance context; individual agents receive assigned order.
- Independently capture each execution; identical case IDs do not permit screenshot reuse.
- Keep practice/main/questionnaire/break phases and the three clocks separate.
- Run synthetic contract checks before any real participant-data predictions. These are software checks, not a required human pilot study.
- Return every scheduled job and a separate attempt/usage ledger. Save the first complete valid forecast.
- Fail visibly if requirements cannot be met; never silently substitute another runtime or observation mode.

To isolate agent design, hold the runtime and observation fixed. To evaluate runtime fidelity, create a separate frozen plan with the agent otherwise unchanged. Historical comparisons require their own explicit provenance and analysis design; this version does not silently relabel old forecasts as fresh jobs.
