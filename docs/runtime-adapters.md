# External XR execution

The launcher runs on the researcher's XR machine. This repository deliberately contains no pretense of a live Unreal, Unity, OpenXR or Meta connection. `UnavailableRuntime` fails explicitly. Only `syntheticResults` is implemented, and all its artifacts are marked synthetic.

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

- **study** (`src/runtimes/study-mcp.ts`, always): `list_files` / `read_file` limited to the permitted project folder, and `submit_forecast`, which checks the full design × measure grid and ends the session. It enforces the tool budget and writes the audit trace.
- **the configuration's runtime**:

| Runtime | Server | Notes |
| --- | --- | --- |
| `webxr` | Built in: `src/runtimes/webxr-mcp.ts` | Serves the app folder from `workspace.json`, drives it in headless Chrome over the DevTools protocol, calls `window.xrStudy` (`start`, `select`, `look`, `listObjects`, `getState`). Mono screenshots only. |
| `unreal` | Your Unreal MCP, wrapped in a study bridge (below) | Set in Settings on the machine that runs Unreal. |
| `unity` | Your Unity MCP server | Not configured: "Unity MCP runtime is not configured". |
| `visionos` | A visionOS simulator MCP server | Not configured: Apple Vision Pro needs a visionOS simulator runtime. |

A runtime for another engine should offer participant-like tools:
- open a design (and start its practice task);
- look or move;
- screenshot (mono, or a synchronized left/right pair with per-eye geometry);
- act or select;
- task state.

It should log the audit trace events `phase`, `case-start`, `observation`, `action` and `case-end` to `<job-dir>/trace.jsonl`, in the shape the WebXR server writes.

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
  "cases": [{ "caseId": "SP-practice", "conditionId": "SP", "phaseId": "practice", "requiredActions": ["complete-task"] }]
}
```

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
- **Action names** are the case's `requiredActions`; a missing one is a protocol deviation.
- **Screenshots** are saved under `screenshots/` so the executor page can show the latest one.

**Settings.** Declare the bridge's real capabilities (for example `screenshot`, `phase-events`). The executor blocks configurations whose study requires a capability the runtime does not declare. A runtime supports stereo configurations only when it declares `stereo-capture`.

- **Time limit per session:** default 90 minutes for Unreal, Unity and visionOS (a full engine session with dozens of answers takes long), otherwise the global limit.
- **Sessions at the same time:** default 1 for Unreal, Unity and visionOS, because one editor hosts one Play session. The queue enforces it whatever the overall number of parallel sessions is; app-free sessions keep running alongside.

**Robustness.**
- Answer `initialize` and `tools/list` at once and connect to the engine on the first tool call. Claude Code starts MCP servers in the background; a server that is still starting shows as "pending" when the model's first turn begins.
- The agent may call tools in parallel, so serialize calls.
- Time out engine calls and say so in the reply instead of hanging.
- Close what you started when stdin closes.

**Token budget.** `job.json` → `tokenBudget` is the session's token budget (all tokens: input including cache, plus output), or null. The executor keeps `<job dir>/usage.json` (`{"tokens": …}`) current from the session's stream. Once `tokens` reaches 90% of the budget, a bridge refuses every further tool call with "Token budget … is nearly used up. Submit your forecast now." (the study server and the WebXR runtime do this too), so the agent submits; the executor stops a session above 150%.

**Tool-call limit.** A configuration's tool-call limit (`budget` in `job.json`) is a safety cap shared by every call, including reading files. The agent configuration page shows the fewest calls the protocol needs: each design to open, each required task's actions, one view per task, and the forecast. A task's `minActions` in `study.json` declares how many actions it needs at least (for example one answer per trial).

## Implement a connector

Implement `RuntimeAdapter` in `src/core/protocol.ts`:

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
