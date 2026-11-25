# Toy example: graphics quality on Apple Vision Pro (visionOS)

This is **suite 8**: suite 3's synthetic study (the same three graphics-quality levels, 18 invented participants, measures, data and agent configurations) with an **Apple Vision Pro app** in place of the WebXR app. Its app configurations play the app in the **visionOS simulator** through the study bridge in `runtime/`. With suites 3 and 8 you can compare two runtimes on one study: the same reference, the same configurations, the same participant tools.

**Research questions** (as in suite 3)

- **RQ1 (about the XR design):** How does the graphics quality of a virtual environment (low, medium, high) affect presence, perceived realism, visual appeal, visual discomfort, preference and a material-search task?
- **RQ2 (about AI prediction):** Which agent methods reproduce these human differences, from text only through reading the project files to using the app?

## What is in this folder

| File | What it is |
| --- | --- |
| `study.json` | Suite 3's study; only the ID, the title, the source descriptions and the device profile (`apple-vision-pro-simulator`) differ |
| `agents.json` | Suite 3's seven configurations; *Uses the app* and *Uses the app + knows the participant* use the `visionos` runtime |
| `workspace.json` | Where each source lives (no WebXR `app` entry: the visionOS app runs through the bridge) |
| `human.json`, `data/` | Suite 3's invented data, copied (`data/convert_to_human.py` writes `human.json` with this study's ID) |
| `visionos-app/` | The Apple Vision Pro app: `GraphicsQuality.xcodeproj` and its Swift sources (SwiftUI + RealityKit) in `GraphicsQuality/`, which is also the project source agents may read |
| `runtime/` | The study bridge (`bridge.mjs`, `sim.mjs`), the build script (`build.mjs`) and a check without an agent (`check.mjs`) |
| `VISIONOS_SETUP.md` | Xcode, the simulator, building, Settings, checking, and how the bridge works |
| `starter/` | The starter campaign, as in every suite |
| `agent-brief.md`, `evidence/`, `proposal.md`, `comparisons.json` | As in suite 3; the brief describes the Apple Vision Pro app |

**The app.** The room of suite 3 in full immersion: a table with two mugs, two bowls and two vases that share shape and colour and differ only in material (glossy vs matte ceramic, metal vs plastic, glass vs plastic), plus a wooden box, a cushion and a plant. One practice trial (the wooden box), then four scored trials (the glossy mug, the metal bowl and the glass vase). Before each scored trial the six look-alikes swap places, with the same seeded layout as the WebXR app for the same participant and level.

- **Low:** flat, unlit colours, so the pairs look identical.
- **Medium:** the surface patterns as simple colour textures, one light, highlights and transparency, no shadows.
- **High:** full physically based texture sets, image-based lighting, clear-coat ceramic, brushed-metal anisotropy, fabric sheen, transparent glass and shadows. RealityKit has no geometric displacement, so normal maps stand in for the WebXR app's displaced bricks and planks.

The textures are generated in the app at start, so it needs no downloads.

**The synthetic data** are suite 3's, with the same toy effects:

| Outcome | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Search time (s) | 26.5 | 23.5 | 22.3 |
| Wrong selections per trial | 0.89 | 0.46 | 0.35 |
| Presence (1–7) | 3.31 | 4.08 | 4.92 |
| Perceived realism (1–7) | 2.44 | 3.94 | 5.56 |
| Visual appeal (1–7) | 3.56 | 4.83 | 5.89 |
| Visual discomfort (0–10) | 1.83 | 1.61 | 2.06 |
| Preference rank (1 = best) | 2.67 | 1.89 | 1.44 |

They were invented for a WebXR study, so here they stand for an imagined Apple Vision Pro study; they test the method, not either platform.

## Try it

1. **Simulate** the starter campaign (free, anywhere).
2. **On a Mac:** follow [`VISIONOS_SETUP.md`](VISIONOS_SETUP.md): install the visionOS simulator runtime, build the app (`node examples/graphics-quality-visionos/runtime/build.mjs`), set Settings → Runtimes → visionos, and run `node examples/graphics-quality-visionos/runtime/check.mjs`.
3. **Run agents:** one *Uses the app* session with **Run this session only**; select it to see the latest screenshot from the simulated headset.
4. **Compare with humans**, and compare with suite 3's *Uses the app* runs (Compare agents in each suite: tool calls, time, cost; Compare with humans: agreement).

## The visionOS runtime

The bridge gives app sessions the same tools as the WebXR runtime:

| Tool | What it does |
| --- | --- |
| `open_design(design)` | Starts the app on that design in the simulator and its practice trial |
| `look(azimuth, polar)` | Orbits the viewpoint around the table (polar 5–89°; the reply says when the view is limited) |
| `screenshot()` | What the simulated headset shows: one view, a JPEG with its longest side 1280 px |
| `list_objects()` | Neutral IDs with screen positions of the objects in view; no names or materials. The IDs are drawn afresh for every design. |
| `select(object)` | Selects an object as a pinch would; wrong selections count |
| `app_state()` | The instruction and the progress shown in the task panel |

Every step goes into the audit trace in the shapes of the [study bridge contract](../../docs/runtime-adapters.md#study-bridge-contract). The configurations that use the app also read `visionos-app/GraphicsQuality/`, which holds the seeded layout, as in suite 3 (see `docs/methodology.md`, audit).

## Use it as a template for a visionOS study

Copy the folder to `private/studies/<your-study>/` and replace the app with yours. Keep its control endpoint (the methods in `visionos-app/README.md`): `hello`, `getState`, `start`, `look`, `objects`, `select`, `log` and `calibrate`. The bridge then needs no change beyond the bundle ID (`runtime/sim.mjs`).
