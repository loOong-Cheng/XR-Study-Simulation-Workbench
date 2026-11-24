// Executor: runs a frozen campaign job by job, as fresh headless Claude Code
// sessions (your planned usage) or as clearly labelled simulations, and streams
// progress to the workbench. All state is on disk (receipts, results, events),
// so a run can pause, stop, resume or rerun failed jobs at any time.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { campaignPlan, conditionModel, type Campaign, type CampaignReceipt } from "../core/campaign.js";
import { simulatedResults } from "../core/example.js";
import { reusedUsage } from "../history.js";
import { agentLevel, agentTargets, hash, jobPacket, protocolForJob } from "../core/planner.js";
import type { AgentProtocol, HumanData, Job, Plan, RunResult, Study, TraceEvent } from "../core/types.js";
import { claudeEffort, effortProblem, requireThat } from "../core/validation.js";
import { claudeCommand, readSettings, runtimeLimits, type Settings } from "../settings.js";
import { changedSources, listCampaigns, missingSources, readCampaign, readHuman, readReceipts, readStudyFolder, repoRoot, runDir, sourceLocation, workspaceDir, type WorkspaceManifest } from "../workspace.js";
import { runtimeFor, runtimeStatus } from "./runtimes.js";
import { compactStreamLine, ScreenshotIndex } from "./stream-log.js";
import { backgroundText, trajectoryText } from "../participant-knowledge.js";
import { agentFileList } from "../runtimes/guard.js";

/** not-started: never asked to run; queued: asked to run and waiting for a free slot. */
export type JobStatus = "not-started" | "queued" | "running" | "done" | "failed" | "stopped" | "reused";
/** The error of an attempt you stopped (also in its receipt, so it reads as stopped after a restart). */
export const STOPPED = "Stopped by you.";
/** Shown for a real session that ended before Claude Code reported its cost. */
export const COST_UNKNOWN = "unknown (stopped before the end)";
/** One run of a session: stop() marks it, so a stopped run never overwrites a rerun of the same session. */
interface RunHandle {
  stopped: boolean;
}
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
  simulated: boolean;
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
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const registry = new Map<string, Executor>();
/** Drop the executor of a campaign before it is deleted; refused while its sessions run. */
export function closeExecutor(workspaceId: string, campaignId: string) {
  workspaceDir(workspaceId); // only the canonical study ID, so the key below is the one open() used
  const ex = registry.get(`${workspaceId}::${campaignId}`);
  requireThat(!ex || ex.running.size === 0, "Sessions of this campaign are running. Stop them first.");
  registry.delete(`${workspaceId}::${campaignId}`);
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

/** Live token use of a session from Claude Code's stream, per API message. */
export class UsageMeter {
  private messages = new Map<string, { uncached: number; cacheWrite: number; cacheRead: number; output: number }>();
  private current = "";
  /** Whether any model answered (a session with an unknown model never gets this far). */
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
    if (m.type === "assistant" && m.message?.usage) (u = m.message.usage), (id = String(m.message.id ?? id));
    else if (m.type === "stream_event" && m.event?.type === "message_start") (u = m.event.message?.usage), (id = this.current = String(m.event.message?.id ?? `m${this.messages.size}`));
    else if (m.type === "stream_event" && m.event?.type === "message_delta") u = m.event.usage;
    if (!u) return false;
    this.modelRan = true;
    const n = (k: string) => Number(u![k]) || 0;
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
 * smaller than 10% of it, or than 1.5 × the last turn's input (every turn re-reads the context).
 */
export const submitNow = (budget: number | null | undefined, total: number, lastTurnInput: number) =>
  !!budget && budget - total < Math.max(0.1 * budget, 1.5 * lastTurnInput);

/** How the agent should play the app, in the words of its runtime's tools. */
export function playInstructions(runtime: string, order: string[], study: Study, caseIds: string[], extra?: string): string {
  const actions = [...new Set(caseIds.flatMap((id) => study.cases.find((c) => c.id === id)?.requiredActions ?? []))];
  const required = actions.length ? ` The study protocol requires these actions in each task: ${actions.join(", ")}; a skipped one is recorded as a protocol deviation.` : "";
  const how =
    runtime === "webxr"
      ? "For each design: open_design, then in EVERY task (the practice task and the main task alike) call look to look around, take a screenshot, and select the requested objects."
      : `Use the ${runtime} tools you have. For each design: load it, then in EVERY task (the practice task and the main task alike) look around, take at least one screenshot, and complete the task as a participant would.`;
  return [`Experience the app like a participant first. Visit the designs in this order: ${order.join(", ")}. ${how}${required}`, ...(extra?.trim() ? [`How to use the ${runtime} tools: ${extra.trim()}`] : [])].join("\n");
}

export class Executor {
  jobs = new Map<string, JobState>();
  paused = true;
  mode: "agent" | "simulate" = "simulate";
  queue: string[] = [];
  running = new Map<string, ChildProcess | null>();
  /** The current run of each running session (see RunHandle). */
  private handles = new Map<string, RunHandle>();
  listeners = new Set<(e: ExecutorEvent) => void>();
  private constructor(
    readonly workspaceId: string,
    readonly campaign: Campaign,
    readonly plan: Plan,
    readonly manifest: WorkspaceManifest,
    readonly dir: string,
  ) {}

  static async open(workspaceId: string, campaignId: string): Promise<Executor> {
    workspaceDir(workspaceId); // one executor per study: refuse any non-canonical spelling of its ID
    const key = `${workspaceId}::${campaignId}`;
    if (registry.has(key)) return registry.get(key)!;
    const campaign = await readCampaign(workspaceId, campaignId);
    const plan = campaignPlan(campaign);
    const { manifest } = await readStudyFolder(workspaceId);
    const ex = new Executor(workspaceId, campaign, plan, manifest, runDir(workspaceId, campaignId));
    await ex.load();
    registry.set(key, ex);
    return ex;
  }
  private agent(id: string) {
    return this.plan.agents.find((a) => a.id === id)!;
  }
  private async load() {
    const receipts = await readReceipts(this.workspaceId, [this.campaign.id]);
    for (const j of this.campaign.jobs) {
      if (j.kind !== "llm") continue;
      const a = this.agent(j.conditionId);
      const mine = receipts.filter((r) => r.jobId === j.id);
      const done = mine.find((r) => r.status === "completed");
      this.jobs.set(j.id, {
        jobId: j.id,
        agentId: a.id,
        label: a.label,
        level: agentLevel(this.plan.study, a),
        participantId: j.participantId ?? null,
        repetition: j.repetition,
        runtime: runtimeFor(this.plan.study, a),
        status: j.inheritedFrom ? "reused" : done ? "done" : mine.at(-1)?.error === STOPPED ? "stopped" : mine.length ? "failed" : "not-started",
        attempts: mine.length,
        simulated: false,
        toolCalls: 0,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
        warning: null,
        lastTool: null,
        screenshot: null,
        error: done ? null : (mine.at(-1)?.error ?? null),
        startedAt: null,
        endedAt: null,
      });
    }
    if (existsSync(join(this.dir, "results")))
      for (const f of await readdir(join(this.dir, "results"))) {
        const run = JSON.parse(await readFile(join(this.dir, "results", f), "utf8")) as RunResult;
        const s = this.jobs.get(run.jobId);
        if (!s) continue;
        s.simulated = run.execution.synthetic;
        s.toolCalls = run.execution.toolCalls;
        if (!run.execution.synthetic) {
          s.tokensIn = totalInput(run.execution);
          s.tokensOut = run.execution.outputTokens;
          s.warning = budgetWarning(s.tokensIn === null ? null : s.tokensIn + (s.tokensOut ?? 0), this.agent(s.agentId).maxTokens);
        }
      }
    // A failed or stopped attempt that counts last: its usage from the receipt (cost unknown when it ended early).
    for (const s of this.jobs.values()) {
      const last = receipts.filter((r) => r.jobId === s.jobId).at(-1) as (CampaignReceipt & { usage: Partial<FullUsage> }) | undefined;
      if (s.status !== "failed" && s.status !== "stopped") continue;
      const u = last?.usage;
      if (!u || u.outputTokens == null) continue;
      s.tokensIn = totalInput({ inputTokens: u.inputTokens ?? null, cacheReadTokens: u.cacheReadTokens ?? null, cacheWriteTokens: u.cacheWriteTokens ?? null });
      s.tokensOut = u.outputTokens;
      s.costUsd = u.costUsd ?? null;
    }
    // Cost of the attempt that counts, from its execution manifest.
    for (const r of receipts)
      if (r.status === "completed" && r.executionManifest?.path.endsWith("execution-manifest.json")) {
        const s = this.jobs.get(r.jobId);
        if (!s || s.costUsd !== null) continue;
        try {
          const m = JSON.parse(await readFile(join(this.dir, r.executionManifest.path), "utf8")) as { costUsd?: number | null };
          s.costUsd = typeof m.costUsd === "number" ? m.costUsd : null;
        } catch {
          // manifest not here
        }
      }
    // Reused sessions show the tokens and cost of the run they reuse (from the campaign it ran in).
    for (const [jobId, usage] of await reusedUsage(this.workspaceId, this.campaign)) if (this.jobs.has(jobId)) Object.assign(this.jobs.get(jobId)!, usage);
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
      counts,
      jobs,
    };
  }
  private emit(e: Omit<ExecutorEvent, "t">) {
    const event = { t: Date.now(), ...e };
    this.listeners.forEach((l) => l(event));
    void mkdir(this.dir, { recursive: true }).then(() =>
      appendFile(join(this.dir, "events.jsonl"), JSON.stringify({ ...event, job: undefined }) + "\n"),
    );
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
          const m = JSON.parse(await readFile(join(runDir(this.workspaceId, c.id), r.executionManifest!.path), "utf8")) as { costUsd?: number | null };
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
    const byRuntime = new Map<string, Set<string>>();
    for (const id of jobIds) {
      const j = this.jobs.get(id);
      if (!j) continue;
      // A source without a file blocks the configuration (never substitute its description).
      for (const m of missingSources(wsDir, study, this.manifest, this.agent(j.agentId).sourceIds))
        byRuntime.set(m.message, (byRuntime.get(m.message) ?? new Set()).add(this.agent(j.agentId).label));
      // A source that changed since the freeze would give the agent other knowledge than the campaign froze.
      for (const m of changed.filter((x) => this.agent(j.agentId).sourceIds.includes(x.id)))
        byRuntime.set(m.message, (byRuntime.get(m.message) ?? new Set()).add(this.agent(j.agentId).label));
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
    this.emit({ type: "state", text: "Paused: running sessions finish, no new ones start." });
    return this.snapshot();
  }
  resume() {
    if (!this.queue.length)
      this.queue = [...this.jobs.values()].filter((j) => j.status === "queued" || j.status === "stopped").map((j) => j.jobId);
    this.paused = false;
    this.emit({ type: "state" });
    void this.pump();
    return this.snapshot();
  }
  /**
   * Stop everything: waiting sessions go back to "not started"; running ones (real and simulated)
   * end at once as "stopped" and can be run again right away. A stopped real session still
   * records its tokens; its cost is unknown, since Claude Code reports it only at the end.
   */
  stop() {
    this.paused = true;
    for (const id of this.queue) if (this.jobs.get(id)?.status === "queued") this.update(id, { status: "not-started" });
    this.queue = [];
    for (const [id, proc] of this.running) {
      const handle = this.handles.get(id);
      if (handle) handle.stopped = true;
      proc?.kill("SIGTERM");
      this.update(id, { status: "stopped", error: STOPPED, endedAt: new Date().toISOString(), lastTool: null });
    }
    this.running.clear();
    this.handles.clear();
    this.emit({ type: "state", text: "Stopped." });
    return this.snapshot();
  }
  private async pump() {
    const settings = await readSettings();
    // Simulated sessions call no model and no app, so they are not held to the real-session limit.
    const limit = this.mode === "agent" ? settings.concurrency : Math.max(settings.concurrency, 8);
    // Real sessions also respect each runtime's own limit (one Unreal/Unity editor = one session at a time).
    const busy = (runtime: string) => [...this.running.keys()].filter((r) => this.jobs.get(r)?.runtime === runtime).length;
    const fits = (id: string) => this.mode !== "agent" || busy(this.jobs.get(id)!.runtime) < runtimeLimits(settings, this.jobs.get(id)!.runtime).maxParallel;
    while (!this.paused && this.queue.length && this.running.size < limit) {
      const next = this.queue.findIndex(fits);
      if (next < 0) break; // the rest wait for their runtime; pump() runs again when a session ends
      const [id] = this.queue.splice(next, 1);
      const handle: RunHandle = { stopped: false };
      this.running.set(id, null);
      this.handles.set(id, handle);
      const run = this.mode === "agent" ? this.runAgent(id, settings, handle) : this.simulate(id, handle);
      void run
        .catch((e) => {
          if (!handle.stopped) this.update(id, { status: "failed", error: (e as Error).message });
        })
        .finally(() => {
          // A stopped run was already taken out; a rerun of the same session may hold the slot now.
          if (this.handles.get(id) === handle) {
            this.running.delete(id);
            this.handles.delete(id);
          }
          if (!this.queue.length && !this.running.size && !this.paused) {
            this.paused = true;
            this.emit({ type: "state", text: "Queue finished." });
          }
          void this.pump();
        });
    }
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
    await appendFile(join(this.dir, "receipts.jsonl"), JSON.stringify(full) + "\n");
    void attempt;
  }
  private planJob(jobId: string) {
    return this.plan.jobs.find((j) => j.id === jobId)!;
  }

  // ---------- simulated execution ----------
  private async simulate(jobId: string, handle: RunHandle) {
    const job = this.planJob(jobId);
    const state = this.jobs.get(jobId)!;
    const attempt = state.attempts + 1;
    const a = this.agent(job.agentId);
    const jobDir = join(this.dir, "jobs", jobId, `a${attempt}`);
    await mkdir(jobDir, { recursive: true });
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
    const state = this.jobs.get(jobId)!;
    const attempt = state.attempts + 1;
    const jobDir = join(this.dir, "jobs", jobId, `a${attempt}`);
    const cwd = join(jobDir, "session");
    await mkdir(cwd, { recursive: true });
    // The study as this campaign froze it: its sources, fields and participants. The workspace may
    // have changed since; only where the files live comes from it (workspace.json).
    const { dir: wsDir } = await readStudyFolder(this.workspaceId);
    const study = this.plan.study;
    const changed = (await changedSources(this.workspaceId, this.campaign, this.manifest)).filter((x) => a.sourceIds.includes(x.id));
    requireThat(changed.length === 0, changed.map((x) => x.message).join(" "));
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
    const injected: { sourceId: string; title: string; content: string }[] = [];
    for (const id of a.sourceIds) {
      const kind = kindOf(id);
      const path = src(id);
      if (kind === "brief" || kind === "evidence")
        injected.push({ sourceId: id, title: kind === "brief" ? "Study brief" : `Knowledge: ${labelOf(id)}`, content: await readFile(path!, "utf8") });
      else if (kind === "project") {
        // The same files list_files and read_file give: nothing hidden from agents is named.
        const files = (await agentFileList(path!)).join("\n");
        injected.push({ sourceId: id, title: "Project files you can open with read_file", content: files });
      } else if (kind === "demographics")
        injected.push({ sourceId: id, title: `Participant background: ${labelOf(id)} (allowed fields only)`, content: await demographics(path, study.sources.find((s) => s.id === id)!.fields ?? [], job.participantId, study.participants.map((p) => p.id)) });
      else if (kind === "trajectory")
        injected.push({ sourceId: id, title: `This participant's recorded movement: ${labelOf(id)} (allowed fields only)`, content: await trajectory(path, job.participantId, study.sources.find((s) => s.id === id)!.fields ?? []) });
    }
    const inputs = a.inputs?.length ? describeInputs(await readHuman(this.workspaceId), study, a, job) : null;
    const designs = (job.participantId ? study.participants.find((p) => p.id === job.participantId)!.conditionOrder : study.conditions.map((c) => c.id)).map((id) => ({
      id,
      label: study.conditions.find((c) => c.id === id)!.label,
    }));
    const runtime = runtimeFor(study, a);
    const caseOf = (design: string, kind: string) => {
      const phase = study.phases.find((p) => p.kind === kind);
      const c = phase && study.cases.find((x) => x.conditionId === design && x.phaseId === phase.id);
      return c ? { caseId: c.id, phaseId: phase!.id } : null;
    };
    const ordered = a.tools.includes("xr-interact")
      ? [...new Set(protocol.requiredCaseIds.map((id) => study.cases.find((c) => c.id === id)!.conditionId))]
      : designs.map((d) => d.id);
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify(
        {
          jobId,
          budget: a.maxToolCalls,
          // Token budget: the runtimes read <job>/usage.json and refuse calls at 90% of it.
          tokenBudget: a.maxTokens ?? null,
          projectDir: a.tools.includes("read-files") ? a.sourceIds.map(src).find((p, i) => kindOf(a.sourceIds[i]) === "project" && p) ?? null : null,
          participantId: job.participantId ?? null,
          designs,
          targets: study.outcomes
            .filter((o) => targets.includes(o.id))
            .map((o) => ({ id: o.id, label: o.label, unit: o.unit, scale: o.scale, aggregation: o.aggregation, ...(o.components ? { components: o.components } : {}) })),
          // Every app runtime (built in or external) gets the same description of the session to play.
          app: a.tools.includes("xr-interact")
            ? {
                runtime,
                observation: a.observation,
                trace: join(jobDir, "trace.jsonl"),
                screenshots: join(jobDir, "screenshots"),
                designs: ordered.map((id) => ({ id, label: study.conditions.find((c) => c.id === id)!.label, practice: caseOf(id, "practice"), main: caseOf(id, "main") })),
                cases: protocol.requiredCaseIds.map((id) => {
                  const c = study.cases.find((x) => x.id === id)!;
                  return { caseId: c.id, conditionId: c.conditionId, phaseId: c.phaseId, requiredActions: c.requiredActions };
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
    const servers: Record<string, unknown> = { study: { type: "stdio", command: process.execPath, args: [studyServer, jobDir] } };
    if (runtime === "webxr") servers.webxr = { type: "stdio", command: process.execPath, args: [webxrServer, jobDir] };
    else if (runtime !== "none") {
      const r = settings.runtimes[runtime];
      const vars: Record<string, string> = { jobDir, jobFile: join(jobDir, "job.json"), trace: join(jobDir, "trace.jsonl") };
      // Claude Code starts the server in the session folder, so a relative path from Settings
      // (e.g. examples/selection/runtime/bridge.py) is resolved against the repository here.
      const fromRepo = (x: string) => (!isAbsolute(x) && /[\\/]/.test(x) && existsSync(resolve(repoRoot, x)) ? resolve(repoRoot, x) : x);
      servers[runtime] = {
        type: "stdio",
        command: fromRepo(r.command!),
        args: (r.args ?? []).map((x) => fromRepo(x.replace(/\{(jobDir|jobFile|trace)\}/g, (_, k: string) => vars[k]))),
        env: { XR_STUDY_JOB_DIR: vars.jobDir, XR_STUDY_JOB_FILE: vars.jobFile, XR_STUDY_TRACE: vars.trace },
      };
    }
    await writeFile(join(jobDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
    const system = [
      "You are an AI agent forecasting the results of a completed XR user study. You have not seen any participant's answers and must not try to obtain them.",
      "Use only the tools provided. Your elapsed time, clicks and errors are not the participants' times or errors; predict what the participants did and reported.",
      "Finish by calling submit_forecast exactly once with one value for every design × outcome listed (named items for composite outcomes), plus your uncertainty and a short reasoning. Then stop.",
      ...(a.tools.includes("xr-interact") ? [playInstructions(runtime, ordered, study, protocol.requiredCaseIds, settings.runtimes[runtime]?.instructions)] : []),
    ].join("\n");
    const prompt = [
      `# Task\n${JSON.stringify(
        {
          study: (packet.task as { title?: string }).title,
          researchQuestion: (packet.task as { researchQuestion?: string }).researchQuestion,
          level: agentLevel(study, a),
          ...(job.participantId ? { participant: (packet.task as { orderContext?: unknown }).orderContext } : { cohort: (packet.task as { orderContext?: unknown }).orderContext }),
          designs,
          phases: study.phases,
          predict: study.outcomes.filter((o) => targets.includes(o.id)).map((o) => ({ outcome: o.id, label: o.label, domain: o.domain, unit: o.unit, scale: o.scale, items: o.components, description: o.description })),
        },
        null,
        2,
      )}`,
      ...injected.map((s) => `# ${s.title}\n${s.content}`),
      ...(inputs ? [`# Measured data you may use as predictors\n${inputs}`] : []),
      `# What to return\n${a.forecastInstruction}\n${agentLevel(study, a) === "individual" ? `Predict for participant ${job.participantId} only.` : "Predict the group of participants as a whole (population means; mean rank for rankings)."}`,
    ].join("\n\n");
    await writeFile(join(jobDir, "prompt.md"), `## System\n${system}\n\n## Prompt\n${prompt}\n`);
    const sourceEvents: TraceEvent[] = injected.map((s) => ({ type: "source", sourceId: s.sourceId, delivery: "injected", sha256: sha(s.content) }));

    const model = a.model;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      // Each API message's final usage (message_delta), so live token counts and the budget follow the session.
      "--include-partial-messages",
      "--model",
      model.model,
      ...effortArgs(model.reasoning),
      "--system-prompt",
      system,
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
    const proc = spawn(claude.command, [...claude.prefix, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    this.running.set(jobId, proc);
    const box: { result: Record<string, any> | null } = { result: null };
    let sessionId = "",
      actualModel = "",
      cliVersion = "",
      stderr = "",
      buf = "",
      tools = 0;
    const { timeoutMinutes } = runtimeLimits(settings, runtime);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMinutes * 60_000);
    // Token use so far, per API message (see UsageMeter), written to usage.json for the runtimes:
    // `submitNow` asks them to refuse further tools. A session far over budget is stopped, but never
    // once its forecast was accepted (the closing turn then only ends the session).
    const forecastPath = join(jobDir, "forecast.json");
    const meter = new UsageMeter();
    let overBudget = false;
    let atForecast: number | null = null;
    const writeUsage = async () => {
      const t = meter.totals();
      await writeFile(
        join(jobDir, "usage.json"),
        JSON.stringify({ tokens: t.total, input: t.input, output: t.output, uncachedInput: t.uncached, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead, lastTurnInput: t.lastTurnInput, budget: a.maxTokens ?? null, submitNow: atForecast === null && submitNow(a.maxTokens, t.total, t.lastTurnInput), tokensAtSubmit: atForecast }),
      );
      return t;
    };
    const trackUsage = async (m: Record<string, any>) => {
      if (!meter.add(m)) return;
      const t = await writeUsage();
      if (mine()) this.update(jobId, { tokensIn: t.input, tokensOut: t.output });
      if (a.maxTokens && t.total > a.maxTokens * 1.5 && !overBudget && atForecast === null) {
        overBudget = true;
        this.emit({ type: "log", jobId, text: `Stopped: ${fmt(t.total)} tokens, far over the token budget of ${fmt(a.maxTokens)}.` });
        proc.kill("SIGTERM");
      }
    };
    /**
     * The moment the study server accepted the forecast: the tokens up to here are what the budget
     * is checked against. Noted when the next turn begins (the tool result or a new message), so the
     * message that submitted it is counted in full and the closing turn is not.
     */
    const noteForecast = async () => {
      if (atForecast !== null || !existsSync(forecastPath)) return;
      atForecast = meter.totals().total;
      await writeUsage();
    };
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
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
      if (meter.startsTurn(m)) await noteForecast();
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
      } else if (m.type === "stream_event") await trackUsage(m);
      else if (m.type === "assistant") {
        await trackUsage(m);
        for (const c of m.message?.content ?? []) {
          if (c.type === "tool_use") {
            const name = String(c.name).replace(/^mcp__/, "").replace("__", ".");
            // Tool calls are what the agent does before forecasting: the submission is not counted (as in calls.log).
            if (!/submit_forecast$/.test(name)) tools++;
            const shots = existsSync(join(jobDir, "screenshots")) ? (await readdir(join(jobDir, "screenshots"))).sort() : [];
            if (mine())
              this.update(jobId, {
                toolCalls: tools,
                lastTool: `${name} ${JSON.stringify(c.input ?? {}).slice(0, 80)}`,
                screenshot: shots.length ? `jobs/${jobId}/a${attempt}/screenshots/${shots.at(-1)}` : null,
              });
          } else if (c.type === "text" && c.text?.trim()) this.emit({ type: "log", jobId, text: String(c.text).slice(0, 400) });
        }
      } else if (m.type === "result") box.result = m;
    };
    // Lines are handled one after another, and all of them before the session's end is read.
    let lines: Promise<void> = Promise.resolve();
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines = lines.then(() => handleLine(line)).catch(() => undefined);
      }
    });
    const code = await new Promise<number | null>((ok) => proc.on("close", ok));
    clearTimeout(timer);
    if (buf.trim()) lines = lines.then(() => handleLine(buf)).catch(() => undefined);
    await lines;
    await noteForecast();
    const traceLines = existsSync(join(jobDir, "trace.jsonl")) ? (await readFile(join(jobDir, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const trace: TraceEvent[] = [...sourceEvents, ...traceLines.filter((l) => l.event).map((l) => l.event as TraceEvent)];
    // The runtime's own report of what it is (bridge contract); the study's recipe only as a fallback.
    const reported = [...trace].reverse().find((e): e is Extract<TraceEvent, { type: "runtime" }> => e.type === "runtime");
    if (a.tools.includes("xr-interact") && !reported && mine())
      this.emit({ type: "log", jobId, text: "The runtime did not report itself (no 'runtime' trace event); the audit records this as a deviation." });
    const result = box.result;
    // Claude Code's own totals; a session that ended early (stopped, killed, timed out) has only the live count.
    const live = meter.totals();
    const usage: Record<string, any> = result?.usage ?? (meter.modelRan ? { input_tokens: live.uncached, cache_read_input_tokens: live.cacheRead, cache_creation_input_tokens: live.cacheWrite, output_tokens: live.output } : {});
    const costUsd = typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
    const forecast = existsSync(forecastPath) ? JSON.parse(await readFile(forecastPath, "utf8")) : null;
    // The tool budget covers what the agent does before forecasting; submitting the forecast is not
    // part of it (a configuration without tools has budget 0 and still submits).
    const calls = existsSync(join(jobDir, "calls.log")) ? (await readFile(join(jobDir, "calls.log"), "utf8")).trim().split("\n").filter((l) => l && l !== "submit_forecast").length : 0;
    const ok = !!forecast;
    const unknownModel = /unrecognized_model/i.test(`${stderr} ${JSON.stringify(result ?? "")}`);
    const error = ok
      ? null
      : handle.stopped
      ? STOPPED
      : unknownModel
      ? `Claude Code does not know the model "${model.model}". Check the model ID on Agent configurations.`
      : overBudget
      ? `Stopped: the session used more than 1.5 × its token budget of ${fmt(a.maxTokens!)} tokens.`
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
        engine: reported?.engine ?? study.runtime.engine,
        backend: reported?.backend ?? study.runtime.backend,
        observation: a.tools.includes("xr-interact") ? (reported?.observation ?? a.observation) : "none",
        deviceProfile: reported?.deviceProfile ?? study.runtime.deviceProfile,
        provider: model.provider,
        model: model.model,
        reasoning: model.reasoning,
        versions: {
          engine: reported?.engineVersion ? `${reported.engine} ${reported.engineVersion}` : runtime === "webxr" ? "Chrome (headless)" : runtime,
          runtime: runtime === "none" ? "none" : `${runtime}-mcp`,
          connector: "xr-study-sim executor 0.4",
          provider: `Claude Code ${cliVersion || "CLI"}`,
        },
        startedAt: startedAt.toISOString(),
        capabilities: reported?.capabilities ?? (runtime === "webxr" ? ["screenshot", "pointer-select", "phase-events", "quality-lock"] : runtime === "none" ? [] : settings.runtimes[runtime]?.capabilities ?? []),
        toolCalls: calls,
        outputTokens: Number(usage.output_tokens ?? 0),
        inputTokens: usage.input_tokens ?? null,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
        reasoningTokens: Number.isSafeInteger(usage.output_tokens_details?.thinking_tokens) ? usage.output_tokens_details.thinking_tokens : null,
        inferenceWallTimeMs: Date.now() - startedAt.getTime(),
        simulationTimeMs: 0,
        humanTimeEstimateMs: null,
        technicalRetries: 0,
        // The audit checks the token budget up to here; the closing turn after acceptance is reported apart.
        ...(atForecast !== null ? { tokensAtSubmit: atForecast } : {}),
      },
      measurements: forecast?.measurements ?? [],
      trace,
    };
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
        actualModel: meter.modelRan || ok ? actualModel : null,
        cliVersion,
        runtime,
        runtimeCommand: runtime === "webxr" || runtime === "none" ? "built in" : servers[runtime],
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
    const effective = !meter.modelRan && !ok ? null : !actualModel || actualModel === requested.model || actualModel.startsWith(requested.model) ? { ...requested } : { ...requested, model: actualModel };
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
      warning: budgetWarning(total, a.maxTokens, atForecast),
      error,
    });
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
  return backgroundText(await readFile(path, "utf8"), fields, participantId, people);
}
/**
 * A participant's movement recordings, only the ID column and the declared fields: from a CSV with
 * a participant column (that person's rows, with the header), or every file of a folder of
 * per-participant files named after the participant ID. Population jobs get none.
 */
export async function trajectory(path: string | null, participantId: string | undefined, fields: string[]): Promise<string> {
  if (!participantId) return "(movement recordings are per participant; none for population forecasts)";
  if (!path || !existsSync(path)) return "(no movement recordings declared)";
  return trajectoryText(path, participantId, fields);
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
export const _test = { hash };
