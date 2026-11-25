// Suite 2 (selecting and placing objects): the participant session in Play mode.
//
// No headset and no device simulator: the study API sets the head and hand poses directly, and "pressing the
// trigger" drives the XR Interaction Toolkit interactors' select input (XRInputButtonReader, ManualValue). So a pickup
// happens only if the interactor really hovers the object: the ray's first hit (ray), an object the hand overlaps
// within arm's reach (direct). Hybrid uses the hand within reach and the ray beyond it.
// Rules (reach, teleport range, play area, obstacles) and the layout come from StreamingAssets/study-trials.json.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEngine;
using UnityEngine.XR.Interaction.Toolkit.Inputs.Readers;
using UnityEngine.XR.Interaction.Toolkit.Interactables;
using UnityEngine.XR.Interaction.Toolkit.Interactors;

namespace XRStudy
{
    [Serializable] public class StudyObjectDef { public string id, shape, color; public bool band; public float x, y, z; }
    [Serializable] public class StudyRect { public string name; public float xMin, xMax, zMin, zMax; }
    [Serializable] public class StudyPose { public float x, z, yaw; }
    [Serializable] public class StudyZone { public float x, y, z, size; }

    [Serializable]
    public class StudyTrials
    {
        public int version;
        public StudyPose start;
        public float eyeHeightM = 1.6f, ipdM = 0.064f, reachM = 0.75f, teleportMaxM = 4f, playAreaHalfM = 1f;
        public StudyRect room;
        public StudyRect[] obstacles;
        public StudyZone goalZone;
        public StudyObjectDef[] objects;
        public string[] practice, main;

        public static string FilePath => Path.Combine(Application.streamingAssetsPath, "study-trials.json");
        public static StudyTrials Load() => JsonUtility.FromJson<StudyTrials>(File.ReadAllText(FilePath));
    }

    public class StudyController : MonoBehaviour
    {
        [Header("Wired by XR Study/Build Scene")]
        public Transform rig;            // moved by teleports; the play area is centred on it
        public Camera head;              // the headset view (mono, shown in the Game view)
        public Camera leftEye, rightEye; // the stereo pair the agent receives
        public Transform rightHand, leftHand;
        public XRRayInteractor ray;
        public XRDirectInteractor direct;
        public Transform goalZone;
        public TextMesh panel;

        const int EyeSize = 1024;
        static readonly string[] Techniques = { "ray", "direct", "hybrid" };
        static readonly Dictionary<string, string> Labels = new() { ["ray"] = "Ray selection", ["direct"] = "Direct touch", ["hybrid"] = "Hybrid selection" };

        StudyTrials t;
        readonly Dictionary<string, XRGrabInteractable> objects = new();
        readonly Dictionary<string, Pose> home = new();
        RenderTexture leftRT, rightRT;
        string technique, phase, logDir;
        string[] tasks = Array.Empty<string>();
        int taskIndex = -1;
        bool blockDone;
        string holding;
        XRBaseInputInteractor holder;
        int selections, wrong, teleports, taskTeleports, frameId;
        readonly List<string> taskPicks = new();
        float blockStart, taskStart;
        Vector2 play;                    // head offset (world x, z) from the rig, inside the play area
        float yaw, pitch;

        // ------------------------------------------------------------------ set-up
        void Awake()
        {
            t = StudyTrials.Load();
            foreach (var g in FindObjectsByType<XRGrabInteractable>(FindObjectsSortMode.None))
            {
                objects[g.name] = g;
                home[g.name] = new Pose(g.transform.position, g.transform.rotation);
            }
            foreach (var it in new XRBaseInputInteractor[] { ray, direct })
            {
                it.selectInput.inputSourceMode = XRInputButtonReader.InputSourceMode.ManualValue;
                it.selectActionTrigger = XRBaseInputInteractor.InputTriggerType.State;
            }
            ray.hitClosestOnly = true;
            leftRT = new RenderTexture(EyeSize, EyeSize, 24) { name = "LeftEye" };
            rightRT = new RenderTexture(EyeSize, EyeSize, 24) { name = "RightEye" };
            SetupEye(leftEye, leftRT, -1);
            SetupEye(rightEye, rightRT, +1);
            SetTechnique(null);
            ResetPose();
            Glow(null);
            Show("Please wait for the experimenter.");
        }

        void SetupEye(Camera cam, RenderTexture rt, int side)
        {
            cam.transform.localPosition = new Vector3(side * t.ipdM / 2f, 0f, 0f);
            cam.transform.localRotation = Quaternion.identity;
            cam.targetTexture = rt;
            const float n = 0.05f, f = 50f;
            // Approximate Quest 3 per-eye frustum (tangents): wider towards the temple, slightly more down than up.
            float inner = 1.0f, outer = 1.28f, up = 1.07f, down = 1.19f;
            float l = side < 0 ? -outer : -inner, r = side < 0 ? inner : outer;
            cam.nearClipPlane = n;
            cam.farClipPlane = f;
            cam.projectionMatrix = Matrix4x4.Frustum(l * n, r * n, -down * n, up * n, n, f);
            cam.enabled = true;
        }

        void ResetPose()
        {
            rig.SetPositionAndRotation(new Vector3(t.start.x, 0f, t.start.z), Quaternion.identity);
            play = Vector2.zero;
            yaw = t.start.yaw;
            pitch = -15f;
            ApplyHead();
        }

        void SetTechnique(string tech)
        {
            technique = tech;
            ray.gameObject.SetActive(tech == "ray" || tech == "hybrid");
            direct.gameObject.SetActive(tech == "direct" || tech == "hybrid");
            RestHands();
        }

        // ------------------------------------------------------------------ body
        Vector3 HeadPos => rig.position + new Vector3(play.x, t.eyeHeightM, play.y);
        Vector3 Forward(float extraYaw = 0f) => Quaternion.Euler(0f, yaw + extraYaw, 0f) * Vector3.forward;
        Vector3 Right => Quaternion.Euler(0f, yaw, 0f) * Vector3.right;
        Vector3 Shoulder(int side = 1) => HeadPos + Right * (0.18f * side) + Vector3.down * 0.22f;

        void ApplyHead()
        {
            head.transform.SetPositionAndRotation(HeadPos, Quaternion.Euler(-pitch, yaw, 0f));
        }

        void RestHands()
        {
            foreach (var (hand, side) in new[] { (rightHand, 1), (leftHand, -1) })
            {
                if (holding != null && hand == rightHand) continue;
                // low and to the side, as hands at rest: visible at the bottom of the view, not in front of the task
                var p = Shoulder(side) + Forward() * 0.28f + Right * (0.06f * side) + Vector3.down * 0.22f;
                hand.SetPositionAndRotation(p, Quaternion.Euler(-5f, yaw, 0f));
            }
        }

        bool InRoom(Vector3 p, float margin) =>
            p.x > t.room.xMin + margin && p.x < t.room.xMax - margin && p.z > t.room.zMin + margin && p.z < t.room.zMax - margin;

        StudyRect Blocking(Vector3 p, float margin) =>
            t.obstacles.FirstOrDefault(o => p.x > o.xMin - margin && p.x < o.xMax + margin && p.z > o.zMin - margin && p.z < o.zMax + margin);

        // ------------------------------------------------------------------ tasks
        void Show(string text) => panel.text = text;

        void Glow(string id)
        {
            foreach (var (name, g) in objects)
            {
                var on = name == id;
                var light = g.transform.Find("Glow");
                if (light) light.gameObject.SetActive(on);
                var rend = g.GetComponent<Renderer>();
                if (on) { rend.material.EnableKeyword("_EMISSION"); rend.material.SetColor("_EmissionColor", new Color(1f, 0.85f, 0.25f) * 0.55f); }
                else { rend.material.DisableKeyword("_EMISSION"); rend.material.SetColor("_EmissionColor", Color.black); }
            }
        }

        void ResetLayout()
        {
            foreach (var (name, pose) in home) objects[name].transform.SetPositionAndRotation(pose.position, pose.rotation);
            Physics.SyncTransforms();
        }

        string Target => taskIndex >= 0 && taskIndex < tasks.Length ? tasks[taskIndex] : null;

        void BeginTask()
        {
            ResetLayout();
            Glow(Target);
            taskStart = Time.time;
            taskTeleports = 0;
            taskPicks.Clear();
            Show($"{(phase == "practice" ? "PRACTICE" : $"Task {taskIndex + 1} of {tasks.Length}")}\nPick up the glowing object\nand put it in the green zone.");
        }

        void Log(string kind, J body)
        {
            if (string.IsNullOrEmpty(logDir)) return;
            Directory.CreateDirectory(logDir);
            File.AppendAllText(Path.Combine(logDir, "study_log.jsonl"),
                J.Obj().Add("t", DateTime.UtcNow.ToString("o")).Add("kind", kind).Add("technique", technique).Add("phase", phase)
                    .Add("task", taskIndex + 1).Raw("data", body.ToString()).ToString() + "\n");
        }

        string State()
        {
            var j = J.Obj().Add("ok", true).Add("technique", technique).Add("techniqueLabel", technique == null ? null : Labels[technique])
                .Add("phase", phase).Add("task", taskIndex + 1).Add("tasks", tasks.Length).Add("blockDone", blockDone)
                .Add("instruction", panel.text).Add("holding", holding).Add("selections", selections).Add("wrongSelections", wrong)
                .Add("teleports", teleports).Add("blockTime", Time.time - blockStart).Add("frame", Time.frameCount)
                // debug only (test harnesses); the bridge never forwards positions to agents
                .Add("debugHeadX", HeadPos.x).Add("debugHeadZ", HeadPos.z).Add("debugYaw", yaw);
            return j.ToString();
        }

        static string Err(string msg) => J.Obj().Add("ok", false).Add("error", msg).ToString();

        // ------------------------------------------------------------------ API
        public IEnumerator Handle(string path, StudyRequest r, Action<string> done)
        {
            switch (path)
            {
                case "/state": done(State()); yield break;
                case "/start": done(StartBlock(r)); yield break;
                case "/objects": done(ListObjects()); yield break;
                case "/look": done(Look(r.yaw, r.pitch)); yield break;
                case "/look_at": done(LookAt(r.target)); yield break;
                case "/walk": done(Walk(r.direction, r.distance)); yield break;
                case "/teleport": done(Teleport(r.direction, r.distance)); yield break;
                case "/head": done(SetHead(r)); yield break;
                case "/hand": done(SetHand(r)); yield break;
                case "/trigger": yield return Trigger(r, done); yield break;
                case "/select": yield return Select(r.id, done); yield break;
                case "/place": yield return Place(done); yield break;
                case "/capture": yield return Capture(done); yield break;
                default: done(Err($"Unknown endpoint {path}.")); yield break;
            }
        }

        string StartBlock(StudyRequest r)
        {
            if (!Techniques.Contains(r.design)) return Err($"Unknown design {r.design}.");
            if (r.phase != "practice" && r.phase != "main") return Err("phase must be practice or main.");
            if (holding != null) ReleaseHeld();
            logDir = string.IsNullOrEmpty(r.logDir) ? logDir : r.logDir;
            SetTechnique(r.design);
            phase = r.phase;
            tasks = r.phase == "practice" ? t.practice : t.main;
            taskIndex = 0;
            blockDone = false;
            selections = wrong = teleports = 0;
            blockStart = Time.time;
            ResetPose();
            RestHands();
            BeginTask();
            Log("start", J.Obj().Add("design", r.design));
            return State();
        }

        string ListObjects()
        {
            var items = new List<J>();
            foreach (var (name, g) in objects.OrderBy(o => int.Parse(o.Key.Split('-')[1])))
            {
                var vp = leftEye.WorldToViewportPoint(g.transform.position);
                var inView = vp.z > 0 && vp.x >= 0 && vp.x <= 1 && vp.y >= 0 && vp.y <= 1;
                items.Add(J.Obj().Add("id", name).Add("inView", inView).Add("x", inView ? vp.x : float.NaN)
                    .Add("y", inView ? 1f - vp.y : float.NaN).Add("distanceM", Vector3.Distance(HeadPos, g.transform.position)));
            }
            return J.Obj().Add("ok", true).Add("objects", items).ToString();
        }

        string Look(float newYaw, float newPitch)
        {
            yaw = Mathf.Repeat(newYaw + 180f, 360f) - 180f;
            pitch = Mathf.Clamp(newPitch, -80f, 80f);
            ApplyHead();
            RestHands();
            return J.Obj().Add("ok", true).Add("yaw", yaw).Add("pitch", pitch).ToString();
        }

        Vector3? PointOf(string target)
        {
            if (string.IsNullOrEmpty(target)) return null;
            if (target == "zone") return goalZone.position;
            if (target == "panel") return panel.transform.position;
            return objects.TryGetValue(target, out var g) ? g.transform.position : (Vector3?)null;
        }

        string LookAt(string target)
        {
            var p = PointOf(target);
            if (p == null) return Err("target must be an object id, zone or panel.");
            var d = p.Value - HeadPos;
            Look(Mathf.Atan2(d.x, d.z) * Mathf.Rad2Deg, Mathf.Atan2(d.y, new Vector2(d.x, d.z).magnitude) * Mathf.Rad2Deg);
            return J.Obj().Add("ok", true).Add("yaw", yaw).Add("pitch", pitch).Add("distanceM", d.magnitude).ToString();
        }

        string Walk(float direction, float distance)
        {
            var want = Mathf.Max(0f, distance);
            var step = Forward(direction);
            var got = 0f;
            for (var d = 0.05f; d <= want + 1e-4f; d += 0.05f)        // walk until the play area edge or furniture stops you
            {
                var p = HeadPos + step * 0.05f;
                var off = play + new Vector2(step.x, step.z) * 0.05f;
                if (Mathf.Abs(off.x) > t.playAreaHalfM || Mathf.Abs(off.y) > t.playAreaHalfM || !InRoom(p, 0.2f) || Blocking(p, 0.15f) != null) break;
                play = off;
                got += 0.05f;
                ApplyHead();
            }
            RestHands();
            return J.Obj().Add("ok", true).Add("walkedM", got).Add("stopped", got < want - 0.01f).ToString();
        }

        string Teleport(float direction, float distance)
        {
            var d = Mathf.Clamp(distance, 0.3f, t.teleportMaxM);
            var dest = HeadPos + Forward(direction) * d;
            dest.y = 0f;
            if (!InRoom(dest, 0.25f)) return J.Obj().Add("ok", true).Add("teleported", false).Add("reason", "no floor there (wall)").ToString();
            var block = Blocking(dest, 0.15f);
            if (block != null) return J.Obj().Add("ok", true).Add("teleported", false).Add("reason", $"the {block.name} is in the way").ToString();
            // the arc rises above furniture; only walls and the shelf (taller than eye height) block it
            var from = HeadPos;
            var to = dest + Vector3.up * 0.1f;
            foreach (var hit in Physics.RaycastAll(from, (to - from).normalized, (to - from).magnitude, ~0, QueryTriggerInteraction.Ignore))
                if (hit.collider.bounds.max.y > t.eyeHeightM && !objects.ContainsKey(hit.collider.name))
                    return J.Obj().Add("ok", true).Add("teleported", false).Add("reason", "a wall is in the way").ToString();
            rig.position = new Vector3(dest.x, 0f, dest.z);
            play = Vector2.zero;
            teleports++;
            taskTeleports++;
            ApplyHead();
            RestHands();
            Log("teleport", J.Obj().Add("distanceM", d));
            return J.Obj().Add("ok", true).Add("teleported", true).Add("distanceM", d).Add("clipped", distance > t.teleportMaxM).ToString();
        }

        string SetHead(StudyRequest r)       // head pose inside the play area (head-pose capability)
        {
            var off = new Vector2(r.x - rig.position.x, r.z - rig.position.z);
            if (Mathf.Abs(off.x) > t.playAreaHalfM || Mathf.Abs(off.y) > t.playAreaHalfM) return Err("outside the play area");
            if (Blocking(new Vector3(r.x, 0, r.z), 0.15f) != null) return Err("furniture is there");
            play = off;
            return Look(r.yaw, r.pitch);
        }

        string SetHand(StudyRequest r)       // a hand pose within arm's reach (hand-poses capability)
        {
            var hand = r.hand == "left" ? leftHand : rightHand;
            var p = new Vector3(r.x, r.y, r.z);
            var s = Shoulder(r.hand == "left" ? -1 : 1);
            if (Vector3.Distance(s, p) > t.reachM) p = s + (p - s).normalized * t.reachM;
            hand.SetPositionAndRotation(p, Quaternion.Euler(-r.pitch, r.yaw, 0f));
            Physics.SyncTransforms();
            return J.Obj().Add("ok", true).Add("clippedToReach", Vector3.Distance(s, new Vector3(r.x, r.y, r.z)) > t.reachM).ToString();
        }

        XRBaseInputInteractor ActiveFor(Vector3 p)
        {
            if (technique == "ray") return ray;
            if (technique == "direct") return direct;
            return Vector3.Distance(Shoulder(), p) <= t.reachM ? direct : ray;  // hybrid: hand within reach, ray beyond
        }

        static IEnumerator Settle()
        {
            Physics.SyncTransforms();
            yield return new WaitForFixedUpdate();
            yield return new WaitForFixedUpdate();
            yield return null;
            yield return null;
        }

        IEnumerator Trigger(StudyRequest r, Action<string> done)   // controller-input capability: press / release
        {
            var it = technique == "direct" ? (XRBaseInputInteractor)direct : ray;
            if (technique == "hybrid") it = holder ?? (direct.interactablesHovered.Count > 0 ? direct : ray);
            it.selectInput.QueueManualState(r.pressed, r.pressed ? 1f : 0f);
            yield return Settle();
            var picked = it.interactablesSelected.Count > 0 ? ((Component)it.interactablesSelected[0]).name : null;
            done(J.Obj().Add("ok", true).Add("selected", picked).ToString());
        }

        IEnumerator Select(string id, Action<string> done)
        {
            if (technique == null || blockDone || Target == null) { done(Err("No task is running.")); yield break; }
            if (holding != null) { done(Err($"You are holding {holding}; place it first.")); yield break; }
            if (!objects.TryGetValue(id ?? "", out var obj)) { done(Err($"Unknown object {id}.")); yield break; }
            var p = obj.transform.position;
            var it = ActiveFor(p);
            if (it == direct)
            {
                var s = Shoulder();
                if (Vector3.Distance(s, p) > t.reachM)
                {
                    rightHand.SetPositionAndRotation(s + (p - s).normalized * t.reachM, Quaternion.LookRotation(p - s));
                    yield return Settle();
                    RestHands();
                    done(J.Obj().Add("ok", true).Add("result", "out-of-reach").Add("selected", (string)null).ToString());
                    yield break;
                }
                rightHand.SetPositionAndRotation(p, Quaternion.LookRotation(p - s));
            }
            else
            {
                RestHands();
                rightHand.rotation = Quaternion.LookRotation(p - rightHand.position);
            }
            yield return Settle();
            it.selectInput.QueueManualState(true, 1f);
            yield return Settle();
            var sel = it.interactablesSelected.Count > 0 ? ((Component)it.interactablesSelected[0]).name : null;
            if (sel == null)
            {
                it.selectInput.QueueManualState(false, 0f);
                yield return Settle();
                RestHands();
                done(J.Obj().Add("ok", true).Add("result", it == ray ? "ray-hit-nothing" : "nothing-in-hand").Add("selected", (string)null).ToString());
                yield break;
            }
            selections++;
            taskPicks.Add(sel);
            if (sel != Target)
            {
                wrong++;
                it.selectInput.QueueManualState(false, 0f);
                yield return Settle();
                var pose = home[sel];
                objects[sel].transform.SetPositionAndRotation(pose.position, pose.rotation);
                RestHands();
                Log("wrong-selection", J.Obj().Add("picked", sel).Add("target", Target));
                done(J.Obj().Add("ok", true).Add("result", "wrong-object").Add("selected", sel).Add("via", it == ray ? "ray" : "hand").ToString());
                yield break;
            }
            holding = sel;
            holder = it;
            if (it == direct)
            {
                var s = Shoulder();
                rightHand.position = s + Forward() * 0.35f + Vector3.down * 0.05f;   // bring it in front of you
            }
            done(J.Obj().Add("ok", true).Add("result", "picked-up").Add("selected", sel).Add("via", it == ray ? "ray" : "hand").ToString());
        }

        void ReleaseHeld()
        {
            holder?.selectInput.QueueManualState(false, 0f);
            holding = null;
            holder = null;
        }

        IEnumerator Place(Action<string> done)
        {
            if (holding == null) { done(Err("You are not holding an object.")); yield break; }
            var z = goalZone.position;
            var obj = objects[holding];
            if (holder == direct)
            {
                if (Vector3.Distance(Shoulder(), z) > t.reachM)
                {
                    done(J.Obj().Add("ok", true).Add("placed", false).Add("reason", "the zone is out of reach").ToString());
                    yield break;
                }
                rightHand.position = z + Vector3.up * 0.08f;
            }
            else
            {
                RestHands();
                rightHand.position = Shoulder() + Forward() * 0.3f + Vector3.down * 0.08f;
                var from = rightHand.position;
                var dir = (z - from).normalized;
                var hits = Physics.RaycastAll(from, dir, 15f, ~0, QueryTriggerInteraction.Ignore)
                    .Where(h => !h.collider.transform.IsChildOf(obj.transform)).OrderBy(h => h.distance).ToArray();
                var ok = hits.Length > 0 && Mathf.Abs(hits[0].point.x - z.x) <= t.goalZone.size / 2 + 0.03f && Mathf.Abs(hits[0].point.z - z.z) <= t.goalZone.size / 2 + 0.03f;
                if (!ok)
                {
                    done(J.Obj().Add("ok", true).Add("placed", false).Add("reason", "the ray cannot reach the zone from here").ToString());
                    yield break;
                }
                rightHand.rotation = Quaternion.LookRotation(dir);
            }
            yield return Settle();
            var id = holding;
            ReleaseHeld();
            yield return Settle();
            var half = obj.GetComponent<Collider>().bounds.extents.y;
            obj.transform.SetPositionAndRotation(z + Vector3.up * (half + 0.005f), Quaternion.identity);
            RestHands();
            var seconds = Time.time - taskStart;
            Log("task-done", J.Obj().Add("target", id).Add("picks", taskPicks).Add("teleports", taskTeleports).Add("seconds", seconds));
            taskIndex++;
            if (taskIndex >= tasks.Length)
            {
                blockDone = true;
                Glow(null);
                Show(phase == "practice" ? "Practice done." : "All tasks done.\nPlease fill in the questionnaire.");
            }
            else
            {
                yield return new WaitForSeconds(0.3f);
                BeginTask();
            }
            done(J.Obj().Add("ok", true).Add("placed", true).Add("blockDone", blockDone).Add("task", Mathf.Min(taskIndex + 1, tasks.Length)).Add("tasks", tasks.Length).ToString());
        }

        IEnumerator Capture(Action<string> done)
        {
            yield return null;                 // let the eye cameras render the current pose
            yield return new WaitForEndOfFrame();
            frameId++;
            var eyes = new List<J>();
            foreach (var (name, cam, rt) in new[] { ("left", leftEye, leftRT), ("right", rightEye, rightRT) })
            {
                var prev = RenderTexture.active;
                RenderTexture.active = rt;
                var tex = new Texture2D(rt.width, rt.height, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
                tex.Apply();
                RenderTexture.active = prev;
                var jpg = tex.EncodeToJPG(85);
                Destroy(tex);
                eyes.Add(J.Obj().Add("eye", name).Add("jpegBase64", Convert.ToBase64String(jpg)).Add("width", rt.width).Add("height", rt.height)
                    .Add("eyeSeparationM", t.ipdM).Add("viewMatrix", cam.worldToCameraMatrix).Add("projectionMatrix", cam.projectionMatrix));
            }
            done(J.Obj().Add("ok", true).Add("frameId", frameId).Add("unityFrame", Time.frameCount).Add("simulationTimeMs", (Time.time - blockStart) * 1000f)
                .Add("eyes", eyes).ToString());
        }
    }
}
