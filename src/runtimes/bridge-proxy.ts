// Wrapper the executor puts around a study bridge (an external runtime's MCP server, stdio):
//   node dist/runtimes/bridge-proxy.js <job-dir> <command> [args...]
// It passes every byte through unchanged in both directions and records in <job-dir>/bridge.jsonl
// what the executor cannot see from Claude Code's stream:
//   {"type": "start", "proxyPid", "pid"}   each start of the bridge (Claude Code may start a crashed one again)
//   {"type": "ready"}                       the bridge answered tools/list (or a tool call) for the first time
//   {"type": "stop", "by"}                  the session ended the bridge (stdin closed, or a signal to the wrapper)
//   {"type": "exit", "code", "signal", "closed"}  the bridge ended; closed = after its stdin was closed
//                                           (written by the wrapper on its own exit, code null, if it ends first)
// The bridge's stderr is passed on and kept in <job-dir>/bridge-stderr.log. When the bridge ends,
// whatever it started and left behind in its process group (an engine) is ended too.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [jobArg, command, ...args] = process.argv.slice(2);
const jobDir = resolve(jobArg ?? ".");
const record = (entry: Record<string, unknown>) => {
  try {
    appendFileSync(join(jobDir, "bridge.jsonl"), JSON.stringify({ t: Date.now(), ...entry }) + "\n");
  } catch {
    // the job folder is gone: nothing to record
  }
};
const stderrLog = (d: Buffer) => {
  try {
    appendFileSync(join(jobDir, "bridge-stderr.log"), d);
  } catch {
    // as above
  }
};
const posix = process.platform !== "win32";

/** End the bridge and everything in its process group (POSIX) or process tree (Windows). */
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (posix) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // the group is empty already
    }
  } else if (signal === "SIGKILL" || child.exitCode === null) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
}

function start(shell: boolean): ChildProcess {
  // Its own process group, so an engine the bridge started can be ended with it.
  return spawn(shell ? `"${command}"` : command, shell ? args.map((a) => `"${a}"`) : args, {
    stdio: ["pipe", "pipe", "pipe"],
    detached: posix,
    shell,
    windowsHide: true,
    env: process.env,
  });
}

let child = start(false);
let closed = false;
let ready = false;
/** Whether the bridge's exit is in bridge.jsonl; if the wrapper ends first, it writes one (code null). */
let exitRecorded = false;
process.on("exit", () => {
  if (!exitRecorded) record({ type: "exit", code: null, signal: null, closed, wrapper: "ended before the bridge's exit was seen" });
});
const listIds = new Set<string>();
const callIds = new Set<string>();

function attach(c: ChildProcess) {
  c.on("spawn", () => record({ type: "start", proxyPid: process.pid, pid: c.pid, command: [command, ...args] }));
  let out = "";
  c.stdout!.on("data", (d: Buffer) => {
    process.stdout.write(d);
    if (ready) return;
    out += d.toString("utf8");
    let i: number;
    while ((i = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      try {
        const m = JSON.parse(line) as { id?: unknown; result?: { isError?: boolean } };
        const id = JSON.stringify(m.id);
        if (m.result && (listIds.has(id) || (callIds.has(id) && !m.result.isError))) {
          ready = true;
          record({ type: "ready" });
          break;
        }
      } catch {
        // not a protocol line
      }
    }
  });
  c.stderr!.on("data", (d: Buffer) => {
    process.stderr.write(d);
    stderrLog(d);
  });
  c.on("error", (e: NodeJS.ErrnoException) => {
    // Windows: "npx", "py" and other commands that are .cmd/.bat files need a shell.
    if (e.code === "ENOENT" && !posix && !c.pid && c === child) {
      child = start(true);
      attach(child);
      wire();
      return;
    }
    exitRecorded = true;
    record({ type: "exit", code: null, signal: null, closed, error: e.message });
    stderrLog(Buffer.from(`Could not start ${command}: ${e.message}\n`));
    process.exit(1);
  });
  c.on("exit", (code, signal) => {
    if (c === child) exitRecorded = true;
    record({ type: "exit", code, signal, closed });
    // Whatever the bridge left running (an engine) ends with it.
    killTree(c, "SIGKILL");
    // Pass on its last output, then end: a bridge that ended on its own looks like a closed
    // connection to Claude Code, which may start it again.
    const done = () => process.stdout.write("", () => process.exit(closed ? 0 : 1));
    if (c.stdout!.readableEnded) done();
    else {
      c.stdout!.once("end", done);
      setTimeout(done, 500).unref();
    }
  });
}
function wire() {
  child.stdin!.on("error", () => undefined); // the bridge ended; its exit is handled above
}
attach(child);
wire();

let inbuf = "";
process.stdin.on("data", (d: Buffer) => {
  child.stdin!.write(d);
  if (ready) return;
  inbuf += d.toString("utf8");
  let i: number;
  while ((i = inbuf.indexOf("\n")) >= 0) {
    const line = inbuf.slice(0, i);
    inbuf = inbuf.slice(i + 1);
    try {
      const m = JSON.parse(line) as { id?: unknown; method?: unknown };
      if (m.method === "tools/list") listIds.add(JSON.stringify(m.id));
      else if (m.method === "tools/call") callIds.add(JSON.stringify(m.id));
    } catch {
      // not a protocol line
    }
  }
});
/** Session over: let the bridge close what it started, then end whatever is left. */
function finish(signal?: NodeJS.Signals) {
  if (closed) return;
  closed = true;
  // Recorded at once: the wrapper may itself be ended by force before the bridge's exit is seen.
  record({ type: "stop", by: signal ? "signal" : "stdin-closed" });
  child.stdin!.end();
  if (signal) killTree(child, signal);
  setTimeout(() => {
    killTree(child, "SIGKILL");
    process.exit(0);
  }, signal ? 3000 : 8000).unref();
}
process.stdin.on("end", () => finish());
process.on("SIGTERM", () => finish("SIGTERM"));
process.on("SIGINT", () => finish("SIGTERM"));
