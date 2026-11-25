// Builds Assets/Study/Scenes/SelectionRoom.unity from StreamingAssets/study-trials.json (menu XR Study/Build Scene, or
//   Unity.exe -batchmode -quit -projectPath <p> -executeMethod XRStudy.EditorTools.StudySceneBuilder.BuildFromCommandLine
// The scene is generated, so the layout always matches the trial file the agents' project snapshot contains.
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using UnityEngine.XR.Interaction.Toolkit;
using UnityEngine.XR.Interaction.Toolkit.Interactables;
using UnityEngine.XR.Interaction.Toolkit.Interactors;
using UnityEngine.XR.Interaction.Toolkit.Interactors.Visuals;

namespace XRStudy.EditorTools
{
    public static class StudySceneBuilder
    {
        const string MatDir = "Assets/Study/Materials";

        public static void BuildFromCommandLine()
        {
            Build();
            AssetDatabase.SaveAssets();
        }

        [MenuItem("XR Study/Build Scene")]
        public static void Build()
        {
            var t = JsonUtility.FromJson<StudyTrials>(File.ReadAllText("Assets/StreamingAssets/study-trials.json"));
            Directory.CreateDirectory(MatDir);
            Directory.CreateDirectory(Path.GetDirectoryName(StudyEditorServer.ScenePath));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // ---------------------------------------------------------- materials
            var floorM = Lit("Floor", new Color(0.62f, 0.62f, 0.60f));
            var wallM = Lit("Wall", new Color(0.86f, 0.85f, 0.82f));
            var woodM = Lit("Wood", new Color(0.55f, 0.40f, 0.26f));
            var greyM = Lit("Shelf", new Color(0.45f, 0.46f, 0.48f));
            var whiteM = Lit("Band", Color.white);
            var zoneM = Lit("GoalZone", new Color(0.15f, 0.75f, 0.3f), emission: new Color(0.05f, 0.35f, 0.1f));
            var skinM = Lit("Hand", new Color(0.85f, 0.68f, 0.56f));
            var darkM = Lit("Controller", new Color(0.12f, 0.12f, 0.14f));
            var boardM = Lit("Board", new Color(0.97f, 0.97f, 0.95f));
            var colors = new System.Collections.Generic.Dictionary<string, Material>
            {
                ["red"] = Lit("Red", new Color(0.80f, 0.16f, 0.14f)),
                ["blue"] = Lit("Blue", new Color(0.16f, 0.36f, 0.82f)),
                ["yellow"] = Lit("Yellow", new Color(0.93f, 0.78f, 0.12f)),
            };
            var rayM = AssetDatabase.LoadAssetAtPath<Material>($"{MatDir}/Ray.mat");
            if (rayM == null)
            {
                rayM = new Material(Shader.Find("Universal Render Pipeline/Unlit"));
                AssetDatabase.CreateAsset(rayM, $"{MatDir}/Ray.mat");
            }
            rayM.SetColor("_BaseColor", new Color(0.3f, 0.85f, 1f));

            // ---------------------------------------------------------- light and room
            var sun = new GameObject("Sun").AddComponent<Light>();
            sun.type = LightType.Directional;
            sun.intensity = 1.1f;
            sun.shadows = LightShadows.Soft;
            sun.transform.rotation = Quaternion.Euler(55f, -35f, 0f);
            RenderSettings.ambientMode = AmbientMode.Flat;
            RenderSettings.ambientLight = new Color(0.55f, 0.55f, 0.57f);

            var room = new GameObject("Room").transform;
            float w = t.room.xMax - t.room.xMin, d = t.room.zMax - t.room.zMin, cx = (t.room.xMax + t.room.xMin) / 2, cz = (t.room.zMax + t.room.zMin) / 2;
            Box("Floor", room, new Vector3(cx, -0.01f, cz), new Vector3(w, 0.02f, d), floorM);
            Box("Wall N", room, new Vector3(cx, 1.3f, t.room.zMax + 0.05f), new Vector3(w + 0.2f, 2.6f, 0.1f), wallM);
            Box("Wall S", room, new Vector3(cx, 1.3f, t.room.zMin - 0.05f), new Vector3(w + 0.2f, 2.6f, 0.1f), wallM);
            Box("Wall E", room, new Vector3(t.room.xMax + 0.05f, 1.3f, cz), new Vector3(0.1f, 2.6f, d), wallM);
            Box("Wall W", room, new Vector3(t.room.xMin - 0.05f, 1.3f, cz), new Vector3(0.1f, 2.6f, d), wallM);

            foreach (var o in t.obstacles)
            {
                var c = new Vector3((o.xMin + o.xMax) / 2, 0, (o.zMin + o.zMax) / 2);
                var size = new Vector3(o.xMax - o.xMin, 0, o.zMax - o.zMin);
                var parent = new GameObject(Title(o.name)).transform;
                parent.SetParent(room);
                if (o.name == "shelf")
                {
                    Box("Board", parent, new Vector3(c.x, 1.08f, c.z), new Vector3(size.x, 0.04f, size.z), greyM);
                    Box("Back", parent, new Vector3(o.xMin + 0.02f, 0.75f, c.z), new Vector3(0.04f, 1.5f, size.z), greyM);
                    Box("Side A", parent, new Vector3(c.x, 0.55f, o.zMin + 0.02f), new Vector3(size.x, 1.1f, 0.04f), greyM);
                    Box("Side B", parent, new Vector3(c.x, 0.55f, o.zMax - 0.02f), new Vector3(size.x, 1.1f, 0.04f), greyM);
                }
                else
                {
                    Box("Top", parent, new Vector3(c.x, 0.88f, c.z), new Vector3(size.x, 0.04f, size.z), woodM);
                    foreach (var sx in new[] { -1, 1 })
                        foreach (var sz in new[] { -1, 1 })
                            Box("Leg", parent, new Vector3(c.x + sx * (size.x / 2 - 0.05f), 0.43f, c.z + sz * (size.z / 2 - 0.05f)), new Vector3(0.05f, 0.86f, 0.05f), woodM, collider: false);
                }
            }
            var zone = Box("Goal Zone", room, new Vector3(t.goalZone.x, t.goalZone.y, t.goalZone.z), new Vector3(t.goalZone.size, 0.01f, t.goalZone.size), zoneM);

            // ---------------------------------------------------------- panel
            var panelRoot = new GameObject("Instruction Panel").transform;
            panelRoot.position = new Vector3(0f, 1.78f, 0.25f);
            Box("Board", panelRoot, panelRoot.position + new Vector3(0, 0, 0.03f), new Vector3(1.5f, 0.42f, 0.02f), boardM, collider: false);
            var text = new GameObject("Text").AddComponent<TextMesh>();
            text.transform.SetParent(panelRoot, false);
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.font = font;
            text.GetComponent<MeshRenderer>().sharedMaterial = font.material;
            text.fontSize = 64;
            text.characterSize = 0.012f;
            text.anchor = TextAnchor.MiddleCenter;
            text.alignment = TextAlignment.Center;
            text.color = new Color(0.1f, 0.1f, 0.12f);
            text.text = "Please wait for the experimenter.";

            // ---------------------------------------------------------- objects (XRI grab interactables)
            var objRoot = new GameObject("Objects").transform;
            foreach (var o in t.objects)
            {
                var type = o.shape == "cube" ? PrimitiveType.Cube : o.shape == "sphere" ? PrimitiveType.Sphere : PrimitiveType.Cylinder;
                var go = GameObject.CreatePrimitive(type);
                go.name = o.id;
                go.transform.SetParent(objRoot);
                var scale = o.shape == "cylinder" ? new Vector3(0.08f, 0.05f, 0.08f) : Vector3.one * 0.09f;
                go.transform.localScale = scale;
                var half = o.shape == "cylinder" ? 0.05f : 0.045f;
                go.transform.position = new Vector3(o.x, o.y + half, o.z);
                go.GetComponent<Renderer>().sharedMaterial = colors[o.color];
                if (o.band)
                {
                    var band = GameObject.CreatePrimitive(o.shape == "cube" ? PrimitiveType.Cube : PrimitiveType.Cylinder);
                    band.name = "Band";
                    Object.DestroyImmediate(band.GetComponent<Collider>());
                    band.transform.SetParent(go.transform, false);
                    band.transform.localScale = o.shape == "cube" ? new Vector3(1.04f, 0.16f, 1.04f) : o.shape == "sphere" ? new Vector3(1.04f, 0.05f, 1.04f) : new Vector3(1.06f, 0.1f, 1.06f);
                    band.GetComponent<Renderer>().sharedMaterial = whiteM;
                }
                var glow = new GameObject("Glow").AddComponent<Light>();
                glow.type = LightType.Point;
                glow.color = new Color(1f, 0.85f, 0.3f);
                glow.range = 0.22f;
                glow.intensity = 0.9f;
                glow.transform.SetParent(go.transform, false);
                glow.gameObject.SetActive(false);
                var rb = go.AddComponent<Rigidbody>();
                rb.isKinematic = true;
                rb.useGravity = false;
                var g = go.AddComponent<XRGrabInteractable>();
                g.movementType = XRBaseInteractable.MovementType.Instantaneous;
                g.throwOnDetach = false;
                g.useDynamicAttach = true;
            }

            // ---------------------------------------------------------- the participant (no headset: poses set by the study API)
            new GameObject("XR Interaction Manager").AddComponent<XRInteractionManager>();
            var rig = new GameObject("Rig").transform;
            rig.position = new Vector3(t.start.x, 0, t.start.z);
            var headGo = new GameObject("Head");
            headGo.tag = "MainCamera";
            headGo.transform.SetParent(rig, false);
            headGo.transform.localPosition = new Vector3(0, t.eyeHeightM, 0);
            var head = headGo.AddComponent<Camera>();
            head.nearClipPlane = 0.05f;
            head.fieldOfView = 90f;
            head.clearFlags = CameraClearFlags.SolidColor;
            head.backgroundColor = new Color(0.78f, 0.8f, 0.83f);
            headGo.AddComponent<AudioListener>();
            Camera Eye(string name)
            {
                var e = new GameObject(name).AddComponent<Camera>();
                e.transform.SetParent(headGo.transform, false);
                e.clearFlags = CameraClearFlags.SolidColor;
                e.backgroundColor = head.backgroundColor;
                return e;
            }
            var left = Eye("Left Eye");
            var right = Eye("Right Eye");

            Transform Hand(string name, bool isRight)
            {
                var h = new GameObject(name).transform;
                h.SetParent(rig, false);
                var model = GameObject.CreatePrimitive(PrimitiveType.Sphere);
                model.name = "Hand Model";
                Object.DestroyImmediate(model.GetComponent<Collider>());
                model.transform.SetParent(h, false);
                model.transform.localScale = new Vector3(0.055f, 0.03f, 0.075f);
                model.GetComponent<Renderer>().sharedMaterial = skinM;
                var ctrl = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                ctrl.name = "Controller";
                Object.DestroyImmediate(ctrl.GetComponent<Collider>());
                ctrl.transform.SetParent(h, false);
                ctrl.transform.localPosition = new Vector3(0, -0.02f, 0.04f);
                ctrl.transform.localRotation = Quaternion.Euler(70f, 0, 0);
                ctrl.transform.localScale = new Vector3(0.022f, 0.04f, 0.022f);
                ctrl.GetComponent<Renderer>().sharedMaterial = darkM;
                return h;
            }
            var rightHand = Hand("Right Hand", true);
            var leftHand = Hand("Left Hand", false);

            var rayGo = new GameObject("Ray Interactor");
            rayGo.transform.SetParent(rightHand, false);
            var ray = rayGo.AddComponent<XRRayInteractor>();
            ray.lineType = XRRayInteractor.LineType.StraightLine;
            ray.maxRaycastDistance = 12f;
            ray.useForceGrab = false;
            var line = rayGo.AddComponent<XRInteractorLineVisual>();
            line.lineWidth = 0.006f;
            rayGo.GetComponent<LineRenderer>().sharedMaterial = rayM;

            var directGo = new GameObject("Direct Interactor");
            directGo.transform.SetParent(rightHand, false);
            var sphere = directGo.AddComponent<SphereCollider>();
            sphere.isTrigger = true;
            sphere.radius = 0.05f;
            var direct = directGo.AddComponent<XRDirectInteractor>();

            // ---------------------------------------------------------- the study
            var study = new GameObject("Study");
            var ctl = study.AddComponent<StudyController>();
            ctl.rig = rig;
            ctl.head = head;
            ctl.leftEye = left;
            ctl.rightEye = right;
            ctl.rightHand = rightHand;
            ctl.leftHand = leftHand;
            ctl.ray = ray;
            ctl.direct = direct;
            ctl.goalZone = zone.transform;
            ctl.panel = text;
            study.AddComponent<StudyApi>();

            PlayerSettings.runInBackground = true;
            EditorSceneManager.SaveScene(scene, StudyEditorServer.ScenePath);
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(StudyEditorServer.ScenePath, true) };
            Debug.Log($"[StudySceneBuilder] built {StudyEditorServer.ScenePath}: {t.objects.Length} objects, {t.practice.Length} practice + {t.main.Length} main tasks");
        }

        static string Title(string s) => string.IsNullOrEmpty(s) ? s : char.ToUpperInvariant(s[0]) + s.Substring(1);

        static GameObject Box(string name, Transform parent, Vector3 pos, Vector3 size, Material m, bool collider = true)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = name;
            go.transform.SetParent(parent, true);
            go.transform.position = pos;
            go.transform.localScale = size;
            go.GetComponent<Renderer>().sharedMaterial = m;
            if (!collider) Object.DestroyImmediate(go.GetComponent<Collider>());
            return go;
        }

        static Material Lit(string name, Color c, Color? emission = null)
        {
            var path = $"{MatDir}/{name}.mat";
            var m = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (m == null)
            {
                m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
                AssetDatabase.CreateAsset(m, path);
            }
            m.SetColor("_BaseColor", c);
            m.SetFloat("_Smoothness", 0.25f);
            if (emission != null)
            {
                m.EnableKeyword("_EMISSION");
                m.SetColor("_EmissionColor", emission.Value);
                m.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            }
            EditorUtility.SetDirty(m);
            return m;
        }
    }
}
