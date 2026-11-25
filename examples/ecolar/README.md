# Synthetic Ecolar: temperature visualization in a VR building

This is **suite 1**. It follows the design of the Ecolar VR study, which compared four ways to show a building's temperature in VR. The structure is the same as the real study: designs, tasks, measures, order design and agent configurations. **All participants and all their data are invented.** No number in this folder comes from, or was fitted to, the real study.

**Research questions**

- **RQ1 (about the XR design):** How do Spheres (SP), Volume (VO), Probe Plane (PP) and Handheld Probe (HP) differ in task performance and subjective experience?
- **RQ2 (about AI prediction):** How well do LLM agents forecast these differences? Their access ranges from the description alone to project files, the running Unreal app, model evidence, demographics, measured task data and movement. They forecast at population level and for individual participants.

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | 4 designs, 14 measures, 24 invented participants in a Williams square, sources |
| `agents.json` | 16 configurations (described below) |
| `workspace.json` | Where each source lives |
| `starter/` | The starter campaign: this suite frozen at 1 run per participant (`starter.json` lists its sessions), installed into `campaigns/` the first time the study opens without a campaign; rebuilt with `npm run starters` ([testing with the example suites](../../docs/testing-with-example-suites.md)) |
| `human.json` | Invented human reference, written by `data/convert_to_human.py` |
| `comparisons.json` | Configurations to compare at analysis |
| `agent-brief.md` | What every agent is told |
| `project-snapshot/` | An outcome-blind description of the Unreal app |
| `evidence/model-evidence.md` | Invented computational-model outputs |
| `data/generate_synthetic.py` | Writes the invented raw files: trials, questionnaires, rankings, demographics, movement |
| `data/convert_to_human.py` | Converts the raw files to `human.json` |
| `proposal.md` | A short study description for trying **Understand study** |

To regenerate the data: `python3 data/generate_synthetic.py && python3 data/convert_to_human.py`. Both are deterministic.

## Agent configurations

| Level | Configurations | The agent gets |
| --- | --- | --- |
| Population, 10 runs each | A | The brief only |
| | B | Brief + project files |
| | C | B + the running Unreal app |
| | D | C + model evidence |
| | F | B + model evidence |
| | A-Dem … F-Dem | The same, plus the cohort's demographics |
| Individual, per participant | U1 (3 runs) | The person's design order and tasks, with D's sources |
| | UD (3 runs) | U1 + the person's demographics |
| | UDO (3 runs) | UD + the person's measured accuracy and times as **inputs**; it predicts only the subjective measures |
| | UDOT (3 runs) | UDO + the person's main-task movement |
| | Full (1 run) | UDO + practice and main-task movement |
| | Full-Reason (1 run) | Full, plus explicit reasoning about the movement before submitting |

## Running it

- **Simulate (no setup):** Freeze, then **Run agents** in Simulate mode, then **Compare with humans**. This tests the whole pipeline with invented forecasts.
- **Real agents:**
  - A, B, F, A-Dem, B-Dem and F-Dem need no app and run with Claude Code right away.
  - C, C-Dem, D, D-Dem and the U-series use the Unreal app. They need an Unreal MCP runtime with a study bridge: see [runtime adapters](../../docs/runtime-adapters.md#study-bridge-contract). Without one, the executor says "Unreal MCP runtime is not configured" and runs the rest.
  - [UNREAL_SETUP.md](UNREAL_SETUP.md) describes what the Unreal project, its study API, the Editor control and the bridge need. A real Unreal project for this example is not included.

Simulated runs and invented participants show how the method behaves, not how good agents are.
