# Running suite 8 in the visionOS simulator

Suite 8's app configurations (*Uses the app*, *Uses the app + knows the participant*) play the Apple Vision Pro app in the visionOS simulator through the study bridge in `runtime/`. This needs a Mac. Everything else in the suite (Simulate, the text configurations, the analysis) runs anywhere.

## 1 · Xcode and the visionOS simulator

- **Xcode** (from the App Store), opened once so it installs its components.
- **The visionOS simulator runtime**: Xcode → Settings → Components → visionOS, or in a terminal (a download of about 8 GB):

  ```bash
  xcodebuild -downloadPlatform visionOS
  ```

  `xcrun simctl list runtimes` then lists *visionOS*.

## 2 · Build the app

```bash
node examples/graphics-quality-visionos/runtime/build.mjs
```

It builds `visionos-app/GraphicsQuality.xcodeproj` for the simulator into `.build/visionos-graphics-quality/` at the top of the repository (git-ignored, outside the app's source folder, so building never changes what agents read or what a campaign fingerprints). Build again after changing the app. You can also open the project in Xcode and run it on an Apple Vision Pro simulator to try it yourself: look around by dragging, select objects by clicking (a pinch).

## 3 · Set the runtime in Settings

In the website, **Settings → Runtimes → visionos**, or in `private/settings.json`:

```json
{ "runtimes": { "visionos": {
  "command": "node",
  "args": ["examples/graphics-quality-visionos/runtime/bridge.mjs", "{jobFile}"],
  "capabilities": ["screenshot", "look", "pointer-select", "phase-events", "quality-lock"],
  "instructions": "look orbits the viewpoint around the table: polar about 60 looks down at the table, 89 is almost level with its top. Objects off screen are listed without a position; turn towards them to see them."
} } }
```

Optional bridge arguments after `{jobFile}`: `--app <path to GraphicsQuality.app>` (another build) and `--device <simulator name or UDID>` (default: a simulator named "XR Study Sim (Apple Vision Pro)", created on first use with the newest visionOS runtime). Engine runtimes run one session at a time by default, with a time limit of at least 90 minutes.

## 4 · Check it without an agent

```bash
node examples/graphics-quality-visionos/runtime/check.mjs
```

It opens each design through the bridge in the simulator, takes screenshots, lists the objects and turns the view, and prints where the screenshots are and how well the view calibration fits. Look at the screenshots, then run one real session in the website (**Run agents** → select one *Uses the app* session → **Run this session only**). `npm test` also runs a full session through the executor and the audit in the simulator (`test/visionos-bridge.test.ts`; skipped when the simulator or the app is missing).

## How the bridge works

- **Starting.** On the first tool call it boots the simulator (a minute or two the first time; it stays booted for the next session, `xcrun simctl shutdown "XR Study Sim (Apple Vision Pro)"` stops it), installs the app, and reports itself in the trace (`engine: realitykit`, `backend: visionos-simulator`, `deviceProfile: apple-vision-pro-simulator`, mono).
- **Each design.** `open_design` starts the app afresh (`xcrun simctl launch` with `--quality <design> --participant <person> --port <free port>`), waits until its scene is ready and starts the practice task. The app answers the bridge on `http://127.0.0.1:<port>/rpc` (the simulator shares the Mac's network); its methods are listed in `visionos-app/README.md`.
- **The view.** The room is anchored to the simulated head. `look(azimuth, polar)` orbits a virtual camera around the table as in the WebXR app, by moving the room relative to the head.
- **Screenshots.** `xcrun simctl io <device> screenshot`, turned into a JPEG with its longest side 1280 px (`sips`), as the agent gets it. One view: no left/right pair.
- **Where objects are on the screen.** After each design opens, the app shows seven coloured markers at known positions on black, the bridge finds them in one screenshot and fits the projection from head coordinates to the screen. `list_objects` maps each object's centre through it. The agent never sees this step.
- **The audit trace and object IDs** follow the [study bridge contract](../../docs/runtime-adapters.md#study-bridge-contract): neutral IDs drawn afresh for every design (`object-ids.jsonl`), `phase`, `case-start`, `observation`, `action` and `case-end` events, the app's own log in `app-logs/`, and the shared tool-call budget.
- **Restarts.** A bridge that Claude Code starts again resumes from `bridge-state.json` and starts the running task again from its first trial, as the contract says.

## Limits

- The simulator is not a headset: no eyes, hands or head movement of a person. The agent turns the view with `look` and selects by object ID, as in the WebXR runtime.
- RealityKit has no geometric displacement; the high level uses normal maps where the WebXR app displaces the brick wall and floor.
- The simulator renders on the Mac's GPU; its frame rate and the headset's display differ, so neither stands in for a person's response time or comfort.
