# Suite 2: selecting and placing objects (synthetic, Unity)

A synthetic within-subjects study of three selection techniques (ray, direct touch, hybrid) in a Unity app, with 12 invented participants and objective and subjective measures. **All participants and their data are invented.**

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | 3 techniques, 7 measures, 12 participants (P01–P12, all six orders twice), sources |
| `agents.json` | 6 configurations (below) |
| `human.json` | Invented human reference, written by `data/convert_to_human.py` |
| `data/generate_synthetic.py`, `data/raw/` | Invented raw data: background, scored tasks, questionnaires, rankings |
| `agent-brief.md`, `evidence/toy-evidence.md` | What agents are told; an invented, qualitative evidence note |
| `project-snapshot/` | The study code of the Unity app, read-only, for configurations that read the project |
| `unity-project/` | The Unity study app itself (`Assets/Study`, `Assets/StreamingAssets`, `Packages/manifest.json`); see [UNITY_SETUP.md](UNITY_SETUP.md) |
| `runtime/bridge.py` | The study bridge the executor starts for *Uses the app* sessions |
| `comparisons.json`, `workspace.json`, `proposal.md` | Comparisons for the analyzer; where each source lives; a short proposal for trying **Understand study** |
| `starter/` | The starter campaign: this suite frozen at 1 run per participant (`starter.json` lists its sessions), installed into `campaigns/` the first time the study opens without a campaign; rebuilt with `npm run starters` ([testing with the example suites](../../docs/testing-with-example-suites.md)) |

To regenerate the data: `python3 data/generate_synthetic.py && python3 data/convert_to_human.py` (deterministic).

**The invented effects.** Background drives outcomes, so person-level forecasts have something to find: people without XR experience are slower and report more workload, most of all with direct touch (which needs walking and teleporting to the far row and the shelf); gaming hours help with the ray; left-handed people are slower with direct touch and hybrid (the controller is in the right hand). Averages:

| Measure | Ray | Direct | Hybrid |
| --- | --- | --- | --- |
| Completion time (s, geometric mean) | 6.6 | 9.7 | 7.4 |
| Accuracy | 0.82 | 1.00 | 0.86 |
| Teleports per task | 0.03 | 1.26 | 0.19 |
| Workload (1–7) | 2.95 | 3.98 | 3.05 |
| Appeal (1–7) | 4.67 | 5.17 | 5.25 |

## Agent configurations

| Configuration | Level | The agent gets |
| --- | --- | --- |
| Text only | population, 3 runs | The brief |
| Reads the project files | population, 3 runs | Brief + project snapshot |
| Uses the app | population, 3 runs | Brief + project + the running Unity app (stereo pairs) |
| Reads the project + your evidence | population, 3 runs | Brief + project + evidence note |
| Text + participant background | individual | Brief + that person's background |
| Uses the app + knows the participant | individual | Brief + project + app + that person's background |

At 1 run per participant: 4 × 3 + 2 × 12 = 36 sessions.

## Running it

- **Simulate** (no setup): Freeze, **Run agents** in Simulate mode, then **Compare agents** and **Compare with humans**.
- **Real agents:** configurations without the app run with Claude Code right away. *Uses the app* and *Uses the app + knows the participant* need the Unity app and the bridge: follow [UNITY_SETUP.md](UNITY_SETUP.md), then set the bridge in **Settings → Runtimes → unity**. Without it, the executor says "Unity MCP runtime is not configured" and runs the rest.

Simulated runs and invented participants show how the method behaves, not how good agents are.
