# Toy example: graphics quality and subjective experience in WebXR

This is **suite 3**: a complete, synthetic study you can run from start to finish, including real agent sessions in the WebXR app. It is also a template for your own project. The participants and their data are invented.

**Research questions**

- **RQ1 (about the XR design):** How does the graphics quality of a virtual environment (low, medium, high) affect presence, perceived realism, visual appeal, visual discomfort, preference and a material-search task?
- **RQ2 (about AI prediction):** Which agent methods reproduce these human differences? The configurations range from text only through reading the project files to using the app, at population level and for individual participants. One configuration also predicts experience from the measured task performance.

## What is in this folder

| File | What it is | In your own project |
| --- | --- | --- |
| `study.json` | Designs, measures, participants and orders, sources | Drafted from your document with **Understand study**, then reviewed |
| `agents.json` | Seven agent configurations (population and individual, with and without the app, one with measured inputs) | Your configurations |
| `workspace.json` | Where each source lives; how to serve the app (`?quality={condition}&study=1&participant={participant}`) | Same, for your project |
| `human.json` | Human reference (invented), used only by the executor for declared inputs and by the analyzer | Written by your converter |
| `comparisons.json` | Which configurations to test against each other | Chosen at analysis |
| `webxr-app/` | The app; exposes `window.xrStudy` for the WebXR runtime | Your app or engine project |
| `agent-brief.md`, `evidence/` | What agents are told; an invented evidence note | Your brief and evidence |
| `proposal.md` | A short proposal for trying **Understand study** | Your protocol or manuscript |
| `data/generate_synthetic.py`, `data/convert_to_human.py` | Invented raw data and the converter to `human.json` | Your logs/questionnaires and converter |

**The app.** Two mugs, two bowls and two vases share shape and colour and differ only in material: glossy vs matte ceramic, metal vs plastic, glass vs plastic. The task is to pick the glossy mug, the metal bowl and the glass vase: one practice trial (the wooden box), then four scored trials. Before each scored trial the six look-alike objects swap places, seeded by participant and level (`?participant=`), so every trial needs a new search. All three levels show the same room and the same surface patterns:

- **Low:** flat colours, so the pairs look identical.
- **Medium:** the patterns as simple colour textures, with highlights and transparency.
- **High:** full PBR. Every material has a procedurally generated texture set (albedo, normal, roughness, metalness, ambient occlusion and height). The brick wall and floor planks are physically displaced, and there are clear-coat ceramic, brushed metal, fabric sheen, glass transmission and soft shadows.

So graphics quality genuinely changes what can be seen. The textures are generated in the browser (`webxr-app/pbr.js`), and three.js 0.160.0 is included in `webxr-app/vendor/three/` (MIT), so the app runs offline with no downloads. To use scanned texture sets instead (for example CC0 sets from ambientCG or Poly Haven), load them in `material()` in `main.js`.

**The synthetic data.** 18 people, all six orders of the three levels, three people per order. One practice trial and four scored trials per level, then a questionnaire, and a ranking at the end. The built-in toy effects give these averages:

| Outcome | Low | Medium | High |
| --- | ---: | ---: | ---: |
| Search time (s) | 26.5 | 23.5 | 22.3 |
| Wrong selections per trial | 0.89 | 0.46 | 0.35 |
| Presence (1–7) | 3.31 | 4.08 | 4.92 |
| Perceived realism (1–7) | 2.44 | 3.94 | 5.56 |
| Visual appeal (1–7) | 3.56 | 4.83 | 5.89 |
| Visual discomfort (0–10) | 1.83 | 1.61 | 2.06 |
| Preference rank (1 = best) | 2.67 | 1.89 | 1.44 |

Visual discomfort is deliberately not monotonic: lowest at medium. An agent that simply assumes "higher quality is better on everything" gets that outcome wrong.

## Try it

```bash
npm ci
npm start      # http://127.0.0.1:4317 → Open study → Graphics quality
```

1. **Study & variables:** 3 designs, 7 measures (objective and subjective), 18 participants in all six orders, participant demographics as information agents may get. Reference answers are never shown here.
2. **Agent configurations:** seven cards, each with its level, model (Claude Code), runtime (none or WebXR), runs, what it gets and what it predicts:
   - **Text + measured task data** receives the measured search time and wrong selections and predicts only the experience measures.
   - The two individual configurations predict each participant.
3. **Freeze & campaigns:** set **Runs per participant** (default 1) and **Freeze campaign**. The table shows every configuration's runs and sessions. No configuration fixes its runs, so at 1 run per participant each of the five population configurations gets 18 participants × 1 = 18 runs and each of the two individual configurations 18 sessions: 7 × 18 = 126 sessions. To try a few first, freeze and use **Choose sessions to run** in the executor, or type fewer runs in a configuration's Runs box.
4. **Run agents:**
   - **Simulate** fills all sessions with invented forecasts in about a minute, to try the pipeline.
   - **Run agents** starts real Claude Code sessions: text-only sessions take about a minute; app sessions open the app in headless Chrome, look around, take screenshots, do the practice and main tasks, then submit. Select a job to see its latest screenshot. Pause, resume and **Save runs as zip** work at any time.
5. **Compare with humans:** **Analyze campaign**, tick configurations, then draw Agreement, Agent vs human (e.g. Visual discomfort), Correlation, Population vs individual (tick the individual configurations) and Participants. **Save SVG / PNG**.
6. **Continue / rerun:** change the model of "Uses the app" on Agent configurations (Continue then runs it again with that model), or **Add model** to put a copy with another model next to it, then **Preview** (only the new sessions run) and **Create continuation**.

**Setup on a new machine.** This suite needs only Google Chrome; there is no engine, MCP server or app server to install.
- The WebXR runtime is built into the framework. Each session starts its own headless Chrome and serves `webxr-app/` itself.
- `node scripts/setup.mjs` finds Chrome and writes its path into Settings. Check **Settings → Chrome path** if the WebXR runtime card says Chrome was not found.
- To build another WebXR study, copy `webxr-app/` and expose the `window.xrStudy` functions the runtime calls: `getState`, `start`, `listObjects`, `select` and `look`. Screenshots are taken by Chrome itself, so the app's own `capture` is optional.

To see the app yourself: `cd examples/graphics-quality/webxr-app && python3 -m http.server 8123 --bind 127.0.0.1`, then open http://127.0.0.1:8123/?quality=low (or `medium`, `high`).

## What a simulated run does and does not show

Simulated runs test the whole pipeline. They do **not** measure prediction quality: their numbers are invented without looking at the app (for example search times of 2–4 s against the participants' 22–26 s). Only real agent runs say anything about agents. The participants here are invented too, so even real runs only show how the method behaves.

## The WebXR runtime

The executor gives app-using sessions these tools (MCP server `src/runtimes/webxr-mcp.ts`). They call the app's `window.xrStudy` in a headless Chrome:

| Tool | What it does |
| --- | --- |
| `open_design(design)` | Opens that design and starts its practice trial |
| `look(azimuth, polar)` | Turns the viewpoint |
| `screenshot()` | Mono screenshot |
| `list_objects()` | Neutral IDs with screen positions; no names or materials. The IDs are drawn afresh for every design. |
| `select(object)` | Selects an object; wrong selections count |
| `app_state()` | Task progress |

Every step is logged as an audit trace (the runtime's own report of what it provides, phases, cases, observations, actions), and the forecast arrives through the study server's `submit_forecast`. WebXR on a desktop page has no stereo pair, so stereo configurations are refused.

## Use it as a template

Copy the folder to `private/studies/<your-study>/`, then replace the following:
- the app: any WebXR page exposing `window.xrStudy`, or another engine with its MCP runtime;
- `study.json`, via **Understand study**;
- the configurations;
- `agent-brief.md`, `workspace.json` and the converter.

Keep design, measure and participant IDs identical between `study.json` and `human.json`.
