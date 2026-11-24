// The processes the workbench starts: Claude Code sessions (with their MCP servers, Chrome and
// engine bridges) and the assistant. Started without a console window, ended as a whole tree on
// every system, ended with the server, and never mistaken for another program's processes.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCommand, type Settings } from "../settings.js";

const win = process.platform === "win32";

/** What this Claude Code accepts, read from `claude --help`. Unknown when the help could not be read. */
export interface ClaudeFeatures {
  /** Whether the help text was read; otherwise the flags below are the defaults of a current version. */
  known: boolean;
  /** --include-partial-messages: live token counts per API message (older versions lack it). */
  partialMessages: boolean;
  /** --system-prompt-file. */
  systemPromptFile: boolean;
}
const features = new Map<string, Promise<ClaudeFeatures>>();
/** Read once per Claude Code path (an unreadable help is tried again next time). */
export function claudeFeatures(settings: Pick<Settings, "claudePath">): Promise<ClaudeFeatures> {
  const { command, prefix } = claudeCommand(settings);
  const key = [command, ...prefix].join("\0");
  if (!features.has(key))
    features.set(
      key,
      readHelp(command, prefix).then((f) => {
        if (!f.known) features.delete(key);
        return f;
      }),
    );
  return features.get(key)!;
}
/** The flags in a help text of Claude Code; null when it is not one (no print-mode options). */
export function featuresFromHelp(help: string): ClaudeFeatures | null {
  if (!/--output-format/.test(help)) return null;
  return {
    known: true,
    partialMessages: /--include-partial-messages\b/.test(help),
    // Listed as its own option, or (newer versions) as "--system-prompt[-file]" in another option's text.
    systemPromptFile: /--system-prompt(-file\b|\[-file\])/.test(help),
  };
}
function readHelp(command: string, prefix: string[]): Promise<ClaudeFeatures> {
  const unknown: ClaudeFeatures = { known: false, partialMessages: true, systemPromptFile: false };
  return new Promise((done) => {
    let p: ChildProcess;
    try {
      p = spawn(command, [...prefix, "--help"], { cwd: tmpdir(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return done(unknown);
    }
    let out = "";
    p.stdout!.setEncoding("utf8");
    p.stdout!.on("data", (d: string) => (out = (out + d).slice(0, 200_000)));
    const timer = setTimeout(() => p.kill(), 20_000);
    p.on("error", () => undefined); // reported by "close" with no help text
    p.on("close", (code) => {
      clearTimeout(timer);
      done((code === 0 && featuresFromHelp(out)) || unknown);
    });
  });
}

/** Processes started here and still running: ended with the server, however it ends. */
const live = new Set<ChildProcess>();
/**
 * Start a process whose whole tree can be ended later (killTree), without a console window.
 * On macOS and Linux it leads its own process group; Windows ends trees by process ID.
 */
export function spawnTree(command: string, args: string[], options: SpawnOptions): ChildProcess {
  const p = spawn(command, args, { ...options, windowsHide: true, detached: !win });
  if (p.pid !== undefined) {
    live.add(p);
    p.once("close", () => live.delete(p));
  }
  return p;
}
/**
 * End a process and everything it started (MCP servers, Chrome, an engine bridge). macOS and Linux:
 * SIGTERM to its process group, so the servers clean up (Chrome, temporary profiles), then SIGKILL
 * to whatever is left after `graceMs`. Windows has no signals for console programs: taskkill /T /F
 * ends the whole tree at once (profiles left behind are removed later, see removeStaleProfiles).
 */
export function killTree(p: ChildProcess | null | undefined, graceMs = 5000): void {
  if (!p || p.pid === undefined) return;
  const pid = p.pid;
  if (win) {
    if (p.exitCode !== null || p.signalCode !== null) return;
    const t = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    t.on("error", () => p.kill());
    return;
  }
  const group = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false; // the group has ended (or was never one)
    }
  };
  if (!group("SIGTERM")) {
    p.kill("SIGTERM");
    return;
  }
  setTimeout(() => group("SIGKILL"), graceMs).unref();
}
/** At exit only synchronous work runs: end every tree still running. */
function killAllNow() {
  for (const p of live) {
    if (p.pid === undefined) continue;
    if (win) spawnSync("taskkill", ["/T", "/F", "/PID", String(p.pid)], { stdio: "ignore", windowsHide: true });
    else
      try {
        process.kill(-p.pid, "SIGTERM");
      } catch {
        p.kill("SIGTERM");
      }
  }
  live.clear();
}
process.on("exit", killAllNow);

/**
 * Chrome profiles of the WebXR runtime (xr-webxr-* in the temporary folder) that a session ended
 * by force left behind, older than a day so that running sessions keep theirs.
 */
export async function removeStaleProfiles(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
    if (!name.startsWith("xr-webxr-")) continue;
    const dir = join(tmpdir(), name);
    try {
      const s = await stat(dir);
      if (!s.isDirectory() || now - s.mtimeMs < 24 * 3600_000) continue;
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed++;
    } catch {
      // in use or already gone
    }
  }
  return removed;
}
