# Project snapshot: selecting and placing objects (Unity)

A read-only copy of the study code of the Unity project that runs this study (Unity 6000.3, URP, XR Interaction
Toolkit 3.3.1). It contains no participant data and no results.

| File | What it is |
| --- | --- |
| `Assets/StreamingAssets/study-trials.json` | The fixed layout and tasks: room, furniture, the 12 objects (neutral ids, shape, colour, white band), the goal zone, the practice task and the six scored tasks. They are the same for every technique and every participant. It also holds the rules: arm's reach, teleport range, play area, eye height, IPD. |
| `Assets/Study/Editor/StudySceneBuilder.cs` | Builds the scene from that file: room, long table, side table with the green zone, wall shelf, objects as XRI Grab Interactables, instruction panel, the participant's head, hands and interactors. |
| `Assets/Study/Scripts/StudyController.cs` | The session: technique switch, tasks, glow, reach and teleport rules, selection, placement, stereo rendering, logging. |
| `Assets/Study/Scripts/StudyApi.cs`, `StudyJson.cs` | The local HTTP interface the session is driven through. |

**How the techniques work in this app**

- **Ray:** an XRI Ray Interactor on the right controller. Pressing the trigger picks up whatever the ray hits first.
  The object follows the ray. Placing means pointing the ray at the zone and releasing.
- **Direct:** an XRI Direct Interactor on the right hand. Only objects within arm's reach (0.75 m from the shoulder)
  can be grabbed. Placing needs the zone within reach too.
- **Hybrid:** the hand within arm's reach and the ray beyond it, switched automatically.
- **Moving:** walking inside a 2 m × 2 m play area, and teleports of up to 4 m, which furniture and walls can block.
  The far row of the table and the shelf are out of reach from the start position.
- **Wrong pickups:** picking up an object other than the glowing one counts as a wrong selection, and the object goes
  back to its place.

**Rendering:** the participant view is a stereo pair, 1024 × 1024 per eye, IPD 64 mm, with an approximate Quest 3
per-eye field of view.
