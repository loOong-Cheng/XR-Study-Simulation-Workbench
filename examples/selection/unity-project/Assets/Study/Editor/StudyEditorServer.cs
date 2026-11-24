// Editor control for the study bridge, MCP-independent: a tiny HTTP endpoint on 127.0.0.1:8096 while the Editor runs.
//   GET /status  -> {"playing", "changing", "compiling", "scene"}
//   POST /play   -> opens Assets/Study/Scenes/SelectionRoom.unity if needed and enters Play mode
//   POST /stop   -> exits Play mode
// Also: menu XR Study/Open Scene, Play, Stop. Restarted automatically after every domain reload.
using System;
using System.Collections.Concurrent;
using System.Net;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace XRStudy.EditorTools
{
    [InitializeOnLoad]
    static class StudyEditorServer
    {
        const int Port = 8096;
        public const string ScenePath = "Assets/Study/Scenes/SelectionRoom.unity";
        static HttpListener listener;
        static readonly ConcurrentQueue<HttpListenerContext> Queue = new();

        static StudyEditorServer()
        {
            if (Application.isBatchMode) return;
            try
            {
                listener = new HttpListener();
                listener.Prefixes.Add($"http://127.0.0.1:{Port}/");
                listener.Start();
                new Thread(Listen) { IsBackground = true, Name = "StudyEditorServer" }.Start();
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[StudyEditorServer] port {Port}: {e.Message}");
                listener = null;
            }
            EditorApplication.update += Pump;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
        }

        static void Listen()
        {
            while (listener != null && listener.IsListening)
            {
                try { Queue.Enqueue(listener.GetContext()); }
                catch (Exception) { break; }
            }
        }

        static void Stop()
        {
            try { listener?.Stop(); listener?.Close(); } catch (Exception) { }
            listener = null;
        }

        static void Pump()
        {
            while (Queue.TryDequeue(out var ctx))
            {
                string json;
                try { json = Handle(ctx.Request.Url.AbsolutePath); }
                catch (Exception e) { json = "{\"ok\":false,\"error\":" + J.Str(e.Message) + "}"; }
                try
                {
                    var bytes = Encoding.UTF8.GetBytes(json);
                    ctx.Response.ContentType = "application/json";
                    ctx.Response.ContentLength64 = bytes.Length;
                    ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                    ctx.Response.OutputStream.Close();
                }
                catch (Exception) { }
            }
        }

        static string Status() =>
            J.Obj().Add("ok", true).Add("playing", EditorApplication.isPlaying).Add("changing", EditorApplication.isPlayingOrWillChangePlaymode != EditorApplication.isPlaying)
                .Add("compiling", EditorApplication.isCompiling).Add("scene", SceneManager.GetActiveScene().path).Add("unity", Application.unityVersion)
                .Add("project", Application.dataPath.Replace("/Assets", "")).ToString();

        static string Handle(string path)
        {
            switch (path)
            {
                case "/status": return Status();
                case "/play": Play(); return Status();
                case "/stop": EditorApplication.isPlaying = false; return Status();
                case "/refresh": AssetDatabase.Refresh(); return Status();      // pick up edited scripts (recompiles)
                case "/build":                                                  // regenerate the scene (not in Play mode)
                    if (EditorApplication.isPlaying) return "{\"ok\":false,\"error\":\"stop Play mode first\"}";
                    StudySceneBuilder.Build();
                    return Status();
                default: return "{\"ok\":false,\"error\":\"unknown endpoint\"}";
            }
        }

        [MenuItem("XR Study/Open Scene")]
        static void OpenScene()
        {
            if (SceneManager.GetActiveScene().path != ScenePath) EditorSceneManager.OpenScene(ScenePath, OpenSceneMode.Single);
        }

        [MenuItem("XR Study/Play")]
        static void Play()
        {
            if (EditorApplication.isPlaying) return;
            OpenScene();
            EditorApplication.isPlaying = true;
        }

        [MenuItem("XR Study/Stop")]
        static void StopPlay() => EditorApplication.isPlaying = false;
    }
}
