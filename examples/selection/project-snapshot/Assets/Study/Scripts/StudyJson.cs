// Minimal JSON writing for the study API (JsonUtility cannot write dictionaries or mixed objects).
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEngine;

namespace XRStudy
{
    public sealed class J
    {
        readonly StringBuilder sb = new StringBuilder("{");
        bool first = true;

        public static J Obj() => new J();

        J Key(string k)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append(Str(k)).Append(':');
            return this;
        }

        public J Add(string k, string v) { Key(k); sb.Append(v == null ? "null" : Str(v)); return this; }
        public J Add(string k, bool v) { Key(k); sb.Append(v ? "true" : "false"); return this; }
        public J Add(string k, int v) { Key(k); sb.Append(v.ToString(CultureInfo.InvariantCulture)); return this; }
        public J Add(string k, float v) { Key(k); sb.Append(Num(v)); return this; }
        public J Add(string k, double v) { Key(k); sb.Append(Num((float)v)); return this; }
        public J Raw(string k, string json) { Key(k); sb.Append(json); return this; }
        public J Add(string k, J v) { Key(k); sb.Append(v.ToString()); return this; }
        public J Add(string k, IEnumerable<J> items) { Key(k); sb.Append(Arr(items)); return this; }
        public J Add(string k, IEnumerable<string> items)
        {
            Key(k);
            var s = new StringBuilder("[");
            var f = true;
            foreach (var i in items) { if (!f) s.Append(','); f = false; s.Append(Str(i)); }
            sb.Append(s.Append(']'));
            return this;
        }
        public J Add(string k, Matrix4x4 m)
        {
            Key(k);
            var s = new StringBuilder("[");
            for (var r = 0; r < 4; r++)
                for (var c = 0; c < 4; c++)
                    s.Append(r + c == 0 ? "" : ",").Append(Num(m[r, c]));   // row-major
            sb.Append(s.Append(']'));
            return this;
        }

        public override string ToString() => sb.ToString() + "}";

        public static string Arr(IEnumerable<J> items)
        {
            var s = new StringBuilder("[");
            var f = true;
            foreach (var i in items) { if (!f) s.Append(','); f = false; s.Append(i.ToString()); }
            return s.Append(']').ToString();
        }

        public static string Num(float v) =>
            float.IsNaN(v) || float.IsInfinity(v) ? "null" : System.Math.Round(v, 5).ToString("R", CultureInfo.InvariantCulture);

        public static string Str(string s)
        {
            var b = new StringBuilder("\"");
            foreach (var ch in s)
            {
                switch (ch)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (ch < 0x20) b.Append("\\u").Append(((int)ch).ToString("x4"));
                        else b.Append(ch);
                        break;
                }
            }
            return b.Append('"').ToString();
        }
    }

    /// <summary>Every field any endpoint may take; JsonUtility fills what the body has.</summary>
    [System.Serializable]
    public class StudyRequest
    {
        public string design, phase, id, target, hand, logDir;
        public float yaw, pitch, direction, distance, x, y, z;
        public bool pressed;
    }
}
