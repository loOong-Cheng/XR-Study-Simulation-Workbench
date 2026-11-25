// Attempt folders and what survives a crash of the workbench. Every attempt of a session runs in
// its own new folder (jobs/<job>/a<n>/, see Executor.attemptFolder) that starts with a marker, attempt.json: when it started,
// in which mode, which workbench process runs it and the PID of its claude process. A marker
// without a receipt is an attempt whose end was never recorded: after a restart the executor
// finishes or closes it (see Executor.open) and stops processes it left behind.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TraceEvent } from "../core/types.js";

/** This workbench process, as written into the markers of the attempts it starts. */
export const SERVER = { instance: randomUUID(), pid: process.pid, script: process.argv[1] ?? "" };
export interface AttemptMarker {
  schema: "xr-study-attempt/1";
  jobId: string;
  attempt: number;
  mode: "agent" | "simulate";
  startedAt: string;
  server: { instance: string; pid: number; script: string };
  /** The claude process of a real session; null before it starts and for simulations. */
  pid: number | null;
  /** Sources injected into the prompt (the audit's source deliveries), to finish the attempt after a restart. */
  sourceEvents?: TraceEvent[];
}
export const MARKER = "attempt.json";
/**
 * Attempt folders this process is running and has not yet closed with a receipt. A restart of
 * the executor (closed and opened again) never treats them as left behind.
 */
export const activeAttempts = new Set<string>();

/** Attempt numbers that have a folder (a1, a2, …) in a session's folder. */
export async function attemptFolders(jobRoot: string): Promise<number[]> {
  if (!existsSync(jobRoot)) return [];
  return (await readdir(jobRoot)).filter((f) => /^a\d+$/.test(f)).map((f) => Number(f.slice(1)));
}
/** Writes (or rewrites) an attempt's marker whole: a crash never leaves half a marker. */
export async function writeMarker(dir: string, marker: Omit<AttemptMarker, "schema" | "server">) {
  const full: AttemptMarker = { schema: "xr-study-attempt/1", ...marker, server: { ...SERVER } };
  const tmp = join(dir, `${MARKER}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(full, null, 2) + "\n");
  await rename(tmp, join(dir, MARKER));
  return full;
}
export async function readMarker(dir: string): Promise<AttemptMarker | null> {
  try {
    const m = JSON.parse(await readFile(join(dir, MARKER), "utf8")) as AttemptMarker;
    return m && m.schema === "xr-study-attempt/1" ? m : null;
  } catch {
    return null;
  }
}
/** Attempts of a campaign's run folder with a marker but no receipt ("job|attempt" in `receipted`). */
export async function unfinishedAttempts(runFolder: string, receipted: Set<string>) {
  const out: { jobId: string; attempt: number; dir: string; marker: AttemptMarker }[] = [];
  const jobs = join(runFolder, "jobs");
  if (!existsSync(jobs)) return out;
  for (const jobId of await readdir(jobs)) {
    for (const attempt of await attemptFolders(join(jobs, jobId)).catch(() => [])) {
      if (receipted.has(`${jobId}|${attempt}`)) continue;
      const dir = join(jobs, jobId, `a${attempt}`);
      const marker = await readMarker(dir);
      if (marker) out.push({ jobId, attempt, dir, marker });
    }
  }
  return out;
}

/**
 * Appends to one file one after another, in the order they were asked for, each line whole
 * (events and receipts of sessions that end at the same moment never interleave). A missing
 * folder is created, but only inside `root` while it exists: a line written after its study or
 * campaign was moved away (deleted) is dropped rather than bringing the folder back.
 */
const appends = new Map<string, Promise<void>>();
export function appendLine(path: string, text: string, root?: string): Promise<void> {
  const write = async () => {
    try {
      await appendFile(path, text);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (root && !existsSync(root)) return;
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text);
    }
  };
  const next = (appends.get(path) ?? Promise.resolve()).then(write, write);
  appends.set(path, next);
  const clear = () => {
    if (appends.get(path) === next) appends.delete(path);
  };
  next.then(clear, clear);
  return next;
}

// ---------- processes a crashed workbench left behind ----------

export function alive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
const run = (cmd: string, args: string[]) =>
  new Promise<string>((ok) => execFile(cmd, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, out) => ok(err ? "" : String(out))));
/** Every process of this user with its full command line (empty when it cannot be listed). */
export async function processList(): Promise<{ pid: number; command: string }[]> {
  const text =
    process.platform === "win32"
      ? await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"])
      : await run("ps", ["-ww", "-axo", "pid=,command="]);
  return text
    .split(/\r?\n/)
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), command: m[2] }));
}
/** Whether a command line names this attempt folder (a1 must not match a10). */
export function mentionsFolder(command: string, dir: string): boolean {
  for (let i = command.indexOf(dir); i >= 0; i = command.indexOf(dir, i + 1)) {
    const after = command[i + dir.length];
    if (after === undefined || /[\\/\s"']/.test(after)) return true;
  }
  return false;
}
/** Whether the workbench process that started an attempt still runs (another server on this checkout). */
export async function serverAlive(server: AttemptMarker["server"]): Promise<boolean> {
  if (server.pid === process.pid || !alive(server.pid)) return false;
  const p = (await processList()).find((x) => x.pid === server.pid);
  // A process that reuses the PID of a dead workbench is not it.
  return !p || !server.script || p.command.includes(basename(server.script));
}
/**
 * Stop the processes an attempt left running: its claude process (the marker's PID) and the MCP
 * servers it started, each only if its command line names the attempt folder. Waits until they
 * have ended (SIGKILL after a grace period) and returns their PIDs.
 */
export async function stopLeftovers(dir: string, pid: number | null): Promise<number[]> {
  const list = await processList();
  const ours = list.filter((p) => p.pid !== process.pid && mentionsFolder(p.command, dir)).map((p) => p.pid);
  // The marker's PID is stopped only when its command line names the folder too (a reused PID is someone else's).
  const pids = [...new Set(pid && list.some((p) => p.pid === pid && mentionsFolder(p.command, dir)) ? [pid, ...ours] : ours)];
  if (!pids.length) return [];
  const signal = (s: NodeJS.Signals) =>
    pids.forEach((p) => {
      try {
        process.kill(p, s);
      } catch {
        // already gone
      }
    });
  signal("SIGTERM");
  for (let i = 0; i < 30 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  if (pids.some(alive)) {
    signal("SIGKILL");
    for (let i = 0; i < 30 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 100));
  }
  return pids;
}
