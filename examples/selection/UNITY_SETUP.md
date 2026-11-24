# Unity app for suite 2 (selecting and placing objects)

How to run suite 2's *Uses the app* configurations for real: the Unity study app in `unity-project/`, driven in Editor Play mode by the Python study bridge in `runtime/bridge.py`. No headset, device simulator or third-party Unity MCP is needed. This setup was built and tested on a Windows test PC with Unity 6000.3.11f1.

## What the study asks for

| `study.json` says | In the app |
| --- | --- |
| Designs `ray`, `direct`, `hybrid` | Three selection techniques with XR Interaction Toolkit interactors, switched per design |
| Cases `<design>-practice`, `<design>-main`, each requiring `select` and `place` | One guided practice task, then six scored tasks: pick up the glowing object and put it in the green zone |
| Measures | Completion time, accuracy (correct / all pickups), teleports per task; five workload items, appeal, two rankings (forecast only) |
| Runtime `unity`, backend `editor`, device profile `quest-3`, observation `stereo-pair` | Play mode in the Editor; the app renders a left/right pair (1024² per eye, IPD 64 mm, approximate Quest 3 per-eye frustum, per-eye view and projection matrices) |
| Required capabilities `head-pose`, `hand-poses`, `controller-input`, `stereo-capture`, `phase-events` | Provided by the app's study API and reported by the bridge in its `runtime` trace event |

## 1 · Create the Unity project

1. Unity Hub → new project, **Unity 6000.3** (Unity 6), template **Universal 3D (URP)**, for example `XR-SSR-Unity`.
2. Copy from `examples/selection/unity-project/` into the project, with their `.meta` files:
   - `Assets/Study/` (scripts, editor scripts, materials, scene);
   - `Assets/StreamingAssets/` (`study-trials.json`: layout, rules, the practice task and six scored tasks).
3. Merge `Packages/manifest.json`. The only addition to the URP template is `"com.unity.xr.interaction.toolkit": "3.3.1"`, which ships with the Editor.
4. Open the project and choose **XR Study → Build Scene**. This regenerates `Assets/Study/Scenes/SelectionRoom.unity` from `study-trials.json`.
5. For unattended runs: Player Settings → **Run In Background** on; Preferences → General → **Interaction Mode: No Throttling**.

## 2 · How the app is driven

- **Editor endpoint** (`Assets/Study/Editor/StudyEditorServer.cs`, `127.0.0.1:8096`): `/status`, `/play`, `/stop`, `/refresh` (recompile) and `/build`. It starts with the Editor, so the bridge enters and leaves Play mode itself.
- **Study API in Play mode** (`Assets/Study/Scripts/StudyApi.cs`, `127.0.0.1:8097`): sets head and hand poses, presses the interactors' select input (XRI `ManualValue` input), teleports through the teleportation provider, lists neutral object IDs with their positions in the left image, and renders the stereo pair.
- **Interaction goes through XRI**, so a ray must hit and a hand must reach (0.75 m from the shoulder); furniture and walls block teleport landing spots. The API never says which object is the target or whether a pickup was right beyond what the participant sees.

## 3 · The bridge and Settings

`runtime/bridge.py` (Python 3, standard library only) is a stdio MCP server following the [bridge contract](../../docs/runtime-adapters.md#study-bridge-contract). Tools: `open_design`, `look`, `look_at`, `walk`, `teleport`, `list_objects`, `select`, `place`, `screenshot`, `task_state`; every action returns both eyes. It reports itself with a `runtime` event, opens designs only in the job's order, and logs `select` and `place` as completed only when the app confirms.

In **Settings → Runtimes → unity**:
- **command:** `python` (or the full path to `python.exe`);
- **arguments:** `examples/selection/runtime/bridge.py {jobFile} --project "<your Unity project folder>"`;
- **capabilities:** `head-pose, hand-poses, controller-input, stereo-capture, phase-events`;
- **time limit** and **sessions at the same time:** the defaults (90 minutes, 1) fit: one Editor hosts one session;
- **guidance**, for example: "Use the techniques with open_design in the order given; each starts with one guided practice task, then six scored tasks. In every task find the glowing object in your left and right images (list_objects gives neutral ids and where they are in the left image), select it, then place it in the green zone. The ray works at a distance; direct touch only within arm's reach, so walk or teleport closer first; hybrid uses your hand within reach and the ray beyond."

Keep the Editor open on the project while sessions run.

## 4 · Check before real runs

1. Test the bridge with a scripted client or one session: open each design, take one capture, finish the practice and one scored task, and check `trace.jsonl` (`runtime`, `phase`, `case-start`, stereo `observation`, `action`, `case-end`). On the test PC a scripted session needed 98 tool calls for all three techniques (budget 150).
2. In the workbench: **Freeze**, then **Run agents**; select one *Uses the app* session and press **Run this session only**. Watch the stereo screenshots and messages.
3. Then start the rest, or choose a few sessions for a pilot.

The humans in suite 2 are invented. Real runs test the pipeline and the agents' behaviour, not prediction accuracy.
