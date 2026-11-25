# Graphics Quality Room for Apple Vision Pro

The visionOS (SwiftUI + RealityKit) version of the WebXR study app in
`examples/graphics-quality/webxr-app`. It has the same room, the nine objects (`obj-1` … `obj-9`,
same hidden truths and positions), the same task text and trial flow (one practice trial, four
scored trials) and the same seeded shuffle of the six look-alikes before each scored trial. For a
given participant and level, the layout is identical to the WebXR app's; this was checked against
the JavaScript. The app opens directly into a full immersive space. A study bridge drives it
through a small HTTP endpoint.

## Build

Requires Xcode 27 with the visionOS SDK and simulator runtime. Run this from this folder:

```sh
xcodebuild -project GraphicsQuality.xcodeproj -scheme GraphicsQuality -sdk xrsimulator \
  -configuration Debug -derivedDataPath ../../../.build/visionos-graphics-quality build
```

The app is then `.build/visionos-graphics-quality/Build/Products/Debug-xrsimulator/GraphicsQuality.app`
at the repository root. Signing is ad hoc (`CODE_SIGN_IDENTITY = -`), with no team, and the
deployment target is visionOS 2.0. A device build needs a development team.

## Launch

```sh
xcrun simctl install <udid> <path>/GraphicsQuality.app
xcrun simctl launch --terminate-running-process <udid> org.xrstudysim.graphicsquality \
  --quality high --participant p01 --port 47800
```

| Argument | Values | Default |
| --- | --- | --- |
| `--quality` | `low`, `medium`, `high` | `high` |
| `--participant` | any id (goes into the log and seeds the layout) | `anonymous` |
| `--port` | TCP port of the control endpoint | `47800` |

The simulator shares the Mac's network, so the endpoint is `http://127.0.0.1:<port>/rpc`. It
answers as soon as the app runs. Poll `hello` until `ready` is `true`, which means the scene is
built and has rendered smoothly for 30 frames. This takes about 3–10 s, longer on the first launch
after an install, while shaders compile.

## View model

All content hangs under `AnchorEntity(.head)`. A child `root` holds the room, and its transform is
the inverse of a virtual orbit camera, so the camera coincides with the head. Head coordinates are
in metres, with −Z forward and +Y up. The orbit camera is the WebXR one: target (0, 0.8, 0) and
distance 1.35 m. `azimuth` is degrees around +Y (0 = camera on +Z; positive moves it towards +X).
`polar` is degrees down from straight up, clamped to 5–89. The initial view is the WebXR initial
camera at (0, 1.3, 1.25), which is azimuth 0, polar ≈ 68.2. Lights are children of `root`, so they
stay fixed to the room.

A head-locked task panel sits at the upper left of the view, clear of the table. It shows the
title, the instruction, "k/n found · e wrong selection(s)" and a pinch hint, plus a Start button
before the practice. A selection shows a green (correct) or red (wrong) ring on the table for
600 ms. Objects also accept a pinch or click (`SpatialTapGesture`). As with the WebXR controller,
the first pinch before the practice starts it.

On the Apple-Vision-Pro-4K simulator, `simctl io screenshot` gives 3840×2160 px. The projection
measured with `calibrate` is a pinhole with a 90° horizontal field of view (f ≈ 1920 px) at the
image centre. Bridges should still calibrate rather than assume it. Screenshot colours are not the
requested values: markers of (255, 0, 0), (0, 255, 0) and (0, 0, 255) came out as about
(234, 51, 35), (117, 251, 76) and (0, 0, 245). Match markers by nearest hue, not by exact colour.

## Control protocol

`POST /rpc` with the body `{"method": "...", "params": {...}}` returns `200` with either
`{"result": …}` or `{"error": "message"}`. `Content-Length` and chunked bodies are accepted, and
the connection closes after each response. Other paths return 404, and other HTTP methods 405.
Every request is logged to stderr and os_log (subsystem `org.xrstudysim.graphicsquality`).

| Method | Params | Result |
| --- | --- | --- |
| `hello` | – | `{"app": "graphics-quality-visionos", "version": "1", "quality", "participant", "os", "device", "ready"}` |
| `getState` | – | `{"phase", "trial", "instruction", "done", "timeMs", "public": {"found", "targets", "wrongSelections"}}`. `phase` is `idle`, `practice`, `main` or `questionnaire`, and `timeMs` counts from `ready`. |
| `start` | `{"phase": "main"}` (optional) | Starts the practice trial. With `"main"`, it starts scored trial 1 of 4, with the seeded layout of trial index 1. Either way it logs `phase` and `trial-start`. Returns `{"ok": true}`. |
| `look` | `{"azimuth", "polar"}` (degrees) | Applies the view instantly and returns `{"azimuth", "polar"}` as applied. A missing value keeps the current one. |
| `objects` | – | `[{"id": "obj-1", "head": [x, y, z]}, …]`: the centre of each object's visual bounds in head coordinates, for the current view. |
| `select` | `{"id": "obj-3"}` | Same as WebXR `select()`: `{"accepted": false, "reason": "No active trial." / "Unknown object."}` or `{"accepted": true, "correct": bool}`. It advances trials and logs like the WebXR app. |
| `log` | – | The event log: `session-start`, `phase`, `trial-start` (with `layout`), `select`, `trial-end` (with `seconds`, `errors`). `t` is in ms since launch. |
| `calibrate` | `{"markers": [{"head": [x, y, z], "color": [r, g, b]}]}` | Hides the room, panel and rings. Shows one unlit sphere (radius 0.012 m) per marker, at the given head position and colour (0–255), on black. `{"markers": []}` restores the view. |

`start`, `look`, `select` and `calibrate` reply after the change has been simulated for a few
frames. In tests, a screenshot taken straight after the reply showed the change.

## Rendering levels and what RealityKit cannot match

- **low:** `UnlitMaterial` flat colours, the same as the WebXR flat colours. No lights, textures or
  shadows. RealityKit cannot lower the render resolution or turn off anti-aliasing, so the WebXR
  low level's reduced pixel ratio is not reproduced.
- **medium:** `PhysicallyBasedMaterial` with 256 px procedural colour textures (the `pbr.js`
  patterns, ported exactly). There is one directional light without shadows. Roughness, metallic
  and specular values stand in for the WebXR Phong highlights on the glossy mug, the metal bowl and
  the table. Lambert surfaces get no specular. The glass is 55 % opaque. The app adds no
  image-based light of its own, but visionOS still applies its default environment lighting, which
  stands in for the WebXR hemisphere light.
- **high:** full procedural sets. The floor, walls and table use 1024 px maps, the objects 512 px.
  Each set has colour, normal, roughness, metallic and ambient-occlusion maps. The glossy mug and
  the table have clear coat, the brushed-metal bowl has anisotropy and the fabric has sheen. There
  is a directional light with shadows, plus `GroundingShadowComponent`. Image-based light comes from
  a procedurally painted HDR equirectangular environment (a grey room with area lights).
  - No geometric displacement: RealityKit has none, so normal maps stand in for the WebXR height
    displacement on the floor and brick wall.
  - No glass transmission or refraction: the glass is a clear, glossy, 30 % opaque surface with
    clear coat.
  - No sheen roughness parameter.
  - Tone mapping and anti-aliasing are the system's, not ACES/MSAA settings.

Textures are generated with CoreGraphics at startup, so no binary assets are needed. Meshes are
ports of the three.js geometries (plane, box, cylinder, sphere, lathe, torus, ring), with the same
vertex layout and UVs. That includes the mugs, which sit half below the table top as in the WebXR
app.

## Project notes

- Sources are in `GraphicsQuality/`, an Xcode 16+ synchronized folder.
- `GENERATE_INFOPLIST_FILE = YES` is merged with the small `GraphicsQuality/Info.plist`. The
  build-settings route has no key for the scene manifest, so this file holds it:
  `UIApplicationPreferredDefaultSceneSessionRole = UISceneSessionRoleImmersiveSpaceApplication`
  and initial immersion style full. The file is excluded from the target's resources.
- Swift 5 language mode, minimal concurrency checking.
