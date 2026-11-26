# Suite 7-w · Mid-air text entry in WebXR (synthetic)

This is **suite 7-w**, inside suite 7's folder and a study of its own (ID `examples/text-entry/webxr`). It is suite 7's synthetic study with a runnable **WebXR app of the four keyboards**.

Copied unchanged from suite 7: the designs, the 24 invented participants and their Latin-square orders, the measures, the brief, the evidence note, the background and the invented data. `human.json` carries this study's ID. `test/example-webxr-variants.test.ts` checks that the copies still match suite 7.

Forecasts are still made before the study. The app configurations try the keyboards like a pilot participant, and get no measured data. The study runs with Claude Code and the built-in WebXR runtime (Chrome).

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | Suite 7's study. Only the ID, the title and the runtime differ (the WebXR runtime's device `webxr-desktop-browser-1280x720` and its capabilities). |
| `agents.json` | Suite 7's six configurations, plus *Uses the app* and *Uses the app + participant background* |
| `workspace.json` | Where each source lives. The app is `webxr-app` with `?keyboard={condition}&participant={participant}`; its declared actions are `type`, `backspace` and `enter-phrase`. |
| `human.json`, `data/raw/` | Suite 7's invented data, copied |
| `webxr-app/` | The app: `index.html`, `main.js` and `phrases.js`, plus vendored three.js. `phrases.js` holds the study's 40 phrases and the recogniser's lexicon from suite 7's `data/generate_synthetic.py`, plus eight practice phrases from outside the pool. |
| `agent-brief.md`, `evidence/`, `comparisons.json` | As in suite 7. The comparisons add *Uses the app* against *Text only*. |
| `starter/` | The starter campaign |

## The app

The participant sits in a plain grey room, holding two controllers. The panel shows the phrase and the text typed so far.

Each keyboard gets two practice phrases, then ten scored phrases. The order of the phrase pool is drawn from the participant ID (`population` for population jobs). Each keyboard takes ten phrases, chosen by its place in the list [raycast, drum, swipe, split], so no phrase repeats within a session.

| Keyboard | Scene | What `type` takes (in the reply) |
| --- | --- | --- |
| raycast | A flat QWERTY keyboard, 1 m wide and 1.5 m away, with rays from both controllers | A trigger pull per key; each key lights up and clicks |
| drum | Pads on a curved surface 45 cm in front, tilted 30°, with a 20 cm stick per controller | A strike per key; the controller vibrates on each hit |
| swipe | The raycast panel plus *Delete word*, with suggestions on the panel | `type` taps single letters; `swipe` draws one stroke per word |
| split | Two small halves above the controllers; the highlight starts on d and k | Thumbstick tilts (one key each, back to the middle after each key) and presses; grips for spaces |

- **Actions.** Every keyboard has `type`, `backspace` and `enter-phrase`. The swipe keyboard adds `swipe`, `choose-word` and `delete-word`, which the app lists through `actions()` while it is open. Only `enter-phrase` is scored, as the suite's cases require (10 per main case).
- **Swipe recogniser.** A stroke runs exactly through the key centres of the letters given. The recogniser compares it with the path of every lexicon word (32 resampled points, mean distance). It types the closest word and offers the next three as suggestions. Words with the same path can swap: "soon" comes out as "son", and `choose-word` fixes it.
- **Not modelled:**
  - motor noise;
  - human timing (the 180 s limit per phrase is not used);
  - stroke scatter.

  Uncorrected errors are computed per phrase in the app log and never shown.

To see the app yourself: `cd examples/text-entry/webxr/webxr-app && python3 -m http.server 8123 --bind 127.0.0.1`, then open http://127.0.0.1:8123/?keyboard=swipe (or `raycast`, `drum`, `split`).

## Configurations

Suite 7's six configurations, plus:
- `uses-app`: population; gets the brief and the app; covers all eight cases; 200 tool calls, 15M tokens.
- `uses-app-knows-participant`: individual; the same, plus the participant's background.

## Checking it

```bash
node dist/cli.js study-check examples/text-entry/webxr/study.json --agents examples/text-entry/webxr/agents.json --human examples/text-entry/webxr/human.json
node dist/cli.js app-check examples/text-entry/webxr
```

`npm test` also types every phrase of every keyboard through the WebXR runtime when Chrome is installed. It uses the swipe actions on the swipe keyboard.

**Real sessions** (2026-11-26, Windows):

| Configuration | Model | Tool calls | Cost |
| --- | --- | --- | --- |
| *Uses the app* | Opus 5.5 | 106 | $1.02 |
| Individual, with P01 (its own phrase order) | Opus 5.5 | 116 | $1.03 |
| *Text only* | Opus 5.5 | | $0.11 |
| Second-model arm | Sonnet 5.5 | | $0.06 |

The study's device must stay the WebXR runtime's (GitHub issue 2).
