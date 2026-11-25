// Machine-local workbench settings (private/settings.json, git-ignored): which
// agent answers workbench buttons, the default forecasting model, MCP runtimes.
import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { repoRoot } from "./workspace.js";
import { requireThat } from "./core/validation.js";
import { readJsonFile, unquotePath } from "./files.js";

export interface RuntimeSetting {
  /** Command that starts the runtime's MCP server (stdio). Empty = not configured. */
  command?: string;
  /** Arguments; {jobDir}, {jobFile} and {trace} are replaced per session (also given as XR_STUDY_JOB_DIR, XR_STUDY_JOB_FILE, XR_STUDY_TRACE). */
  args?: string[];
  /** Extra guidance for agents on how to use this runtime's tools (added to the session's instructions). */
  instructions?: string;
  /** Capabilities this runtime provides, matched against the study's required capabilities (e.g. screenshot, phase-events). */
  capabilities?: string[];
  /** Minutes before a session on this runtime is stopped (default: 90 for engine runtimes, else the global job timeout). */
  timeoutMinutes?: number;
  /** Sessions on this runtime at the same time (default: 1 for engine runtimes, since one editor hosts one session; WebXR: one per 4 logical cores). */
  maxParallel?: number;
  /** Seconds the bridge has to answer tools/list after the session starts; otherwise the session fails (default 60). */
  startupSeconds?: number;
  note?: string;
}
export interface Settings {
  /** Agent used when you press workbench buttons (understand study, suggest configs, explain results). */
  assistant: { kind: "claude-code" | "codex" | "api"; model: string };
  /** Default forecasting model for new agent configs: your planned usage. */
  forecasting: { provider: string; model: string; reasoning: string };
  runtimes: Record<string, RuntimeSetting>;
  chromePath: string;
  /** Claude Code executable for agent sessions and the assistant (default: "claude" on PATH; setup fills in the full path). */
  claudePath?: string;
  concurrency: number;
  jobTimeoutMinutes: number;
}
export const defaultSettings = (): Settings => ({
  assistant: { kind: "claude-code", model: "claude-opus-5-5" },
  forecasting: { provider: "claude-code", model: "claude-opus-5-5", reasoning: "default" },
  runtimes: { unreal: {}, unity: {}, visionos: {} },
  chromePath:
    process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : process.platform === "win32"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "google-chrome",
  concurrency: 1,
  jobTimeoutMinutes: 30,
});
/** Engine runtimes run in one editor that hosts one Play session at a time and need long sessions. */
const engineRuntimes = new Set(["unreal", "unity", "visionos"]);
/**
 * WebXR sessions at the same time by default: one per 4 logical cores of this computer, at least 1.
 * Each session's Chrome renders the app in software on the CPU, and a detailed scene takes several
 * cores for each frame it draws (GitHub issue 1).
 */
export const webxrDefaultParallel = (): number => Math.max(1, Math.floor(availableParallelism() / 4));
/** Per-runtime session time limit and how many sessions of it may run at once. */
export function runtimeLimits(settings: Pick<Settings, "runtimes" | "jobTimeoutMinutes">, runtime: string): { timeoutMinutes: number; maxParallel: number; startupSeconds: number } {
  const r = settings.runtimes?.[runtime] ?? {};
  const engine = engineRuntimes.has(runtime);
  return {
    timeoutMinutes: r.timeoutMinutes ?? (engine ? Math.max(90, settings.jobTimeoutMinutes) : settings.jobTimeoutMinutes),
    maxParallel: r.maxParallel ?? (engine ? 1 : runtime === "webxr" ? webxrDefaultParallel() : Infinity),
    startupSeconds: r.startupSeconds ?? 60,
  };
}
/**
 * How to start Claude Code. Normally the native executable (claude.exe on Windows). A Node script
 * (.js/.cjs/.mjs, e.g. the tests' stand-in CLI) is run with this Node, because Windows cannot start
 * extensionless shebang scripts and spawning .cmd files needs a shell.
 */
export function claudeCommand(settings: Pick<Settings, "claudePath">): { command: string; prefix: string[] } {
  const p = settings.claudePath || "claude";
  return /\.[cm]?js$/i.test(p) ? { command: process.execPath, prefix: [p] } : { command: p, prefix: [] };
}
/**
 * Why the configured Claude Code cannot be started, or null. A .cmd/.bat file (npm's claude.cmd)
 * needs a shell on Windows, which the executor does not use; a path that does not exist fails at
 * once. The default, `claude` on PATH, is checked when a session starts.
 */
export function claudeProblem(settings: Pick<Settings, "claudePath">): string | null {
  const p = settings.claudePath;
  if (!p) return null;
  if (/\.(cmd|bat)$/i.test(p))
    return `Claude Code is set to ${p}, a .cmd/.bat script that agent sessions cannot start. Run \`node scripts/setup.mjs\`, which finds the native claude.exe, or set claudePath in private/settings.json to claude.exe.`;
  if (/[\\/]/.test(p) && !existsSync(p)) return `Claude Code was not found at ${p}. Run \`node scripts/setup.mjs\` on this machine to find it again.`;
  return null;
}
/** XR_STUDY_SETTINGS points at another settings file (tests, several machines sharing one checkout). */
export const settingsFile = () => process.env.XR_STUDY_SETTINGS || join(repoRoot, "private", "settings.json");
const path = settingsFile;
/**
 * Program paths without the quotes a pasted path brings along ("Copy as path" in Windows Explorer,
 * or a path copied from a shortcut): Chrome, Claude Code and each runtime's command.
 */
function unquotedPaths<T extends Partial<Settings>>(s: T): T {
  const out = { ...s };
  if (typeof out.chromePath === "string") out.chromePath = unquotePath(out.chromePath);
  if (typeof out.claudePath === "string") out.claudePath = unquotePath(out.claudePath);
  if (out.runtimes && typeof out.runtimes === "object")
    out.runtimes = Object.fromEntries(
      Object.entries(out.runtimes).map(([id, r]) => [id, r && typeof r === "object" && typeof r.command === "string" ? { ...r, command: unquotePath(r.command) } : r]),
    );
  return out;
}
export async function readSettings(): Promise<Settings> {
  if (!existsSync(path())) return defaultSettings();
  // Also a file saved by PowerShell 5.1 or Notepad (byte-order mark, UTF-16).
  const saved = unquotedPaths(await readJsonFile<Partial<Settings>>(path()));
  const d = defaultSettings();
  return { ...d, ...saved, runtimes: { ...d.runtimes, ...(saved.runtimes ?? {}) } };
}
export async function writeSettings(input: Settings): Promise<Settings> {
  const value = input && typeof input === "object" ? unquotedPaths(input) : input;
  requireThat(["claude-code", "codex", "api"].includes(value?.assistant?.kind), "Choose the assistant agent.");
  requireThat(
    [value.forecasting?.provider, value.forecasting?.model, value.forecasting?.reasoning].every(
      (v) => typeof v === "string" && v.trim().length > 0,
    ),
    "Enter the default forecasting provider, model and reasoning setting.",
  );
  requireThat(Number.isInteger(value.concurrency) && value.concurrency >= 1 && value.concurrency <= 8, "Use 1–8 parallel sessions.");
  requireThat(Number.isFinite(value.jobTimeoutMinutes) && value.jobTimeoutMinutes >= 1, "Set a job timeout in minutes.");
  for (const [id, r] of Object.entries(value.runtimes ?? {}))
    requireThat(
      /^[a-z0-9-]+$/.test(id) &&
        (r.command === undefined || typeof r.command === "string") &&
        (r.args === undefined || (Array.isArray(r.args) && r.args.every((x) => typeof x === "string"))) &&
        (r.instructions === undefined || typeof r.instructions === "string") &&
        (r.capabilities === undefined || (Array.isArray(r.capabilities) && r.capabilities.every((x) => typeof x === "string"))) &&
        (r.timeoutMinutes === undefined || (Number.isFinite(r.timeoutMinutes) && r.timeoutMinutes >= 1)) &&
        (r.maxParallel === undefined || (Number.isInteger(r.maxParallel) && r.maxParallel >= 1)) &&
        (r.startupSeconds === undefined || (Number.isFinite(r.startupSeconds) && r.startupSeconds >= 1)),
      `Invalid runtime ${id}.`,
    );
  await mkdir(dirname(path()), { recursive: true });
  await writeFile(path(), JSON.stringify(value, null, 2) + "\n");
  return value;
}
