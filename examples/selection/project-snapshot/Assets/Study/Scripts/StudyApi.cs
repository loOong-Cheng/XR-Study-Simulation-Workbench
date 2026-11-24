// The study API: a small HTTP server on 127.0.0.1, active only in Play mode (the equivalent of window.xrStudy in the
// WebXR example). Requests are handled one at a time on the main thread by StudyController.Handle.
//   GET /state  /objects     POST /start /look /look_at /walk /teleport /head /hand /trigger /select /place /capture
using System;
using System.Collections;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using UnityEngine;

namespace XRStudy
{
    [RequireComponent(typeof(StudyController))]
    public class StudyApi : MonoBehaviour
    {
        public int port = 8097;

        HttpListener listener;
        Thread thread;
        readonly ConcurrentQueue<(HttpListenerContext ctx, string path, string body)> queue = new();
        StudyController controller;
        bool busy;

        void OnEnable()
        {
            controller = GetComponent<StudyController>();
            Application.runInBackground = true;
            listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Start();
            thread = new Thread(Listen) { IsBackground = true, Name = "StudyApi" };
            thread.Start();
            Debug.Log($"[StudyApi] listening on http://127.0.0.1:{port}/");
        }

        void Listen()
        {
            while (listener != null && listener.IsListening)
            {
                try
                {
                    var ctx = listener.GetContext();
                    string body;
                    using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) body = reader.ReadToEnd();
                    queue.Enqueue((ctx, ctx.Request.Url.AbsolutePath, body));
                }
                catch (Exception)
                {
                    break;      // listener stopped
                }
            }
        }

        void Update()
        {
            if (!busy && queue.TryDequeue(out var r)) StartCoroutine(Run(r.ctx, r.path, r.body));
        }

        IEnumerator Run(HttpListenerContext ctx, string path, string body)
        {
            busy = true;
            string result = null;
            StudyRequest req;
            try { req = string.IsNullOrWhiteSpace(body) ? new StudyRequest() : JsonUtility.FromJson<StudyRequest>(body); }
            catch (Exception e) { req = null; result = J.Obj().Add("ok", false).Add("error", "bad JSON: " + e.Message).ToString(); }
            if (req != null)
            {
                var work = controller.Handle(path, req, s => result = s);
                while (true)
                {
                    object step;
                    try
                    {
                        if (!work.MoveNext()) break;
                        step = work.Current;
                    }
                    catch (Exception e)
                    {
                        Debug.LogException(e);
                        result = J.Obj().Add("ok", false).Add("error", $"{e.GetType().Name}: {e.Message}").ToString();
                        break;
                    }
                    yield return step;
                }
            }
            Respond(ctx, result ?? J.Obj().Add("ok", false).Add("error", "no result").ToString());
            busy = false;
        }

        static void Respond(HttpListenerContext ctx, string json)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(json);
                ctx.Response.ContentType = "application/json";
                ctx.Response.ContentLength64 = bytes.Length;
                ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
                ctx.Response.OutputStream.Close();
            }
            catch (Exception e)
            {
                Debug.LogWarning("[StudyApi] could not answer: " + e.Message);
            }
        }

        void OnDisable()
        {
            try { listener?.Stop(); listener?.Close(); } catch (Exception) { }
            listener = null;
        }
    }
}
