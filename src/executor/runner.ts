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
import { syntheticResults } from "../core/example.js";
import { agentLevel, agentTargets, hash, jobPacket, protocolForJob } from "../core/planner.js";
import type { AgentProtocol, HumanData, Job, Plan, RunResult, Study, TraceEvent } from "../core/types.js";
import { requireThat } from "../core/validation.js";
import { claudeCommand, readSettings, runtimeLimits, type Settings } from "../settings.js";
import { listCampaigns, missingSources, readCampaign, readHuman, readReceipts, readWorkspace, repoRoot, runDir, sourceLocation, workspaceDir, type WorkspaceManifest } from "../workspace.js";
import { runtimeFor, runtimeStatus } from "./runtimes.js";
import { compactStreamLine, ScreenshotIndex } from "./stream-log.js";
import { backgroundText, trajectoryText } from "../participant-knowledge.js";

/** not-started: never asked to run; queued: asked to run and waiting for a free slot. */
export type JobStatus = "not-started" | "queued" | "running" | "done" | "failed" | "stopped" | "reused";
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

/**
 * Claude Code's --effort for a configuration's reasoning setting: "default" adds nothing;
 * "high" or "effort=high" (low, medium, high, xhigh, max) sets it. Anything else is refused
 * rather than silently ignored.
 */
export function effortArgs(reasoning: string): string[] {
  const r = String(reasoning ?? "").trim().toLowerCase();
  if (!r || r === "default") return [];
  const m = /^(?:effort\s*[=:]\s*)?(low|medium|high|xhigh|max)$/.exec(r);
  if (!m) throw new Error(`Reasoning setting "${reasoning}" is not understood by Claude Code. Use default, or effort=low|medium|high|xhigh|max.`);
  return ["--effort", m[1]];
}

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
    const { manifest } = await readWorkspace(workspaceId);
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
        status: j.inheritedFrom ? "reused" : done ? "done" : mine.length ? "failed" : "not-started",
        attempts: mine.length,
        simulated: false,
        toolCalls: 0,
        tokensIn: null,
        tokensOut: null,
        costUsd: null,
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
        if (!run.execution.synthetic) {
          s.tokensIn = totalInput(run.execution);
          s.tokensOut = run.execution.outputTokens;
        }
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

  /**
   * Cost per session from earlier real, completed sessions of the same configuration and model
   * in any campaign of this study (execution-manifest.json → costUsd). Null when none exist yet.
   */
  async estimate(jobIds: string[]) {
    const wanted = new Map<string, number>();
    for (const id of jobIds) {
      const j = this.jobs.get(id);
      if (j) wanted.set(j.agentId, (wanted.get(j.agentId) ?? 0) + 1);
    }
    const costs = new Map<string, number[]>();
    for (const c of await listCampaigns(this.workspaceId)) {
      const receipts = (await readReceipts(this.workspaceId, [c.id])).filter((r) => r.status === "completed" && r.executionManifest);
      for (const r of receipts) {
        const job = c.jobs.find((x) => x.id === r.jobId);
        if (!job || !wanted.has(job.conditionId)) continue;
        if (conditionModel(c, job.conditionId).model !== conditionModel(this.campaign, job.conditionId).model) continue;
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
    const { dir: wsDir, study } = await readWorkspace(this.workspaceId);
    const byRuntime = new Map<string, Set<string>>();
    for (const id of jobIds) {
      const j = this.jobs.get(id)!;
      // A source without a file blocks the configuration (never substitute its description).
      for (const m of missingSources(wsDir, study, this.manifest, this.agent(j.agentId).sourceIds))
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
  async start(mode: "agent" | "simulate", jobIds?: string[]) {
    const candidates = (jobIds ?? [...this.jobs.keys()]).filter((id) => {
      const s = this.jobs.get(id)?.status;
      return s === "not-started" || s === "queued" || s === "failed" || s === "stopped";
    });
    requireThat(candidates.length > 0, "Nothing to run: every selected job is finished or reused.");
    if (mode === "agent") {
      const blocked = await this.blockers(candidates);
      requireThat(
        blocked.length === 0,
        blocked.map((b) => `${b.message} Needed by: ${b.configs.join(", ")}.`).join(" "),
      );
    }
    this.mode = mode;
    this.queue = candidates.filter((id) => !this.running.has(id));
    this.queue.forEach((id) => this.update(id, { status: "queued", error: null }));
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
  stop() {
    this.paused = true;
    // Waiting sessions go back to "not started": they were never run.
    for (const id of this.queue) if (this.jobs.get(id)?.status === "queued") this.update(id, { status: "not-started" });
    this.queue = [];
    for (const [id, proc] of this.running) {
      proc?.kill("SIGTERM");
      this.update(id, { status: "stopped", error: "Stopped by you." });
    }
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
      this.running.set(id, null);
      const run = this.mode === "agent" ? this.runAgent(id, settings) : this.simulate(id);
      void run
        .catch((e) => this.update(id, { status: "failed", error: (e as Error).message }))
        .finally(() => {
          this.running.delete(id);
          if (!this.queue.length && !this.running.size) {
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
  private async simulate(jobId: string) {
    const job = this.planJob(jobId);
    const state = this.jobs.get(jobId)!;
    const attempt = state.attempts + 1;
    const a = this.agent(job.agentId);
    const jobDir = join(this.dir, "jobs", jobId, `a${attempt}`);
    await mkdir(jobDir, { recursive: true });
    this.update(jobId, { status: "running", attempts: attempt, simulated: true, startedAt: new Date().toISOString(), toolCalls: 0, lastTool: null });
    const steps = a.tools.includes("xr-interact")
      ? ["open_design", "look", "screenshot", "select", "screenshot", "select", "submit_forecast"]
      : a.tools.includes("read-files")
      ? ["list_files", "read_file", "read_file", "submit_forecast"]
      : ["submit_forecast"];
    for (const [i, step] of steps.entries()) {
      await wait(120 + Math.round(Math.random() * 180));
      if (!this.running.has(jobId)) return;
      this.update(jobId, { toolCalls: i + 1, lastTool: `${step} (simulated)` });
    }
    const sub: Plan = { ...this.plan, jobs: [job], frozenAt: this.campaign.createdAt };
    const run = syntheticResults(sub, false, parseInt(sha(jobId + attempt).slice(0, 8), 16)).runs[0];
    run.sessionId = `${this.campaign.jobs.find((j) => j.id === jobId)!.sessionKey}-a${attempt}`;
    run.execution.startedAt = new Date().toISOString();
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
    this.update(jobId, { status: "done", endedAt: new Date().toISOString(), tokensIn: null, tokensOut: null, costUsd: null });
  }

  // ---------- real execution: headless Claude Code ----------
  private async runAgent(jobId: string, settings: Settings) {
    const job = this.planJob(jobId);
    const a = this.agent(job.agentId);
    const state = this.jobs.get(jobId)!;
    const attempt = state.attempts + 1;
    const jobDir = join(this.dir, "jobs", jobId, `a${attempt}`);
    const cwd = join(jobDir, "session");
    await mkdir(cwd, { recursive: true });
    const { dir: wsDir, study } = await readWorkspace(this.workspaceId);
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
        const files = (await listTree(path!)).join("\n");
        injected.push({ sourceId: id, title: "Project files you can open with read_file", content: files });
      } else if (kind === "demographics")
        injected.push({ sourceId: id, title: `Participant background: ${labelOf(id)} (allowed fields only)`, content: await demographics(path, study.sources.find((s) => s.id === id)!.fields ?? [], job.participantId) });
      else if (kind === "trajectory")
        injected.push({ sourceId: id, title: `This participant's recorded movement: ${labelOf(id)}`, content: await trajectory(path, job.participantId) });
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
    const startedAt = new Date();
    this.update(jobId, { status: "running", attempts: attempt, simulated: false, startedAt: startedAt.toISOString(), toolCalls: 0, lastTool: "starting session", error: null });
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
    // Token use so far: every API response in the stream carries its usage (once per message id).
    // Written to usage.json for the runtimes; a session far over budget is stopped.
    // Live counts for the job table: input (uncached + cache writes + cache reads) and output.
    const perMessage = new Map<string, { input: number; output: number }>();
    let overBudget = false;
    const trackUsage = async (m: Record<string, any>) => {
      const u = m.message?.usage;
      if (!u) return;
      const input = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"].reduce((s, k) => s + (Number(u[k]) || 0), 0);
      perMessage.set(String(m.message?.id ?? perMessage.size), { input, output: Number(u.output_tokens) || 0 });
      const live = [...perMessage.values()].reduce((s, x) => ({ input: s.input + x.input, output: s.output + x.output }), { input: 0, output: 0 });
      const used = live.input + live.output;
      await writeFile(join(jobDir, "usage.json"), JSON.stringify({ tokens: used, input: live.input, output: live.output, budget: a.maxTokens ?? null }));
      this.update(jobId, { tokensIn: live.input, tokensOut: live.output });
      if (a.maxTokens && used > a.maxTokens * 1.5 && !overBudget) {
        overBudget = true;
        this.emit({ type: "log", jobId, text: `Stopped: ${used} tokens, far over the token budget of ${a.maxTokens}.` });
        proc.kill("SIGTERM");
      }
    };
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
    const shots = new ScreenshotIndex(join(jobDir, "screenshots"));
    proc.stdout.on("data", async (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        await appendFile(join(jobDir, "stream.jsonl"), (await compactStreamLine(line, shots)) + "\n");
        let m: Record<string, any>;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
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
        } else if (m.type === "assistant") {
          await trackUsage(m);
          for (const c of m.message?.content ?? []) {
            if (c.type === "tool_use") {
              tools++;
              const name = String(c.name).replace(/^mcp__/, "").replace("__", ".");
              const shots = existsSync(join(jobDir, "screenshots")) ? (await readdir(join(jobDir, "screenshots"))).sort() : [];
              this.update(jobId, {
                toolCalls: tools,
                lastTool: `${name} ${JSON.stringify(c.input ?? {}).slice(0, 80)}`,
                screenshot: shots.length ? `jobs/${jobId}/a${attempt}/screenshots/${shots.at(-1)}` : null,
              });
            } else if (c.type === "text" && c.text?.trim()) this.emit({ type: "log", jobId, text: String(c.text).slice(0, 400) });
          }
        } else if (m.type === "result") box.result = m;
      }
    });
    const code = await new Promise<number | null>((ok) => proc.on("close", ok));
    clearTimeout(timer);
    if (state.status === "stopped") return;
    const forecastPath = join(jobDir, "forecast.json");
    const traceLines = existsSync(join(jobDir, "trace.jsonl")) ? (await readFile(join(jobDir, "trace.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    const trace: TraceEvent[] = [...sourceEvents, ...traceLines.filter((l) => l.event).map((l) => l.event as TraceEvent)];
    // The runtime's own report of what it is (bridge contract); the study's recipe only as a fallback.
    const reported = [...trace].reverse().find((e): e is Extract<TraceEvent, { type: "runtime" }> => e.type === "runtime");
    if (a.tools.includes("xr-interact") && !reported)
      this.emit({ type: "log", jobId, text: "The runtime did not report itself (no 'runtime' trace event); the audit records this as a deviation." });
    const result = box.result;
    const usage = result?.usage ?? {};
    const forecast = existsSync(forecastPath) ? JSON.parse(await readFile(forecastPath, "utf8")) : null;
    // The tool budget covers what the agent does before forecasting; submitting the forecast is not
    // part of it (a configuration without tools has budget 0 and still submits).
    const calls = existsSync(join(jobDir, "calls.log")) ? (await readFile(join(jobDir, "calls.log"), "utf8")).trim().split("\n").filter((l) => l && l !== "submit_forecast").length : 0;
    const ok = !!forecast;
    const error = ok
      ? null
      : overBudget
      ? `Stopped: the session used more than 1.5 × its token budget of ${a.maxTokens} tokens.`
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
      },
      measurements: forecast?.measurements ?? [],
      trace,
    };
    const manifestBody = JSON.stringify({ requestedModel: model, effort: effortArgs(model.reasoning)[1] ?? "default", actualModel, cliVersion, runtime, runtimeCommand: runtime === "webxr" || runtime === "none" ? "built in" : servers[runtime], mcp: Object.keys(servers), costUsd: result?.total_cost_usd ?? null, turns: result?.num_turns ?? null, exitCode: code }, null, 2);
    await writeFile(join(jobDir, "execution-manifest.json"), manifestBody);
    const requested = conditionModel(this.campaign, job.agentId);
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
        actualModel: !actualModel || actualModel === requested.model || actualModel.startsWith(requested.model) ? { ...requested } : { ...requested, model: actualModel },
        sessionId: run.sessionId,
        freshSession: true,
        freshPIE: true,
        freshScreenshots: true,
        assetHashes: {},
        executionManifest: { path: `jobs/${jobId}/a${attempt}/execution-manifest.json`, sha256: sha(manifestBody) },
        usage: { inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null },
        ...(error ? { error } : {}),
      },
      jobDir,
    );
    this.update(jobId, {
      status: ok ? "done" : "failed",
      endedAt: new Date().toISOString(),
      // The session's final totals; if it ended without a result line, keep the live counts.
      tokensIn: totalInput({ inputTokens: usage.input_tokens ?? null, cacheReadTokens: usage.cache_read_input_tokens ?? null, cacheWriteTokens: usage.cache_creation_input_tokens ?? null }) ?? state.tokensIn,
      tokensOut: usage.output_tokens ?? state.tokensOut,
      costUsd: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null,
      error,
    });
  }
}

/** All input tokens of a session: uncached input plus cache writes and cache reads. */
function totalInput(e: { inputTokens: number | null; cacheReadTokens: number | null; cacheWriteTokens: number | null }): number | null {
  const parts = [e.inputTokens, e.cacheReadTokens, e.cacheWriteTokens].filter((x): x is number => typeof x === "number");
  return parts.length ? parts.reduce((s, x) => s + x, 0) : null;
}
async function listTree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listTree(root, rel)));
    else out.push(rel);
  }
  return out.slice(0, 500);
}
/** Allowed demographic fields: the person's row, or a cohort summary for population configs. */
async function demographics(path: string | null, fields: string[], participantId: string | undefined): Promise<string> {
  if (!path || !existsSync(path)) return "(no participant background file declared)";
  return backgroundText(await readFile(path, "utf8"), fields, participantId);
}
/**
 * A participant's movement recordings: a CSV with a participant column (that person's rows, with the header),
 * or a folder of per-participant files named after the participant ID. Population jobs get none.
 */
export async function trajectory(path: string | null, participantId: string | undefined): Promise<string> {
  if (!participantId) return "(movement recordings are per participant; none for population forecasts)";
  if (!path || !existsSync(path)) return "(no movement recordings declared)";
  return trajectoryText(path, participantId);
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
