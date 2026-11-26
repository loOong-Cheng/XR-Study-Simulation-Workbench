# Suite 6-w · Haptic buttons, between subjects, in WebXR (synthetic)

This is **suite 6-w**. It sits inside suite 6's folder and is a study of its own (ID `examples/haptic-buttons-between/webxr`). It is suite 6's synthetic study with a runnable **WebXR keypad app**. It runs with Claude Code and the built-in WebXR runtime (Chrome).

The following are suite 6's own, copied unchanged:
- the designs;
- the 36 invented people (12 per design);
- the measures, the brief, the evidence note and the background;
- the invented data.

`human.json` carries this study's ID. `test/example-webxr-variants.test.ts` checks that the copies still match suite 6.

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | Suite 6's study. Only the ID, the title and the runtime differ: the device is the WebXR runtime's `webxr-desktop-browser-1280x720`, with its capabilities. |
| `agents.json` | Suite 6's four configurations, plus *Uses the app*. |
| `workspace.json` | Where each source lives. The app is `webxr-app` with `?feedback={condition}&task=codes`, and its declared actions are `press-key` and `confirm-code`. |
| `human.json`, `data/raw/` | Suite 6's invented data, copied. |
| `webxr-app/` | Suite 5-w's keypad app, copied, in its `codes` task. |
| `agent-brief.md`, `evidence/`, `comparisons.json` | As in suite 6. The comparisons add *Uses the app* against *Text only*. |
| `starter/` | The starter campaign. |

## The app

A plain room. A numeric keypad floats at chest height, 40 cm in front, tilted towards the participant. It has 1–9, then Delete, 0 and Enter, with 4 cm keys and 1 cm gaps. The panel above shows the code and the digits typed so far.

Each design has two practice codes and twelve scored 4-digit codes. Enter submits the code as typed, and the next one appears.

- **Input: declared actions.** Both actions are scored, as the suite's cases require.
  - `act press-key` takes `key` (0–9 or `delete`), or `keys` (several digits pressed one after another, for example `7391`).
  - `act confirm-code` presses Enter.
- **Feedback:** each press replies with what the participant sees and what the ring does, in words from the brief. The participant sees light blue on touch; the key moves in, turns dark blue at 1.5 cm and springs back. The first press of a design describes it in full.
- **Not modelled:** motor noise, human timing and double registrations.
- **`look`** turns the head.

## Configurations

Suite 6's four configurations, plus `uses-app`. It is a population configuration that gets the brief and the app: every design's practice and main case, with a budget of 160 tool calls and 12M tokens. Each person used one design, but a population forecast covers all three, so the agent uses all three.

## Checking it

```bash
node dist/cli.js study-check examples/haptic-buttons-between/webxr/study.json --agents examples/haptic-buttons-between/webxr/agents.json --human examples/haptic-buttons-between/webxr/human.json
node dist/cli.js app-check examples/haptic-buttons-between/webxr
```

`npm test` also plays every design to the end through the WebXR runtime, when Chrome is installed.

**Real sessions** (2026-11-26, Opus 5.5, Windows):
- *Uses the app*: 91–93 tool calls, $0.67–$0.74, three sessions. It typed each code with one multi-key `press-key`.
- *Text only*: $0.08.
- Stopping a session and running it again worked: the rerun started in a fresh attempt.

The study's device must stay the WebXR runtime's (GitHub issue 2).
