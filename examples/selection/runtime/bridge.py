#!/usr/bin/env python3
"""Study bridge for suite 2 (selecting and placing objects, Unity): a participant session in the Unity app.

The executor starts it once per agent session (Settings -> Runtimes -> unity), for example:
    python <repo>/examples/selection/runtime/bridge.py {jobFile} --project <your Unity project folder>

It is a stdio MCP server (JSON-RPC 2.0, one message per line) with participant tools (open_design, look, look_at,
walk, teleport, list_objects, select, place, screenshot, task_state). Underneath it talks to the Unity project of
XR-SSR-Unity (Assets/Study), MCP-independent:
- the Editor endpoint (Assets/Study/Editor/StudyEditorServer.cs, 127.0.0.1:8096) enters and exits Play mode;
- the study API in Play mode (Assets/Study/Scripts/StudyApi.cs, 127.0.0.1:8097) sets head and hand poses, presses the
  XR Interaction Toolkit interactors' select input, teleports, and renders a stereo pair (Quest 3 IPD, per-eye matrices).

It follows docs/runtime-adapters.md, "Study bridge contract": answers initialize / tools/list at once and connects on
the first tool call; a fresh Play mode per session; designs only in the order of job.json app.designs; trace events
phase / case-start / observation (both eyes, with eyeSeparationM, viewMatrix, projectionMatrix) / action (select and
place, completed when the app confirms) / case-end; screenshots in <job>/screenshots; never returns which object is the
target, correctness beyond what the participant sees, or other participants' data. Standard library only.

Tool calls count against the shared cap in <job>/calls.log only when accepted. The session's progress (designs used,
the current task, frame counter) is kept in <job>/bridge-state.json: if Claude Code starts the bridge again after a
crash, it resumes there (a fresh Play mode, the current task started again) instead of losing the design order. Frame
IDs and screenshot names are unique within the job. Play mode is stopped when stdin closes or on SIGTERM/SIGINT.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import signal
import sys
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

PROTOCOL_OUT = sys.stdout.buffer
sys.stdout = sys.stderr
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8")


class ToolError(Exception):
    pass


def norm(p):
    return str(Path(p)).replace("\\", "/").rstrip("/").lower() if p else ""


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("job_file", nargs="?", default=os.environ.get("XR_STUDY_JOB_FILE"))
    ap.add_argument("--project", required=True, help="the Unity project the Editor must have open")
    ap.add_argument("--editor-port", type=int, default=8096)
    ap.add_argument("--api-port", type=int, default=8097)
    ap.add_argument("--timeout", type=float, default=60.0, help="seconds per app call")
    return ap.parse_args()


class Session:
    def __init__(self, args):
        self.args = args
        self.job_file = Path(args.job_file).resolve()
        self.job = json.loads(self.job_file.read_text(encoding="utf-8"))
        self.app = self.job.get("app") or {}
        if not self.app.get("designs"):
            raise SystemExit("job.json has no app section: this configuration does not use the app")
        self.job_dir = Path(os.environ.get("XR_STUDY_JOB_DIR") or self.job_file.parent)
        self.trace_path = Path(os.environ.get("XR_STUDY_TRACE") or self.app.get("trace") or self.job_dir / "trace.jsonl")
        self.shots = Path(self.app.get("screenshots") or self.job_dir / "screenshots")
        self.server = self.app.get("runtime") or "unity"
        self.budget = int(self.job.get("budget") or 0)
        self.job_id = self.job.get("jobId") or self.job_dir.parent.name
        self.order = [d["id"] for d in self.app["designs"]]
        self.designs = {d["id"]: d for d in self.app["designs"]}
        self.connected = False
        self.opened = []
        self.design = None
        self.stage = None                # "practice" | "main" | "done"
        self.frames = 0
        self.resume_note = ""
        self.state_path = self.job_dir / "bridge-state.json"
        self.load_state()

    # ------------------------------------------------------------------ state kept in the job folder
    def load_state(self):
        """A bridge started again within the session (after a crash) continues where the last one was."""
        try:
            st = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        self.opened = [d for d in st.get("opened", []) if d in self.designs]
        self.design = self.designs.get(st.get("design"))
        self.stage = st.get("stage") if self.design else None
        self.frames = int(st.get("frames") or 0)

    def save_state(self):
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"opened": self.opened, "design": self.design["id"] if self.design else None,
                                   "stage": self.stage, "frames": self.frames, "pid": os.getpid()}), encoding="utf-8")
        os.replace(tmp, self.state_path)

    # ------------------------------------------------------------------ logging
    def log(self, entry):
        with open(self.trace_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"t": int(time.time() * 1000), "server": self.server, **entry}) + "\n")

    def event(self, ev):
        self.log({"event": ev})

    def count_call(self, tool):
        # Token budget: the executor keeps <job>/usage.json current and sets submitNow once what is left
        # is smaller than 10% of the budget or 3.5 x the last turn; then only the forecast may follow.
        token_budget = int(self.job.get("tokenBudget") or 0)
        if token_budget:
            try:
                usage = json.loads((self.job_dir / "usage.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                usage = {}
            used_tokens = int(usage.get("tokens") or 0)
            if usage.get("submitNow") or used_tokens >= 0.9 * token_budget:
                raise ToolError(f"Token budget of {token_budget} tokens is nearly used up. Submit your forecast now.")
        # Tool-call cap shared with the study server: <job>/calls.log holds one line per accepted call. Checked
        # first and written only when accepted, under the lock folder calls.lock (mkdir is atomic).
        lock, held = self.job_dir / "calls.lock", False
        for _ in range(400):
            try:
                os.mkdir(lock)
                held = True
                break
            except FileExistsError:
                try:
                    if time.time() - lock.stat().st_mtime > 2:      # left by a crashed holder
                        os.rmdir(lock)
                except OSError:
                    pass
                time.sleep(0.01)
            except OSError:
                break
        try:
            calls = self.job_dir / "calls.log"
            try:
                lines = calls.read_text(encoding="utf-8").splitlines()
            except OSError:
                lines = []
            used = len([ln for ln in lines if ln.strip() and ln.strip() != "submit_forecast"])
            if self.budget and used >= self.budget:
                raise ToolError(f"Tool budget of {self.budget} calls is used up. Submit your forecast now.")
            with open(calls, "a", encoding="utf-8") as fh:
                fh.write(tool + "\n")
        finally:
            if held:
                try:
                    os.rmdir(lock)
                except OSError:
                    pass

    def case(self):
        return self.design.get(self.stage) if self.design and self.stage in ("practice", "main") else None

    def begin_case(self, stage):
        self.stage = stage
        self.save_state()
        c = self.case()
        if c:
            self.event({"type": "phase", "phaseId": c["phaseId"]})
            self.event({"type": "case-start", "caseId": c["caseId"], "phaseId": c["phaseId"]})

    def end_case(self, complete):
        c = self.case()
        if c:
            self.event({"type": "case-end", "caseId": c["caseId"], "phaseId": c["phaseId"], "submitted": bool(complete)})

    def action(self, name, completed=True):
        c = self.case()
        if c:
            self.event({"type": "action", "caseId": c["caseId"], "phaseId": c["phaseId"], "action": name,
                        "completed": bool(completed)})

    # ------------------------------------------------------------------ the app
    def http(self, port, path, body=None, timeout=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="GET" if data is None else "POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.args.timeout) as r:
                return json.loads(r.read() or b"{}")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            raise ConnectionError(f"127.0.0.1:{port}{path}: {e}") from e

    def editor(self, path):
        return self.http(self.args.editor_port, path, {} if path != "/status" else None)

    def api(self, path, body=None):
        out = self.http(self.args.api_port, path, body if body is not None else ({} if path not in ("/state", "/objects") else None))
        if not out.get("ok", False):
            raise ToolError(out.get("error") or f"{path} failed")
        return out

    def wait_for(self, check, timeout, what):
        end = time.time() + timeout
        while True:
            try:
                if check():
                    return
            except (ConnectionError, ToolError, json.JSONDecodeError):
                pass                     # the Editor reloads scripts when Play mode starts or stops
            if time.time() > end:
                raise ToolError(f"The Unity app did not {what} within {timeout:.0f} s.")
            time.sleep(0.5)

    def connect(self):
        if self.connected:
            return
        try:
            st = self.editor("/status")
        except ConnectionError:
            raise ToolError(f"The Unity Editor is not reachable on port {self.args.editor_port}; open {self.args.project} "
                            "in Unity (the study's Editor endpoint starts with it).")
        if norm(st.get("project")) != norm(self.args.project):
            raise ToolError(f"The Unity Editor on port {self.args.editor_port} has {st.get('project')} open, not {self.args.project}.")
        if st.get("playing"):            # a fresh Play mode for every session
            self.editor("/stop")
            self.wait_for(lambda: not self.editor("/status")["playing"], 60, "leave Play mode")
        self.editor("/play")
        self.wait_for(lambda: self.api("/state").get("ok"), 180, "enter Play mode")
        self.connected = True
        self.log({"bridge": "connected", "project": st.get("project"), "unity": st.get("unity")})
        # The runtime's own identity for the audit (docs/runtime-adapters.md, "runtime" event): what this
        # bridge and app really provide, compared there with study.json's frozen runtime recipe.
        # A bridge started again within the session reports itself again: the audit counts the restart.
        self.event({"type": "runtime", "engine": "unity", "engineVersion": str(st.get("unity") or "unknown"),
                    "backend": "editor", "deviceProfile": "quest-3", "observation": "stereo-pair",
                    "capabilities": ["head-pose", "hand-poses", "controller-input", "stereo-capture", "phase-events"],
                    "pid": os.getpid()})
        if self.design and self.stage in ("practice", "main"):
            # Resumed after a crash: the fresh Play mode starts the task the participant was on again.
            self.api("/start", {"design": self.design["id"], "phase": self.stage, "logDir": str(self.job_dir / "app_logs")})
            self.begin_case(self.stage)
            part = "practice task starts" if self.stage == "practice" else "scored tasks start"
            self.resume_note = f"The app was restarted: the {part} again with {self.design['label']}. "

    def view(self):
        """Capture the stereo pair, save both eyes, log one observation, return both images."""
        cap = self.api("/capture")
        # The frame counter lives in bridge-state.json, so frame IDs and file names stay unique within the job
        # even when the bridge (and the app's own frame counter) starts again.
        self.frames += 1
        self.save_state()
        self.shots.mkdir(parents=True, exist_ok=True)
        content, captures = [], []
        for eye in cap["eyes"]:
            data = base64.b64decode(eye["jpegBase64"])
            (self.shots / f"{self.frames:03d}-{self.design['id'] if self.design else 'none'}-{eye['eye']}.jpg").write_bytes(data)
            captures.append({"eye": eye["eye"], "sha256": hashlib.sha256(data).hexdigest(),
                             "frameId": f"{self.job_id}-{self.frames}", "simulationTimeMs": round(cap["simulationTimeMs"]),
                             "eyeSeparationM": eye["eyeSeparationM"], "viewMatrix": eye["viewMatrix"],
                             "projectionMatrix": eye["projectionMatrix"]})
            content.append({"type": "text", "text": f"{eye['eye'].capitalize()} eye:"})
            content.append({"type": "image", "data": eye["jpegBase64"], "mimeType": "image/jpeg"})
        c = self.case()
        if c:
            self.event({"type": "observation", "caseId": c["caseId"], "phaseId": c["phaseId"], "captures": captures})
        return content

    def need_task(self):
        if not self.connected and self.design is not None and self.stage in ("practice", "main"):
            self.connect()               # started again after a crash: resume the current task
        if not self.connected or self.design is None:
            raise ToolError(f"Use a technique first: open_design with {self.next_design()}.")
        if self.stage == "done":
            nxt = self.next_design()
            raise ToolError("This technique is finished. " + (f"Open the next one: {nxt}." if nxt else "All techniques are done: submit your forecast."))

    def next_design(self):
        return next((d for d in self.order if d not in self.opened), None)

    def describe(self, st):
        part = "practice" if st["phase"] == "practice" else "scored tasks"
        holding = f" You are holding {st['holding']}." if st.get("holding") else ""
        return (f"{st['techniqueLabel']}, {part}: task {st['task']} of {st['tasks']}. The panel says: "
                f"\"{' '.join(st['instruction'].split())}\".{holding}")

    # ------------------------------------------------------------------ tools
    def open_design(self, a):
        design = str(a.get("design", ""))
        nxt = self.next_design()
        if design not in self.designs:
            raise ToolError(f"Unknown technique {design!r}. Your order: {', '.join(self.order)}.")
        if design in self.opened:
            raise ToolError(f"You already used {design}. " + (f"The next one is {nxt}." if nxt else "All techniques are done: submit your forecast."))
        if design != nxt:
            raise ToolError(f"Use the techniques in your order: the next one is {nxt}.")
        self.connect()
        if self.case():
            self.end_case(False)
        d = self.designs[design]
        self.opened.append(design)
        self.design = d
        self.resume_note = ""
        stage = "practice" if d.get("practice") else "main"
        st = self.api("/start", {"design": design, "phase": stage, "logDir": str(self.job_dir / "app_logs")})
        self.begin_case(stage)
        head = (f"You now use {d['label']}: first a guided practice task, then the scored tasks. " if stage == "practice"
                else f"You now use {d['label']}. ")
        return [{"type": "text", "text": head + self.describe(st) + " Your view (left and right eye):"}] + self.view()

    def look(self, a):
        self.need_task()
        self.api("/look", {"yaw": float(a.get("yaw", 0)), "pitch": float(a.get("pitch", 0))})
        self.action("look-around")
        return [{"type": "text", "text": "You turned your head. Your view:"}] + self.view()

    def look_at(self, a):
        self.need_task()
        out = self.api("/look_at", {"target": str(a.get("target", ""))})
        self.action("look-around")
        return [{"type": "text", "text": f"You look at {a.get('target')}, about {out['distanceM']:.1f} m away. Your view:"}] + self.view()

    def walk(self, a):
        self.need_task()
        out = self.api("/walk", {"direction": float(a.get("direction", 0)), "distance": float(a.get("distance_m", 0))})
        self.action("walk")
        msg = f"You walked {out['walkedM']:.2f} m" + (" (the play area or furniture stopped you)." if out["stopped"] else ".")
        return [{"type": "text", "text": msg + " Your view:"}] + self.view()

    def teleport(self, a):
        self.need_task()
        out = self.api("/teleport", {"direction": float(a.get("direction", 0)), "distance": float(a.get("distance_m", 0))})
        self.action("teleport", out.get("teleported", False))
        msg = (f"You teleported {out['distanceM']:.1f} m" + (" (the arc reaches 4 m at most)." if out.get("clipped") else ".")
               if out.get("teleported") else f"No teleport: {out.get('reason')}.")
        return [{"type": "text", "text": msg + " Your view:"}] + self.view()

    def list_objects(self, a):
        self.need_task()
        out = self.api("/objects")
        rows = [{"id": o["id"], "in_view": o["inView"], "x": o["x"], "y": o["y"], "distance_m": round(o["distanceM"], 2)}
                for o in out["objects"]]
        return [{"type": "text", "text": "Objects (neutral ids; x, y = position in the left-eye image, 0-1 from the "
                 "top left; null when out of view): " + json.dumps(rows)}]

    def select(self, a):
        self.need_task()
        out = self.api("/select", {"id": str(a.get("object", ""))})
        res = out.get("result")
        self.action("select", res == "picked-up")
        msg = {"picked-up": f"You picked up {out.get('selected')} ({'with the ray' if out.get('via') == 'ray' else 'by hand'}).",
               "wrong-object": f"You picked up {out.get('selected')}, which is not the glowing object; you put it back.",
               "out-of-reach": "Your hand cannot reach it from here: move closer first.",
               "ray-hit-nothing": "The ray hit no object when you pressed the trigger.",
               "nothing-in-hand": "There was nothing in your hand when you grabbed."}.get(res, str(res))
        return [{"type": "text", "text": msg + " Your view:"}] + self.view()

    def place(self, a):
        self.need_task()
        out = self.api("/place", {})
        if not out.get("placed"):
            self.action("place", False)
            return [{"type": "text", "text": f"Not placed: {out.get('reason')}. Your view:"}] + self.view()
        self.action("place", True)
        if not out.get("blockDone"):
            st = self.api("/state")
            return [{"type": "text", "text": "Placed. Next: " + self.describe(st) + " Your view:"}] + self.view()
        self.event({"type": "action", "caseId": self.case()["caseId"], "phaseId": self.case()["phaseId"],
                    "action": "complete-task", "completed": True})
        self.end_case(True)
        if self.stage == "practice" and self.design.get("main"):
            st = self.api("/start", {"design": self.design["id"], "phase": "main", "logDir": str(self.job_dir / "app_logs")})
            self.begin_case("main")
            return [{"type": "text", "text": "Placed. Practice is over; the scored tasks start now. " + self.describe(st)
                     + " Your view:"}] + self.view()
        self.stage = "done"
        self.save_state()
        nxt = self.next_design()
        return [{"type": "text", "text": f"Placed. That was the last task with {self.design['label']}. "
                 + (f"Open the next technique: {nxt}." if nxt else "You have used every technique: submit your forecast.")}]

    def screenshot(self, a):
        self.need_task()
        return [{"type": "text", "text": "Your current view (left and right eye):"}] + self.view()

    def task_state(self, a):
        out = {"techniques_in_order": self.order, "techniques_done": [d for d in self.opened if not (self.design and d == self.design["id"] and self.stage != "done")],
               "next_technique": self.next_design()}
        if self.connected and self.design and self.stage != "done":
            st = self.api("/state")
            out.update({"technique": st["techniqueLabel"], "part": st["phase"], "task": st["task"], "tasks": st["tasks"],
                        "panel": " ".join(st["instruction"].split()), "holding": st.get("holding"),
                        "wrong_pickups_this_part": st["wrongSelections"], "teleports_this_part": st["teleports"]})
        return [{"type": "text", "text": json.dumps(out)}]

    def close(self):
        if not self.connected:
            return
        try:
            # The forecast was usually accepted by now: only the case still open is closed (submitted false),
            # which the audit allows after the forecast boundary. Nothing else is written.
            if self.case():
                self.end_case(False)
            self.editor("/stop")
        except Exception as e:
            self.log({"bridge": "close-failed", "error": repr(e)[:300]})


def tools_for(s):
    order = ", ".join(s.order)
    num = {"type": "number"}
    return [
        ("open_design", f"Start using the next selection technique, in your order: {order}. First a guided practice task, "
                        "then the scored tasks. Returns the panel's instruction and your view (left and right eye).",
         {"design": {"type": "string", "enum": s.order}}, ["design"]),
        ("look", "Turn your head to an absolute direction: yaw in degrees (0 = towards the long table, + right) and "
                 "pitch in degrees (+ up, - down).", {"yaw": num, "pitch": num}, ["yaw", "pitch"]),
        ("look_at", "Turn your head towards an object (its id from list_objects), the green 'zone' or the 'panel'.",
         {"target": {"type": "string"}}, ["target"]),
        ("walk", "Step inside your 2 x 2 m play area: direction in degrees relative to your view (+ right), distance in m.",
         {"direction": num, "distance_m": num}, ["distance_m"]),
        ("teleport", "Teleport with the thumbstick arc: direction in degrees relative to your view (+ right), distance in m "
                     "(at most 4). Walls and furniture block landing spots.", {"direction": num, "distance_m": num}, ["distance_m"]),
        ("list_objects", "Neutral ids of the objects with their position in your left-eye image and their distance. It "
                         "does not say which one glows: look at the images.", {}, []),
        ("select", "Pick up an object with the current technique: aim at it and press the trigger (ray), or reach and grab "
                   "it (hand, only within arm's reach). Whatever the ray hits first, or the hand touches, is picked up.",
         {"object": {"type": "string"}}, ["object"]),
        ("place", "Put the object you hold into the green zone: point the ray at it, or reach it with your hand (it must be "
                  "within arm's reach). Ends the task when it rests in the zone.", {}, []),
        ("screenshot", "See your current view again (left and right eye).", {}, []),
        ("task_state", "The panel's instruction and your progress, as text (no image).", {}, []),
    ]


def main():
    args = parse_args()
    s = Session(args)
    specs = tools_for(s)
    handlers = {n: getattr(s, n) for n, *_ in specs}

    def send(msg):
        PROTOCOL_OUT.write((json.dumps(msg) + "\n").encode("utf-8"))
        PROTOCOL_OUT.flush()

    def stop(signum, frame):
        raise SystemExit(0)              # runs close() below: Play mode does not outlive the session

    signal.signal(signal.SIGTERM, stop)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            mid, method = msg.get("id"), msg.get("method")
            if mid is None:
                continue
            if method == "initialize":
                version = (msg.get("params") or {}).get("protocolVersion", "2025-06-18")
                send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": version, "capabilities": {"tools": {}},
                                                              "serverInfo": {"name": "selection-unity-bridge", "version": "1"}}})
            elif method == "ping":
                send({"jsonrpc": "2.0", "id": mid, "result": {}})
            elif method == "tools/list":
                send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [
                    {"name": n, "description": d, "inputSchema": {"type": "object", "properties": p, "required": r}}
                    for n, d, p, r in specs]}})
            elif method == "tools/call":
                p = msg.get("params") or {}
                name, a = p.get("name"), p.get("arguments") or {}
                if name not in handlers:
                    send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32602, "message": f"Unknown tool {name}"}})
                    continue
                try:
                    s.count_call(name)
                    content = handlers[name](a)
                    if s.resume_note and content and content[0].get("type") == "text":
                        content[0]["text"] = s.resume_note + content[0]["text"]
                        s.resume_note = ""
                    s.log({"tool": name, "ok": True})
                    send({"jsonrpc": "2.0", "id": mid, "result": {"content": content}})
                except ToolError as e:
                    s.log({"tool": name, "ok": False, "error": str(e)[:300]})
                    send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": str(e)}], "isError": True}})
                except Exception as e:
                    s.log({"tool": name, "ok": False, "error": traceback.format_exc()[-1500:]})
                    send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text":
                          f"The app did not respond as expected ({type(e).__name__}: {str(e)[:300]}). Try again."}], "isError": True}})
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"Method not found: {method}"}})
    finally:
        s.close()


if __name__ == "__main__":
    main()
