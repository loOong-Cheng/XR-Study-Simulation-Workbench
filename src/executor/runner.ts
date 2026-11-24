// Executor: runs a frozen campaign job by job, as fresh headless Claude Code
// sessions (your planned usage) or as clearly labelled simulations, and streams
// progress to the workbench. All state is on disk (receipts, results, events),
// so a run can pause, stop, resume or rerun failed jobs at any time.
import type { ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignPlan, conditionModel, type Campaign, type CampaignReceipt } from "../core/campaign.js";
import { simulatedResults } from "../core/example.js";
import { lineageRuns, reusedUsage } from "../history.js";
import { agentLevel, agentTargets, hash, jobPacket, protocolForJob } from "../core/planner.js";
import type { AgentProtocol, HumanData, Job, Plan, RunResult, Study, TraceEvent } from "../core/types.js";
import { claudeEffort, effortProblem, requireThat } from "../core/validation.js";
import { claudeCommand, claudeProblem, readSettings, runtimeLimits, type Settings } from "../settings.js";
import { claudeFeatures, killTree, spawnTree } from "./processes.js";
import { changedApp, changedSources, listCampaigns, listWorkspaces, missingSources, readCampaign, readHuman, readReceipts, readStudyFolder, repoRoot, runDir, sourceLocation, workspaceDir, type WorkspaceManifest } from "../workspace.js";
import { appActions, runtimeFor, runtimeStatus, webxrCapabilities } from "./runtimes.js";
import { runRecordPath } from "./archive.js";
import { activeAttempts, appendLine, SERVER, serverAlive, stopLeftovers, unfinishedAttempts, writeMarker, type AttemptMarker } from "./attempts.js";
import { joinScheduler, leaveScheduler, schedule, type Schedulable } from "./scheduler.js";
import { compactStreamLine, ScreenshotIndex } from "./stream-log.js";
import { backgroundText, trajectoryText } from "../participant-knowledge.js";
import { agentFileList } from "../runtimes/guard.js";
import { readText } from "../files.js";
import { unfinishedCases } from "../runtimes/exposure.js";
import { casesInOrder, designOrder } from "../core/fairness.js";
import { buildPrompt, READ_FILES_LINE, type PromptSection } from "./prompt.js";

/** not-started: never asked to run; queued: asked to run and waiting for a free slot. */
export type JobStatus = "not-started" | "queued" | "running" | "done" | "failed" | "stopped" | "reused";
/** The error of an attempt you stopped (also in its receipt, so it reads as stopped after a restart). */
export const STOPPED = "Stopped by you.";
/** The error of an attempt that has a folder but no receipt (the words of sessionAttempts in history.ts). */
export const STOPPED_UNRECORDED = "Stopped before it finished; no result was recorded.";
/** Shown for a real session that ended before Claude Code reported its cost. */
export const COST_UNKNOWN = "unknown (stopped before the end)";
/**
 * The error of an attempt the workbench could not see to its end: it was shut down, or crashed,
 * while the session ran (also in its receipt). The session can be run again, in a new attempt folder.
 */
export const INTERRUPTED = "Interrupted: the workbench stopped while this session ran. Run it again.";
/** Receipt, result and manifest note of an attempt whose forecast was accepted before a crash and that was finished after the restart. */
export const RECOVERED = "Completed after a workbench restart: the forecast was accepted before the workbench stopped. Tokens are those recorded until then; the cost is unknown.";
/** One run of a session: stop() marks it, so a stopped run never overwrites a rerun of the same session. */
interface RunHandle {
  stopped: boolean;
  /** Stopped by you (Stop), or by the workbench shutting down. */
  reason?: "stop" | "shutdown";
  /** The attempt's folder and number once created: every attempt ends with a receipt. */
  dir?: string;
  attempt?: number;
}
/** Called with (study, campaign) after a receipt was written, e.g. to forget cached analyses. */
export const receiptsChanged = new Set<(workspaceId: string, campaignId: string) => void>();
/** Usage as recorded in receipts: uncached input, cache writes and reads, output (thinking included) and cost. */
export interface FullUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  /** "final": Claude Code's own totals; "live": counted from the stream because the session ended early. */
  source: "final" | "live";
  /** All tokens (input including cache, plus output) when the forecast was accepted; null without one. */
  tokensAtSubmit: number | null;
}
export interface JobState {
  jobId: string;
  agentId: string;
  label: string;
  level: "population" | "individual";
  participantId: string | null;
  repetition: number;
  runtime: string;
  status: JobStatus;
  attempts: number;
  /** The run that counts is simulated (invented); for a reused session, the run it reuses. */
  simulated: boolean;
  /** A reused session without any result in the lineage: it never ran, so it is not done. */
  noResult?: boolean;
  toolCalls: number;
  /** Real sessions: all input tokens (uncached + cache writes + cache reads). Simulated: null. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** Session cost reported by Claude Code; null for simulated runs or when not reported. */
  costUsd: number | null;
  /** A finished session to look at, e.g. "over budget: 97,712 of 60,000 tokens". */
  warning: string | null;
  lastTool: string | null;
  screenshot: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
export interface ExecutorEvent {
  t: number;
  type: "job" | "log" | "state";
  jobId?: string;
  text?: string;
  job?: JobState;
}
const here = fileURLToPath(new URL(".", import.meta.url));
const studyServer = resolve(here, "../runtimes/study-mcp.js");
const webxrServer = resolve(here, "../runtimes/webxr-mcp.js");
const bridgeProxy = resolve(here, "../runtimes/bridge-proxy.js");
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const registry = new Map<string, Executor>();
/** How long a study bridge that ended after it answered may take to be started again (tests shorten it). */
export const timing = { bridgeRestartGraceMs: 15_000 };
/** Executors being opened: a second request for the same campaign waits for the first, so there is only ever one. */
const opening = new Map<string, Promise<Executor>>();
/** Drop the executor of a campaign before it is deleted; refused while its sessions run or wait to run. */
export function closeExecutor(workspaceId: string, campaignId: string) {
  workspaceDir(workspaceId); // only the canonical study ID, so the key below is the one open() used
  const key = `${workspaceId}::${campaignId}`;
  const ex = registry.get(key);
  requireThat(!ex || ex.running.size === 0, "Sessions of this campaign are running. Stop them first.");
  requireThat(!ex || ex.paused || !ex.queue.length, "Sessions of this campaign are waiting to run. Stop them first.");
  registry.delete(key);
  opening.delete(key);
  if (ex) leaveScheduler(ex);
}
/**
 * Workbench shutdown (SIGINT/SIGTERM): every running session is stopped and recorded as
 * interrupted (with its usage so far); waiting ones stay not started. Resolves when their receipts
 * are written, or after `timeoutMs`.
 */
let shuttingDown = false;
export async function shutdownExecutors(timeoutMs = 20_000) {
  shuttingDown = true;
  const runs = [...registry.values()].flatMap((ex) => ex.interrupt());
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([Promise.allSettled(runs), new Promise((r) => (timer = setTimeout(r, timeoutMs)))]);
  clearTimeout(timer);
}
/**
 * At server start: attempts that a crashed or killed workbench left without a receipt, in every
 * study and campaign, are closed (see Executor.recover) and the processes they left are stopped.
 * Returns how many campaigns had such attempts.
 */
export async function recoverLeftovers(): Promise<number> {
  let n = 0;
  for (const w of await listWorkspaces()) {
    let campaigns: Campaign[] = [];
    try {
      campaigns = await listCampaigns(w.id);
    } catch {
      continue;
    }
    for (const c of campaigns) {
      try {
        const receipts = await readReceipts(w.id, [c.id]);
        const left = await unfinishedAttempts(runDir(w.id, c.id), new Set(receipts.map((r) => `${r.jobId}|${r.attempt}`)));
        if (!left.some((u) => !activeAttempts.has(u.dir))) continue;
        await Executor.open(w.id, c.id);
        n++;
      } catch (e) {
        console.error(`Could not check the sessions of ${w.id} ${c.id}:`, (e as Error).message);
      }
    }
  }
  return n;
}
/** Session statuses of a campaign whose executor is open (what the executor table shows), else null. */
export function liveStatuses(workspaceId: string, campaignId: string): Map<string, JobStatus> | null {
  const ex = registry.get(`${workspaceId}::${campaignId}`);
  return ex ? new Map([...ex.jobs.values()].map((j) => [j.jobId, j.status])) : null;
}

/**
 * Claude Code's --effort for a configuration's reasoning setting: "default" adds nothing;
 * "high" or "effort=high" (low, medium, high, xhigh, max) sets it. Anything else is refused
 * rather than silently ignored.
 */
export function effortArgs(reasoning: string): string[] {
  const level = claudeEffort(reasoning);
  if (level === undefined) throw new Error(effortProblem(reasoning));
  return level ? ["--effort", level] : [];
}
const fmt = (n: number) => n.toLocaleString("en-US");
/** "over budget: 97,712 of 60,000 tokens" for a session whose tokens exceed its budget, else null. */
export function budgetWarning(total: number | null, budget: number | undefined, atForecast: number | null = null): string | null {
  if (!budget || total === null || total <= budget) return null;
  return `over budget: ${fmt(total)} of ${fmt(budget)} tokens${atForecast !== null && atForecast !== total ? ` (${fmt(atForecast)} when the forecast was accepted)` : ""}`;
}

/** How messages name a runtime: "the Unity bridge", "the WebXR runtime". */
export function runtimeName(runtime: string): string {
  if (runtime === "webxr") return "the WebXR runtime";
  const names: Record<string, string> = { unity: "Unity", unreal: "Unreal", visionos: "visionOS" };
  return `the ${names[runtime] ?? runtime} bridge`;
}
/**
 * What the row of a finished real session says besides the token budget: a forecast accepted
 * before every required case was started and ended (allowed only when a budget was nearly used
 * up), and a runtime that was started more than once (bridge.jsonl starts or repeated runtime
 * reports in the trace).
 */
export function sessionWarnings(requiredCaseIds: string[], runtime: string, run: RunResult): string[] {
  if (run.status !== "completed" || run.execution?.synthetic) return [];
  const trace = Array.isArray(run.trace) ? run.trace : [];
  const out: string[] = [];
  const missing = unfinishedCases(requiredCaseIds, trace);
  if (missing.length)
    out.push(`submitted without required exposure (${missing.length} of ${requiredCaseIds.length} required tasks not finished: ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ", …" : ""})`);
  const reports = trace.filter((e) => e?.type === "runtime").length;
  if (Math.max(reports, run.execution?.runtimeStarts ?? 0) > 1) out.push(`${runtimeName(runtime)} restarted during the session`);
  return out;
}
/**
 * The simulated time a session's captures report: each observation's clock (simulationTimeMs),
 * summed over the stretches in which it runs on (a clock that starts again, per design or after
 * a restart, begins a new stretch). 0 without observations.
 */
export function simulationTime(trace: TraceEvent[]): number {
  let total = 0,
    last = 0;
  for (const e of trace) {
    if (e?.type !== "observation" || !Array.isArray(e.captures)) continue;
    const t = Number(e.captures[0]?.simulationTimeMs);
    if (!Number.isFinite(t) || t < 0) continue;
    if (t < last) total += last;
    last = t;
  }
  return Math.round(total + last);
}
const joinWarnings = (...w: (string | null | undefined)[]) => w.filter(Boolean).join("; ") || null;

/** Live token use of a session from Claude Code's stream, per API message. */
export class UsageMeter {
  private messages = new Map<string, { uncached: number; cacheWrite: number; cacheRead: number; output: number }>();
  private current = "";
  /** The API message the last message_start began (stream events carry no ID after it). */
  get currentMessage() {
    return this.current;
  }
  /**
   * Whether any model answered. Claude Code's own messages do not count: with an unknown model it
   * writes the error as an assistant message of model "<synthetic>" with zero usage.
   */
  modelRan = false;
  /**
   * One stream line. Assistant messages repeat the usage of their message_start (output only a
   * few tokens) for every content block; with --include-partial-messages, each message's
   * message_delta carries its final output (thinking included). Per message, the largest value of
   * each field counts, so the totals match Claude Code's own within the message in progress.
   */
  add(m: Record<string, any>): boolean {
    let u: Record<string, unknown> | undefined;
    let id = this.current;
    if (m.type === "assistant" && m.message?.model === "<synthetic>") return false;
    if (m.type === "assistant" && m.message?.usage) (u = m.message.usage), (id = String(m.message.id ?? id));
    else if (m.type === "stream_event" && m.event?.type === "message_start") (u = m.event.message?.usage), (id = this.current = String(m.event.message?.id ?? `m${this.messages.size}`));
    else if (m.type === "stream_event" && m.event?.type === "message_delta") u = m.event.usage;
    if (!u) return false;
    const n = (k: string) => Number(u![k]) || 0;
    // A message without any tokens was not answered by a model.
    if (!["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].some((k) => n(k) > 0)) return false;
    this.modelRan = true;
    const old = this.messages.get(id) ?? { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    this.messages.set(id, {
      uncached: Math.max(old.uncached, n("input_tokens")),
      cacheWrite: Math.max(old.cacheWrite, n("cache_creation_input_tokens")),
      cacheRead: Math.max(old.cacheRead, n("cache_read_input_tokens")),
      output: Math.max(old.output, n("output_tokens")),
    });
    return true;
  }
  /** Whether a stream line begins a new turn: a tool result, or a message not seen yet. */
  startsTurn(m: Record<string, any>): boolean {
    if (m.type === "user") return true;
    if (m.type === "stream_event") return m.event?.type === "message_start";
    return m.type === "assistant" && m.message?.id !== undefined && !this.messages.has(String(m.message.id));
  }
  totals() {
    const t = { uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    for (const x of this.messages.values()) (t.uncached += x.uncached), (t.cacheWrite += x.cacheWrite), (t.cacheRead += x.cacheRead), (t.output += x.output);
    const last = [...this.messages.values()].at(-1);
    const input = t.uncached + t.cacheWrite + t.cacheRead;
    return { ...t, input, total: input + t.output, lastTurnInput: last ? last.uncached + last.cacheWrite + last.cacheRead : 0 };
  }
}
/**
 * Whether the tools should refuse and ask for the forecast: when what is left of the budget is
 * smaller than 10% of it, or than the turns still needed: the submission, one possibly rejected
 * submission and the closing turn, each re-reading about the last turn's input (3.5 × it, with room
 * for their output).
 */
export const submitNow = (budget: number | null | undefined, total: number, lastTurnInput: number) =>
  !!budget && budget - total < Math.max(0.1 * budget, 3.5 * lastTurnInput);
/** Submissions a session may make once its tools were refused for the budget; it is stopped after the last one is refused. */
export const SUBMIT_ATTEMPTS = 3;

/**
 * How the agent should play the app: the study's tasks (phases, labels, required actions, least
 * actions, views before actions), in the words of its runtime's tools. `capabilities` are what the
 * runtime provides (for WebXR: what workspace.json → app declares), so only offered tools are named.
 */
/**
 * A task named once, from its phase's label and its own label: the task's label alone when it
 * already names the task ("Main block: click 9 targets" in the phase "Main block (9 targets)", or
 * any "Name: what to do" label), the phase label alone without a task label, else "phase (label)".
 */
export function taskName(phaseLabel: string, label?: string): string {
  const l = (label ?? "").trim();
  if (!l) return phaseLabel;
  const head = (x: string) => x.split(/[(:]/)[0].trim().toLowerCase();
  const [hl, hp] = [head(l), head(phaseLabel)];
  if (l.includes(":") || (hl && hp && (hl.startsWith(hp) || hp.startsWith(hl)))) return l;
  return `${phaseLabel} (${l})`;
}
export function playInstructions(runtime: string, order: string[], study: Study, caseIds: string[], extra?: string, capabilities: string[] = []): string {
  const cases = caseIds.map((id) => study.cases.find((c) => c.id === id)).filter((c): c is Study["cases"][number] => !!c);
  const actions = [...new Set(cases.flatMap((c) => c.requiredActions))];
  const required = actions.length ? ` The study protocol requires these actions in each task: ${actions.join(", ")}; a skipped one is recorded as a protocol deviation.` : "";
  const phase = (id: string) => study.phases.find((p) => p.id === id)?.label ?? id;
  const lines = [
    ...new Set(
      cases.map(
        (c) =>
          `${taskName(phase(c.phaseId), c.label)}${c.minActions ? `, at least ${c.minActions} action${c.minActions === 1 ? "" : "s"}` : ""}${c.observeBeforeEachAction ? ", with a fresh screenshot before each action (acting from memory is a protocol deviation)" : ""}`,
      ),
    ),
  ];
  const perDesign = lines.length === new Set(cases.map((c) => c.phaseId)).size;
  const tasks = !lines.length ? "" : lines.length <= 8 ? ` ${perDesign ? "In each design the tasks are" : "The tasks are"}: ${lines.join("; ")}.` : ` Each design has these phases: ${[...new Set(cases.map((c) => phase(c.phaseId)))].join(", ")}.`;
  const caps = new Set(capabilities);
  const tools = [
    "open_design opens a design and starts its first task",
    "screenshot shows what a participant sees",
    caps.has("look") && "look turns the viewpoint (recorded as look-around)",
    caps.has("pointer-select") && "list_objects and select(object) pick an object by its neutral ID (select-target)",
    caps.has("pointer-xy") && "point_at(x, y) moves the pointer and click(x, y) clicks, x and y from 0 to 1 from the top-left corner of the screen (select-target)",
    caps.has("actions") && "act(name, args) performs one of the app's own actions (open_design lists them; recorded under the action's name)",
    "app_state shows the instruction and progress",
  ].filter((x): x is string => !!x);
  const how =
    runtime === "webxr"
      ? `For each design: call open_design, then do every task (the practice task and the main task alike) as a participant would: take at least one screenshot, then act on what you see. A task ends when the app moves on (recorded as complete-task). Tools: ${tools.join("; ")}.`
      : `Use the ${runtime} tools you have. For each design: load it, then in EVERY task (the practice task and the main task alike) look around, take at least one screenshot, and complete the task as a participant would.`;
  return [
    `Experience the app like a participant first, following the instructions the app shows and the study brief. Visit the designs in this order: ${order.join(", ")}. ${how}${tasks}${required}`,
    ...(extra?.trim() ? [`How to use the ${runtime} tools: ${extra.trim()}`] : []),
  ].join("\n");
}

export class Executor implements Schedulable {
  jobs = new Map<string, JobState>();
  paused = true;
  mode: "agent" | "simulate" = "simulate";
  queue: string[] = [];
  running = new Map<string, ChildProcess | null>();
  /** Why queued sessions wait when another campaign holds the free slots (see scheduler.ts), else null. */
  waiting: string | null = null;
  /** The current run of each running session (see RunHandle). */
  private handles = new Map<string, RunHandle>();
  /** Every run until its receipt is written (also runs that were stopped). */
  private runs = new Set<Promise<void>>();
  listeners = new Set<(e: ExecutorEvent) => void>();
  /** Whether this executor already said that the Claude Code here is too old for live token counts. */
  private notedOldCli = false;
  private constructor(
    readonly workspaceId: string,
    readonly campaign: Campaign,
    readonly plan: Plan,
    readonly manifest: WorkspaceManifest,
    readonly dir: string,
  ) {}

  /**
   * The one executor of a campaign. Requests that arrive while it is being opened wait for the
   * same one (never two executors running the same sessions). Opening it first closes attempts a
   * crashed workbench left behind (recover).
   */
  static async open(workspaceId: string, campaignId: string): Promise<Executor> {
    workspaceDir(workspaceId); // one executor per study: refuse any non-canonical spelling of its ID
    const key = `${workspaceId}::${campaignId}`;
    const open = registry.get(key);
    if (open) return open;
    let pending = opening.get(key);
    if (!pending) {
      const created = (async () => {
        const campaign = await readCampaign(workspaceId, campaignId);
        const plan = campaignPlan(campaign);
        const { manifest } = await readStudyFolder(workspaceId);
        const ex = new Executor(workspaceId, campaign, plan, manifest, runDir(workspaceId, campaignId));
        await ex.recover();
        await ex.load();
        return ex;
      })();
      pending = created;
      opening.set(key, created);
      // Registered before any caller continues (this handler is attached first).
      created.then(
        (ex) => {
          if (opening.get(key) !== created) return;
          opening.delete(key);
          registry.set(key, ex);
          joinScheduler(ex);
        },
        () => {
          if (opening.get(key) === created) opening.delete(key);
        },
      );
    }
    const ex = await pending;
    // Closed while it was opening (e.g. runs loaded from a zip): open it again from disk.
    return registry.get(key) === ex ? ex : Executor.open(workspaceId, campaignId);
  }
  private agent(id: string) {
    return this.plan.agents.find((a) => a.id === id)!;
  }
  /**
   * The sessions as the files on disk record them, so a restart shows what was shown before:
   * receipts (status, error, usage of failed attempts), results and execution manifests (tokens,
   * tool calls, cost, tokens when the forecast was accepted) and the attempt folders. Every attempt
   * now ends with a receipt (also stopped simulated ones), and those a crashed workbench left get
   * one when the campaign opens (recover). An attempt folder still without a receipt (written by an
   * older version) was stopped before it finished and counts as an attempt, so a rerun gets a new folder.
   */
  private async load() {
    const receipts = await readReceipts(this.workspaceId, [this.campaign.id]);
    const json = async <T>(path: string): Promise<T | null> => {
      try {
        return JSON.parse(await readFile(path, "utf8")) as T;
      } catch {
        return null;
      }
    };
    // Tool calls as the executor counts them: calls.log without the forecast submission.
    const callsIn = async (dir: string) =>
      existsSync(join(dir, "calls.log")) ? (await readFile(join(dir, "calls.log"), "utf8")).split("\n").filter((l) => l.trim() && l.trim() !== "submit_forecast").length : 0;
    for (const j of this.campaign.jobs) {
      if (j.kind !== "llm") continue;
      const a = this.agent(j.conditionId);
      const mine = receipts.filter((r) => r.jobId === j.id).sort((x, y) => x.attempt - y.attempt) as (CampaignReceipt & { usage: Partial<FullUsage> })[];
      const done = mine.find((r) => r.status === "completed");
      const last = mine.at(-1);
      const jobDir = join(this.dir, "jobs", j.id);
      const folders = !j.inheritedFrom && existsSync(jobDir) ? (await readdir(jobDir)).filter((f) => /^a\d+$/.test(f)).map((f) => Number(f.slice(1))) : [];
      const attempts = Math.max(0, ...folders, ...mine.map((r) => r.attempt));
      // The latest attempt has a folder but no receipt: it was stopped before it finished.
      const unrecorded = !done && !j.inheritedFrom && attempts > (last?.attempt ?? 0);
      const state: JobState = {
        jobId: j.id,
        agentId: a.id,
        label: a.label,
        level: agentLevel(this.plan.study, a),
        participantId: j.participantId ?? null,
        repetition: j.repetition,
        runtime: runtimeFor(this.plan.study, a),
        status: j.inheritedFrom ? "reused" : done ? "done" : unrecorded || last?.error === STOPPED ? "stopped" : last ? "failed" : "not-started",
        attempts,
        simulated: false,
        toolCalls: 0,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        warning: null,
        lastTool: null,
        screenshot: null,
        error: done ? null : unrecorded ? STOPPED_UNRECORDED : (last?.error ?? null),
        startedAt: null,
        endedAt: null,
      };
      this.jobs.set(j.id, state);
      if (done || j.inheritedFrom || !attempts) continue;
      // A failed or stopped attempt that counts last: its tool calls from its folder, its usage from
      // the receipt (or, without one, the live count in usage.json); cost unknown when it ended early.
      const dir = join(jobDir, `a${attempts}`);
      state.toolCalls = await callsIn(dir);
      if (unrecorded) {
        // A real session's folder holds its session folder and job.json; a simulated one's only calls.log.
        state.simulated = !existsSync(join(dir, "session")) && !existsSync(join(dir, "job.json"));
        const live = await json<{ input?: number; output?: number }>(join(dir, "usage.json"));
        if (live && !state.simulated) (state.tokensIn = live.input ?? null), (state.tokensOut = live.output ?? null);
        continue;
      }
      const u = last!.usage;
      const run = await json<RunResult>(join(dir, "result.json"));
      // A stopped or interrupted simulation has a receipt but no result: its marker says it was simulated.
      state.simulated = run?.execution.synthetic ?? (await json<{ mode?: string }>(join(dir, "attempt.json")))?.mode === "simulate";
      if (!u || u.outputTokens == null) continue;
      state.tokensIn = totalInput({ inputTokens: u.inputTokens ?? null, cacheReadTokens: u.cacheReadTokens ?? null, cacheWriteTokens: u.cacheWriteTokens ?? null });
      state.tokensOut = u.outputTokens;
      state.costUsd = u.costUsd ?? null;
      // As when the session ended: a failed session over its budget says so (a stopped one does not).
      if (state.status === "failed") state.warning = budgetWarning(state.tokensIn === null ? null : state.tokensIn + (state.tokensOut ?? 0), a.maxTokens, u.tokensAtSubmit ?? null);
    }
    if (existsSync(join(this.dir, "results")))
      for (const f of await readdir(join(this.dir, "results"))) {
        const run = await json<RunResult>(join(this.dir, "results", f));
        const s = run && this.jobs.get(run.jobId);
        if (!s || s.status !== "done") continue;
        s.simulated = run.execution.synthetic;
        s.toolCalls = run.execution.toolCalls;
        if (!run.execution.synthetic) {
          s.tokensIn = totalInput(run.execution);
          s.tokensOut = run.execution.outputTokens;
          const job = this.plan.jobs.find((j) => j.id === run.jobId);
          const required = job && this.agent(s.agentId).tools.includes("xr-interact") ? protocolForJob(this.plan, job).requiredCaseIds : [];
          s.warning = joinWarnings(
            budgetWarning(s.tokensIn === null ? null : s.tokensIn + (s.tokensOut ?? 0), this.agent(s.agentId).maxTokens, run.execution.tokensAtSubmit ?? null),
            ...sessionWarnings(required, s.runtime, run),
          );
        }
      }
    // Cost of the attempt that counts, from its execution manifest.
    for (const r of receipts)
      if (r.status === "completed" && r.executionManifest?.path.endsWith("execution-manifest.json")) {
        const s = this.jobs.get(r.jobId);
        if (!s || s.costUsd !== null) continue;
        // Only inside this campaign's run folder (runRecordPath).
        const path = runRecordPath(this.dir, r.executionManifest.path);
        const m = path ? await json<{ costUsd?: number | null }>(path) : null;
        s.costUsd = typeof m?.costUsd === "number" ? m.costUsd : null;
      }
    // Reused sessions show the tokens and cost of the run they reuse (from the campaign it ran in).
    for (const [jobId, usage] of await reusedUsage(this.workspaceId, this.campaign)) if (this.jobs.has(jobId)) Object.assign(this.jobs.get(jobId)!, usage);
    // Whether a reused session's run is simulated, from the lineage's results (as the analysis
    // reads them); one that never ran (an early continuation marked it reused) says so.
    const lineage = await lineageRuns(this.workspaceId, this.campaign);
    if (lineage)
      for (const s of this.jobs.values()) {
        if (s.status !== "reused") continue;
        s.simulated = lineage.simulated.has(s.jobId);
        if (!lineage.accepted.has(s.jobId)) {
          s.noResult = true;
          s.warning = "marked reused, but it never ran: no result to reuse; a continuation runs it again";
        }
      }
    // A forecast finished after a restart says so in the table.
    for (const s of this.jobs.values()) {
      const done = receipts.find((r) => r.jobId === s.jobId && r.status === "completed");
      if (s.status === "done" && done?.recovered) s.warning = [s.warning, "completed after a workbench restart"].filter(Boolean).join("; ");
    }
  }
  snapshot() {
    const jobs = [...this.jobs.values()];
    const counts: Record<string, number> = {};
    jobs.forEach((j) => (counts[j.status] = (counts[j.status] ?? 0) + 1));
    return {
      campaignId: this.campaign.id,
      mode: this.mode,
      paused: this.paused,
      running: this.running.size,
      queued: this.queue.length,
      waiting: this.waiting,
      counts,
      jobs,
    };
  }
  private emit(e: Omit<ExecutorEvent, "t">) {
    const event = { t: Date.now(), ...e };
    this.listeners.forEach((l) => l(event));
    // One write after another, so the lines of events.jsonl stay in the order of their times.
    void appendLine(join(this.dir, "events.jsonl"), JSON.stringify({ ...event, job: undefined }) + "\n", join(this.dir, "..", "..", "campaigns", this.campaign.id)).catch(() => undefined);
  }
  private update(jobId: string, patch: Partial<JobState>) {
    const job = Object.assign(this.jobs.get(jobId)!, patch);
    this.emit({ type: "job", jobId, job });
  }

  /** The chosen sessions that Start would run (finished and reused ones are left out). */
  private runnable(jobIds: string[]) {
    return jobIds.filter((id) => {
      const s = this.jobs.get(id)?.status;
      return s === "not-started" || s === "queued" || s === "failed" || s === "stopped";
    });
  }
  /**
   * Cost per session from earlier real, completed sessions of the same configuration and model
   * settings (provider, model and effort) in any campaign of this study
   * (execution-manifest.json → costUsd), for the sessions that would run. Null when none exist yet.
   */
  async estimate(jobIds: string[]) {
    const wanted = new Map<string, number>();
    for (const id of this.runnable(jobIds)) {
      const j = this.jobs.get(id)!;
      wanted.set(j.agentId, (wanted.get(j.agentId) ?? 0) + 1);
    }
    const costs = new Map<string, number[]>();
    for (const c of await listCampaigns(this.workspaceId)) {
      const receipts = (await readReceipts(this.workspaceId, [c.id])).filter((r) => r.status === "completed" && r.executionManifest);
      for (const r of receipts) {
        const job = c.jobs.find((x) => x.id === r.jobId);
        if (!job || !wanted.has(job.conditionId)) continue;
        if (hash(conditionModel(c, job.conditionId)) !== hash(conditionModel(this.campaign, job.conditionId))) continue;
        try {
          const m = JSON.parse(await readFile(runRecordPath(runDir(this.workspaceId, c.id), r.executionManifest!.path)!, "utf8")) as { costUsd?: number | null };
          if (typeof m.costUsd === "number") costs.set(job.conditionId, [...(costs.get(job.conditionId) ?? []), m.costUsd]);
        } catch {
          // manifest missing (e.g. a partial zip): no estimate from this run
        }
      }
    }
    return [...wanted].map(([agentId, sessions]) => {
      const seen = costs.get(agentId) ?? [];
      const perSession = seen.length ? seen.reduce((x, y) => x + y, 0) / seen.length : null;
      return { agentId, label: this.agent(agentId).label, sessions, perSession, basedOn: seen.length, total: perSession === null ? null : perSession * sessions };
    });
  }

  /** Which selected jobs cannot run as agents because their runtime is not available. */
  async blockers(jobIds: string[]) {
    const settings = await readSettings();
    const { dir: wsDir } = await readStudyFolder(this.workspaceId);
    // The study as frozen (its sources and fields), never the one being edited now.
    const study = this.plan.study;
    const changed = await changedSources(this.workspaceId, this.campaign, this.manifest);
    // The WebXR app (its files, query and declarations) as the campaign froze it.
    const appChanged = await changedApp(this.workspaceId, this.campaign, this.manifest);
    const byRuntime = new Map<string, Set<string>>();
    // Every agent session is a Claude Code session: a Claude Code that cannot start blocks them all.
    const cliProblem = claudeProblem(settings);
    for (const id of jobIds) {
      const j = this.jobs.get(id);
      if (!j) continue;
      if (cliProblem) byRuntime.set(cliProblem, (byRuntime.get(cliProblem) ?? new Set()).add(this.agent(j.agentId).label));
      // A source without a file blocks the configuration (never substitute its description).
      for (const m of missingSources(wsDir, study, this.manifest, this.agent(j.agentId).sourceIds))
        byRuntime.set(m.message, (byRuntime.get(m.message) ?? new Set()).add(this.agent(j.agentId).label));
      // A source that changed since the freeze would give the agent other knowledge than the campaign froze.
      for (const m of changed.filter((x) => this.agent(j.agentId).sourceIds.includes(x.id)))
        byRuntime.set(m.message, (byRuntime.get(m.message) ?? new Set()).add(this.agent(j.agentId).label));
      if (appChanged && j.runtime === "webxr" && this.agent(j.agentId).tools.includes("xr-interact"))
        byRuntime.set(appChanged, (byRuntime.get(appChanged) ?? new Set()).add(this.agent(j.agentId).label));
      const status = runtimeStatus(j.runtime, settings, this.manifest);
      const agent = this.agent(j.agentId);
      const stereo = agent.observation === "stereo-pair" && !status.observations.includes("stereo-pair") && agent.tools.includes("xr-interact");
      let effortProblem = "";
      try {
        effortArgs(agent.model.reasoning);
      } catch (e) {
        effortProblem = (e as Error).message;
      }
      const lacking = agent.tools.includes("xr-interact") && status.available ? (this.plan.study.runtime.requiredCapabilities ?? []).filter((c) => !status.capabilities.includes(c)) : [];
      if (!status.available || stereo || effortProblem || lacking.length) {
        const msg =
          effortProblem ||
          (!status.available
            ? status.message
            : stereo
            ? status.builtIn
              ? `${status.label} provides mono screenshots only, but this study's agent observation is a stereo pair (two eyes), which ${agent.label} needs. Set Agent observation to Single image (mono) on Study & variables and freeze a new campaign, or simulate these sessions.`
              : `${status.label} provides mono screenshots only; ${agent.label} requires a stereo pair. Declare the stereo-capture capability in Settings if the runtime captures a stereo pair.`
            : j.runtime === "webxr"
            ? `The WebXR app does not declare the capabilities this study requires: ${lacking.join(", ")}. Declare them in workspace.json → app.capabilities once the app provides them (docs/runtime-adapters.md lists the names), or change the study's required capabilities.`
            : `${status.label} does not declare the capabilities this study requires: ${lacking.join(", ")}. Add them to the runtime in Settings once it provides them.`);
        byRuntime.set(msg, (byRuntime.get(msg) ?? new Set()).add(agent.label));
      }
    }
    return [...byRuntime].map(([message, configs]) => ({ message, configs: [...configs] }));
  }
  /**
   * Queue the chosen sessions (all runnable ones without a choice). A second Start while sessions
   * wait or run adds to the queue; it never drops what is already queued.
   */
  async start(mode: "agent" | "simulate", jobIds?: string[]) {
    requireThat(!shuttingDown, "The workbench is shutting down; start the sessions again after it restarts.");
    const candidates = this.runnable(jobIds ?? [...this.jobs.keys()]).filter((id) => !this.running.has(id));
    requireThat(candidates.length > 0, "Nothing to run: every selected session is finished, reused or already running.");
    const busy = this.queue.length + this.running.size > 0;
    requireThat(
      !busy || mode === this.mode,
      mode === "agent"
        ? "Simulated sessions are still queued or running. Wait until they finish, or Stop them, before starting real sessions."
        : "Real sessions are still queued or running. Wait until they finish, or Stop them, before simulating.",
    );
    if (mode === "agent") {
      const blocked = await this.blockers(candidates);
      requireThat(
        blocked.length === 0,
        blocked.map((b) => `${b.message} Needed by: ${b.configs.join(", ")}.`).join(" "),
      );
    }
    this.mode = mode;
    const added = candidates.filter((id) => !this.queue.includes(id));
    this.queue.push(...added);
    added.forEach((id) => this.update(id, { status: "queued", error: null }));
    this.paused = false;
    this.emit({ type: "state" });
    void this.pump();
    return this.snapshot();
  }
  pause() {
    this.paused = true;
    this.waiting = null;
    this.emit({ type: "state", text: "Paused: running sessions finish, no new ones start." });
    return this.snapshot();
  }
  /**
   * Continue after Pause: only the sessions that were waiting in the queue start. Stop empties the
   * queue, so stopped sessions run again only through Start or Rerun failed, which check what blocks
   * them (and, in the website, ask before real sessions start).
   */
  resume() {
    this.queue = this.queue.filter((id) => this.jobs.get(id)?.status === "queued");
    requireThat(
      this.queue.length > 0 || this.running.size > 0,
      "Nothing to resume: no sessions are waiting. Stopped or failed sessions run again with Rerun failed, and the others with Start.",
    );
    this.paused = false;
    this.emit({ type: "state" });
    void this.pump();
    return this.snapshot();
  }
  /**
   * Stop everything: running sessions (real and simulated) end at once as "stopped", with a
   * receipt, and can be run again right away. A stopped real session still records its tokens; its
   * cost is unknown, since Claude Code reports it only at the end. Waiting sessions are not started
   * (back to "not started"); the message says how many, so they are not lost from sight.
   */
  stop() {
    const dropped = this.halt("stop");
    const them = dropped === 1 ? "it" : "them";
    this.emit({
      type: "state",
      text: dropped ? `Stopped. ${dropped} waiting session${dropped === 1 ? " was" : "s were"} not started; select ${them} and Start ${them} again to run ${them}.` : "Stopped.",
    });
    return this.snapshot();
  }
  /** Workbench shutdown: running sessions end as interrupted (each with a receipt). Returns their runs. */
  interrupt(): Promise<void>[] {
    this.halt("shutdown");
    return [...this.runs];
  }
  /** Ends every running session and empties the queue; returns how many waiting sessions were not started. */
  private halt(reason: "stop" | "shutdown") {
    this.paused = true;
    let dropped = 0;
    for (const id of this.queue)
      if (this.jobs.get(id)?.status === "queued") {
        this.update(id, { status: "not-started" });
        dropped++;
      }
    this.queue = [];
    for (const [id, proc] of this.running) {
      const handle = this.handles.get(id);
      if (handle) Object.assign(handle, { stopped: true, reason });
      killTree(proc); // with its MCP servers, Chrome and bridge
      this.update(id, { status: reason === "stop" ? "stopped" : "failed", error: reason === "stop" ? STOPPED : INTERRUPTED, endedAt: new Date().toISOString(), lastTool: null });
    }
    this.running.clear();
    this.handles.clear();
    this.waiting = null;
    // The slots are free for other campaigns now.
    void schedule();
    return dropped;
  }
  /** Sessions start through the workbench's one scheduler (scheduler.ts), across all campaigns. */
  private pump() {
    return schedule();
  }

  // ---------- the scheduler's view of this campaign (Schedulable) ----------
  waitingSessions() {
    return this.paused ? [] : this.queue.map((id) => ({ id, runtime: this.jobs.get(id)!.runtime }));
  }
  runningRuntimes() {
    return [...this.running.keys()].map((id) => this.jobs.get(id)!.runtime);
  }
  setWaiting(text: string | null) {
    if (text === this.waiting) return;
    this.waiting = text;
    this.emit({ type: "state" });
  }
  launch(id: string, settings: Settings) {
    const i = this.queue.indexOf(id);
    if (i >= 0) this.queue.splice(i, 1);
    const handle: RunHandle = { stopped: false };
    this.running.set(id, null);
    this.handles.set(id, handle);
    const run = this.mode === "agent" ? this.runAgent(id, settings, handle) : this.simulate(id, handle);
    const settled: Promise<void> = run
      .then(
        () => null,
        (e: Error) => {
          if (!handle.stopped) this.update(id, { status: "failed", error: e.message });
          return e.message;
        },
      )
      // An attempt that ended without writing its receipt (stopped, or an error) gets one now.
      .then((error) => this.closeAttempt(id, handle, error))
      .catch((e) => console.error(`Session ${id}: could not record its end:`, (e as Error).message))
      .finally(() => {
        this.runs.delete(settled);
        // A stopped run was already taken out; a rerun of the same session may hold the slot now.
        if (this.handles.get(id) === handle) {
          this.running.delete(id);
          this.handles.delete(id);
        }
        if (!this.queue.length && !this.running.size && !this.paused) {
          this.paused = true;
          this.emit({ type: "state", text: "Queue finished." });
        }
        void schedule();
      });
    this.runs.add(settled);
  }

  // ---------- attempts: a new folder each, a marker at the start, a receipt at the end ----------
  /** A fresh attempt folder (attemptFolder) with its marker; from here on the attempt ends with a receipt. */
  private async newAttempt(jobId: string, handle: RunHandle, mode: "agent" | "simulate") {
    const { attempt, jobDir } = await this.attemptFolder(jobId);
    Object.assign(handle, { attempt, dir: jobDir });
    activeAttempts.add(jobDir);
    await writeMarker(jobDir, { jobId, attempt, mode, startedAt: new Date().toISOString(), pid: null });
    return { attempt, jobDir };
  }
  private async appendReceipt(receipt: CampaignReceipt, attemptDir: string) {
    await appendLine(join(this.dir, "receipts.jsonl"), JSON.stringify(receipt) + "\n");
    activeAttempts.delete(attemptDir);
    for (const f of receiptsChanged)
      try {
        f(this.workspaceId, this.campaign.id);
      } catch {
        // a listener's problem is not the session's
      }
  }
  /** A failed receipt for an attempt that ended without a result of its own. */
  private async closingReceipt(jobId: string, attempt: number, attemptDir: string, error: string, usage: CampaignReceipt["usage"], extra: Partial<CampaignReceipt> = {}) {
    await this.appendReceipt(
      {
        campaignDigest: this.campaign.digest,
        jobId,
        attempt,
        status: "failed",
        actualModel: null,
        sessionId: `${jobId}-a${attempt}`,
        freshSession: true,
        freshPIE: true,
        freshScreenshots: true,
        assetHashes: {},
        output: null,
        executionManifest: null,
        usage,
        error,
        ...extra,
      },
      attemptDir,
    );
  }
  /** After a run: the receipt of an attempt that has none yet (stopped before or while it ran, or failed with an error). */
  private async closeAttempt(jobId: string, handle: RunHandle, error: string | null) {
    const dir = handle.dir;
    if (!dir || handle.attempt === undefined || !activeAttempts.has(dir)) return;
    const why = handle.stopped ? (handle.reason === "shutdown" ? INTERRUPTED : STOPPED) : (error ?? "The session ended without a result.");
    await this.closingReceipt(jobId, handle.attempt, dir, why, await liveUsage(dir), handle.reason === "shutdown" ? { interrupted: true } : {});
  }

  // ---------- after a crash: attempts left without a receipt ----------
  /**
   * Attempts a crashed or killed workbench left without a receipt (a marker, attempt.json, but no
   * receipt). Processes still running for them are stopped first (only those whose command line
   * names the attempt folder). One whose forecast was accepted and whose files are complete is
   * finished from its files and marked as completed after a restart; any other gets an
   * "interrupted" receipt with its usage so far. Attempts this process or another running
   * workbench still runs are left alone. A rerun gets a new folder.
   */
  private async recover() {
    const receipts = await readReceipts(this.workspaceId, [this.campaign.id]);
    for (const u of await unfinishedAttempts(this.dir, new Set(receipts.map((r) => `${r.jobId}|${r.attempt}`)))) {
      if (activeAttempts.has(u.dir) || !this.plan.jobs.some((j) => j.id === u.jobId)) continue;
      if (u.marker.server.instance !== SERVER.instance && (await serverAlive(u.marker.server))) continue;
      const stopped = await stopLeftovers(u.dir, u.marker.pid);
      if (stopped.length) console.log(`Stopped ${stopped.length} process(es) left running by session ${u.jobId} (attempt ${u.attempt}).`);
      activeAttempts.add(u.dir);
      try {
        await this.finishLeftover(u.jobId, u.attempt, u.dir, u.marker);
      } finally {
        activeAttempts.delete(u.dir);
      }
    }
  }
  private async finishLeftover(jobId: string, attempt: number, dir: string, marker: AttemptMarker) {
    const interrupted = (usage: CampaignReceipt["usage"], extra: Partial<CampaignReceipt> = {}) => this.closingReceipt(jobId, attempt, dir, INTERRUPTED, usage, { interrupted: true, ...extra });
    if (marker.mode === "simulate") return interrupted({ inputTokens: null, outputTokens: null });
    const job = this.planJob(jobId);
    const a = this.agent(job.agentId);
    const study = this.plan.study;
    const text = async (f: string) => (existsSync(join(dir, f)) ? await readFile(join(dir, f), "utf8") : "");
    const parse = <T>(s: string): T | null => {
      try {
        return JSON.parse(s) as T;
      } catch {
        return null;
      }
    };
    // The session's stream as far as it was recorded: who answered, and its tokens until then.
    const meter = new UsageMeter();
    let sessionId = "",
      actualModel = "",
      cliVersion = "",
      submitted = false,
      atSubmit: number | null = null,
      result: Record<string, any> | null = null;
    for (const line of (await text("stream.jsonl")).split("\n")) {
      const m = parse<Record<string, any>>(line);
      if (!m || typeof m !== "object") continue;
      // As while running: the forecast counts from the turn after the one that submitted it.
      if (submitted && atSubmit === null && meter.startsTurn(m)) atSubmit = meter.totals().total;
      if (m.type === "system" && m.subtype === "init") {
        sessionId = m.session_id ?? "";
        actualModel = m.model ?? "";
        cliVersion = m.claude_code_version ?? "";
      } else if (m.type === "stream_event" || m.type === "assistant") {
        meter.add(m);
        if (m.type === "assistant" && (m.message?.content ?? []).some((c: Record<string, unknown>) => c?.type === "tool_use" && /submit_forecast$/.test(String(c.name)))) submitted = true;
      } else if (m.type === "result") result = m;
    }
    const live = meter.totals();
    const usage: Record<string, any> = result?.usage ?? (meter.modelRan ? { input_tokens: live.uncached, cache_read_input_tokens: live.cacheRead, cache_creation_input_tokens: live.cacheWrite, output_tokens: live.output } : {});
    const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
    const noted = parse<{ tokensAtSubmit?: number | null }>(await text("usage.json"))?.tokensAtSubmit;
    const full: FullUsage = {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
      reasoningTokens: null,
      costUsd,
      source: result?.usage ? "final" : "live",
      tokensAtSubmit: null,
    };
    // Only the forecast the study server accepted in this attempt (it carries the attempt's ID from job.json).
    const jobSpec = parse<{ attemptId?: string; designOrder?: unknown }>(await text("job.json"));
    const attemptId = jobSpec?.attemptId;
    // The design order the session was given at launch (the audit checks the visits against it).
    const designOrder = Array.isArray(jobSpec?.designOrder) && jobSpec!.designOrder.every((x) => typeof x === "string") ? (jobSpec!.designOrder as string[]) : null;
    const written = parse<{ attemptId?: string; measurements?: unknown[] }>(await text("forecast.json"));
    const forecast = attemptId && written?.attemptId === attemptId ? written : null;
    const xr = a.tools.includes("xr-interact");
    // Complete: an accepted forecast with values, the session's start in the stream, and the app's trace for app sessions.
    const complete = !!forecast && Array.isArray(forecast.measurements) && forecast.measurements.length > 0 && !!sessionId && (!xr || existsSync(join(dir, "trace.jsonl")));
    if (!complete) return interrupted(full, sessionId ? { sessionId } : {});

    // As noted while it ran; else from the recorded stream; unknown when the stream ends before the submission.
    full.tokensAtSubmit = typeof noted === "number" ? noted : (atSubmit ?? (submitted ? live.total : null));
    const traceLines = (await text("trace.jsonl")).split("\n").map((l) => parse<{ event?: TraceEvent }>(l)).filter((l): l is { event?: TraceEvent } => !!l);
    const trace: TraceEvent[] = [...(marker.sourceEvents ?? []), ...traceLines.filter((l) => l.event).map((l) => l.event as TraceEvent)];
    // As runAgent records it: the runtime's own report, else "not reported" (nothing copied from study.json or Settings).
    const reported = [...trace].reverse().find((e): e is Extract<TraceEvent, { type: "runtime" }> => e.type === "runtime");
    const NOT_REPORTED = "not reported";
    const runtime = runtimeFor(study, a);
    const servers = parse<{ mcpServers?: Record<string, unknown> }>(await text("mcp.json"))?.mcpServers ?? {};
    const bridged = existsSync(join(dir, "bridge.jsonl"));
    const runtimeStarts = bridged ? (await jsonLines(join(dir, "bridge.jsonl"))).filter((x) => x.type === "start").length : 0;
    const calls = (await text("calls.log")).trim().split("\n").filter((l) => l && l !== "submit_forecast").length;
    const model = a.model;
    const outputTokens = Number(usage.output_tokens ?? 0);
    const run: RunResult = {
      jobId,
      planDigest: this.campaign.digest,
      status: "completed",
      sessionId: sessionId || `${jobId}-a${attempt}`,
      execution: {
        synthetic: false,
        engine: reported?.engine ?? (xr ? NOT_REPORTED : "none"),
        backend: reported?.backend ?? (xr ? NOT_REPORTED : "none"),
        observation: xr ? (reported?.observation ?? "none") : "none",
        deviceProfile: reported?.deviceProfile ?? (xr ? NOT_REPORTED : "none"),
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
        versions: {
          engine: reported?.engineVersion ? `${reported.engine} ${reported.engineVersion}` : xr ? `${runtime} (${NOT_REPORTED})` : "none",
          runtime: runtime === "none" ? "none" : `${runtime}-mcp`,
          connector: "xr-study-sim executor 0.4",
          provider: `Claude Code ${cliVersion || "CLI"}`,
        },
        startedAt: marker.startedAt,
        capabilities: Array.isArray(reported?.capabilities) ? reported!.capabilities : [],
        toolCalls: calls,
        outputTokens,
        inputTokens: usage.input_tokens ?? null,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
        reasoningTokens: null,
        inferenceWallTimeMs: Math.max(0, (existsSync(join(dir, "forecast.json")) ? statSync(join(dir, "forecast.json")).mtimeMs : Date.now()) - Date.parse(marker.startedAt)),
        simulationTimeMs: simulationTime(trace),
        humanTimeEstimateMs: null,
        technicalRetries: 0,
        ...(bridged ? { runtimeStarts } : {}),
        ...(designOrder ? { designOrder } : {}),
        ...(full.tokensAtSubmit !== null ? { tokensAtSubmit: full.tokensAtSubmit } : {}),
        recovered: RECOVERED,
      },
      measurements: forecast!.measurements as RunResult["measurements"],
      trace,
    };
    const total = (totalInput(run.execution) ?? 0) + outputTokens;
    const manifestBody = JSON.stringify(
      {
        requestedModel: model,
        effort: effortArgs(model.reasoning)[1] ?? "default",
        actualModel: actualModel || null,
        cliVersion,
        runtime,
        runtimeCommand: runtime === "webxr" || runtime === "none" ? "built in" : (servers[runtime] ?? null),
        ...(bridged ? { runtimeStarts } : {}),
        mcp: Object.keys(servers),
        costUsd,
        ...(costUsd === null ? { cost: COST_UNKNOWN } : {}),
        turns: result?.num_turns ?? null,
        exitCode: null,
        usage: full,
        tokensAtSubmit: full.tokensAtSubmit,
        tokensAfterSubmit: full.tokensAtSubmit === null ? null : Math.max(0, total - full.tokensAtSubmit),
        recovered: RECOVERED,
      },
      null,
      2,
    );
    await writeFile(join(dir, "execution-manifest.json"), manifestBody);
    const requested = conditionModel(this.campaign, job.agentId);
    const effective = !actualModel || actualModel === requested.model || actualModel.startsWith(requested.model) ? { ...requested } : { ...requested, model: actualModel };
    await this.finish(
      job,
      attempt,
      run,
      {
        campaignDigest: this.campaign.digest,
        jobId,
        attempt,
        status: "completed",
        actualModel: effective,
        sessionId: run.sessionId,
        freshSession: true,
        freshPIE: true,
        freshScreenshots: true,
        assetHashes: {},
        executionManifest: { path: `jobs/${jobId}/a${attempt}/execution-manifest.json`, sha256: sha(manifestBody) },
        usage: full,
        recovered: RECOVERED,
      },
      dir,
    );
  }

  // ---------- shared result writing ----------
  private async finish(job: Job, attempt: number, result: RunResult, receipt: Omit<CampaignReceipt, "output">, jobDir: string) {
    const resultsDir = join(this.dir, "results");
    await mkdir(resultsDir, { recursive: true });
    const body = JSON.stringify(result, null, 2) + "\n";
    const path = join(resultsDir, `${job.id}.json`);
    // The first completed attempt is the selected output; later attempts are kept only in the job folder.
    if (result.status === "completed" && !existsSync(path)) await writeFile(path, body);
    await writeFile(join(jobDir, "result.json"), body);
    const full: CampaignReceipt = {
      ...receipt,
      output: result.status === "completed" ? { path: `results/${job.id}.json`, sha256: sha(body) } : null,
    };
    await this.appendReceipt(full, jobDir);
    void attempt;
  }
  private planJob(jobId: string) {
    return this.plan.jobs.find((j) => j.id === jobId)!;
  }
  /**
   * A fresh, empty folder for a new attempt of a session. An attempt never reuses a folder that is
   * there already: a loaded runs zip or an attempt that ended without a receipt may have left files
   * in it (Claude Code settings in session/, a forecast, a used-up tool budget). The number is the
   * next one after every attempt counted and every attempt folder on disk; the folder is created
   * here, and one that exists by then refuses the attempt.
   */
  private async attemptFolder(jobId: string): Promise<{ attempt: number; jobDir: string }> {
    const base = join(this.dir, "jobs", jobId);
    await mkdir(base, { recursive: true });
    const onDisk = (await readdir(base)).map((f) => /^a(\d{1,6})$/i.exec(f)).filter((m) => m !== null).map((m) => Number(m![1]));
    const attempt = Math.max(this.jobs.get(jobId)!.attempts, ...onDisk) + 1;
    const jobDir = join(base, `a${attempt}`);
    try {
      await mkdir(jobDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`The folder of attempt ${attempt} of this session exists already, so it was not run. Run it again.`);
      throw e;
    }
    return { attempt, jobDir };
  }

  // ---------- simulated execution ----------
  private async simulate(jobId: string, handle: RunHandle) {
    const job = this.planJob(jobId);
    const a = this.agent(job.agentId);
    const { attempt, jobDir } = await this.newAttempt(jobId, handle, "simulate");
    if (handle.stopped) return;
    this.update(jobId, { status: "running", attempts: attempt, simulated: true, startedAt: new Date().toISOString(), toolCalls: 0, lastTool: null, warning: null });
    // Tool calls are counted as in real sessions: the forecast submission is not one of them.
    const tools = (
      a.tools.includes("xr-interact")
        ? ["open_design", "look", "screenshot", "select", "screenshot", "select"]
        : a.tools.includes("read-files")
        ? ["list_files", "read_file", "read_file"]
        : []
    ).slice(0, a.maxToolCalls);
    for (const step of [...tools, "submit_forecast"]) {
      await wait(120 + Math.round(Math.random() * 180));
      if (handle.stopped) return;
      if (step !== "submit_forecast") await appendFile(join(jobDir, "calls.log"), step + "\n");
      this.update(jobId, { toolCalls: tools.indexOf(step) + 1 || tools.length, lastTool: `${step} (simulated)` });
    }
    const sub: Plan = { ...this.plan, jobs: [job], frozenAt: this.campaign.createdAt };
    const run = simulatedResults(sub, parseInt(sha(jobId + attempt).slice(0, 8), 16)).runs[0];
    run.sessionId = `${this.campaign.jobs.find((j) => j.id === jobId)!.sessionKey}-a${attempt}`;
    run.execution.startedAt = new Date().toISOString();
    run.execution.toolCalls = tools.length;
    // No model was called: no token usage to report (not placeholder numbers).
    Object.assign(run.execution, { inputTokens: null, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
    const model = conditionModel(this.campaign, job.agentId);
    await this.finish(
      job,
      attempt,
      run,
      {
        campaignDigest: this.campaign.digest,
        jobId,
        attempt,
        status: "completed",
        actualModel: { ...model },
        sessionId: run.sessionId,
        freshSession: true,
        freshPIE: true,
        freshScreenshots: true,
        assetHashes: {},
        executionManifest: { path: `jobs/${jobId}/a${attempt}/result.json`, sha256: sha(JSON.stringify(run)) },
        usage: { inputTokens: null, outputTokens: null },
      },
      jobDir,
    );
    if (!handle.stopped) this.update(jobId, { status: "done", endedAt: new Date().toISOString(), tokensIn: null, tokensOut: null, costUsd: null, toolCalls: tools.length });
  }

  // ---------- real execution: headless Claude Code ----------
  private async runAgent(jobId: string, settings: Settings, handle: RunHandle) {
    const job = this.planJob(jobId);
    const a = this.agent(job.agentId);
    const { attempt, jobDir } = await this.newAttempt(jobId, handle, "agent");
    const cwd = join(jobDir, "session");
    await mkdir(cwd);
    // The study server writes this ID into the forecast it accepts: only that forecast counts.
    const attemptId = randomUUID();
    // The study as this campaign froze it: its sources, fields and participants. The workspace may
    // have changed since; only where the files live comes from it (workspace.json).
    const { dir: wsDir } = await readStudyFolder(this.workspaceId);
    const study = this.plan.study;
    const changed = (await changedSources(this.workspaceId, this.campaign, this.manifest)).filter((x) => a.sourceIds.includes(x.id));
    requireThat(changed.length === 0, changed.map((x) => x.message).join(" "));
    if (runtimeFor(this.plan.study, a) === "webxr" && a.tools.includes("xr-interact")) {
      const appChanged = await changedApp(this.workspaceId, this.campaign, this.manifest);
      requireThat(!appChanged, appChanged ?? "");
    }
    const packet = jobPacket(this.plan, job) as { task: Record<string, unknown> };
    const protocol = protocolForJob(this.plan, job);
    const targets = agentTargets(study, a);
    // The real path under the one source rule (inside the study; a project may be an absolute path elsewhere).
    const src = (id: string) => sourceLocation(wsDir, kindOf(id) ?? "", this.manifest.sources?.[id]).path ?? null;
    // Each injected source is titled with its own name, so an agent with several can tell them apart.
    const labelOf = (id: string) => study.sources.find((s) => s.id === id)?.label ?? id;
    const kindOf = (id: string) => study.sources.find((s) => s.id === id)?.kind;

    // Injected material, recorded as source deliveries for the audit. blockers() refuses missing
    // sources before a run starts; this guard covers files removed after that check.
    const missing = missingSources(wsDir, study, this.manifest, a.sourceIds);
    requireThat(missing.length === 0, missing.map((m) => m.message).join(" "));
    const injected: PromptSection[] = [];
    for (const id of a.sourceIds) {
      const kind = kindOf(id);
      const path = src(id);
      if (kind === "brief" || kind === "evidence")
        injected.push({ sourceId: id, title: kind === "brief" ? "Study brief" : `Knowledge: ${labelOf(id)}`, content: await readFile(path!, "utf8") });
      else if (kind === "project") {
        // The same files list_files and read_file give: nothing hidden from agents is named.
        const files = (await agentFileList(path!)).join("\n");
        // The same one line for every configuration that can read files (its content, hashed for the audit, is the list).
        injected.push({ sourceId: id, title: "Project files you can open with read_file", content: files, ...(a.tools.includes("read-files") ? { note: READ_FILES_LINE } : {}) });
      } else if (kind === "demographics")
        injected.push({ sourceId: id, title: `Participant background: ${labelOf(id)} (allowed fields only)`, content: await demographics(path, study.sources.find((s) => s.id === id)!.fields ?? [], job.participantId, study.participants.map((p) => p.id)) });
      else if (kind === "trajectory")
        injected.push({ sourceId: id, title: `This participant's recorded movement: ${labelOf(id)} (allowed fields only)`, content: await trajectory(path, job.participantId, study.sources.find((s) => s.id === id)!.fields ?? [], study.sources.find((s) => s.id === id)!.phases) });
    }
    const inputs = a.inputs?.length ? describeInputs(await readHuman(this.workspaceId), study, a, job) : null;
    // The session's design order, derived at launch and recorded in job.json and the result: the
    // person's own order, or for population sessions the human orders in rotation over repetitions
    // (the same for every configuration). Designs are listed and played in it.
    const order = designOrder(study, job);
    const designs = order.map((id) => ({ id, label: study.conditions.find((c) => c.id === id)!.label }));
    const caseIds = casesInOrder(study, protocol.requiredCaseIds, order);
    const runtime = runtimeFor(study, a);
    const caseOf = (design: string, kind: string) => {
      const phase = study.phases.find((p) => p.kind === kind);
      const c = phase && study.cases.find((x) => x.conditionId === design && x.phaseId === phase.id);
      return c ? { caseId: c.id, phaseId: phase!.id } : null;
    };
    const ordered = a.tools.includes("xr-interact") ? [...new Set(caseIds.map((id) => study.cases.find((c) => c.id === id)!.conditionId))] : designs.map((d) => d.id);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify(
        {
          jobId,
          attemptId,
          budget: a.maxToolCalls,
          // Token budget: the runtimes read <job>/usage.json and refuse calls once submitNow is set.
          tokenBudget: a.maxTokens ?? null,
          submitAttempts: SUBMIT_ATTEMPTS,
          projectDir: a.tools.includes("read-files") ? a.sourceIds.map(src).find((p, i) => kindOf(a.sourceIds[i]) === "project" && p) ?? null : null,
          // The study's ID of that project source, for the read events of the audit trace.
          projectSourceId: a.tools.includes("read-files") ? a.sourceIds.find((id) => kindOf(id) === "project" && src(id)) ?? null : null,
          participantId: job.participantId ?? null,
          designOrder: order,
          designs,
          targets: study.outcomes
            .filter((o) => targets.includes(o.id))
            .map((o) => ({ id: o.id, label: o.label, unit: o.unit, scale: o.scale, aggregation: o.aggregation, ...(o.range ? { range: o.range } : {}), ...(o.components ? { components: o.components, componentRule: o.componentRule ?? "mean", ...(o.componentWeights ? { componentWeights: o.componentWeights } : {}) } : {}) })),
          // Every app runtime (built in or external) gets the same description of the session to play.
          app: a.tools.includes("xr-interact")
            ? {
                runtime,
                observation: a.observation,
                trace: join(jobDir, "trace.jsonl"),
                screenshots: join(jobDir, "screenshots"),
                designs: ordered.map((id) => ({ id, label: study.conditions.find((c) => c.id === id)!.label, practice: caseOf(id, "practice"), main: caseOf(id, "main") })),
                cases: caseIds.map((id) => {
                  const c = study.cases.find((x) => x.id === id)!;
                  return {
                    caseId: c.id,
                    conditionId: c.conditionId,
                    phaseId: c.phaseId,
                    requiredActions: c.requiredActions,
                    ...(c.minActions !== undefined ? { minActions: c.minActions } : {}),
                    ...(c.observeBeforeEachAction ? { observeBeforeEachAction: true } : {}),
                  };
                }),
              }
            : undefined,
          webxr:
            runtime === "webxr"
              ? {
                  jobId,
                  budget: a.maxToolCalls,
                  tokenBudget: a.maxTokens ?? null,
                  chromePath: settings.chromePath,
                  app: { dir: resolve(wsDir, this.manifest.app!.serve), query: this.manifest.app!.query },
                  // What the app declares (workspace.json → app): which tools the agent gets and what the runtime reports.
                  capabilities: webxrCapabilities(this.manifest),
                  actions: appActions(this.manifest),
                  // {participant} in the app query: that person's trial layouts for individual jobs.
                  participant: job.participantId ?? null,
                  designs: ordered.map((id) => ({ id, label: study.conditions.find((c) => c.id === id)!.label, practice: caseOf(id, "practice"), main: caseOf(id, "main") })),
                }
              : undefined,
        },
        null,
        2,
      ),
    );
    // Every process of the session carries XR_STUDY_JOB, so this workbench's processes can be told apart.
    const marker = { XR_STUDY_JOB: jobId };
    const servers: Record<string, unknown> = { study: { type: "stdio", command: process.execPath, args: [studyServer, jobDir], env: marker } };
    // The study bridge as configured in Settings (recorded in the execution manifest).
    let bridge: { type: string; command: string; args: string[]; env: Record<string, string> } | null = null;
    if (runtime === "webxr") servers.webxr = { type: "stdio", command: process.execPath, args: [webxrServer, jobDir], env: marker };
    else if (runtime !== "none") {
      const r = settings.runtimes[runtime];
      const vars: Record<string, string> = { jobDir, jobFile: join(jobDir, "job.json"), trace: join(jobDir, "trace.jsonl") };
      // Claude Code starts the server in the session folder, so a relative path from Settings
      // (e.g. examples/selection/runtime/bridge.py) is resolved against the repository here.
      const fromRepo = (x: string) => (!isAbsolute(x) && /[\\/]/.test(x) && existsSync(resolve(repoRoot, x)) ? resolve(repoRoot, x) : x);
      bridge = {
        type: "stdio",
        command: fromRepo(r.command!),
        args: (r.args ?? []).map((x) => fromRepo(x.replace(/\{(jobDir|jobFile|trace)\}/g, (_, k: string) => vars[k]))),
        env: { XR_STUDY_JOB_DIR: vars.jobDir, XR_STUDY_JOB_FILE: vars.jobFile, XR_STUDY_TRACE: vars.trace, ...marker },
      };
      // Started through a wrapper that records each start of the bridge and its first answer to
      // tools/list (bridge.jsonl), and ends what the bridge leaves running when it ends.
      servers[runtime] = { ...bridge, command: process.execPath, args: [bridgeProxy, jobDir, bridge.command, ...bridge.args] };
    }
    await writeFile(join(jobDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
    const play = !a.tools.includes("xr-interact")
      ? null
      : runtime === "webxr"
      ? playInstructions(runtime, ordered, study, caseIds, typeof this.manifest.app?.instructions === "string" ? this.manifest.app.instructions : undefined, webxrCapabilities(this.manifest))
      : playInstructions(runtime, ordered, study, caseIds, settings.runtimes[runtime]?.instructions, settings.runtimes[runtime]?.capabilities ?? []);
    const { system, prompt } = buildPrompt({ study, agent: a, job, designs, orderContext: (packet.task as { orderContext?: unknown }).orderContext, play, sections: injected, inputs });
    await writeFile(join(jobDir, "prompt.md"), `## System\n${system}\n\n## Prompt\n${prompt}\n`);
    const sourceEvents: TraceEvent[] = injected.map((s) => ({ type: "source", sourceId: s.sourceId, delivery: "injected", sha256: sha(s.content) }));

    const model = a.model;
    const problem = claudeProblem(settings);
    requireThat(!problem, problem!);
    // What this Claude Code accepts, read once from `claude --help`.
    const cli = await claudeFeatures(settings);
    if (cli.known && !cli.partialMessages && !this.notedOldCli) {
      this.notedOldCli = true;
      this.emit({
        type: "log",
        jobId,
        text: "This Claude Code is an older version without --include-partial-messages: token counts update when a message ends and show too few output tokens until the session's own totals arrive at its end, so the token budget is checked later. Update Claude Code for live counts.",
      });
    }
    // Beside prompt.md in the attempt folder: Claude Code starts in an empty working folder (session/).
    if (cli.systemPromptFile) await writeFile(join(jobDir, "system-prompt.md"), system);
    // The prompt goes on stdin (below), never on the command line: Windows allows 32,767 characters
    // per command line and Linux 128 KB per argument, less than a brief with evidence or movement data.
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // Each API message's final usage (message_delta), so live token counts and the budget follow the session.
      ...(cli.partialMessages ? ["--include-partial-messages"] : []),
      "--model",
      model.model,
      ...effortArgs(model.reasoning),
      ...(cli.systemPromptFile ? ["--system-prompt-file", join(jobDir, "system-prompt.md")] : ["--system-prompt", system]),
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      join(jobDir, "mcp.json"),
      "--allowedTools",
      ...Object.keys(servers).map((s) => `mcp__${s}`),
      "--setting-sources",
      "local",
      "--disable-slash-commands",
      "--no-session-persistence",
    ];
    if (handle.stopped) return;
    const startedAt = new Date();
    const mine = () => !handle.stopped;
    this.update(jobId, { status: "running", attempts: attempt, simulated: false, startedAt: startedAt.toISOString(), toolCalls: 0, lastTool: "starting session", error: null, warning: null, tokensIn: null, tokensOut: null, costUsd: null });
    const claude = claudeCommand(settings);
    let proc: ChildProcess;
    try {
      // Its own process tree (ended as a whole by killTree), without a console window, marked with the job.
      proc = spawnTree(claude.command, [...claude.prefix, ...args], { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...marker } });
    } catch (e) {
      throw new Error(`Claude Code could not be started (${claude.command}: ${(e as Error).message}). Run \`node scripts/setup.mjs\` so the workbench finds the native Claude Code.`);
    }
    // A missing executable (ENOENT) is reported here and the session fails with a plain message, never the server.
    let startError: Error | null = null;
    proc.on("error", (e) => (startError = e));
    proc.stdin!.on("error", () => undefined); // a session that ended early reads no more of its prompt
    proc.stdin!.end(prompt);
    this.running.set(jobId, proc);
    // The marker names the claude process, so a workbench restarted after a crash can stop it (and finish this attempt from its files).
    void writeMarker(jobDir, {
      jobId,
      attempt,
      mode: "agent",
      startedAt: startedAt.toISOString(),
      pid: proc.pid ?? null,
      sourceEvents,
    }).catch(() => undefined);
    const box: { result: Record<string, any> | null } = { result: null };
    let sessionId = "",
      actualModel = "",
      cliVersion = "",
      stderr = "",
      buf = "",
      tools = 0;
    const { timeoutMinutes, startupSeconds } = runtimeLimits(settings, runtime);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, timeoutMinutes * 60_000);
    // A study bridge that never answers tools/list leaves the agent without the app: the session
    // is stopped as failed instead of running on without it.
    const bridgeLog = join(jobDir, "bridge.jsonl");
    let startupFailed: string | null = null;
    const startup = bridge
      ? setTimeout(() => {
          void (async () => {
            const records = await jsonLines(bridgeLog);
            if (records.some((x) => x.type === "ready") || box.result || existsSync(join(jobDir, "forecast.json"))) return;
            const exit = records.find((x) => x.type === "exit");
            const stderrFile = join(jobDir, "bridge-stderr.log");
            const errTail = existsSync(stderrFile) ? (await readFile(stderrFile, "utf8")).trim().split("\n").slice(-2).join(" ").slice(-300) : "";
            const name = runtimeName(runtime);
            startupFailed =
              `${name[0].toUpperCase()}${name.slice(1)} did not start (no answer to tools/list within ${startupSeconds} s).` +
              (!records.some((x) => x.type === "start") ? " It was never started." : exit ? ` It exited${exit.signal ? ` on ${exit.signal}` : ` with code ${exit.code}`}.` : "") +
              (errTail ? ` Its last output: ${errTail}` : "") +
              ` Check its command in Settings → Runtimes → ${runtime}.`;
            if (mine()) this.emit({ type: "log", jobId, text: startupFailed });
            killTree(proc);
          })();
        }, startupSeconds * 1000)
      : undefined;
    // Token use so far, per API message (see UsageMeter), written to usage.json for the runtimes:
    // `submitNow` asks them to refuse further tools, and stays set. A session that then submits is
    // never stopped for its budget: it has SUBMIT_ATTEMPTS submissions and is stopped only once the
    // last of them is refused. A session that still calls other tools far over its budget (1.5 ×) is
    // stopped; none is stopped once its forecast was accepted (the closing turn only ends it).
    const forecastPath = join(jobDir, "forecast.json");
    const meter = new UsageMeter();
    let refused = false;
    let overBudget = false;
    let outOfAttempts = false;
    let lateRejections = 0;
    /** Submissions by tool_use ID: true when made after the tools were refused for the budget. */
    const submissions = new Map<string, boolean>();
    let atForecast: number | null = null;
    const writeUsage = async () => {
      const t = meter.totals();
      if (atForecast === null && submitNow(a.maxTokens, t.total, t.lastTurnInput)) refused = true;
      await writeFile(
        join(jobDir, "usage.json"),
        JSON.stringify({ tokens: t.total, input: t.input, output: t.output, uncachedInput: t.uncached, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, lastTurnInput: t.lastTurnInput, budget: a.maxTokens ?? null, submitNow: atForecast === null && refused, tokensAtSubmit: atForecast }),
      );
      return t;
    };
    const trackUsage = async (m: Record<string, any>) => {
      if (!meter.add(m)) return;
      const t = await writeUsage();
      if (mine()) this.update(jobId, { tokensIn: t.input, tokensOut: t.output });
    };
    const endSession = (text: string) => {
      this.emit({ type: "log", jobId, text });
      killTree(proc);
    };
    /** A tool call: other tools far over the budget stop the session; submissions never do. */
    const noteToolCall = (id: string, submit: boolean) => {
      if (submit) return void submissions.set(id, refused);
      const total = meter.totals().total;
      if (!a.maxTokens || total <= a.maxTokens * 1.5 || overBudget || outOfAttempts || atForecast !== null) return;
      overBudget = true;
      endSession(`Stopped: ${fmt(total)} tokens, far over the token budget of ${fmt(a.maxTokens)}, and still calling other tools instead of submitting the forecast.`);
    };
    /** Tool results: count the refused late submissions (the session ends after the last attempt). */
    const noteToolResults = (m: Record<string, any>) => {
      const content = Array.isArray(m.message?.content) ? m.message.content : [];
      for (const c of content) {
        if (c?.type !== "tool_result" || !submissions.get(String(c.tool_use_id))) continue;
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "");
        if ((c.is_error === true || /Forecast not accepted/.test(text)) && !existsSync(forecastPath)) lateRejections++;
      }
      if (lateRejections < SUBMIT_ATTEMPTS || outOfAttempts || overBudget || atForecast !== null) return;
      outOfAttempts = true;
      endSession(`Stopped: the forecast was not accepted in ${SUBMIT_ATTEMPTS} attempts after the token budget was used up.`);
    };
    /** Tool calls as the final count has them (calls.log, without the submission): refused calls are not counted. */
    const callsMade = async () =>
      existsSync(join(jobDir, "calls.log")) ? (await readFile(join(jobDir, "calls.log"), "utf8")).split("\n").filter((l) => l.trim() && l.trim() !== "submit_forecast").length : 0;
    /**
     * The moment the study server accepted the forecast: the tokens up to here are what the budget
     * is checked against. Noted when the submitting message is complete (its message_delta), or the
     * next message begins, or the session ends, so the message that submitted it is counted in full
     * and the closing turn is not. Not at the tool result alone: Claude Code runs the tool, and prints
     * its result, before the submitting message's final usage (message_delta) arrives.
     */
    let submitSeen = false;
    /** The message that called submit_forecast, and whether its final usage (message_delta) has arrived. */
    let submitMessage: string | null = null;
    let submitFinal = false;
    const noteForecast = async () => {
      if (atForecast !== null || !submitSeen || !existsSync(forecastPath)) return;
      atForecast = meter.totals().total;
      await writeUsage();
    };
    /**
     * A study bridge that could not start (it ended before it ever answered) or ended before the
     * forecast and was not started again: the session stops at once with the bridge's own last
     * output, instead of going on without the app. A bridge that ended after it answered gets
     * timing.bridgeRestartGraceMs for Claude Code to start it again (a restart, flagged on the row);
     * one that runs but never answers is the startup timeout's (startupSeconds).
     */
    let runtimeFailure: string | null = null;
    const stopForRuntime = (message: string) => {
      if (runtimeFailure || !mine()) return;
      runtimeFailure = message;
      this.emit({ type: "log", jobId, text: message });
      killTree(proc);
    };
    const bridgeEnded = async (now = Date.now()): Promise<string | null> => {
      if (!bridge) return null;
      const records = await jsonLines(bridgeLog);
      const i = records.map((x) => x.type === "exit" && !x.closed).lastIndexOf(true);
      if (i < 0 || records.slice(i + 1).some((x) => x.type === "start")) return null;
      const exit = records[i];
      const answered = records.slice(0, i).some((x) => x.type === "ready");
      if (answered && now - Number(exit.t ?? 0) < timing.bridgeRestartGraceMs) return null;
      const stderrFile = join(jobDir, "bridge-stderr.log");
      const said = existsSync(stderrFile) ? (await readFile(stderrFile, "utf8")).trim().split(/\r?\n/).slice(-3).join(" ").slice(-400) : "";
      const name = runtimeName(runtime);
      const how = exit.error ? String(exit.error) : exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
      return `${name[0].toUpperCase()}${name.slice(1)} ${answered ? "ended before the forecast" : "could not start"} (${how}): ${[bridge.command, ...bridge.args].join(" ")}${said ? `. It said: ${said}` : ""}. The session was stopped; check Settings → Runtimes → ${runtime}.`;
    };
    const watcher = bridge
      ? setInterval(async () => {
          if (runtimeFailure || startupFailed || atForecast !== null || existsSync(forecastPath)) return;
          const message = await bridgeEnded();
          if (message) stopForRuntime(message);
        }, 500)
      : null;
    // Text, decoded across chunks: a character split between two chunks stays whole.
    proc.stdout!.setEncoding("utf8");
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => (stderr = (stderr + d).slice(-4000)));
    const shots = new ScreenshotIndex(join(jobDir, "screenshots"));
    const handleLine = async (line: string) => {
      let m: Record<string, any> | null = null;
      try {
        m = JSON.parse(line);
      } catch {
        // not JSON: kept in the log as it is
      }
      // Partial-message chunks are many and only their usage matters: keep message_start/message_delta in the log.
      const keep = m?.type !== "stream_event" || ["message_start", "message_delta"].includes(m.event?.type);
      if (keep) await appendFile(join(jobDir, "stream.jsonl"), (await compactStreamLine(line, shots)) + "\n");
      if (!m) return;
      // A tool result counts as the next turn only once the submitting message's final usage is in
      // (or without partial messages, which never bring it).
      if (meter.startsTurn(m) && (m.type !== "user" || submitFinal || !cli.partialMessages)) await noteForecast();
      if (m.type === "system" && m.subtype === "init") {
        sessionId = m.session_id ?? "";
        actualModel = m.model ?? "";
        cliVersion = m.claude_code_version ?? "";
        // Claude Code connects MCP servers in the background: "pending" means still starting, not failed.
        const servers = (m.mcp_servers ?? []) as { name: string; status: string }[];
        const failed = servers.filter((s) => s.status !== "connected" && s.status !== "pending");
        const pending = servers.filter((s) => s.status === "pending");
        this.emit({ type: "log", jobId, text: `Session started (${actualModel}). MCP: ${servers.map((s) => `${s.name} ${s.status}`).join(", ")}` });
        if (pending.length) this.emit({ type: "log", jobId, text: `Still connecting: ${pending.map((s) => s.name).join(", ")}` });
        if (failed.length) this.emit({ type: "log", jobId, text: `Runtime failed to connect: ${failed.map((s) => s.name).join(", ")}` });
        // Without the study server (submit_forecast) or its runtime, the session cannot do what it is for.
        const needed = failed.filter((s) => s.name === "study" || s.name === runtime);
        if (needed.length)
          stopForRuntime(
            `${needed.map((s) => (s.name === "study" ? "The study server" : `${runtimeName(runtime)[0].toUpperCase()}${runtimeName(runtime).slice(1)}`)).join(" and ")} failed to connect (${needed.map((s) => s.status).join(", ")}). The session was stopped${bridge ? `; check Settings → Runtimes → ${runtime}` : ""}.`,
          );
      } else if (m.type === "stream_event") {
        await trackUsage(m);
        // The submitting message is complete: its output is in (Claude Code prints this after the tool result).
        if (m.event?.type === "message_delta" && submitMessage !== null && meter.currentMessage === submitMessage) {
          submitFinal = true;
          await noteForecast();
        }
      }
      else if (m.type === "assistant") {
        await trackUsage(m);
        for (const c of m.message?.content ?? []) {
          if (c.type === "tool_use") {
            const name = String(c.name).replace(/^mcp__/, "").replace("__", ".");
            noteToolCall(String(c.id), /submit_forecast$/.test(name));
            if (/submit_forecast$/.test(name)) (submitSeen = true), (submitMessage = String(m.message?.id ?? meter.currentMessage));
            const shots = existsSync(join(jobDir, "screenshots")) ? (await readdir(join(jobDir, "screenshots"))).sort() : [];
            if (mine())
              this.update(jobId, {
                toolCalls: tools,
                lastTool: `${name} ${JSON.stringify(c.input ?? {}).slice(0, 80)}`,
                screenshot: shots.length ? `jobs/${jobId}/a${attempt}/screenshots/${shots.at(-1)}` : null,
              });
          } else if (c.type === "text" && c.text?.trim()) this.emit({ type: "log", jobId, text: String(c.text).slice(0, 400) });
        }
      } else if (m.type === "user") {
        noteToolResults(m);
        // Tool calls are what the agent did before forecasting, as the runtimes logged them: the
        // submission and calls refused for the budget are not counted (the same as the final count).
        const made = await callsMade();
        if (made !== tools && mine()) this.update(jobId, { toolCalls: (tools = made) });
      } else if (m.type === "result") box.result = m;
    };
    // Lines are handled one after another, and all of them before the session's end is read.
    let lines: Promise<void> = Promise.resolve();
    proc.stdout!.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines = lines.then(() => handleLine(line)).catch(() => undefined);
      }
    });
    const code = await new Promise<number | null>((ok) => proc.on("close", ok));
    clearTimeout(timer);
    clearTimeout(startup);
    if (watcher) clearInterval(watcher);
    if (buf.trim()) lines = lines.then(() => handleLine(buf)).catch(() => undefined);
    await lines;
    // Every line is read now: a forecast on disk was accepted before the session ended. (Before,
    // only after the stream showed the submit_forecast call: lines are read a little behind the
    // session, so forecast.json may exist while the message that submitted it is still being read.)
    submitSeen = true;
    await noteForecast();
    // How the bridge ended, in its own words, once the session is over (no grace is left to wait for).
    const runtimeError = existsSync(forecastPath) ? null : runtimeFailure ?? (await bridgeEnded(Infinity));
    const traceLines = existsSync(join(jobDir, "trace.jsonl")) ? (await readFile(join(jobDir, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const trace: TraceEvent[] = [...sourceEvents, ...traceLines.filter((l) => l.event).map((l) => l.event as TraceEvent)];
    // The runtime's own report of what it is (bridge contract). Without one, nothing is copied
    // from study.json or Settings: the record says "not reported" and the audit flags it.
    const reported = [...trace].reverse().find((e): e is Extract<TraceEvent, { type: "runtime" }> => e.type === "runtime");
    const usesApp = a.tools.includes("xr-interact");
    if (usesApp && !reported && mine())
      this.emit({ type: "log", jobId, text: "The runtime did not report itself (no 'runtime' trace event); the audit records this as a deviation." });
    const NOT_REPORTED = "not reported";
    // Each start of a wrapped bridge (Claude Code may start a crashed one again within the session).
    const runtimeStarts = bridge ? (await jsonLines(bridgeLog)).filter((x) => x.type === "start").length : 0;
    const result = box.result;
    // Claude Code's own totals; a session that ended early (stopped, killed, timed out) has only the live count.
    const live = meter.totals();
    const usage: Record<string, any> = result?.usage ?? (meter.modelRan ? { input_tokens: live.uncached, cache_read_input_tokens: live.cacheRead, cache_creation_input_tokens: live.cacheWrite, output_tokens: live.output } : {});
    const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
    // Only the forecast the study server accepted in this attempt (it carries this attempt's ID).
    const forecast = await acceptedForecast(forecastPath, attemptId);
    // The tool budget covers what the agent does before forecasting; submitting the forecast is not
    // part of it (a configuration without tools has budget 0 and still submits).
    const calls = existsSync(join(jobDir, "calls.log")) ? (await readFile(join(jobDir, "calls.log"), "utf8")).trim().split("\n").filter((l) => l && l !== "submit_forecast").length : 0;
    const ok = !!forecast;
    const unknownModel = /unrecognized_model|issue with the selected model/i.test(`${stderr} ${JSON.stringify(result ?? "")}`);
    const error = ok
      ? null
      : handle.stopped
      ? handle.reason === "shutdown"
        ? INTERRUPTED
        : STOPPED
      : startError
      ? `Claude Code could not be started (${claude.command}: ${(startError as Error).message}). Install Claude Code, log in, and run \`node scripts/setup.mjs\` so the workbench finds it.`
      : runtimeError
      ? runtimeError
      : startupFailed
      ? startupFailed
      : unknownModel
      ? `Claude Code does not know the model "${model.model}". Check the model ID on Agent configurations.`
      : outOfAttempts
      ? `Stopped: the forecast was not accepted in ${SUBMIT_ATTEMPTS} attempts after the token budget of ${fmt(a.maxTokens!)} tokens was used up.`
      : overBudget
      ? `Stopped: the session used more than 1.5 × its token budget of ${fmt(a.maxTokens!)} tokens and was still calling other tools instead of submitting its forecast.`
      : timedOut
      ? `Stopped after ${timeoutMinutes} minutes (time limit for the ${runtime} runtime; Settings → Runtimes → time limit).`
      : result?.subtype && result.subtype !== "success"
      ? `Session ended: ${result.subtype}.`
      : code !== 0
      ? `claude exited with code ${code}: ${stderr.trim().split("\n").slice(-2).join(" ")}`
      : "The session ended without an accepted forecast.";
    const run: RunResult = {
      jobId,
      planDigest: this.campaign.digest,
      status: ok ? "completed" : "failed",
      sessionId: sessionId || `${jobId}-a${attempt}`,
      ...(error ? { error } : {}),
      execution: {
        synthetic: false,
        engine: reported?.engine ?? (usesApp ? NOT_REPORTED : "none"),
        backend: reported?.backend ?? (usesApp ? NOT_REPORTED : "none"),
        observation: usesApp ? (reported?.observation ?? "none") : "none",
        deviceProfile: reported?.deviceProfile ?? (usesApp ? NOT_REPORTED : "none"),
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
        versions: {
          engine: reported?.engineVersion ? `${reported.engine} ${reported.engineVersion}` : usesApp ? `${runtime} (${NOT_REPORTED})` : "none",
          runtime: runtime === "none" ? "none" : `${runtime}-mcp`,
          connector: "xr-study-sim executor 0.4",
          provider: `Claude Code ${cliVersion || "CLI"}`,
        },
        startedAt: startedAt.toISOString(),
        capabilities: Array.isArray(reported?.capabilities) ? reported!.capabilities : [],
        toolCalls: calls,
        outputTokens: Number(usage.output_tokens ?? 0),
        inputTokens: usage.input_tokens ?? null,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
        reasoningTokens: Number.isSafeInteger(usage.output_tokens_details?.thinking_tokens) ? usage.output_tokens_details.thinking_tokens : null,
        inferenceWallTimeMs: Date.now() - startedAt.getTime(),
        simulationTimeMs: simulationTime(trace),
        humanTimeEstimateMs: null,
        technicalRetries: 0,
        ...(bridge ? { runtimeStarts } : {}),
        // The order this session was given; the audit checks the visits against it.
        designOrder: order,
        // The audit checks the token budget up to here; the closing turn after acceptance is reported apart.
        ...(atForecast !== null ? { tokensAtSubmit: atForecast } : {}),
      },
      measurements: forecast?.measurements ?? [],
      trace,
    };
    const warnings = sessionWarnings(usesApp ? protocol.requiredCaseIds : [], runtime, run);
    if (mine()) for (const w of warnings) this.emit({ type: "log", jobId, text: `Warning: ${w[0].toUpperCase()}${w.slice(1)}.` });
    const full: FullUsage = {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
      reasoningTokens: run.execution.reasoningTokens,
      costUsd,
      source: result?.usage ? "final" : "live",
      tokensAtSubmit: atForecast,
    };
    const total = (totalInput(run.execution) ?? 0) + run.execution.outputTokens;
    const manifestBody = JSON.stringify(
      {
        requestedModel: model,
        effort: effortArgs(model.reasoning)[1] ?? "default",
        actualModel: (meter.modelRan && !unknownModel) || ok ? actualModel : null,
        cliVersion,
        runtime,
        runtimeCommand: runtime === "webxr" || runtime === "none" ? "built in" : bridge,
        ...(bridge ? { runtimeWrapper: "bridge-proxy (records starts and readiness in bridge.jsonl)", runtimeStarts } : {}),
        mcp: Object.keys(servers),
        costUsd,
        ...(costUsd === null && meter.modelRan ? { cost: COST_UNKNOWN } : {}),
        turns: result?.num_turns ?? null,
        exitCode: code,
        usage: full,
        // All tokens (input including cache, plus output) when the forecast was accepted: the budget applies up to here.
        tokensAtSubmit: atForecast,
        tokensAfterSubmit: atForecast === null ? null : Math.max(0, total - atForecast),
      },
      null,
      2,
    );
    await writeFile(join(jobDir, "execution-manifest.json"), manifestBody);
    const requested = conditionModel(this.campaign, job.agentId);
    // No model answered (for example an unknown model ID): no effective model is recorded.
    const effective = (!meter.modelRan || unknownModel) && !ok ? null : !actualModel || actualModel === requested.model || actualModel.startsWith(requested.model) ? { ...requested } : { ...requested, model: actualModel };
    const receiptUsage: CampaignReceipt["usage"] = full;
    await this.finish(
      job,
      attempt,
      run,
      {
        campaignDigest: this.campaign.digest,
        jobId,
        attempt,
        status: ok ? "completed" : "failed",
        // The CLI reports the resolved model; an alias that resolves to the requested ID counts as the requested model.
        actualModel: effective,
        sessionId: run.sessionId,
        freshSession: true,
        freshPIE: true,
        freshScreenshots: true,
        assetHashes: {},
        executionManifest: { path: `jobs/${jobId}/a${attempt}/execution-manifest.json`, sha256: sha(manifestBody) },
        usage: receiptUsage,
        ...(error ? { error } : {}),
        ...(error === INTERRUPTED ? { interrupted: true } : {}),
      },
      jobDir,
    );
    if (unknownModel && mine()) this.emit({ type: "log", jobId, text: error! });
    // A stopped run stays "stopped" (a rerun may already hold the session); only its counts are kept.
    if (handle.stopped && !ok) {
      if (this.jobs.get(jobId)!.attempts === attempt && this.jobs.get(jobId)!.status === "stopped")
        this.update(jobId, { tokensIn: totalInput(run.execution), tokensOut: run.execution.outputTokens, toolCalls: calls, costUsd: null });
      return;
    }
    if (handle.stopped && this.jobs.get(jobId)!.attempts !== attempt) return;
    this.update(jobId, {
      status: ok ? "done" : "failed",
      endedAt: new Date().toISOString(),
      toolCalls: calls,
      tokensIn: totalInput(run.execution),
      tokensOut: run.execution.outputTokens,
      costUsd,
      warning: joinWarnings(budgetWarning(total, a.maxTokens, atForecast), ...warnings),
      error,
    });
  }
}
/** The JSON lines of a file (unreadable lines skipped); none when it does not exist. */
async function jsonLines(path: string): Promise<Record<string, any>[]> {
  if (!existsSync(path)) return [];
  const out: Record<string, any>[] = [];
  for (const l of (await readFile(path, "utf8")).split("\n"))
    if (l.trim())
      try {
        out.push(JSON.parse(l));
      } catch {
        // a line being written
      }
  return out;
}

/** The forecast in forecast.json if the study server wrote it for this attempt (its attemptId), else null. */
async function acceptedForecast(path: string, attemptId: string): Promise<{ measurements?: RunResult["measurements"] } | null> {
  try {
    const f = JSON.parse(await readFile(path, "utf8"));
    return f && typeof f === "object" && f.attemptId === attemptId ? f : null;
  } catch {
    return null;
  }
}
/** An attempt's tokens as its usage.json last recorded them (live counts), for a receipt written without the session's own totals. */
async function liveUsage(dir: string): Promise<CampaignReceipt["usage"]> {
  try {
    const u = JSON.parse(await readFile(join(dir, "usage.json"), "utf8"));
    const n = (x: unknown) => (typeof x === "number" ? x : null);
    const usage: FullUsage = { inputTokens: n(u.uncachedInput), outputTokens: n(u.output), cacheReadTokens: n(u.cacheRead), cacheWriteTokens: n(u.cacheWrite), reasoningTokens: null, costUsd: null, source: "live", tokensAtSubmit: n(u.tokensAtSubmit) };
    return usage;
  } catch {
    return { inputTokens: null, outputTokens: null };
  }
}
/** All input tokens of a session: uncached input plus cache writes and cache reads. */
function totalInput(e: { inputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }): number | null {
  const parts = [e.inputTokens, e.cacheReadTokens, e.cacheWriteTokens].filter((x): x is number => typeof x === "number");
  return parts.length ? parts.reduce((s, x) => s + x, 0) : null;
}
/** Allowed demographic fields: the person's row, or a cohort summary for population configs. */
async function demographics(path: string | null, fields: string[], participantId: string | undefined, people: string[]): Promise<string> {
  if (!path || !existsSync(path)) return "(no participant background file declared)";
  // Also a table Excel saved as Windows-1252 or UTF-16.
  return backgroundText(await readText(path), fields, participantId, people);
}
/**
 * A participant's movement recordings, only the ID column and the declared fields: from a CSV with
 * a participant column (that person's rows, with the header), or every file of a folder of
 * per-participant files named after the participant ID. Population jobs get none. With `phases`
 * (the source's phases), only rows of those phases.
 */
export async function trajectory(path: string | null, participantId: string | undefined, fields: string[], phases?: string[]): Promise<string> {
  if (!participantId) return "(movement recordings are per participant; none for population forecasts)";
  if (!path || !existsSync(path)) return "(no movement recordings declared)";
  return trajectoryText(path, participantId, fields, phases);
}
/** Declared input variables (measured outcomes used as predictors): the person's values, or cohort means. Never targets. */
function describeInputs(human: HumanData | null, study: Plan["study"], a: AgentProtocol, job: Job): string {
  if (!human) return "(no measured data available)";
  const lines: string[] = [];
  for (const id of a.inputs ?? []) {
    const o = study.outcomes.find((x) => x.id === id)!;
    for (const c of study.conditions) {
      const rows = human.measurements.filter(
        (m) => m.outcomeId === id && m.conditionId === c.id && (!job.participantId || m.participantId === job.participantId),
      );
      const values = rows.map((m) => (m.components ? Object.values(m.components).reduce((s, v) => s + v, 0) / Object.values(m.components).length : m.value!));
      if (!values.length) continue;
      const v =
        o.aggregation === "geometric"
          ? Math.exp(values.reduce((s, x) => s + Math.log(x), 0) / values.length)
          : values.reduce((s, x) => s + x, 0) / values.length;
      lines.push(`${o.label} (${o.unit}), ${c.label}: ${v.toFixed(3)}${job.participantId ? "" : ` (cohort ${o.aggregation === "geometric" ? "geometric " : ""}mean, n=${values.length})`}`);
    }
  }
  return lines.join("\n") || "(no measured data for the declared inputs)";
}
export const _test = {
  hash,
  /** Lets one test process start sessions again after testing shutdownExecutors. */
  afterShutdown: () => {
    shuttingDown = false;
  },
};
