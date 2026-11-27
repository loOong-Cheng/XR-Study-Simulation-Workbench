# Suite 5-w · Haptic buttons in WebXR (synthetic)

This is **suite 5-w**. It sits inside suite 5's folder but is a study of its own (ID `examples/haptic-buttons/webxr`). It is suite 5's synthetic study with a runnable **WebXR keypad app**, so the study also gets app configurations: agents press the keys like a participant. It runs with Claude Code and the built-in WebXR runtime (Chrome), like suites 3 and 4.

Shared with suite 5, copied unchanged:
- the designs, the 18 invented participants and their orders, and the measures;
- the brief and the evidence note;
- the background and the practice movement;
- the invented data.

`human.json` carries this study's ID. `test/example-webxr-variants.test.ts` checks that the copies still match suite 5.

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | Suite 5's study. Only these differ: the ID, the title, the runtime (the WebXR runtime's device `webxr-desktop-browser-1280x720` and its capabilities) and the cases' required action. A press is logged as `select-target`, 12 per practice case and 40 per main case, as in suite 5. |
| `agents.json` | Suite 5's six configurations, plus *Uses the app* and *Uses the app + participant background*. |
| `workspace.json` | Where each source lives, and the app: `webxr-app`, `?feedback={condition}&task=sequences`. |
| `human.json`, `data/raw/` | Suite 5's invented data, copied. Regenerate it in suite 5, then copy it here with this study's ID. |
| `webxr-app/` | The keypad app (`index.html`, `main.js`, vendored three.js). Suite 6-w uses the same app with `task=codes`. |
| `agent-brief.md`, `evidence/`, `comparisons.json` | As in suite 5. The comparisons add *Uses the app* against *Text only*. |
| `starter/` | The starter campaign, as in every suite. |

## The app

- **The scene.** A plain, evenly lit room. A phone-style keypad floats at chest height, 40 cm in front of a standing participant, tilted towards them: 1–9, then Delete, 0 and an unused blank key, with 3 cm keys and 1 cm gaps. The panel above it shows the sequence and the digits typed so far.
- **The tasks.** Each design has 3 practice and 10 scored 4-digit sequences. A sequence is complete when its four digits are right.
- **Input (`pointer-xy`).** The agent clicks keys on the screenshot (`click`), like a fingertip press. `point_at` moves the fingertip over a key and says which key it is over. A press in a gap between keys is refused.
- **Feedback.** Each press replies with what the participant sees and what the fingertip actuator does, in words from the brief, because an agent cannot feel a vibration. The participant sees the key flash light blue and move 3 mm. The first press of a design describes it in full; later presses describe it briefly.
- **Not modelled:**
  - motor noise (a click lands where it is aimed, unless the study sets `app.pointer`);
  - human timing;
  - pressing past the activation plane;
  - unintended double presses.

  The app shows the task and the feedback, not human performance.
- **`look`** turns the head. At the start view (polar about 127), the participant looks down at the keypad.

To see the app yourself, run `cd examples/haptic-buttons/webxr/webxr-app && python3 -m http.server 8123 --bind 127.0.0.1`. Then open http://127.0.0.1:8123/?feedback=buzz&task=sequences, or use `visual` or `pulse` in place of `buzz`.

## Configurations

Suite 5's six configurations, plus these two:

| ID | Level | Gets | Budget |
| --- | --- | --- | --- |
| `uses-app` | population | the brief and the app (all six cases) | 340 tool calls, 26M tokens |
| `uses-app-knows-participant` | individual | the brief, the participant's background and the app | 340 tool calls, 26M tokens |

The budget fits a session that moves the fingertip over each key (`point_at`) before it presses it, as a participant does: 39 sequences × 4 keys = 156 presses, so 312 calls, plus opening the designs and the screenshots, about 321 (GitHub issue 8). Clicking each key directly needs about 163.

## Checking it

```bash
node dist/cli.js study-check examples/haptic-buttons/webxr/study.json --agents examples/haptic-buttons/webxr/agents.json --human examples/haptic-buttons/webxr/human.json
node dist/cli.js app-check examples/haptic-buttons/webxr
```

`npm test` also plays every design to the end through the WebXR runtime, without a model, when Chrome is installed.

**Real sessions** (2026-11-26, Opus 5.5, Windows): *Uses the app* took 163 tool calls and cost $1.13. The individual configuration with P01 took 165 calls and cost $1.14. *Text only* cost $0.10. Every app case was submitted.

The study's device must stay `webxr-desktop-browser-1280x720`, the WebXR runtime's own. Otherwise every app session is listed as a protocol deviation (GitHub issue 2).
