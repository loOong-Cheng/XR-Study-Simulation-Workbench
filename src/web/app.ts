// XR Study Sim workbench: Planner (study, agent configs, freeze, continue) →
// Executor (runtimes, live runs, zip) → Analyzer (figures with significance).
// The page never requests human reference values while planning.
import type { AgentProtocol, Comparison, Domain, Study } from "../core/types.js";
import { agentVsHumanPlot, agreementPlot, correlationPlot, downloadPng, downloadSvg, humanPlot, trajectoryPlot } from "./plots.js";
import { clippedToScale, focusMark, focusTarget, markdownToHtml, money, plural, type FocusMark } from "./ui.js";

type Page = "home" | "study" | "evidence" | "configs" | "freeze" | "compare" | "executor" | "analyzer" | "continue" | "settings";
interface WorkspaceInfo { id: string; title: string; suite: string | null; description: string | null; synthetic: boolean; engine: string; hasAgents: boolean; hasHuman: boolean; campaigns: number }
interface CampaignInfo { id: string; digest: string; createdAt: string; parentDigest: string | null; parentId: string | null; label: string | null; note: string | null; jobs: number; reused: number; done: number; failed: number; notStarted: number; running?: number; dropped?: string[]; real: number; simulated: number; costUsd: number | null; models: Record<string, { provider: string; model: string; reasoning: string }>; configs?: { id: string; label: string; individual: boolean; runs: number }[]; designKey: string }
interface Attempt { attempt: number; status: string; error: string | null; toolCalls: number; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; cost: string | null; simulated: boolean | null; counts: boolean }
interface WorkspaceView {
  id: string; study: Study; agents: AgentProtocol[]; agentsSaved: boolean; comparisons: Comparison[];
  manifest: { title?: string; suite?: string; description?: string; app?: unknown; sources?: Record<string, string> };
  hasHuman: boolean; approval: { approved: boolean; current: boolean; approval: { approvedAt: string; note: string } | null };
  gets: Record<string, string[]>; runtimes: Record<string, string>; missingSources: Record<string, string[]>; sourceFiles?: Record<string, boolean>; campaigns: CampaignInfo[];
  /** The saved study and configurations disagree: what to fix (the study still opens). */
  problem: string | null;
  /** Planning warnings for the saved study, e.g. too few people for any significant difference. */
  studyWarnings?: string[];
  /** Fairness of what agents get (core/fairness.ts): the research question, stand-in recordings, models of compared configurations. */
  warnings?: string[];
  /** Per configuration: what it names that the saved study does not have, and why it does not fit. */
  problems?: ConfigProblem[];
  /** Required capabilities that the app or a runtime does not declare (those configurations cannot start as agents). */
  capabilityWarnings?: string[];
}
interface ConfigProblem { configId: string; label: string; unknownSources: string[]; unknownOutcomes: string[]; unknownCases: string[]; message: string | null }
interface Settings { assistant: { kind: string; model: string }; forecasting: { provider: string; model: string; reasoning: string }; runtimes: Record<string, { command?: string; args?: string[]; instructions?: string; capabilities?: string[]; timeoutMinutes?: number; maxParallel?: number; note?: string }>; chromePath: string; claudePath?: string; concurrency: number; jobTimeoutMinutes: number }
interface RuntimeStatus { id: string; label: string; available: boolean; builtIn: boolean; message: string }
interface JobState { jobId: string; agentId: string; label: string; level: string; participantId: string | null; repetition: number; runtime: string; status: string; attempts: number; simulated: boolean; noResult?: boolean; toolCalls: number; tokensIn: number | null; tokensOut: number | null; costUsd: number | null; warning: string | null; lastTool: string | null; screenshot: string | null; error: string | null }
interface Snapshot { campaignId: string; mode: string; paused: boolean; running: number; queued: number; waiting?: string | null; counts: Record<string, number>; jobs: JobState[] }
interface AnalysisView {
  campaignId: string; configs: { id: string; label: string; level: string; model: { model: string }; targets: string[] }[];
  outcomes: { id: string; label: string; domain: Domain; unit: string }[];
  summaries: { agentId: string; level?: string; domain: Domain; agreement: number | null; ci95: { low: number; high: number } | null; assigned: number; returned: number; real?: number; simulated?: number; scoreable: number; compliant: number }[];
  contrasts: { candidate: string; baseline: string; domain: Domain; difference: number | null; ci95: { low: number; high: number } | null; holmP: number | null; declared: string; status: string }[];
  design?: string; pairRule?: "means" | "significant";
  humanPairs?: HumanPairView[]; absoluteFit?: { agentId: string; outcomeId: string; conditionId: string; human: number; low: number; high: number; n: number; agent: number; error: number; inside: boolean; degenerate?: boolean; note?: string }[];
  significantOnly?: { summaries: AnalysisView["summaries"]; exclusions: string[]; humanPairs: HumanPairView[] } | null;
  audits: { jobId: string; issues: string[] }[]; assigned: number; progress?: { sessions: number; finished: number; failed: number; notStarted: number; reusedNeverRan?: number }; notes: string[]; exclusions: string[]; reused: number; synthetic: boolean;
}
interface HumanPairView { outcomeId: string; a: string; b: string; meanA: number; meanB: number; test: string; p: number | null; pHolm: number | null; significant: boolean; used: boolean }
let showSignificantOnly = false;
type View = "agreement" | "agent-vs-human" | "correlation" | "population-vs-individual" | "trajectories";

let page: Page = "home";
let workspaces: WorkspaceInfo[] = [];
let ws: WorkspaceView | null = null;
let study: Study | null = null;
let agents: AgentProtocol[] = [];
let saved = "";
let settings: Settings | null = null;
let runtimes: RuntimeStatus[] = [];
let showAllRuntimes = false;
interface EvidenceItem { id: string; label: string; description: string; path: string | null; problem: string | null; exists: boolean; bytes: number; sha256: string | null; preview: string; truncated: boolean; configs: string[]; check: LeakCheck | null }
let evidence: EvidenceItem[] | null = null;
/** The study brief (what every configuration gets); null when the study has no brief source yet. */
let brief: EvidenceItem | null = null;
/** Text of the brief while it is written or edited on Evidence & knowledge. */
let briefEdit: string | null = null;
/** A brief drafted by Understand study and taken with the draft; written to the study folder on Save. */
let briefDraft: string | null = null;
/** Outcome-blind check of a text agents get; `predictions` are its own sentences that predict measured outcomes (never human data). */
type LeakCheck = { participantIds: number; humanMeanMatches: number; checkedAgainstHuman: boolean; predictions?: string[] };
interface ParticipantItem { id: string; label: string; kind: string; description: string; fields: string[]; phases?: string[] | null; warnings?: string[]; path: string | null; exists: boolean; sha256: string | null; participants: number; problems: string[]; columns: { name: string; missing: string[] }[]; population: string | null; individual: { participantId: string; text: string } | null; notes: string; configs: string[] }
let participantKnowledge: ParticipantItem[] = [];
/** A new or replacement source, drafted on the server (by the assistant for documents) and reviewed here. */
interface KnowledgeDraft { kind: "general" | "participant"; via: "assistant" | "table" | "raw"; sourceId: string; label: string; description: string; path: string; text: string; columns: { name: string; missing: string[] }[] | null; problems: string[]; check: LeakCheck | null; notes: string; replaces?: string }
let knowledgeDraft: KnowledgeDraft | null = null;
/** Which knowledge card is being edited, and how. */
let knowledgeEdit: { id: string; mode: "rename" | "text" | "fields"; text?: string } | null = null;
let campaignId: string | null = null;
let snapshot: Snapshot | null = null;
const logs = new Map<string, string[]>();
let selectedJob: string | null = null;
let attemptsOf: { jobId: string; attempts: Attempt[] } | null = null;
let newLabel = "";
/** Sessions chosen to run (executor); empty = run every session not run yet. */
let chosen = new Set<string>();
let pickK = 1;
let pickConfigs = new Set<string>();
const canRun = (j: JobState) => ["not-started", "failed", "stopped"].includes(j.status);
const campaignOf = (id: string | null) => ws?.campaigns.find((c) => c.id === id) ?? null;
function campaignName(c: CampaignInfo | null) {
  if (!c) return "No campaign";
  return c.label ?? `Campaign ${c.id.slice(9, 17)}${c.parentId ? " (continuation)" : ""}`;
}
/** Which campaign this page shows, with a switcher. */
function campaignBar() {
  const c = campaignOf(campaignId);
  if (!ws || !c) return "";
  const options = ws.campaigns
    .map((x) => `<option value="${esc(x.id)}" ${x.id === c.id ? "selected" : ""}>${esc(campaignName(x))} · ${esc(new Date(x.createdAt).toLocaleString())}</option>`)
    .join("");
  return `<div class="campaign-bar"><label class="field">Campaign shown<select id="campaign-switch">${options}</select></label><p class="caption">Frozen ${esc(new Date(c.createdAt).toLocaleString())}${c.parentId ? ` · continues ${esc(campaignName(campaignOf(c.parentId)))}` : ""} · ${c.jobs} sessions${c.reused ? `, ${c.reused} reused` : ""} · ${c.done} done · ${c.failed} failed${c.running ? ` · ${c.running} running or waiting` : ""} · ${c.notStarted} not run yet${c.costUsd != null ? ` · ${money(c.costUsd)} so far` : ""}. Rename or compare campaigns on Freeze &amp; campaigns.</p></div>`;
}
const fmtTokens = (x: number | null) => (x == null ? "?" : x >= 10000 ? `${Math.round(x / 1000)}k` : String(x));
/** Runtimes the campaign shown (or, before freezing, the study) uses: e.g. "No app" and "Unreal" for suite 1. */
function usedRuntimes(): Set<string> {
  const used = new Set<string>(snapshot?.jobs.map((j) => j.runtime) ?? []);
  if (!used.size) agents.forEach((a) => used.add(a.runtime ?? ws!.runtimes[a.id] ?? "none"));
  return used;
}
/** How many reused sessions rest on simulated runs, and how many never ran, for the executor's header. */
function reusedNote(s: { jobs: JobState[] } | null | undefined): string {
  const reused = (s?.jobs ?? []).filter((j) => j.status === "reused");
  const sim = reused.filter((j) => j.simulated).length,
    none = reused.filter((j) => j.noResult).length;
  const parts = [sim ? `${sim} simulated` : "", none ? `<span class="warn">${none} never ran</span>` : ""].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}
/** A per-configuration sum row: sessions, real usage and cost so far. */
function configSum(list: JobState[]) {
  const real = list.filter((j) => (j.status === "done" || j.status === "failed") && !j.simulated);
  // Reused sessions count with the run they reuse (simulated or real); one that never ran is not done.
  const sim = list.filter((j) => j.simulated && (j.status === "done" || j.status === "reused")).length;
  const done = list.filter((j) => j.status === "done" || (j.status === "reused" && !j.noResult)).length;
  const sum = (f: (j: JobState) => number | null) => real.reduce((s, j) => s + (f(j) ?? 0), 0);
  const cost = real.some((j) => j.costUsd != null) ? sum((j) => j.costUsd) : null;
  // Reused runs were paid in the campaign they ran in: shown per row, not added to this campaign's cost.
  const reusedCost = list.filter((j) => j.status === "reused" && j.costUsd != null).reduce((s, j) => s + j.costUsd!, 0);
  return `<tr class="config-sum"><td></td><td colspan="3"><strong>${esc(list[0].label)}</strong> · ${done} of ${list.length} done${sim ? ` (${sim} simulated)` : ""}</td><td></td><td></td><td>${real.length ? `${fmtTokens(sum((j) => j.tokensIn))} / ${fmtTokens(sum((j) => j.tokensOut))}` : ""}</td><td>${cost != null ? `<strong>${money(cost)}</strong>` : ""}${reusedCost ? `<br><span class="small">reused: ${money(reusedCost)}, paid earlier</span>` : ""}</td></tr>`;
}
/**
 * What the agents of the campaign shown get, as links the researcher can read while sessions run.
 * From the campaign's frozen study, so later changes to the study (a deleted source) do not hide them.
 */
function studyInputs() {
  if (!ws || !campaignInputs || campaignInputs.campaignId !== campaignId || !campaignInputs.sources.length) return "";
  const link = (id: string) => `/api/workspace/source?id=${encodeURIComponent(ws!.id)}&source=${encodeURIComponent(id)}`;
  return `<div class="card inputs"><h2>What the agents get</h2><ul>${campaignInputs.sources
    .map(
      (src) =>
        `<li>${src.readable ? `<a href="${link(src.id)}" target="_blank" rel="noopener">${esc(src.label)}</a>` : esc(src.label)} <span class="small">${src.path ? `${esc(src.path)} · ` : ""}${esc(src.kind)} · ${src.configs} configuration(s)${src.removed ? " · deleted from the study after this campaign was frozen" : src.readable ? "" : " · no file on this machine"}</span></li>`,
    )
    .join("")}</ul></div>`;
}
/** One line saying what to do next with the campaign shown in the executor. */
function nextStep(): string {
  const s = snapshot;
  const c = campaignOf(campaignId);
  if (!s || !c) return "";
  const n = (k: string) => s.counts[k] ?? 0;
  const changed = agents.filter((a) => {
    const m = c.models[a.id];
    return m && (m.model !== a.model.model || m.provider !== a.model.provider || m.reasoning !== a.model.reasoning);
  });
  // A configuration a continuation dropped on purpose is not missing.
  const absent = agents.filter((a) => !c.models[a.id] && !c.dropped?.includes(a.id));
  const finished = n("done") + n("reused");
  let text: string;
  if (n("running") || n("queued")) text = `${n("running")} running, ${n("queued")} waiting. You can analyze the finished ones in the meantime (interim).`;
  else if (n("failed") + n("stopped")) text = `${n("failed") + n("stopped")} failed or stopped → <strong>Rerun failed</strong> (same campaign; each try is kept as an attempt).`;
  else if (n("not-started")) text = `${n("not-started")} sessions not run yet → <strong>Start</strong>, or choose a few for a pilot.`;
  else text = `Complete: all ${finished} sessions finished → <strong>Compare agents</strong> or <strong>Compare with humans</strong>.`;
  if (changed.length && !n("running"))
    text += ` The model of ${esc(changed.map((a) => a.label).join(", "))} changed since this campaign was frozen → <strong>Continue / rerun</strong> makes a new campaign that reuses the ${finished} finished runs that still match.`;
  if (absent.length && !n("running"))
    text += ` Not in this campaign: ${esc(absent.map((a) => a.label).join(", "))} (freeze a new campaign to include them).`;
  return `<div class="next-step"><span class="tag">Next</span> ${text}</div>`;
}
async function loadAttempts(jobId: string) {
  if (!ws || !campaignId) return;
  attemptsOf = { jobId, ...(await api<{ attempts: Attempt[] }>(`executor/attempts?id=${encodeURIComponent(ws.id)}&campaign=${encodeURIComponent(campaignId)}&job=${encodeURIComponent(jobId)}`)) };
  render();
}
/** The exact sessions that will start, per configuration, with a cost estimate from earlier real runs. */
async function runSummary(jobs: JobState[]): Promise<string> {
  const est = await api<{ label: string; sessions: number; perSession: number | null; basedOn: number; total: number | null }[]>("executor/estimate", { id: ws!.id, campaignId, jobIds: jobs.map((j) => j.jobId) });
  const lines = est.map((e) => `${e.label}: ${plural(e.sessions, "session")}${e.total === null ? " (no earlier real run to estimate cost from)" : `, about ${money(e.total)} (${money(e.perSession)} each, from ${plural(e.basedOn, "earlier run")})`}`);
  const known = est.filter((e) => e.total !== null);
  const sum = known.reduce((x, e) => x + e.total!, 0);
  return `Start exactly ${plural(jobs.length, "Claude Code session")} with your login?\n\n${lines.join("\n")}${known.length ? `\n\nEstimated: about ${money(sum)}${known.length < est.length ? " for the configurations with earlier runs" : ""}.` : ""}\nThis uses your Claude usage.`;
}
let events: EventSource | null = null;
let mode: "agent" | "simulate" = "simulate";
let analysis: AnalysisView | null = null;
interface AgentCmp {
  campaignId: string;
  configs: { id: string; label: string; level: string; model: string; assigned: number; real: number; simulated: number; basis: string; deviations: number; meanToolCalls: number | null; meanFilesRead?: number | null; runsWithoutReads?: number | null; meanWallMinutes: number | null; meanCostUsd: number | null; totalCostUsd: number | null; consistency: Record<Domain, number | null>; consistencyPairs: number }[];
  pairs: { a: string; b: string; domain: Domain; agreement: number | null; outcomes: number }[];
  notes: string[];
}
let agentCmp: AgentCmp | null = null;

let view: View = "agreement";
let selected = new Set<string>();
let domain: Domain = "subjective";
let outcomeId = "";
let figureSvg = "";
let figureData: any = null;
let comparisons: Comparison[] = [];
let explainText = "";
let understanding: { study: Study; valid: boolean; reading: { facts: Record<string, { value: string; quote: string }> }; brief: { text: string; check: LeakCheck | null } | null; questions: string[] } | null = null;
let doc: { name: string; base64: string } | null = null;
/** The chosen document has been read by Understand study (its draft was used or discarded). */
let docDrafted = false;
let participantsCsv: string | null = null;
/** Runs per participant for configurations without their own count (see defaultRuns in core/planner.ts). */
let newRepetitions = 1;
// continuation draft
let contBase: string | null = null;
let contRows: Record<string, { repetitions: number; arm: boolean; rerun: boolean; drop: boolean }> = {};
/** The campaign the continuation rows were made for. */
let contRowsFor: string | null = null;
/**
 * Effort: how much the model thinks before answering, passed to Claude Code as --effort.
 * Stored in a configuration's model as "default" or "effort=<level>" (see effortArgs in the executor).
 */
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"] as const;
function effortLevel(value: string): string {
  const v = String(value ?? "").trim().toLowerCase();
  const m = /^(?:effort\s*[=:]\s*)?(low|medium|high|xhigh|max)$/.exec(v);
  return m ? m[1] : !v || v === "default" ? "default" : value;
}
function effortSelect(attrs: string, value: string) {
  const current = effortLevel(value);
  const options = EFFORTS.map((e) => `<option value="${e === "default" ? "default" : `effort=${e}`}" ${current === e ? "selected" : ""}>${e === "default" ? "default (Claude Code decides)" : e}</option>`);
  if (!(EFFORTS as readonly string[]).includes(current)) options.push(`<option value="${esc(value)}" selected>${esc(value)} (not understood by Claude Code)</option>`);
  return `<select ${attrs}>${options.join("")}</select>`;
}
/** A model for people: "claude-sonnet-5-5, effort high" (no effort shown when it is the default). */
const modelText = (m: { model: string; reasoning: string }) => `${m.model}${effortLevel(m.reasoning) === "default" ? "" : `, effort ${effortLevel(m.reasoning)}`}`;
let contArmModel = { provider: "claude-code", model: "", reasoning: "default" };
let contSuffix = "";
let contNote = "";
let contPreview: any = null;
/** Reuse finished simulated runs in a continuation (default: run those sessions again). */
let contKeepSimulated = false;
let contPreviewSim: { reused: number; runAgain: number; byCondition: Record<string, { reused: number; runAgain: number }> } | null = null;
/** Configurations the continuation runs again because a source they read changed since the freeze. */
let contPreviewSources: string[] = [];
// campaign comparison (Freeze & campaigns)
let cmpBefore = "";
let cmpAfter = "";
interface CampaignCmpRow { conditionId: string; domain: Domain; status: string; comparable: boolean; beforeLabel: string | null; afterLabel: string | null; beforeModel: string | null; afterModel: string | null; modelChanged: boolean; modelChanges: string[]; beforeRunKind: string; afterRunKind: string; before: number | null; after: number | null; changePercentagePoints: number | null; nHumans: number; beforeRuns: number; afterRuns: number; note: string | null }
let campaignCmp: { before: string; after: string; rows: CampaignCmpRow[]; notes: string[] } | null = null;
let busy = false;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (x: unknown) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (x: number | null | undefined) => (x == null ? "—" : (x * 100).toFixed(1) + "%");
const btn = (action: string, label: string, primary = false, extra = "") => `<button class="button ${primary ? "primary" : ""}" data-action="${action}" ${extra}>${label}</button>`;
// The page title can take the focus (after a page change), so a screen reader reads where you are.
const heading = (eyebrow: string, title: string, lead: string) => `<div class="eyebrow">${eyebrow}</div><h1 id="page-title" tabindex="-1">${title}</h1><p class="lead">${lead}</p>`;
/** The study or configurations differ from the saved files (also configurations never saved: templates). */
const unsaved = () => !!ws && JSON.stringify({ study, agents }) !== saved;
/** You changed the study or configurations since they were loaded or saved (templates alone are no change). */
const edited = () => !!ws && JSON.stringify({ study, agents }) !== baseline;
/**
 * One polite live region speaks short status messages (toasts, the server banner) to screen
 * readers; the page itself is not a live region, so a redraw is not read out again.
 */
let announceTimer: ReturnType<typeof setTimeout> | undefined;
function announce(message: string) {
  const live = $("live");
  if (!live) return;
  live.textContent = "";
  // Emptied first, so the same message twice is read twice.
  if (announceTimer) clearTimeout(announceTimer);
  announceTimer = setTimeout(() => (live.textContent = message), 60);
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string, error = false) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  t.className = error ? "error-toast" : "";
  announce(error ? `Error: ${message}` : message);
  // A new message restarts the timer; errors stay longer.
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), error ? 12000 : 6000);
}
const SERVER_GONE = "The workbench server is not answering; retrying…";
async function api<T = any>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch("/api/" + path, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // No answer at all: the server stopped. The banner says so and the page reconnects by itself.
    serverGone();
    throw new Error("The workbench server is not answering. Start it again (npm start); this page reconnects by itself, then try again.");
  }
  let v: any;
  try {
    v = await r.json();
  } catch {
    throw new Error(`The server answered ${r.status} without a readable message.`);
  }
  if (!r.ok) throw new Error(v.error ?? "Request failed.");
  return v as T;
}
// ---------- server banner: the page notices when the workbench server stops, and reconnects ----------
let serverDown = false;
let streamRetries = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 1000;
function setServerDown(down: boolean) {
  if (down === serverDown) return;
  serverDown = down;
  const banner = $("server-banner");
  if (banner) banner.hidden = !down;
  announce(down ? SERVER_GONE : "The workbench server is answering again.");
}
/** The server stopped answering: show the banner and try again with growing pauses (at most 15 s). */
function serverGone() {
  setServerDown(true);
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    try {
      const r = await fetch("/api/settings", { cache: "no-store" });
      if (!r.ok) throw new Error();
    } catch {
      retryDelay = Math.min(15000, retryDelay * 2);
      serverGone();
      return;
    }
    serverBack();
  }, retryDelay);
}
function serverBack() {
  retryDelay = 1000;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  const was = serverDown;
  setServerDown(false);
  if (!was) return;
  // The page never loaded (the server was down when it opened): load it now.
  if (!settings) return location.reload();
  // A restarted server reopens the campaign's executor from disk: listen again and refresh progress.
  if (ws && campaignId && (!events || events.readyState === EventSource.CLOSED)) openStream();
  scheduleSummaryRefresh();
}
function pickFile(accept: string): Promise<File | undefined> {
  return new Promise((ok) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => ok(input.files?.[0]);
    input.addEventListener("cancel", () => ok(undefined));
    input.click();
  });
}
const toBase64 = (f: File) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1]);
    r.onerror = () => fail(new Error("Could not read the file."));
    r.readAsDataURL(f);
  });
function download(name: string, text: string, type = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
}

// ---------- loading ----------
/**
 * Forget every analyzer result: scores, agent comparison, figures (data and drawing), human data
 * and the assistant's explanation. Called when a study opens, the campaign shown changes, and
 * before each analysis, so nothing from another study or campaign is shown.
 */
function resetAnalyzer() {
  analysis = null;
  agentCmp = null;
  humanFig = null;
  humanSvg = "";
  figureSvg = "";
  figureData = null;
  explainText = "";
}
/** Show another campaign in the executor and analyzer. */
function showCampaign(id: string | null) {
  campaignId = id;
  resetAnalyzer();
  attemptsOf = null;
  selectedJob = null;
  watched = new Set();
  chosen = new Set();
  pickConfigs = new Set();
  contBase = null;
  contPreview = null;
  contPreviewSim = null;
  contPreviewSources = [];
  connect();
}
/** The study and configurations as the server has them: changes since then are unsaved edits (see beforeunload). */
let baseline = "";
async function openWorkspace(id: string) {
  ws = await api<WorkspaceView>(`workspace?id=${encodeURIComponent(id)}`);
  study = structuredClone(ws.study);
  agents = structuredClone(ws.agents);
  saved = ws.agentsSaved ? JSON.stringify({ study, agents }) : "";
  baseline = JSON.stringify({ study, agents });
  comparisons = structuredClone(ws.comparisons);
  runtimes = await api(`runtimes?id=${encodeURIComponent(id)}`);
  // Nothing chosen for another study carries over: document, participants file, drafts, edits, selections.
  doc = null;
  docDrafted = false;
  participantsCsv = null;
  understanding = null;
  briefDraft = null;
  briefEdit = null;
  brief = null;
  evidence = null;
  participantKnowledge = [];
  knowledgeDraft = null;
  knowledgeEdit = null;
  contRows = {};
  contNote = "";
  contSuffix = "";
  contKeepSimulated = false;
  cmpBefore = "";
  cmpAfter = "";
  campaignCmp = null;
  newLabel = "";
  selected = new Set();
  outcomeId = "";
  humanOutcome = "";
  view = "agreement";
  // The analyzer starts on a domain this study measures (subjective first), not the last study's choice.
  domain = ws.study.outcomes.some((o) => o.domain === "subjective") || !ws.study.outcomes.length ? "subjective" : "objective";
  showSignificantOnly = false;
  logs.clear();
  // Real studies start in "Run agents" (nothing starts without your OK); synthetic ones in "Simulate".
  mode = ws.study.synthetic ? "simulate" : "agent";
  history.replaceState(null, "", `?study=${encodeURIComponent(id)}`);
  showCampaign(ws.campaigns.at(-1)?.id ?? null);
}
/**
 * The mode follows the study's kind when that changes (a study.json loaded or saved as synthetic or
 * real): Simulate for synthetic studies, Run agents for real ones. Not while sessions run or wait.
 */
function followStudyKind(wasSynthetic: boolean, isSynthetic: boolean) {
  if (isSynthetic === wasSynthetic) return;
  if (snapshot && (snapshot.running || snapshot.queued)) return;
  mode = isSynthetic ? "simulate" : "agent";
}
async function refreshWorkspace() {
  if (!ws) return;
  const keep = { study, agents };
  const dirty = unsaved();
  const wasSynthetic = !!ws.study.synthetic;
  ws = await api<WorkspaceView>(`workspace?id=${encodeURIComponent(ws.id)}`);
  if (dirty) ({ study, agents } = keep);
  else {
    study = structuredClone(ws.study);
    agents = structuredClone(ws.agents);
    saved = ws.agentsSaved ? JSON.stringify({ study, agents }) : "";
    baseline = JSON.stringify({ study, agents });
  }
  followStudyKind(wasSynthetic, !!ws.study.synthetic);
}
/**
 * Campaign progress (Freeze & campaigns, the campaign bar, Delete) follows the sessions: refreshed
 * when sessions end, at most every 2 seconds.
 */
const SUMMARY_REFRESH_MS = 2000;
let summaryTimer: ReturnType<typeof setTimeout> | null = null;
let lastSummary = 0;
/** A refresh is waiting for the server's answer; another one asked for meanwhile follows it (never two at once). */
let summaryLoading = false;
let summaryAgain = false;
function scheduleSummaryRefresh() {
  if (!ws) return;
  if (summaryLoading) {
    summaryAgain = true;
    return;
  }
  if (summaryTimer) return;
  summaryTimer = setTimeout(async () => {
    summaryTimer = null;
    if (!ws) return;
    const id = ws.id;
    summaryLoading = true;
    try {
      const list = await api<CampaignInfo[]>(`workspace/campaigns?id=${encodeURIComponent(id)}`);
      if (ws?.id !== id) return;
      ws.campaigns = list;
    } catch {
      return;
    } finally {
      summaryLoading = false;
      // The next refresh waits SUMMARY_REFRESH_MS after this answer, however long it took.
      lastSummary = Date.now();
      if (summaryAgain) {
        summaryAgain = false;
        scheduleSummaryRefresh();
      }
    }
    if (page === "executor") scheduleRender();
    else if (["freeze", "compare", "analyzer", "continue"].includes(page) && !editingField()) render();
  }, Math.max(0, lastSummary + SUMMARY_REFRESH_MS - Date.now()));
}
const editingField = () => !!document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName);
/** What the agents of the campaign shown get: the campaign's own frozen sources. */
let campaignInputs: { campaignId: string; sources: { id: string; label: string; kind: string; configs: number; path: string | null; removed: boolean; readable: boolean }[] } | null = null;
async function loadCampaignInputs() {
  if (!ws || !campaignId) return;
  const [id, cid] = [ws.id, campaignId];
  try {
    const sources = await api<NonNullable<typeof campaignInputs>["sources"]>(`workspace/campaign-inputs?id=${encodeURIComponent(id)}&campaign=${encodeURIComponent(cid)}`);
    if (ws?.id === id && campaignId === cid) campaignInputs = { campaignId: cid, sources };
  } catch {
    campaignInputs = null;
  }
  if (page === "executor") scheduleRender();
}
function connect() {
  events?.close();
  events = null;
  snapshot = null;
  campaignInputs = null;
  if (!ws || !campaignId) return;
  void loadCampaignInputs();
  openStream();
}
/**
 * Listen to the executor of the campaign shown. When the stream breaks (the server stopped), the
 * banner says so and the page reconnects by itself; the table keeps its last state until then.
 */
function openStream() {
  events?.close();
  if (!ws || !campaignId) return;
  const [id, cid] = [ws.id, campaignId];
  const source = new EventSource(`/api/executor/events?id=${encodeURIComponent(id)}&campaign=${encodeURIComponent(cid)}`);
  events = source;
  source.onopen = () => {
    streamRetries = 0;
    serverBack();
  };
  source.onerror = async () => {
    if (events !== source) return;
    // The browser's own retry gives up on some errors; the page reconnects itself in every case.
    source.close();
    events = null;
    const answering = await fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok, () => false);
    if (!answering) return serverGone();
    // The server answers but ended this stream: listen again a few times, then say so.
    if (++streamRetries <= 3)
      setTimeout(() => {
        if (!events && ws?.id === id && campaignId === cid) openStream();
      }, 1000 * streamRetries);
    else toast("Live progress of this campaign stopped. Reload the page to listen again.", true);
  };
  source.onmessage = (m) => {
    const e = JSON.parse(m.data);
    if (e.type === "snapshot") {
      snapshot = e.snapshot;
      if (!e.snapshot.paused) mode = e.snapshot.mode === "agent" ? "agent" : "simulate";
    }
    else if (e.type === "job" && snapshot) {
      const i = snapshot.jobs.findIndex((j) => j.jobId === e.jobId);
      const before = i >= 0 ? snapshot.jobs[i].status : null;
      if (i >= 0) snapshot.jobs[i] = e.job;
      recount();
      // A session started, ended or was stopped: the campaign's progress changes.
      if (before !== e.job?.status && ["running", "done", "failed", "stopped", "not-started"].includes(e.job?.status)) scheduleSummaryRefresh();
    } else if (e.type === "log" && e.jobId) logs.set(e.jobId, [...(logs.get(e.jobId) ?? []), e.text].slice(-60));
    else if (e.type === "state") {
      scheduleSummaryRefresh();
      void api<Snapshot>(`executor/state?id=${encodeURIComponent(ws!.id)}&campaign=${encodeURIComponent(campaignId!)}`).then((s) => {
        snapshot = s;
        // "Queue finished.", "Paused", "Stopped." belong to Run agents; other pages do not pop them up.
        if (e.text && page === "executor") toast(e.text);
        scheduleRender();
      }).catch(() => undefined);
    }
    scheduleRender();
  };
}
function recount() {
  if (!snapshot) return;
  snapshot.counts = {};
  snapshot.jobs.forEach((j) => (snapshot!.counts[j.status] = (snapshot!.counts[j.status] ?? 0) + 1));
}
let pending = false;
/**
 * Live updates redraw the Run agents page at most twice a second: events in between only update
 * the data, and the next redraw shows the latest state. Clicks and edits still redraw at once.
 */
const LIVE_REDRAW_MS = 500;
let lastLiveRender = 0;
function scheduleRender() {
  if (page !== "executor" || pending) return;
  pending = true;
  const wait = Math.max(0, lastLiveRender + LIVE_REDRAW_MS - Date.now());
  setTimeout(() => {
    pending = false;
    if (page !== "executor") return;
    // Do not redraw under the cursor of a field being edited; the next update catches up.
    lastLiveRender = Date.now();
    if (document.activeElement && ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return scheduleRender();
    requestAnimationFrame(() => render());
  }, wait);
}

// ---------- rendering ----------
/**
 * Where the focus goes after the next redraw when the focused control cannot say so itself: the
 * button just clicked (it is disabled while its action runs), or the page title after a page change.
 */
let focusNext: FocusMark | "heading" | null = null;
/** The text field typed into since its last change event: a redraw keeps what was typed. */
let typing: HTMLInputElement | HTMLTextAreaElement | null = null;
const markOf = (el: HTMLElement) => focusMark(el, $("content").getElementsByTagName(el.tagName));
/** Put the focus on the page title (without scrolling), so a screen reader reads the new page. */
function focusHeading() {
  const h = $("content").querySelector<HTMLElement>("h1") ?? $("content");
  h.focus({ preventScroll: true });
}
/** A control that cannot take the focus now (disabled): the next one in its row of buttons, else the title. */
function focusNear(el: HTMLElement) {
  const near = el.closest(".actions, .card, tr")?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex='0']");
  if (near) near.focus({ preventScroll: true });
  else focusHeading();
}
function render() {
  const content = $("content");
  const now = document.activeElement;
  const active = now instanceof HTMLElement && now !== content && content.contains(now) ? now : null;
  const wanted = focusNext ?? (active ? markOf(active) : null);
  focusNext = null;
  // A text field keeps its caret, scroll and (while being typed into) its text.
  const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : null;
  const caret = field ? { typed: field === typing, value: field.value, start: field.selectionStart, end: field.selectionEnd, dir: field.selectionDirection, scroll: field.scrollTop } : null;
  // Open <details> stay open: a redraw would otherwise close the one you are working in.
  const open = new Set(Array.from(content.querySelectorAll<HTMLDetailsElement>("details[data-key][open]")).map((d) => d.dataset.key!));
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((b) => {
    b.classList.toggle("active", b.dataset.page === page);
    if (b.dataset.page === page) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
    b.disabled = !ws && !["home", "settings"].includes(b.dataset.page!);
  });
  $("study-breadcrumb").textContent = ws ? `${ws.manifest.suite ? ws.manifest.suite + " · " : ""}${study?.title}` : "No study open";
  $("data-label").textContent = ws ? (study?.synthetic ? "SYNTHETIC STUDY" : "RESEARCH STUDY") : "—";
  $("data-label").className = "pill" + (ws && !study?.synthetic ? " real" : "");
  const pages: Record<Page, () => string> = { home: renderHome, study: renderStudy, evidence: renderEvidence, compare: renderCompareAgents, configs: renderConfigs, freeze: renderFreeze, executor: renderExecutor, analyzer: renderAnalyzer, continue: renderContinue, settings: renderSettings };
  content.innerHTML =
    (ws?.problem && page !== "home" && page !== "settings" ? problemBanner() : "") +
    (edited() && !["home", "study", "evidence", "configs", "freeze", "settings"].includes(page) ? `<div class="notice">Unsaved planner changes. Save them on the Study or Agent configurations page.</div>` : "") +
    pages[page]();
  content.querySelectorAll<HTMLDetailsElement>("details[data-key]").forEach((d) => open.has(d.dataset.key!) && (d.open = true));
  // Focus inside the page that nothing names, or a control that is gone: the page title, not the top of the document.
  if (wanted === "heading" || (active && !wanted)) return focusHeading();
  if (!wanted) return;
  const target = focusTarget(wanted, content.getElementsByTagName(wanted.key.slice(0, wanted.key.indexOf("|")))) as HTMLElement | null;
  if (!target) return focusHeading();
  if ((target as HTMLButtonElement).disabled) return focusNear(target);
  target.focus({ preventScroll: true });
  if (caret && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    if (caret.typed && target.value !== caret.value) {
      target.value = caret.value;
      typing = target;
    }
    try {
      if (caret.start !== null && caret.end !== null) target.setSelectionRange(caret.start, caret.end, caret.dir ?? undefined);
    } catch {
      // Number, checkbox and other inputs have no caret.
    }
    target.scrollTop = caret.scroll;
  }
}
/** Redraw after the current event: a change while tabbing away lets the focus land first, then keeps it there. */
let redrawSoon = false;
function renderSoon() {
  if (redrawSoon) return;
  redrawSoon = true;
  setTimeout(() => {
    redrawSoon = false;
    render();
  }, 0);
}
/** What a configuration (as edited now) names that the study (as edited now) does not have. */
function unknownRefs(a: AgentProtocol) {
  const st = study!;
  const sources = new Set(st.sources.map((x) => x.id));
  const outcomes = new Set(st.outcomes.map((x) => x.id));
  const cases = new Set(st.cases.map((x) => x.id));
  return {
    sources: [...new Set([...a.sourceIds, ...a.requiredSourceIds])].filter((id) => !sources.has(id)),
    outcomes: [...new Set([...(a.targets ?? []), ...(a.inputs ?? [])])].filter((id) => !outcomes.has(id)),
    cases: a.requiredCaseIds.filter((id) => !cases.has(id)),
  };
}
const hasUnknown = (a: AgentProtocol) => {
  const u = unknownRefs(a);
  return !!(u.sources.length || u.outcomes.length || u.cases.length);
};
/** "source "notes"" or "sources "a", "b"" and the like. */
const named = (one: string, ids: string[]) => `${ids.length === 1 ? one : `${one}s`} ${ids.map((x) => `"${x}"`).join(", ")}`;
/** In words: what a configuration names that the study does not have. */
function unknownText(a: AgentProtocol) {
  const u = unknownRefs(a);
  const parts = [u.sources.length ? named("source", u.sources) : "", u.outcomes.length ? named("measure", u.outcomes) : "", u.cases.length ? named("task", u.cases) : ""].filter(Boolean);
  return parts.length ? `${a.label} (${a.id}) names ${parts.join(", ")}, which the study does not have` : "";
}
/** The button that removes what the study does not have from one configuration. */
function fixButton(a: AgentProtocol, primary = true) {
  const u = unknownRefs(a);
  const what = u.sources.length && !u.outcomes.length && !u.cases.length ? (u.sources.length === 1 ? "the unknown source" : "the unknown sources") : "what the study does not have";
  return btn(`fix-config:${a.id}`, `Remove ${what} from ${esc(a.label)}`, primary);
}
/**
 * The saved study and configurations disagree: say which configuration names what, offer to remove
 * it, and say that saving, approving and freezing wait for the fix.
 */
function problemBanner() {
  const broken = agents.filter(hasUnknown);
  // Unknown sources, measures and tasks are checked here on the configurations as edited; other
  // refusals of the saved files are shown as the server words them.
  const listed = (p: ConfigProblem) => p.unknownSources.length || p.unknownOutcomes.length || p.unknownCases.length;
  const other = (ws?.problems ?? []).filter((p) => p.message && !listed(p) && agents.some((a) => a.id === p.configId));
  const fixedHere = !broken.length && !other.length && unsaved();
  // One primary button per page: on Freeze the fix is the next step (freezing waits for it); Agent
  // configurations marks it on the configuration's card; other pages keep their own next step.
  const lines = broken
    .map((a, i) => `<li>${esc(unknownText(a))}. ${fixButton(a, i === 0 && page === "freeze")}</li>`)
    .concat(other.map((p) => `<li>${esc(p.label)} (${esc(p.configId)}): ${esc(p.message)}</li>`));
  return `<div class="notice problem"><strong>The saved files disagree.</strong> ${
    lines.length
      ? `The saved agent configurations do not fit the saved study. Saving, approving and freezing wait until they do.<ul>${lines.join("")}</ul>${broken.length ? "<p>Or add what is missing back to the study (Evidence &amp; knowledge, Study &amp; variables).</p>" : ""}`
      : fixedHere
      ? "Fixed on this page but not saved yet: press <strong>Save configurations</strong> on Agent configurations."
      : esc(ws!.problem)
  }</div>`;
}
/** Saving sends the study and configurations together: refuse in words before the server refuses in IDs. */
function checkSavable() {
  const block = problemBlock();
  if (block) throw new Error(`Not saved: ${block}`);
}
/** Why the configurations cannot be saved, approved or frozen yet (null when they can). */
function problemBlock(): string | null {
  const broken = agents.filter(hasUnknown);
  if (!broken.length) return null;
  return `${broken.map(unknownText).join("; ")}. Press "Remove … from ${broken[0].label}" in the notice at the top of the page or on its card, or add it back to the study, then save.`;
}
const withheld = `<div class="notice neutral"><strong>Reference answers are withheld.</strong> Neither you nor the agents see the human results while planning. Measured values are used only for inputs you declare per configuration, and in the analyzer.</div>`;

/** Configuration templates, with what the study still lacks for each (same rules as the planner's designers). */
function templates() {
  const st = study!;
  const has = (kind: string) => st.sources.some((x) => x.kind === kind);
  // A source counts once it has a (complete) file on this machine; until the study is saved, as listed.
  const ready = (kind: string) => st.sources.some((x) => x.kind === kind && (ws?.sourceFiles?.[x.id] ?? true));
  const personKinds = st.predictionTiming === "after-experience" ? ["demographics", "objective-records", "trajectory"] : ["demographics"];
  const project = !has("project") ? "" : ready("project") ? "" : "the project files on this machine (workspace.json → sources)";
  // The app: tasks to play and, for the built-in WebXR runtime, an app declared in workspace.json.
  const webxr = st.runtime.engine !== "unreal" && st.runtime.engine !== "unity";
  const app = !st.cases.length ? "tasks to play" : webxr && !ws?.manifest.app ? "a WebXR app declared in workspace.json (app)" : project;
  return [
    { id: "text-only", missing: "" },
    { id: "reads-project", missing: !has("project") ? "a project source" : project },
    { id: "app-only", missing: !st.cases.length ? "tasks to play" : webxr && !ws?.manifest.app ? "a WebXR app declared in workspace.json (app)" : "" },
    { id: "uses-app", missing: app },
    { id: "reads-evidence", missing: !has("evidence") ? "an evidence source (Evidence & knowledge page)" : !ready("evidence") ? "the evidence file on this machine" : project },
    { id: "uses-app-people", missing: app || (!personKinds.some(has) ? "participant-specific knowledge (Evidence & knowledge page)" : !personKinds.filter(has).every(ready) ? "complete participant-specific knowledge (Evidence & knowledge page)" : "") },
  ];
}
/**
 * The built-in WebXR runtime reports its device profile to the audit; app sessions whose study
 * declares another one are listed as deviations. Offer the runtime's profile when they differ.
 */
const WEBXR_PROFILE = "webxr-desktop-browser-1280x720";
function usesWebxr() {
  return !!study && agents.some((a) => a.tools.includes("xr-interact") && (a.runtime ?? ws?.runtimes[a.id]) === "webxr");
}
function webxrProfileHint() {
  if (!study || study.runtime.engine !== "custom" || study.runtime.deviceProfile === WEBXR_PROFILE) return "";
  return `<p class="caption">${usesWebxr() ? '<span class="warn">' : "<span>"}The built-in WebXR runtime reports the device <code>${WEBXR_PROFILE}</code>. For WebXR app sessions the study's device must match it, or every session is listed as a protocol deviation.</span> ${btn("use-webxr-profile", "Use the WebXR runtime's device")}</p>`;
}
/** The built-in WebXR runtime captures one image; a stereo study cannot run its app sessions there. */
function webxrStereoHint() {
  if (!study || study.runtime.observation !== "stereo-pair" || !usesWebxr()) return "";
  return `<p class="caption"><span class="warn">The built-in WebXR runtime gives a single image (mono), not a left/right pair. With stereo observation, configurations that use the app can be simulated but not run as agents.</span> Choose Single image (mono) to run them.</p>`;
}
/** A study counts as understood once the placeholder of a new study has been replaced (examples are). */
function studyUnderstood() {
  return !!study && !study.outcomes.some((o) => o.description === "Placeholder") && !/^New study \(draft/.test(study.title);
}
/** Card actions shared by every kind of knowledge: rename, change, delete. */
function knowledgeActions(id: string, kind: "general" | "participant") {
  return `<div class="actions">${btn(`k-rename:${id}`, "Rename")}${kind === "general" ? btn(`k-text:${id}`, "Edit text") : btn(`k-fields:${id}`, "Fields")}${kind === "participant" ? btn(`k-replace:${id}`, "Replace file") : ""}${btn(`k-delete:${id}`, "Delete")}</div>`;
}
function renameForm(id: string, label: string, description: string) {
  return knowledgeEdit?.id === id && knowledgeEdit.mode === "rename"
    ? `<div class="row"><label class="field">Name<input id="k-label" value="${esc(label)}"></label><label class="field">What it is and where it comes from<input id="k-desc" value="${esc(description)}"></label></div><div class="actions">${btn(`k-rename-save:${id}`, "Save name", evidenceNext() === `k-rename-save:${id}`)}${btn("k-cancel", "Cancel")}</div>`
    : "";
}
const usedBy = (id: string) => agents.filter((a) => a.sourceIds.includes(id));
const usedText = (id: string) => (usedBy(id).length ? `Used by ${usedBy(id).map((a) => esc(a.label)).join(", ")}.` : "Not used by any configuration yet.");

/** General knowledge: the same for everyone. */
function generalSection() {
  const cards = (evidence ?? [])
    .map((e) => {
      const check = e.check
        ? e.check.participantIds || e.check.humanMeanMatches
          ? `<div class="notice">Outcome-blind check: ${e.check.participantIds ? `names ${e.check.participantIds} participant ID(s)` : ""}${e.check.participantIds && e.check.humanMeanMatches ? "; " : ""}${e.check.humanMeanMatches ? `${e.check.humanMeanMatches} number(s) equal a human design mean to two decimals` : ""}. Knowledge must not contain the study's results. Which numbers match is not shown, so you do not see the results either.</div>`
          : `<p class="caption ok">Outcome-blind check: no participant IDs${e.check.checkedAgainstHuman ? ", and no number equals a human design mean to two decimals" : ""}.</p>`
        : "";
      const predicted = predictionNotice(e.check);
      const editing = knowledgeEdit?.id === e.id && knowledgeEdit.mode === "text";
      return `<div class="card"><div class="card-heading"><div><h3>${esc(e.label)}</h3><p class="caption">${esc(e.description)}</p></div><span class="tag">general</span></div>
        <p class="caption">${e.exists ? `${esc(e.path)} · ${(e.bytes / 1024).toFixed(1)} KB · sha256 ${esc(e.sha256!.slice(0, 16))}… · <a href="/api/workspace/source?id=${encodeURIComponent(ws!.id)}&source=${encodeURIComponent(e.id)}" target="_blank" rel="noopener">open full text</a>` : `<span class="warn">${e.problem && e.path ? `Not usable: this source ${esc(e.problem)}` : `No file on this machine${e.path ? ` (${esc(e.path)} is missing)` : ""}`}.</span>`} · ${usedText(e.id)}</p>
        ${knowledgeActions(e.id, "general")}${renameForm(e.id, e.label, e.description)}
        ${editing ? `<label class="field">Text (Markdown)<textarea id="k-text" rows="18">${esc(knowledgeEdit!.text ?? "")}</textarea></label><div class="actions">${btn(`k-text-save:${e.id}`, "Save text", evidenceNext() === `k-text-save:${e.id}`)}${btn("k-cancel", "Cancel")}</div>` : `${check}${predicted}${e.exists ? `<pre class="preview">${esc(e.preview)}${e.truncated ? "\n…" : ""}</pre>` : ""}`}</div>`;
    })
    .join("");
  return `<h2 class="group-title">General knowledge</h2><p class="group-caption">The same for everyone: findings from papers, computational models, expert heuristics.</p>${cards || '<div class="card"><p class="caption">None yet.</p></div>'}`;
}

/** Participant-specific knowledge: each source with completeness and what agents get. */
function participantSection() {
  if (!ws || !study) return "";
  const cards = participantKnowledge
    .map((k) => {
      const status = !k.exists
        ? `<div class="notice">No file on this machine${k.path ? ` (${esc(k.path)} is missing)` : ""}. Configurations that get it cannot run.</div>`
        : k.problems.length
        ? `<div class="notice">This file ${esc(k.problems.join("; "))}. Participant-specific knowledge needs exactly one complete entry per participant, so configurations that get it cannot run until this is fixed.</div>`
        : `<p class="caption ok">Complete: all ${k.participants} participants have an entry${k.fields.length ? ` for ${esc(k.fields.join(", "))}` : ""}.</p>`;
      const fieldsForm =
        knowledgeEdit?.id === k.id && knowledgeEdit.mode === "fields"
          ? `<p class="caption">Fields agents may see. A field that is empty for anyone cannot be chosen.</p><div class="config-picks">${k.columns
              .map((c) =>
                c.missing.length
                  ? `<label class="check disabled"><input type="checkbox" disabled> ${esc(c.name)} <small class="warn">(empty for ${esc(c.missing.slice(0, 5).join(", "))}${c.missing.length > 5 ? " …" : ""})</small></label>`
                  : `<label class="check"><input type="checkbox" data-kfield="${esc(c.name)}" ${k.fields.includes(c.name) ? "checked" : ""}> ${esc(c.name)}</label>`,
              )
              .join("")}</div><div class="actions">${btn(`k-fields-save:${k.id}`, "Save fields", evidenceNext() === `k-fields-save:${k.id}`)}${btn("k-cancel", "Cancel")}</div>`
          : "";
      const shown =
        k.kind === "demographics"
          ? `${k.population ? `<h3>A population configuration gets</h3><pre class="preview">${esc(k.population)}</pre>` : ""}${k.individual && study!.design !== "between-subjects" ? `<h3>An individual configuration gets (for example ${esc(k.individual.participantId)})</h3><pre class="preview">${esc(k.individual.text)}</pre>` : ""}`
          : `<p class="caption">Movement recordings were measured during the study, so their values are not shown while planning. Individual configurations get each person's own rows${k.phases?.length ? ` of the ${k.phases.length === 1 ? "phase" : "phases"} ${esc(k.phases.join(", "))} only` : ""}: the ID column and ${esc(k.fields.join(", "))} only (other columns never reach the agent); population configurations get none. To deliver only some phases (for example practice), set <code>"phases": ["practice"]</code> on the source in study.json.</p>`;
      const standIns = (k.warnings ?? []).map((w) => `<div class="notice">${esc(w)}</div>`).join("");
      return `<div class="card"><div class="card-heading"><div><h3>${esc(k.label)}</h3><p class="caption">${esc(k.description)}</p></div><span class="tag">${esc(k.kind === "demographics" ? "background" : "movement")}</span></div><p class="caption">${k.path ? esc(k.path) : "not mapped"}${k.sha256 ? ` · sha256 ${esc(k.sha256.slice(0, 16))}…` : ""} · ${usedText(k.id)}</p>
        ${k.kind === "demographics" ? knowledgeActions(k.id, "participant") : `<div class="actions">${btn(`k-rename:${k.id}`, "Rename")}${btn(`k-delete:${k.id}`, "Delete")}</div>`}${renameForm(k.id, k.label, k.description)}${fieldsForm}${status}${standIns}${k.notes ? `<p class="caption">${esc(k.notes)}</p>` : ""}${shown}</div>`;
    })
    .join("");
  return `<h2 class="group-title">Participant-specific knowledge</h2><p class="group-caption">What is known about each participant apart from the measured results, for example background. Like general knowledge, both population configurations (a summary of the cohort) and individual configurations (the person's own entry) can use it. It must exist for every participant: no missing person and no empty field.</p>
    ${cards || '<div class="card"><p class="caption">None yet, so no configuration can know about the participants.</p></div>'}`;
}

/** Add knowledge: any file; tables with this study's participant IDs are participant-specific, documents are drafted by the assistant. */
function addKnowledgeCard() {
  const d = knowledgeDraft;
  if (!d)
    return `<div class="card"><h2>Add knowledge</h2><p class="caption">Choose a file: a paper (PDF, DOCX), notes or a model description (Markdown, text), or a table (CSV). A table with this study's participant IDs becomes participant-specific knowledge as it is. Any other file is read by the assistant (${esc(settings?.assistant.kind ?? "assistant")}, ${esc(settings?.assistant.model ?? "")}), which drafts it as general or participant-specific knowledge and leaves out this study's own results. You review the draft before it is added. This uses your assistant's usage.</p><div class="actions">${btn("k-add", "Choose file")}</div></div>`;
  const where = d.kind === "general" ? "general knowledge" : "participant-specific knowledge";
  const by = d.via === "table" ? "read as a table" : d.via === "assistant" ? "drafted by the assistant" : "extracted text (the assistant was not used)";
  const check = d.check && (d.check.participantIds || d.check.humanMeanMatches) ? `<div class="notice">Outcome-blind check: ${d.check.participantIds ? `names ${d.check.participantIds} participant ID(s)` : ""}${d.check.participantIds && d.check.humanMeanMatches ? "; " : ""}${d.check.humanMeanMatches ? `${d.check.humanMeanMatches} number(s) equal a human design mean to two decimals` : ""}. Remove the study's own results before adding.</div>` : d.check ? '<p class="caption ok">Outcome-blind check: nothing found.</p>' : "";
  const body =
    d.kind === "general"
      ? `<label class="field">Text (Markdown; edit as needed)<textarea id="kd-text" rows="16">${esc(d.text)}</textarea></label>${check}${predictionNotice(d.check)}`
      : `${d.problems.length ? `<div class="notice">Cannot be added yet: this file ${esc(d.problems.join("; "))}. Participant-specific knowledge needs exactly one complete entry per participant.</div>` : ""}<p class="caption">Fields agents may see. A field that is empty for anyone cannot be chosen.</p><div class="config-picks">${(d.columns ?? [])
          .map((c) =>
            c.missing.length
              ? `<label class="check disabled"><input type="checkbox" disabled> ${esc(c.name)} <small class="warn">(empty for ${esc(c.missing.slice(0, 5).join(", "))}${c.missing.length > 5 ? " …" : ""})</small></label>`
              : `<label class="check"><input type="checkbox" data-kdfield="${esc(c.name)}" checked> ${esc(c.name)}</label>`,
          )
          .join("")}</div>`;
  return `<div class="card draft"><h2>${d.replaces ? "Replace" : "New"} ${where}</h2><p class="caption">${esc(by)}. ${d.replaces ? `It replaces the file of ${esc(study!.sources.find((x) => x.id === d.replaces)?.label ?? d.replaces)}.` : `It will be listed under ${where}.`}${d.notes ? ` Notes: ${esc(d.notes)}` : ""}</p>
    <div class="row"><label class="field">Name<input id="kd-label" value="${esc(d.label)}"></label><label class="field">What it is and where it comes from<input id="kd-desc" value="${esc(d.description)}"></label></div>
    ${body}<div class="actions">${btn("k-add-save", d.replaces ? "Replace" : `Add to ${where}`, evidenceNext() === "k-add-save", d.kind === "participant" && d.problems.length ? "disabled" : "")}${btn("k-discard", "Discard", evidenceNext() === "k-discard")}</div></div>`;
}
/**
 * Save a knowledge change in one step: files to write, sources to unmap, and the study and
 * configurations as they are now (this also saves other unsaved planner edits).
 */
async function saveKnowledge(write?: { sourceId: string; path: string; text: string }[], unmap?: string[]) {
  checkSavable();
  await api("workspace/knowledge-save", { id: ws!.id, study, agents, write, unmap });
  saved = JSON.stringify({ study, agents });
  await refreshWorkspace();
  await loadEvidence();
}
async function loadEvidence() {
  if (!ws) return;
  try {
    const r = await api<{ brief: EvidenceItem | null; general: EvidenceItem[]; participants: ParticipantItem[] }>(`workspace/evidence?id=${encodeURIComponent(ws.id)}`);
    brief = r.brief;
    evidence = r.general;
    participantKnowledge = r.participants;
  } catch (err) {
    toast((err as Error).message, true);
    evidence = [];
  }
  render();
}
/** The study brief: what every configuration gets. Edit its text, or write it when the study has none. */
function briefCard() {
  const b = brief;
  const has = !!b?.exists;
  const writing = briefEdit !== null;
  const next = evidenceNext();
  const form = `<label class="field">Brief (Markdown): the task, each design, the procedure and each measure as participants experienced them. Never results.<textarea id="brief-text" rows="16">${esc(briefEdit ?? "")}</textarea></label><div class="actions">${btn("brief-save", "Save brief", next === "brief-save")}${btn("brief-cancel", "Cancel")}</div>`;
  const pending = briefDraft !== null ? `<p class="caption">A brief drafted by Understand study is waiting: it is written when you save the study.</p>` : "";
  return `<div class="card"><div class="card-heading"><div><h2>Study brief — what every configuration gets</h2><p class="caption">The description agents read first: the task, designs, procedure and measures as participants experienced them, without any results. Understand study drafts it from your document; you can also write it here.</p></div><span class="tag">brief</span></div>
    ${has ? `<p class="caption">${esc(b!.path)} · ${(b!.bytes / 1024).toFixed(1)} KB · sha256 ${esc(b!.sha256!.slice(0, 16))}… · <a href="/api/workspace/source?id=${encodeURIComponent(ws!.id)}&source=${encodeURIComponent(b!.id)}" target="_blank" rel="noopener">open full text</a> · ${usedText(b!.id)}</p>` : `<div class="notice">No study brief yet, so no configuration can run as an agent.${b?.path ? ` (${esc(b.path)} is missing or empty.)` : ""} Write it below${studyUnderstood() ? "" : ", or let Understand study draft it from your document"}.</div>`}
    ${pending}${writing ? form : `<div class="actions">${btn("brief-edit", has ? "Edit text" : "Write the brief", next === "brief-edit")}</div>${has ? `${leakNotice(b!.check, "The brief must not contain the study's results.")}<pre class="preview">${esc(b!.preview)}${b!.truncated ? "\n…" : ""}</pre>` : ""}`}</div>`;
}
/** Planner tab: the evidence agents may get, what is in it, who gets it, and an outcome-blind check. */
function renderEvidence() {
  if (!ws || !study) return "";
  const intro = heading("PLANNER", "Evidence and knowledge.", "What configurations get: the study brief (everyone), general knowledge (the same for everyone) and participant-specific knowledge (per person). Knowledge beyond the brief is optional: the workbench runs without any. Which configuration gets what is chosen on Agent configurations, for example two otherwise identical configurations with different knowledge, to compare them in the analyzer.");
  if (!evidence) return intro + `<div class="card"><p class="caption">Loading…</p></div>`;
  const next = evidenceNext();
  return (
    intro +
    briefCard() +
    generalSection() +
    participantSection() +
    addKnowledgeCard() +
    `<div class="actions sticky">${btn("save", unsaved() || briefDraft !== null ? "Save study" : "Saved", next === "save")}${btn("goto:configs", "Agent configurations →", next === "goto:configs")}</div>`
  );
}
/**
 * The Evidence page's next step, which alone gets the primary button: finish the form that is
 * open, save your changes, write the missing brief, then go on to Agent configurations.
 * Configurations that were never saved (templates) are no change of yours: they wait for Agent configurations.
 */
function evidenceNext(): string {
  if (briefEdit !== null) return "brief-save";
  if (knowledgeEdit) return `k-${knowledgeEdit.mode === "rename" ? "rename" : knowledgeEdit.mode}-save:${knowledgeEdit.id}`;
  if (knowledgeDraft) return knowledgeDraft.kind === "participant" && knowledgeDraft.problems.length ? "k-discard" : "k-add-save";
  if (edited() || briefDraft !== null) return "save";
  if (!brief?.exists) return "brief-edit";
  return "goto:configs";
}

function renderHome() {
  // One primary button: the study open now, else your first own study, else Create study.
  const own = workspaces.filter((w) => !w.id.startsWith("examples/"));
  const primary = ws && workspaces.some((w) => w.id === ws!.id) ? ws.id : own[0]?.id ?? null;
  const card = (w: WorkspaceInfo) =>
    `<article class="card study-card"><div class="eyebrow">${esc(w.suite ?? "Study")}</div><h2>${esc(w.title)}</h2><p class="caption">${esc(w.description ?? "")}</p><div class="tags"><span class="tag">${w.synthetic ? "synthetic" : "research data"}</span><span class="tag">engine: ${esc(w.engine)}</span><span class="tag">${w.campaigns} campaign(s)</span>${w.hasHuman ? "" : '<span class="tag pending">no human reference yet</span>'}</div><div class="actions">${btn(`open:${w.id}`, "Open", w.id === primary, `aria-label="Open ${esc(w.title)}"`)}</div><p class="path">${esc(w.id)}</p></article>`;
  const examples = workspaces.filter((w) => w.id.startsWith("examples/"));
  const newStudy = `<article class="card study-card new-study"><div class="eyebrow">NEW STUDY</div><h2>Start from a document</h2><p class="caption">Create a study folder, then use <em>Understand study</em> to draft it from your protocol or manuscript. Real data stays under <code>private/studies/</code>, which git ignores.</p><label class="field">Folder name<input id="new-study-name" placeholder="e.g. my-unity-study"></label><div class="actions">${btn("create-study", "Create study", primary === null)}</div></article>`;
  return (
    heading("OPEN A STUDY", "Which study are you working on?", "Each study is a folder with its description, agent configurations, campaigns and runs. Everything is saved, so you can stop and continue at any step.") +
    `<div class="study-grid">${newStudy}${own.map(card).join("")}</div>` +
    (examples.length
      ? `<h2 class="group-title">Example suites</h2><p class="caption group-caption">Synthetic studies for trying the framework end to end. Their participants and data are invented.</p><div class="study-grid">${examples.map(card).join("")}</div>`
      : "")
  );
}

function renderStudy() {
  if (!study || !ws) return "";
  const s = study;
  const choice = (kind: string, id: string, value: string, options: string[]) =>
    `<select data-edit="${kind}" data-id="${esc(id)}" aria-label="${esc(kind)} ${esc(id)}">${[...new Set([...options, value])].map((x) => `<option ${x === value ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>`;
  const input = (edit: string, id: string, value: string | number, type = "text") =>
    `<input type="${type}" ${type === "number" ? 'step="0.05" min="0"' : ""} data-edit="${edit}" data-id="${esc(id)}" value="${esc(value)}" aria-label="${esc(edit + " " + id)}">`;
  const orders = new Map<string, string[]>();
  s.participants.forEach((p) => {
    const k = p.conditionOrder.map((c) => s.conditions.find((x) => x.id === c)?.label ?? c).join(" → ");
    orders.set(k, [...(orders.get(k) ?? []), p.id]);
  });
  const covariates = s.sources.filter((x) => ["demographics", "objective-records", "trajectory"].includes(x.kind));
  const u = understanding;
  const next = studyNext();
  return (
    heading("1 · PLANNER", "Understand the study and its variables.", "Start from your protocol, documentation or manuscript. The assistant drafts the designs, measures, participant information and the study brief agents read; you check and tune them here.") +
    withheld +
    `<div class="card"><h2>Understand study</h2><p class="caption">Upload the document (PDF, DOCX, Markdown or text) and, if you have it, a participants file with IDs and the order each person experienced the designs (CSV columns <code>participant,order</code>). No answers are needed here. The assistant is ${esc(settings?.assistant.kind)} · ${esc(settings?.assistant.model)} (change in Settings).</p>
    <div class="actions">${btn("pick-doc", doc ? `Document: ${esc(doc.name)}` : "Choose document", next === "pick-doc")}${btn("pick-participants", participantsCsv ? "Participants file loaded" : "Choose participants file")}${btn("understand", "Understand study", next === "understand", doc ? "" : 'disabled title="Choose a document first"')}</div>${studyUnderstood() && !doc ? '<p class="caption">This study is already described below. Use a document only to draft it again.</p>' : ""}${
      u
        ? `<div class="divider"></div><h3>Draft from the document</h3><div class="table-scroll"><table><thead><tr><th>Fact</th><th>Value</th><th>Quote in the document</th></tr></thead><tbody>${Object.entries(u.reading.facts)
            .map(([k, f]) => `<tr><td>${esc(k)}</td><td class="wrap">${esc(f.value || "—")}</td><td class="wrap quote">${esc(f.quote || "")}</td></tr>`)
            .join("")}</tbody></table></div>${u.questions.length ? `<div class="notice"><strong>Open questions</strong><ul>${u.questions.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>` : ""}<p class="caption">Draft: ${u.study.conditions.length} designs, ${u.study.outcomes.length} measures, ${u.study.participants.length} participants. ${u.valid ? "" : "It is not complete yet; resolve the questions first."}</p>${
            u.brief
              ? `<h3>Study brief (what every configuration gets)</h3><p class="caption">The task, designs, procedure and measures as participants experienced them, without any results. Edit it as needed; it is saved with the study as agent-brief.md.</p><label class="field">Brief (Markdown)<textarea id="ud-brief" rows="14">${esc(u.brief.text)}</textarea></label>${leakNotice(u.brief.check, "Remove the study's results from the brief before using it.")}`
              : `<p class="caption warn">No study brief was drafted. Write it on Evidence &amp; knowledge before running agents.</p>`
          }<div class="actions">${btn("use-draft", u.brief ? "Use this draft and brief for this study" : "Use this draft for this study", true)}${btn("discard-draft", "Discard draft")}</div>`
        : ""
    }${briefDraft !== null ? '<p class="caption">The drafted study brief is saved with the study when you press Save study.</p>' : ""}</div>
    <div class="grid"><section><div class="card"><h2>Study</h2><label class="field">Title<input data-edit="title" data-id="study" value="${esc(s.title)}"></label><label class="field">Research questions about the human study (every agent gets them)<textarea data-edit="rq" data-id="study" rows="4">${esc(s.researchQuestion)}</textarea></label>${(ws.warnings ?? []).filter((w) => w.startsWith("The research question")).map((w) => `<p class="caption warn">${esc(w)}</p>`).join("")}
    <label class="field">Questions about the agents (never sent to agents)<textarea data-edit="agent-questions" data-id="study" rows="2" placeholder="e.g. Which agent configurations reproduce these differences?">${esc(s.agentQuestions ?? "")}</textarea></label>
    <label class="field">Title agents see<input data-edit="agent-title" data-id="study" value="${esc(s.agentTitle ?? "")}" placeholder="An XR user study"></label><p class="caption">Agents never see the study's own title, which may name the result or the data (such as "synthetic"). Leave this empty for the neutral "An XR user study".</p>
    <div class="row"><label class="field">Design<select data-edit="design" data-id="study"><option value="within-subjects" ${s.design === "within-subjects" ? "selected" : ""}>Within-subjects</option><option value="between-subjects" ${s.design === "between-subjects" ? "selected" : ""}>Between-subjects</option></select></label><label class="field">Forecast timing<select data-edit="timing" data-id="study"><option value="after-experience" ${s.predictionTiming === "after-experience" ? "selected" : ""}>After the study (measured data may be inputs)</option><option value="before-experience" ${s.predictionTiming === "before-experience" ? "selected" : ""}>Before (no measured data as input)</option></select></label></div>
    <div class="row"><label class="field">Engine<select data-edit="engine" data-id="study">${["unreal", "unity", "custom"].map((v) => `<option ${s.runtime.engine === v ? "selected" : ""}>${v}</option>`).join("")}</select></label><label class="field">Agent observation<select data-edit="observation" data-id="study"><option value="mono" ${s.runtime.observation === "mono" ? "selected" : ""}>Single image (mono)</option><option value="stereo-pair" ${s.runtime.observation === "stereo-pair" ? "selected" : ""}>Left/right pair (stereo)</option></select></label></div>
    <label class="field">Device<input data-edit="device" data-id="study" value="${esc(s.runtime.deviceProfile)}"></label>${webxrProfileHint()}${webxrStereoHint()}</div></section>
    <aside><div class="card"><h2>At a glance</h2><div class="fact"><span>Designs (independent variable)</span><strong>${s.conditions.length}</strong></div><div class="fact"><span>Measures (dependent variables)</span><strong>${s.outcomes.length}</strong></div><div class="fact"><span>Participants</span><strong>${s.participants.length}</strong></div><div class="fact"><span>Participant information</span><strong>${covariates.length}</strong></div><div class="fact"><span>Approval</span><strong>${ws.approval.current ? "approved" : ws.approval.approved ? "changed since approval" : "not yet"}</strong></div></div></aside></div>
    <div class="card"><h2>Independent variables</h2><p class="caption">Designs people experienced (levels of the manipulated variable). Participant background agents may be given is managed on <strong>Evidence &amp; knowledge</strong>.</p><div class="table-scroll"><table class="edit-table"><thead><tr><th>Design ID</th><th>Label</th><th>Tasks</th></tr></thead><tbody>${s.conditions
      .map((c) => `<tr><td>${esc(c.id)}</td><td>${input("condition", c.id, c.label)}</td><td class="wrap">${esc(s.cases.filter((x) => x.conditionId === c.id).map((x) => x.label).join(" · "))}</td></tr>`)
      .join("")}</tbody></table></div>${
      covariates.length
        ? `<div class="table-scroll"><table><thead><tr><th>Participant information</th><th>Kind</th><th>Allowed fields</th></tr></thead><tbody>${covariates.map((c) => `<tr><td>${esc(c.label)}</td><td>${esc(c.kind)}</td><td>${esc(c.fields?.join(", ") ?? "—")}</td></tr>`).join("")}</tbody></table></div>`
        : ""
    }</div>
    <div class="card"><h2>Dependent variables</h2><p class="caption">What was measured. Each agent configuration predicts some of these; with forecasts after the study, a configuration may also receive some of them as measured inputs (a dependent variable used as an independent one). Family weight is shared by the measures of a family. A range (for example 1–7) is optional: values outside it are refused and intervals are clipped to it. A count is a whole number per person (for example collisions).</p>${ws.studyWarnings?.length ? `<div class="notice">${ws.studyWarnings.map((w) => esc(w)).join("<br>")}</div>` : ""}<div class="table-scroll"><table class="edit-table"><thead><tr><th>ID</th><th>Measure</th><th>Domain</th><th>Unit · range</th><th>Scale · mean</th><th>Family</th><th>Family weight</th><th>Weight</th><th></th></tr></thead><tbody>${s.outcomes
      .map(
        (o) =>
          `<tr><td>${esc(o.id)}</td><td>${input("outcome-label", o.id, o.label)}${o.components ? `<small class="items">items (${o.componentWeights ? "weighted " : ""}${o.componentRule === "sum" ? "sum" : "mean"}): ${esc(o.components.join(", "))}</small>` : ""}</td><td>${choice("outcome-domain", o.id, o.domain, ["objective", "subjective"])}</td><td>${input("outcome-unit", o.id, o.unit)}${o.scale === "rank" ? "" : `<input type="text" class="range-input" data-edit="outcome-range" data-id="${esc(o.id)}" value="${o.range ? `${o.range[0]}–${o.range[1]}` : ""}" placeholder="range, e.g. 1–7" title="Lowest and highest possible value (optional). Values outside it are refused; intervals are clipped to it." aria-label="Range of ${esc(o.label)}">`}</td><td>${choice("outcome-scale", o.id, o.scale, ["continuous", "proportion", "ordinal", "rank", "count"])} ${choice("outcome-aggregation", o.id, o.aggregation, ["arithmetic", "geometric"])}</td><td>${esc(o.family)}</td><td>${input("family-weight", o.family, s.analysis.familyWeights[o.family], "number")}</td><td>${input("outcome-weight", o.id, o.weight, "number")}</td><td>${btn(`remove-outcome:${o.id}`, "Remove")}</td></tr>`,
      )
      .join("")}</tbody></table></div></div>
    <div class="card"><h2>Participants and orders</h2><p class="caption">${s.participants.length} people. IDs and design orders only.</p><div class="table-scroll"><table><thead><tr><th>Order</th><th>People</th><th>IDs</th></tr></thead><tbody>${[...orders]
      .map(([o, ids]) => `<tr><td>${esc(o)}</td><td>${ids.length}</td><td class="wrap">${esc(ids.join(", "))}</td></tr>`)
      .join("")}</tbody></table></div></div>
    <div class="actions sticky">${btn("save", unsaved() || briefDraft !== null ? "Save study" : "Saved", next === "save")}${btn("download-study", "Download study.json")}${btn("import-study", "Load study.json")}${btn("goto:evidence", "Evidence & knowledge →", next === "evidence")}</div>`
  );
}
/**
 * The Study page's next sensible step, which alone gets the primary button: choose a document,
 * understand it, use the draft, save, then go on to Evidence & knowledge.
 */
function studyNext(): "pick-doc" | "understand" | "use-draft" | "save" | "evidence" {
  if (understanding) return "use-draft";
  if (!studyUnderstood()) return doc ? "understand" : "pick-doc";
  if (unsaved() || briefDraft !== null) return "save";
  if (doc && !docDrafted) return "understand";
  return "evidence";
}
/** Sentences of a knowledge text that state predictions about measured outcomes (a heuristic): confirm they were written without the results. */
function predictionNotice(check: LeakCheck | null) {
  const found = check?.predictions ?? [];
  if (!found.length) return "";
  return `<div class="notice"><strong>Contains predictions about measured outcomes — confirm it was written without the results.</strong> Every agent that gets this text reads these as given:<ul class="notes">${found.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>Published findings or a model's output are fine; anything that knows how this study turned out is not.</div>`;
}
/** The outcome-blind check of a text agents get, in words (counts only), and any predictions it states. */
function leakNotice(check: LeakCheck | null, fix: string) {
  return check ? leakCounts(check, fix) + predictionNotice(check) : "";
}
function leakCounts(check: LeakCheck, fix: string) {
  if (check.participantIds || check.humanMeanMatches)
    return `<div class="notice">Outcome-blind check: ${check.participantIds ? `names ${check.participantIds} participant ID(s)` : ""}${check.participantIds && check.humanMeanMatches ? "; " : ""}${check.humanMeanMatches ? `${check.humanMeanMatches} number(s) equal a human design mean to two decimals` : ""}. ${esc(fix)} Which numbers match is not shown, so you do not see the results either.</div>`;
  return `<p class="caption ok">Outcome-blind check: no participant IDs${check.checkedAgainstHuman ? ", and no number equals a human design mean to two decimals" : ""}.</p>`;
}

const outcomeName = (id: string) => study?.outcomes.find((o) => o.id === id)?.label ?? id;
function renderConfigs() {
  if (!study || !ws) return "";
  const rt = (id: string) => runtimes.find((r) => r.id === id);
  const engineRuntime = study!.runtime.engine === "unreal" ? "unreal" : study!.runtime.engine === "unity" ? "unity" : "webxr";
  // The runtime a configuration uses: its own, else the study's runtime with the app and none without (as the executor decides).
  const runtimeOf = (a: AgentProtocol) => a.runtime ?? (a.tools.includes("xr-interact") ? engineRuntime : "none");
  const runtimeOptions = (a: AgentProtocol) =>
    [...new Set(["none", engineRuntime, runtimeOf(a)])]
      .map((r) => `<option value="${r}" ${runtimeOf(a) === r ? "selected" : ""}>${r}${rt(r)?.available ? "" : " (not configured)"}</option>`)
      .join("");
  const targetsOf = (a: AgentProtocol) => (a.targets ?? study!.outcomes.map((o) => o.id)).filter((id) => !a.inputs?.includes(id));
  // A configuration that names what the study does not have: the fix on its card is the next step.
  const firstBroken = agents.find(hasUnknown)?.id;
  const block = problemBlock();
  // Other refusals of the saved files (unknown sources, measures and tasks are checked on the card as edited).
  const savedProblem = (id: string) => (ws!.problems ?? []).find((p) => p.configId === id && p.message && !p.unknownSources.length && !p.unknownOutcomes.length && !p.unknownCases.length)?.message ?? null;
  return (
    heading("2 · PLANNER", "Configure the agents.", "Each card is one agent configuration: what it gets, at which level it predicts, with which model and runtime, how often, and which measures it predicts or receives.") +
    `<div class="card"><div class="actions">${btn("apply-default-model", `Use default model for all (${esc(settings?.forecasting.model)})`)}<select id="template" aria-label="Template">${templates()
      .map((t) => `<option value="${t.id}" ${t.missing ? "disabled" : ""}>${t.id}${t.missing ? ` (needs ${t.missing})` : ""}</option>`)
      .join("")}</select>${btn("add-config", "Add from template")}${btn("add-custom", "Add custom configuration")}</div><p class="caption">A template adds a ready-made configuration. A custom one starts from the brief only; choose below what it gets, for example a second evidence source. <strong>Duplicate</strong> copies a configuration so you can change one thing, such as which evidence it reads.</p></div>${capabilityNotice()}
    <div class="config-list">${agents
      .map((a) => {
        const r = rt(runtimeOf(a));
        const tg = targetsOf(a);
        const level = a.level ?? study!.predictionLevel;
        return `<article class="card config-card"><div class="card-heading"><div><div class="eyebrow">${esc(a.id)}</div><input class="title-input" aria-label="Configuration name" data-cfg="${esc(a.id)}" data-field="label" value="${esc(a.label)}"></div><div class="actions">${btn(`duplicate-config:${a.id}`, "Duplicate")}${btn(`remove-config:${a.id}`, "Remove")}</div></div><p class="caption">${esc(a.rationale)}</p>${
          hasUnknown(a)
            ? `<div class="notice problem">${esc(unknownText(a))}. Saving waits until it is removed (or added back to the study).<div class="actions">${fixButton(a, a.id === firstBroken)}</div></div>`
            : savedProblem(a.id) && ws!.problem
            ? `<div class="notice">In the saved files: ${esc(savedProblem(a.id))}</div>`
            : ""
        }
        <div class="row4"><label class="field">Level<select data-cfg="${esc(a.id)}" data-field="level"><option value="population" ${level === "population" ? "selected" : ""}>Population</option><option value="individual" ${level === "individual" ? "selected" : ""} ${study!.design === "between-subjects" ? "disabled" : ""}>Individual${study!.design === "between-subjects" ? " (needs within-subjects)" : ""}</option></select></label><label class="field">Runs${level === "individual" ? " per person" : ""}<input type="number" min="1" max="${level === "individual" ? 50 : 1000}" data-cfg="${esc(a.id)}" data-field="repetitions" value="${a.repetitions ?? ""}" placeholder="${level === "individual" ? `default ${newRepetitions}` : `default ${Math.max(1, study!.participants.length)} × ${newRepetitions}`}"></label><label class="field">Runtime<select data-cfg="${esc(a.id)}" data-field="runtime">${runtimeOptions(a)}</select></label><label class="field">Token budget per session<input type="number" min="20000" max="50000000" step="1000" data-cfg="${esc(a.id)}" data-field="maxTokens" value="${a.maxTokens ?? ""}" placeholder="no limit"></label></div><p class="caption">All tokens a session uses: input (including cache) and output; at least 20,000. When what is left is under 10% of it, or under 3.5 × the last turn (the submission, a possible second one and the closing turn each re-read the context), the tools stop and the agent submits. A submitting session is never stopped for its budget (it has 3 attempts); one still calling other tools above 150% is stopped, and none after its forecast was accepted. ${a.maxTokens ? `${fmtTokensLong(a.maxTokens)} tokens.` : "Empty = no limit."}</p>${tokenNote(a)}
        <div class="row3"><label class="field">Provider<input data-cfg="${esc(a.id)}" data-field="provider" value="${esc(a.model.provider)}"></label><label class="field">Model<input data-cfg="${esc(a.id)}" data-field="model" value="${esc(a.model.model)}"></label><label class="field">Effort${effortSelect(`data-cfg="${esc(a.id)}" data-field="reasoning"`, a.model.reasoning)}</label></div>
        <div class="mini-title">The agent gets</div><div class="config-picks">${study!.sources
          .map((src) =>
            // Movement recordings are per participant: a population forecast would get none.
            src.kind === "trajectory" && level !== "individual" && !a.sourceIds.includes(src.id)
              ? `<label class="check disabled"><input type="checkbox" disabled> ${esc(src.label)} <small>(movement recordings: individual configurations only)</small></label>`
              : `<label class="check"><input type="checkbox" data-src="${esc(a.id)}|${esc(src.id)}" ${a.sourceIds.includes(src.id) ? "checked" : ""}> ${esc(src.label)} <small>(${esc(src.kind)}${src.fields?.length ? `: ${esc(src.fields.join(", "))}` : ""})</small></label>`,
          )
          .join("")}${study!.cases.length ? `<label class="check"><input type="checkbox" data-app="${esc(a.id)}" ${a.tools.includes("xr-interact") ? "checked" : ""}> the running app <small>(${esc(study!.runtime.observation)} screenshots, does the tasks)</small></label>` : ""}</div>${ws!.missingSources?.[a.id]?.length ? `<p class="caption warn">Cannot run as an agent yet: ${esc(ws!.missingSources[a.id].join(", "))} is missing or incomplete (see Evidence &amp; knowledge).</p>` : ""}${a.inputs?.length ? `<p class="caption">Also measured ${a.inputs.map(outcomeName).map(esc).join(", ")} from the human data (you do not see the values).</p>` : ""}
        <details data-key="tools-${esc(a.id)}"><summary data-key="tools-${esc(a.id)}">Advanced: tool-call limit</summary><label class="field">Tool-call limit (safety cap; the forecast is not counted)<input type="number" min="0" data-cfg="${esc(a.id)}" data-field="maxToolCalls" value="${a.maxToolCalls}"></label>${budgetNote(a)}</details>
        ${r && !r.available && a.tools.includes("xr-interact") ? `<div class="notice">${esc(r.message)}</div>` : ""}
        <details data-key="targets-${esc(a.id)}"><summary data-key="targets-${esc(a.id)}">Predicts ${tg.length} of ${study!.outcomes.length} measures${a.inputs?.length ? ` · ${a.inputs.length} given as input` : ""}</summary><div class="table-scroll"><table><thead><tr><th>Measure</th><th>Predict</th><th>Give as measured input</th></tr></thead><tbody>${study!.outcomes
          .map(
            (o) =>
              `<tr><td>${esc(o.label)} <span class="domain-label ${o.domain}">${o.domain}</span></td><td><input type="checkbox" aria-label="Predict ${esc(o.label)}" data-target="${esc(a.id)}|${esc(o.id)}" ${tg.includes(o.id) ? "checked" : ""}></td><td><input type="checkbox" aria-label="Give ${esc(o.label)} as input" data-input="${esc(a.id)}|${esc(o.id)}" ${a.inputs?.includes(o.id) ? "checked" : ""} ${study!.predictionTiming === "before-experience" ? "disabled title='Only for forecasts after the study'" : ""}></td></tr>`,
          )
          .join("")}</tbody></table></div></details></article>`;
      })
      .join("")}</div>
    <div class="card"><h2>Approve</h2><p class="caption">${ws.approval.current ? `Approved ${new Date(ws.approval.approval!.approvedAt).toLocaleString()}.` : ws.approval.approved ? "Changed since approval." : "Not approved yet."} Approval records exactly the saved study and configurations.</p><label class="field">Note (optional)<input id="approve-note" placeholder="e.g. checked measures against the analysis plan"></label><div class="actions">${btn("save", unsaved() ? "Save configurations" : "Saved", !block && unsaved())}${btn("approve", "Approve study and configurations", !block && !unsaved() && !ws.approval.current)}${btn("goto:freeze", "Freeze →", !block && !unsaved() && ws.approval.current)}</div>${
      block
        ? `<p class="caption warn">Saving, approving and freezing wait: ${esc(block)}</p>`
        : ws.problem && !unsaved()
        ? `<p class="caption warn">Approving and freezing wait until the saved configurations fit the study (see the notice at the top).</p>`
        : ""
    }</div>`
  );
}

/** Mirrors defaultRuns in core/planner.ts: individual = runs per participant; population = participants × that. */
const fmtTokensLong = (n: number) => n.toLocaleString("en-US");
/**
 * What a configuration gets: its sources and whether it uses the app. Tools follow from them
 * (project → read files, evidence → read evidence, participant information → participant data,
 * app → XR interaction with the study's tasks), as the planner's validation requires.
 */
function setAccess(a: AgentProtocol, sourceIds: string[], app: boolean) {
  const st = study!;
  const kind = (id: string) => st.sources.find((x) => x.id === id)?.kind;
  const hadApp = a.tools.includes("xr-interact");
  a.sourceIds = st.sources.map((x) => x.id).filter((id) => sourceIds.includes(id));
  a.requiredSourceIds = [...a.sourceIds];
  const tools = new Set<AgentProtocol["tools"][number]>();
  if (a.sourceIds.some((id) => kind(id) === "project")) tools.add("read-files");
  if (app) tools.add("xr-interact");
  if (a.sourceIds.some((id) => kind(id) === "evidence")) tools.add("read-evidence");
  if (a.sourceIds.some((id) => ["demographics", "objective-records", "trajectory"].includes(kind(id) ?? ""))) tools.add("read-participant-data");
  if (a.tools.includes("compute")) tools.add("compute");
  a.tools = [...tools];
  if (hadApp !== app) delete a.runtime; // then: the study's runtime with the app, none without
  if (app && !hadApp) {
    a.observation = st.runtime.observation;
    a.requiredCaseIds = st.cases.filter((c) => ["practice", "exploration", "main"].includes(st.phases.find((ph) => ph.id === c.phaseId)?.kind ?? "")).map((c) => c.id);
    a.maxToolCalls = Math.max(a.maxToolCalls, 150);
    if (a.maxTokens && a.maxTokens < 2_000_000) a.maxTokens = 2_000_000;
  } else if (!app) {
    a.observation = "none";
    a.requiredCaseIds = [];
  }
}
const uniqueConfigId = (base: string) => {
  let id = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "config",
    n = 2;
  const first = id;
  while (agents.some((x) => x.id === id)) id = `${first}-${n++}`;
  return id;
};
/** Same rule as minToolCalls in core/planner.ts: the fewest calls that can complete the protocol. */
function budgetNote(a: AgentProtocol) {
  const st = study!;
  let min = 0;
  const parts: string[] = [];
  if (a.tools.includes("read-files")) {
    const files = a.sourceIds.filter((id) => st.sources.find((s) => s.id === id)?.kind === "project").length;
    if (files) (min += files), parts.push(`${files} file read${files === 1 ? "" : "s"}`);
  }
  if (a.tools.includes("xr-interact")) {
    const cases = a.requiredCaseIds.map((id) => st.cases.find((c) => c.id === id)).filter((c): c is Study["cases"][number] => !!c);
    const designs = new Set(cases.map((c) => c.conditionId)).size;
    const actions = cases.reduce((n, c) => n + Math.max(c.minActions ?? 0, c.requiredActions.length), 0);
    const views = cases.reduce((n, c) => n + (c.observeBeforeEachAction ? Math.max(1, c.minActions ?? 0, c.requiredActions.length) : 1), 0);
    min += designs + actions + views;
    parts.push(`${designs} designs to open`, `${actions} task actions`, `${views} views`);
  }
  const short = a.maxToolCalls < min;
  const tight = !short && a.maxToolCalls < min * 1.5;
  if (!min) return `<p class="caption">Needs no tool calls besides submitting the forecast, which the budget does not count.</p>`;
  return `<p class="caption ${short ? "warn" : ""}">The protocol needs at least ${min} tool call${min === 1 ? "" : "s"} (${parts.join(", ")}); submitting the forecast is not counted.${short ? " The budget is too small to finish it." : tight ? " Little room is left to look around or read more." : ""}</p>`;
}
/** Required capabilities the app or a runtime does not declare (saved study and workspace.json; from the server). */
const capabilityNotice = () => (ws?.capabilityWarnings?.length ? `<div class="notice">${ws.capabilityWarnings.map((w) => esc(w)).join("<br>")}</div>` : "");
/** Configurations whose token budget is likely too small for their fewest tool calls. */
const tokenShort = () => agents.filter((a) => a.maxTokens && minCalls(a) && a.maxTokens < tokensForCalls(minCalls(a)));
/** Same estimate as tokensForCalls in core/planner.ts (TOKEN_ESTIMATE): one call per turn, a 6,000-token start, +800 per call, 300 out per turn, 90% usable. */
const tokensForCalls = (calls: number) => {
  const turns = Math.max(0, calls) + 2;
  return Math.ceil((turns * 6300 + (800 * turns * (turns - 1)) / 2) / 0.9);
};
const callsForTokens = (budget: number) => {
  let calls = 0;
  while (tokensForCalls(calls + 1) <= budget && calls < 100_000) calls++;
  return tokensForCalls(0) <= budget ? calls : 0;
};
/** Fewest tool calls of a configuration (same rule as budgetNote and minToolCalls). */
function minCalls(a: AgentProtocol) {
  const st = study!;
  let min = a.tools.includes("read-files") ? a.sourceIds.filter((id) => st.sources.find((s) => s.id === id)?.kind === "project").length : 0;
  if (a.tools.includes("xr-interact")) {
    const cases = a.requiredCaseIds.map((id) => st.cases.find((c) => c.id === id)).filter((c): c is Study["cases"][number] => !!c);
    min += new Set(cases.map((c) => c.conditionId)).size;
    min += cases.reduce((n, c) => n + Math.max(c.minActions ?? 0, c.requiredActions.length), 0);
    min += cases.reduce((n, c) => n + (c.observeBeforeEachAction ? Math.max(1, c.minActions ?? 0, c.requiredActions.length) : 1), 0);
  }
  return min;
}
/** Whether the token budget is likely too small for the fewest tool calls (a warning; see tokenBudgetWarning in core/planner.ts). */
function tokenNote(a: AgentProtocol) {
  const min = minCalls(a);
  if (!a.maxTokens || !min) return "";
  const needed = tokensForCalls(min);
  if (a.maxTokens >= needed) return `<p class="caption">This budget allows about ${callsForTokens(a.maxTokens)} tool calls; the tasks need at least ${min}.</p>`;
  return `<p class="caption warn">This budget allows about ${callsForTokens(a.maxTokens)} tool calls; the tasks need at least ${min} (about ${fmtTokensLong(Math.ceil(needed / 100_000) * 100_000)} tokens: every call re-reads the growing context). Raise it, or expect forecasts submitted without the required tasks.</p>`;
}
const isIndividual = (a: AgentProtocol) => (a.level ?? study!.predictionLevel) === "individual";
const defaultRunsOf = (a: AgentProtocol) => (isIndividual(a) ? newRepetitions : Math.max(1, study!.participants.length) * newRepetitions);
const runsOf = (a: AgentProtocol) => a.repetitions ?? defaultRunsOf(a);

/** All campaigns of the study as a tree (continuations under their parent), with labels, progress and cost. */
function campaignHistory() {
  if (!ws || !ws.campaigns.length) return `<div class="card"><h2>Campaigns</h2><p class="caption">None yet.</p></div>`;
  const children = new Map<string | null, CampaignInfo[]>();
  for (const c of ws.campaigns) {
    const parent = c.parentId && ws.campaigns.some((x) => x.id === c.parentId) ? c.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), c]);
  }
  const rows: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const c of (children.get(parent) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      // A continuation repeats its parent's design on purpose; only unrelated repeats are flagged.
      const same = ws!.campaigns.some((x) => x.id !== c.id && x.designKey === c.designKey && x.parentId !== c.id && c.parentId !== x.id);
      rows.push(`<tr class="${c.id === campaignId ? "selected-row" : ""}"><td><span class="indent-${Math.min(depth, 4)}">${depth ? "↳ " : ""}</span><input class="label-input" data-campaign-label="${esc(c.id)}" value="${esc(c.label ?? "")}" placeholder="${esc(campaignName({ ...c, label: null }))}" aria-label="Label of campaign ${esc(c.id)}">${c.note ? `<br><span class="small">${esc(c.note)}</span>` : ""}${same ? `<br><span class="small warn">Same configurations as another campaign</span>` : ""}</td><td class="small">${esc(new Date(c.createdAt).toLocaleString())}</td><td>${c.jobs}${c.reused ? `<br><span class="small">${c.reused} reused</span>` : ""}</td><td>${c.done}</td><td>${c.failed}</td><td>${c.notStarted}</td><td>${c.real}${c.simulated ? ` + ${c.simulated} sim` : ""}</td><td>${money(c.costUsd)}</td><td>${c.id === campaignId ? `<button class="button current" data-action="use-campaign:${esc(c.id)}" aria-pressed="true">Shown</button>` : btn(`use-campaign:${c.id}`, "Show", false, 'aria-pressed="false"')} ${btn(`delete-campaign:${c.id}`, "Delete")}</td></tr>`);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return `<div class="card"><h2>Campaigns</h2><p class="caption">Every freeze makes a campaign; continuations appear under the campaign they continue. Type a label to name one. "Show" picks the campaign the executor and analyzer use.</p><div class="table-scroll"><table><thead><tr><th>Label</th><th>Frozen</th><th>Sessions</th><th>Done</th><th>Failed</th><th>Not run</th><th>Real + sim results</th><th>Cost</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>${ws.campaigns.length > 1 ? campaignComparison() : ""}</div>`;
}
/** The two campaigns to compare: chosen ones, else the campaign shown and the one it continues. */
function comparedCampaigns() {
  const list = ws?.campaigns ?? [];
  const after = list.some((c) => c.id === cmpAfter) ? cmpAfter : campaignId && list.some((c) => c.id === campaignId) ? campaignId : list.at(-1)?.id ?? "";
  const parent = campaignOf(after)?.parentId;
  const before = list.some((c) => c.id === cmpBefore) ? cmpBefore : parent && list.some((c) => c.id === parent) ? parent : list.find((c) => c.id !== after)?.id ?? "";
  return { before, after };
}
/** Agreement with humans in two campaigns, per configuration and domain (Freeze & campaigns). */
function campaignComparison() {
  const { before, after } = comparedCampaigns();
  const options = (selectedId: string) => ws!.campaigns.map((c) => `<option value="${esc(c.id)}" ${c.id === selectedId ? "selected" : ""}>${esc(campaignName(c))}</option>`).join("");
  const kind = (k: string, n: number) => (k === "real" ? `${n} real run${n === 1 ? "" : "s"}` : k === "simulated" ? `<span class="warn">${n} simulated run${n === 1 ? "" : "s"}</span>` : k === "unknown" ? `${n} runs` : "no runs");
  const side = (agreement: number | null, model: string | null, k: string, n: number) => `${pct(agreement)}<br><span class="small">${model ? `${esc(model)} · ` : ""}${kind(k, n)}</span>`;
  const status: Record<string, string> = { added: "added", removed: "removed", "setup-changed": "setup changed", "real-vs-simulated": "real vs simulated: not compared" };
  const c = campaignCmp && campaignCmp.before === before && campaignCmp.after === after ? campaignCmp : null;
  const table = c
    ? `<div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Domain</th><th>Before</th><th>After</th><th>Change</th><th>Note</th></tr></thead><tbody>${c.rows
        .map(
          (r) =>
            `<tr><td>${esc(r.afterLabel ?? r.beforeLabel ?? r.conditionId)}</td><td>${esc(r.domain)}</td><td>${r.status === "added" ? "—" : side(r.before, r.beforeModel, r.beforeRunKind, r.beforeRuns)}</td><td>${r.status === "removed" ? "—" : side(r.after, r.afterModel, r.afterRunKind, r.afterRuns)}</td><td>${r.changePercentagePoints == null ? (status[r.status] ? `<span class="small">${esc(status[r.status])}</span>` : "—") : `${r.changePercentagePoints > 0 ? "+" : ""}${r.changePercentagePoints.toFixed(1)} pp`}</td><td class="wrap small">${esc(r.note ?? "")}</td></tr>`,
        )
        .join("")}</tbody></table></div><ul class="notes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : "";
  return `<div class="divider"></div><h3>Compare two campaigns</h3><div class="row"><label class="field">Before<select id="cmp-before">${options(before)}</select></label><label class="field">After<select id="cmp-after">${options(after)}</select></label></div><div class="actions">${btn("compare-campaigns", "Compare campaigns")}</div><p class="caption">Agreement with the human data per configuration. A change is shown only where the setup is the same and both sides rest on the same kind of runs; real runs are never set against simulated ones. Needs human data (human.json).</p>${table}`;
}

function renderFreeze() {
  if (!ws || !study) return "";
  const n = study.participants.length;
  const jobs = agents.reduce((sum, a) => sum + runsOf(a) * (isIndividual(a) ? n : 1), 0);
  const above = agents.filter((a) => !isIndividual(a) && a.repetitions && a.repetitions > n * newRepetitions).map((a) => a.label);
  const next = freezeNext();
  return (
    heading("3 · PLANNER", "Freeze a campaign.", "Freezing locks the study and configurations into a campaign with a fixed list of sessions. Later changes become a continuation that reuses finished runs.") +
    `<div class="freeze-layout"><section><div class="card"><h2>New campaign</h2><div class="row"><label class="field">Runs per participant<input type="number" min="1" max="50" id="new-reps" value="${newRepetitions}"></label><label class="field">Label (optional)<input id="new-label" value="${esc(newLabel)}" placeholder="e.g. pilot A×2, main run"></label></div><p class="caption">For configurations without their own count: individual configurations run ${newRepetitions}× per participant; population configurations get ${n} participants × ${newRepetitions} = ${n * newRepetitions} runs, the same number of forecasts. To fix a configuration's runs (for example fewer, to save usage), type a number in its Runs box below; leave it empty to follow this setting.${above.length ? ` More than ${n * newRepetitions} population runs: ${esc(above.join(", "))}.` : ""}</p><div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Level</th><th>Runs</th><th>Sessions</th></tr></thead><tbody>${agents
      .map((a) => {
        const r = runsOf(a);
        const d = defaultRunsOf(a);
        const source = !a.repetitions ? `auto: follows runs per participant (${d})` : a.repetitions < d ? `fixed, fewer than the default ${d}` : a.repetitions > d ? `fixed, more than the default ${d}` : "fixed, equals the default";
        return `<tr><td>${esc(a.label)}</td><td>${isIndividual(a) ? "individual" : "population"}</td><td><input class="runs-input" type="number" min="1" max="${isIndividual(a) ? 50 : 1000}" data-cfg="${esc(a.id)}" data-field="repetitions" value="${a.repetitions ?? ""}" placeholder="auto" aria-label="Runs for ${esc(a.label)}"> ${isIndividual(a) ? "per participant" : "in total"}<br><span class="small">${source}</span>${ws!.missingSources?.[a.id]?.length ? `<br><span class="small warn">Cannot run as an agent: no file on this machine for ${esc(ws!.missingSources[a.id].join(", "))}</span>` : ""}</td><td>${isIndividual(a) ? `${r} × ${n} participants = ${r * n}` : r}</td></tr>`;
      })
      .join("")}<tr><td colspan="3"><strong>Total</strong></td><td><strong>${jobs}</strong></td></tr></tbody></table></div>${
      agents.some((a) => ws!.missingSources?.[a.id]?.length)
        ? `<div class="notice">Some configurations read a source that has no file on this machine (workspace.json → sources). You can freeze, but the executor will not run them as agents until the file is there: ${esc(agents.filter((a) => ws!.missingSources?.[a.id]?.length).map((a) => a.label).join(", "))}.</div>`
        : ""
    }${
      usesWebxr() && study!.runtime.deviceProfile !== WEBXR_PROFILE && study!.runtime.engine === "custom"
        ? `<div class="notice">The study's device is "${esc(study!.runtime.deviceProfile)}", but the WebXR runtime reports <code>${WEBXR_PROFILE}</code>. App sessions would be listed as protocol deviations. Set the device on the Study page (one click) before freezing.</div>`
        : ""
    }${capabilityNotice()}${
      tokenShort().length
        ? `<div class="notice">The token budget is likely too small for the fewest tool calls of ${esc(tokenShort().map((a) => `${a.label} (about ${callsForTokens(a.maxTokens!)} calls allowed, at least ${minCalls(a)} needed)`).join(", "))}. You can freeze; see Agent configurations → Token budget.</div>`
        : ""
    }${
      // Fairness of what agents get, as last saved (fairness.ts): a configuration comparison should change one ingredient.
      ws.warnings?.length
        ? `<div class="notice"><strong>Before freezing, check what the agents get${unsaved() ? " (as last saved)" : ""}:</strong><ul class="notes">${ws.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></div>`
        : ""
    }${
      agents.every((a) => a.repetitions) ? `<div class="notice">Runs per participant changes nothing here: every configuration has a fixed run count. Clear a Runs box to make it follow runs per participant.</div>` : ""
    }<p class="caption">${agents.length} configurations · ${jobs} sessions. Each session is one fresh agent run. An empty Runs box follows runs per participant; a number fixes it. ${ws.approval.current ? "Approved." : "Not approved yet: you can freeze, but approval documents your review."}</p><div class="actions">${btn("freeze", unsaved() ? "Save changes and freeze" : "Freeze campaign", next === "freeze")}${ws.campaigns.length ? btn("goto:executor", "Run agents →", next === "executor") : ""}${next === "continue" ? btn("goto:continue", "Continue / rerun →", true) : ""}${next === "compare" ? btn("goto:compare", "Compare agents →", true) : ""}</div>${
      next === "continue" ? '<p class="caption">A model changed since the campaign shown was frozen: Continue / rerun makes a new campaign that reuses the finished runs that still match.</p>' : next === "compare" ? '<p class="caption">The campaign shown is complete. Freeze again only for a new, separate campaign.</p>' : ""
    }${unsaved() ? '<p class="caption">You have unsaved changes (here or on Study and Agent configurations). They are saved to the study folder before freezing; an earlier approval then no longer matches.</p>' : ""}</div></section></div>${campaignHistory()}`
  );
}

/**
 * The Freeze page's next step, which alone gets the primary button: fix files that disagree, freeze
 * (nothing frozen yet, changes, or configurations not in the campaign shown), continue after a model
 * change, run the sessions of the campaign shown, or compare once it is complete.
 */
function freezeNext(): "fix" | "freeze" | "continue" | "executor" | "compare" {
  if (problemBlock() || ws!.problem) return "fix";
  const c = campaignOf(campaignId);
  if (!c || unsaved()) return "freeze";
  if (agents.some((a) => !c.models[a.id] && !c.dropped?.includes(a.id))) return "freeze";
  if (modelChanges(c.id).length) return "continue";
  if (c.notStarted || c.failed || c.running) return "executor";
  return "compare";
}
function chosenRunnable() {
  return snapshot?.jobs.filter((j) => chosen.has(j.jobId) && canRun(j)) ?? [];
}
/** Pick a few sessions to run: first k of each checked configuration, or tick sessions in the table. */
function chooser(byConfig: Map<string, JobState[]>) {
  const rows = [...byConfig]
    .map(([id, list]) => {
      const open = list.filter(canRun).length;
      const picked = list.filter((j) => chosen.has(j.jobId) && canRun(j)).length;
      const finished = list.filter((j) => j.status === "done" || j.status === "reused").length;
      return `<tr><td><input type="checkbox" data-pick-config="${esc(id)}" ${pickConfigs.has(id) ? "checked" : ""} aria-label="Choose ${esc(list[0].label)}"></td><td>${esc(list[0].label)}</td><td>${finished}</td><td>${open}</td><td>${picked || ""}</td></tr>`;
    })
    .join("");
  return `<details class="chooser" data-key="chooser" ${chosen.size || pickConfigs.size ? "open" : ""}><summary data-key="chooser">Choose sessions to run, or configurations to rerun</summary>
    <div class="table-scroll"><table><thead><tr><th><span class="sr-only">Choose</span></th><th>Configuration</th><th>Finished</th><th>Not run yet</th><th>Selected</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="row"><label class="field">Sessions per checked configuration<input type="number" id="pick-k" min="1" max="1000" value="${pickK}"></label></div>
    <div class="actions">${btn("pick-first", `Select the first ${pickK} of each checked configuration`)}${btn("pick-clear", "Clear selection")}${btn("rerun-configs", "Rerun the checked configurations")}</div>
    <p class="caption">Only selected sessions start; the others stay "not started" and can run later in the same campaign. You can also tick single sessions in the table. Start shows the exact number and an estimate of the cost first.</p>
    <p class="caption"><strong>Rerun</strong> runs the checked configurations again from scratch, also their finished sessions. Finished runs are never overwritten, so a rerun makes a new campaign that continues this one: the checked configurations get fresh sessions, all others reuse their finished runs, and this campaign stays as it is. Simulated runs are reused only while the mode is Simulate. Nothing starts until you press Start.</p></details>`;
}

/** Sessions shown in the preview: the ones you picked, plus every running one if you ask for that. */
let watched = new Set<string>();
let watchRunning = false;
function shownJobs(): JobState[] {
  return (snapshot?.jobs ?? []).filter((j) => watched.has(j.jobId) || (watchRunning && j.status === "running"));
}
function tokenCell(j: JobState) {
  if (j.tokensIn == null && j.tokensOut == null) return "";
  return `${fmtTokens(j.tokensIn)} / ${fmtTokens(j.tokensOut)}${j.status === "running" ? ' <span class="small">live</span>' : ""}`;
}
/** Cost of a real session; one stopped or killed before Claude Code reported it has an unknown cost. */
function costCell(j: JobState) {
  if (j.simulated) return "";
  if (j.costUsd != null) return money(j.costUsd);
  return (j.status === "stopped" || j.status === "failed") && (j.tokensIn != null || j.tokensOut != null) ? '<span class="small">cost unknown (stopped before the end)</span>' : "";
}
/** One previewed session: status, live tokens, latest screenshot and messages; details when it is the only one. */
function previewTile(j: JobState, single: boolean) {
  const lines = logs.get(j.jobId) ?? [];
  const shown = single ? lines : lines.slice(-4);
  const attempts =
    single && attemptsOf?.jobId === j.jobId && attemptsOf.attempts.length
      ? `<table class="attempts"><thead><tr><th>Attempt</th><th>Result</th><th>Tools</th><th>Tokens in / out</th><th>Cost</th></tr></thead><tbody>${attemptsOf.attempts
          .map((x) => `<tr><td>a${x.attempt}${x.counts ? " <strong>counts</strong>" : ""}</td><td>${esc(x.status)}${x.simulated ? " · sim" : ""}${x.error ? `<br><span class="small">${esc(x.error.slice(0, 160))}</span>` : ""}</td><td>${x.toolCalls || ""}</td><td>${x.tokensIn != null || x.tokensOut != null ? `${fmtTokens(x.tokensIn)} / ${fmtTokens(x.tokensOut)}` : ""}</td><td>${x.cost ? `<span class="small">cost ${esc(x.cost)}</span>` : money(x.costUsd)}</td></tr>`)
          .join("")}</tbody></table><p class="caption">The first completed attempt counts; the others are kept in the job folder. Tools: calls before the forecast (submitting it is not counted).</p>`
      : "";
  return `<div class="card preview-tile"><div class="card-heading"><div><h3>${esc(j.label)}</h3><p class="caption">${j.participantId ? esc(j.participantId) + " · " : ""}r${j.repetition} · ${esc(j.runtime)} · <span class="status ${j.status}">${j.status === "not-started" ? "not started" : j.status}${j.simulated ? " · sim" : ""}</span></p></div>${btn(`preview-close:${j.jobId}`, "×", false, 'aria-label="Close this preview"')}</div>
    <p class="caption">${j.toolCalls ? `${j.toolCalls} tool calls (the forecast not counted) · ` : ""}${j.simulated ? "simulated, no tokens" : j.tokensIn != null || j.tokensOut != null ? `tokens ${fmtTokens(j.tokensIn)} in / ${fmtTokens(j.tokensOut)} out${j.status === "running" ? " (live)" : ""}` : "no tokens yet"}${costCell(j) ? ` · ${costCell(j)}` : ""}${j.warning ? ` · <span class="warn">${esc(j.warning)}</span>` : ""}</p>
    ${attempts}${single && canRun(j) && !snapshot?.running ? `<div class="actions">${btn(`exec-one:${j.jobId}`, "Run this session only")}</div>` : ""}${j.screenshot ? `<img class="shot" alt="Latest screenshot the agent saw" src="/api/workspace/file?id=${encodeURIComponent(ws!.id)}&campaign=${encodeURIComponent(campaignId!)}&path=${encodeURIComponent(j.screenshot)}">` : ""}<div class="log">${shown.map((l) => `<p>${esc(l)}</p>`).join("") || '<p class="caption">Live messages appear here while the session runs.</p>'}</div></div>`;
}

/** Paused means sessions wait in the queue; with nothing waiting or running the executor is idle. */
function queueState(s: Snapshot | null) {
  // Parallel sessions hold across campaigns: say so when another campaign has the free slots.
  if (s && !s.paused && s.waiting) return ` · ${esc(s.waiting.replace(/\.$/, "").replace(/^W/, "w"))}`;
  if (!s || !s.paused) return "";
  if (s.queued || s.counts.queued) return " · paused";
  return s.running ? " · pausing: running sessions finish" : " · idle";
}
/** Resume continues only the sessions waiting after Pause; stopped ones run again with Rerun failed (which asks first). */
function resumeButton(s: Snapshot | null) {
  const waiting = s?.paused ? s.queued : 0;
  return waiting
    ? btn("exec-resume", `Resume (${waiting} waiting)`)
    : btn("exec-resume", "Resume", false, 'disabled title="Resume continues sessions that wait after Pause. Stopped or failed sessions run again with Rerun failed."');
}
/** Run agents or Simulate, as two clear choices. Research studies start in Run agents, synthetic ones in Simulate. */
function modeChoice() {
  const opt = (value: typeof mode, title: string, text: string) =>
    `<label class="mode-option ${mode === value ? "chosen" : ""}"><input type="radio" name="exec-mode" value="${value}" ${mode === value ? "checked" : ""}> <span><strong>${title}</strong><br><span class="small">${text}</span></span></label>`;
  return `<fieldset class="mode-choice"><legend>Mode</legend>${opt("agent", "Run agents", "Fresh Claude Code sessions with your login. Uses your Claude usage; Start asks first.")}${opt("simulate", "Simulate", study?.synthetic ? "Invented forecasts to try the pipeline at no cost. No model is called." : "Invented forecasts to try the pipeline at no cost. Labelled simulated and never scored against this study's human data.")}</fieldset>`;
}
// The button names stay "Start …" (as the docs say); the mode choice above says what starts.
const startLabel = (n: number, selection: boolean) => `${selection ? "Start selected" : "Start all not run yet"} (${n})`;
/** Start: off when nothing is left to run (every session finished, running or reused). */
function startButton(s: Snapshot | null) {
  const selection = !!chosenRunnable().length;
  const n = chosenRunnable().length || (s?.jobs.filter(canRun).length ?? 0);
  if (!n) return btn("exec-start", startLabel(0, false), false, 'disabled title="Nothing to run: every session is finished, running or reused."');
  return btn("exec-start", startLabel(n, selection), executorNext(s) === "start");
}
/** The executor's next sensible step, which gets the primary button. */
function executorNext(s: Snapshot | null): "start" | "rerun" | "analyze" | null {
  if (!s) return null;
  const n = (k: string) => s.counts[k] ?? 0;
  if (n("running") || n("queued")) return null;
  if (chosenRunnable().length || n("not-started")) return "start";
  if (n("failed") + n("stopped")) return "rerun";
  return "analyze";
}
function renderExecutor() {
  if (!ws) return "";
  if (!campaignId) return heading("4 · EXECUTOR", "Run agents.", "") + `<div class="notice">Freeze a campaign first.</div>`;
  const s = snapshot;
  const counts = s?.counts ?? {};
  const total = s?.jobs.length ?? 0;
  const byConfig = new Map<string, JobState[]>();
  s?.jobs.forEach((j) => byConfig.set(j.agentId, [...(byConfig.get(j.agentId) ?? []), j]));
  // Pause and Stop act on sessions that run or wait; with none they are off (no "Paused" while idle).
  const active = !!(s && (s.running || s.queued || counts.running || counts.queued));
  // SVG, because the page's security policy blocks inline style attributes.
  const colors: Record<string, string> = { done: "#3f9b6b", reused: "#9cc5ad", running: "#4c78a8", failed: "#c8564b", stopped: "#d9a441", queued: "#b9c9d9", "not-started": "#e8ebe6" };
  let x = 0;
  const bar = `<svg class="progress-svg" viewBox="0 0 1000 10" preserveAspectRatio="none" role="img" aria-label="Progress: ${esc(Object.entries(counts).map(([k, v]) => `${v} ${k === "not-started" ? "not started" : k}`).join(", ") || "no sessions")}">${["done", "reused", "running", "failed", "stopped", "queued", "not-started"]
    .map((k) => {
      if (!counts[k] || !total) return "";
      const w = (counts[k] / total) * 1000;
      const r = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="10" fill="${colors[k]}"><title>${k}: ${counts[k]}</title></rect>`;
      x += w;
      return r;
    })
    .join("")}</svg>`;
  return (
    heading("4 · EXECUTOR", "Run the agent sessions.", "Each session is a fresh, locked-down agent with only its configuration's information and runtime. Progress arrives live from every run. Save the runs as a zip at any time and hand it to the analyzer.") +
    campaignBar() +
    nextStep() +
    `<div class="runtime-grid">${runtimes
      .filter((r) => showAllRuntimes || usedRuntimes().has(r.id))
      .map((r) => `<div class="card runtime ${r.available ? "ok" : "off"}"><strong>${esc(r.label)}</strong><p class="caption">${esc(r.message)}</p></div>`)
      .join("")}</div><p class="caption">${showAllRuntimes ? "All runtimes. " : "The runtimes this campaign uses. "}${btn("toggle-runtimes", showAllRuntimes ? "Show only this study's" : "Show all runtimes")}</p>
    ${studyInputs()}
    <div class="card"><div class="card-heading"><div><h2>${esc(campaignName(campaignOf(campaignId)))}</h2><p>${total} sessions · ${counts.done ?? 0} done · ${counts.reused ?? 0} reused${reusedNote(s)} · ${counts.running ?? 0} running · ${counts.queued ?? 0} waiting to start · ${counts.failed ?? 0} failed · ${counts.stopped ?? 0} stopped · ${counts["not-started"] ?? 0} not started${queueState(s)}</p></div>${s && (s.running || counts.queued) ? `<span class="tag">${s.mode === "agent" ? "agents running" : "simulating"}</span>` : ""}</div>${bar}
    ${modeChoice()}
    <div class="row"><label class="field">Parallel sessions<input type="number" id="exec-concurrency" min="1" max="8" value="${settings?.concurrency ?? 1}"></label></div>
    ${chooser(byConfig)}
    <div class="actions">${startButton(s)}${active ? btn("exec-pause", "Pause") : btn("exec-pause", "Pause", false, 'disabled title="Nothing is running or waiting."')}${resumeButton(s)}${active ? btn("exec-stop", "Stop") : btn("exec-stop", "Stop", false, 'disabled title="Nothing is running or waiting."')}${(counts.failed ?? 0) + (counts.stopped ?? 0) ? btn("exec-rerun", "Rerun failed", executorNext(s) === "rerun") : btn("exec-rerun", "Rerun failed", false, 'disabled title="No session failed or was stopped."')}${btn("exec-export", "Save runs as zip")}${btn("exec-import", "Load runs zip")}${executorNext(s) === "analyze" ? btn("goto:compare", "Compare agents →", true) : ""}</div>
    <p class="caption">${study?.synthetic ? "Simulated runs are labelled, and never pooled with real runs of the same configuration." : "This is a research study: simulated runs only test the pipeline. They are labelled and never scored against the human data."} Agent runs use your Claude usage; the start button asks first.</p></div>
    <div class="preview-bar"><label class="check"><input type="checkbox" id="watch-running" ${watchRunning ? "checked" : ""}> Preview all running sessions</label>${shownJobs().length ? btn("preview-none", "Close previews") : ""}<span class="small">Click a session (or focus it and press Enter or Space) to preview it; Ctrl/⌘ or Shift with it previews several; again closes it.</span></div>
    <div class="exec-layout ${shownJobs().length ? (shownJobs().length > 1 ? "multi" : "") : "no-preview"}"><div class="card job-table"><div class="table-scroll"><table><thead><tr><th><span class="sr-only">Choose</span></th><th>Configuration</th><th>Job</th><th>Status</th><th title="Tool calls before the forecast; submitting the forecast is not counted">Tools</th><th>Last step</th><th>Tokens in / out</th><th>Cost</th></tr></thead><tbody>${[...byConfig]
      .map(([, list]) =>
        configSum(list) +
        list
          .map(
            (j, i) =>
              `<tr class="${shownJobs().some((x) => x.jobId === j.jobId) ? "selected-row" : ""}" data-job="${esc(j.jobId)}" tabindex="0" aria-selected="${shownJobs().some((x) => x.jobId === j.jobId)}"><td>${canRun(j) ? `<input type="checkbox" data-pick-job="${esc(j.jobId)}" ${chosen.has(j.jobId) ? "checked" : ""} aria-label="Choose ${esc(j.label)} ${esc(j.jobId)}">` : ""}</td><td>${i === 0 ? esc(j.label) : ""}</td><td>${j.participantId ? esc(j.participantId) + " · " : ""}r${j.repetition}${j.attempts > 1 ? ` (a${j.attempts})` : ""}</td><td><span class="status ${j.status}">${j.status === "not-started" ? "not started" : j.status === "queued" ? "waiting" : j.status}${j.simulated ? " · sim" : ""}</span></td><td>${j.toolCalls || ""}</td><td class="wrap small">${j.warning ? `<span class="warn">${esc(j.warning)}</span>${j.error || j.lastTool ? "<br>" : ""}` : ""}${esc(j.error ?? j.lastTool ?? "")}</td><td>${j.simulated ? '<span class="small">— (simulated)</span>' : tokenCell(j)}</td><td>${costCell(j)}</td></tr>`,
          )
          .join(""),
      )
      .join("")}</tbody></table></div></div>
    ${shownJobs().length ? `<div class="job-detail ${shownJobs().length > 1 ? "tiles" : ""}">${shownJobs().map((x) => previewTile(x, shownJobs().length === 1)).join("")}</div>` : ""}</div>`
  );
}

/** Analyzer, page 1: configurations against each other. Needs no human data. */
function renderCompareAgents() {
  if (!ws) return "";
  if (!campaignId) return heading("5 · ANALYZER", "Compare agents.", "") + `<div class="notice">Freeze a campaign and run or simulate it first.</div>`;
  return (
    heading("5 · ANALYZER", "Compare agents.", "Configurations against each other: how consistent their runs are, how far they agree on the design pattern, and what they cost. Needs no human data.") +
    campaignBar() +
    renderAgentCmp()
  );
}
/**
 * Compare with humans: the one primary button follows the next step — analyze the campaign, then
 * draw a figure. Without human data only the human card could help, and it has nothing to show.
 */
function analyzerNext(): "analyze" | "draw" | "draw-human" | null {
  if (!ws?.hasHuman) return null;
  if (!analysis) return "analyze";
  if (!figureSvg && !figureData?.empty) return "draw";
  return null;
}
/** Analyzer, page 2: human data on its own, and agents against the humans. */
function renderAnalyzer() {
  if (!ws) return "";
  if (!campaignId) return heading("6 · ANALYZER", "Compare with humans.", "") + `<div class="notice">Freeze a campaign first. Human results stay hidden while the study and configurations are planned.</div>`;
  return (
    heading("6 · ANALYZER", "Compare with humans.", "The human participants' data on its own, and each configuration's forecasts against it.") +
    campaignBar() +
    humanCard() +
    renderHumans()
  );
}

function renderAgentCmp() {
  if (!agentCmp || agentCmp.campaignId !== campaignId)
    return `<div class="card"><div class="actions">${btn("compare-agents", "Compare agents", true)}${btn("exec-import", "Load runs zip")}</div><p class="caption">Uses the finished runs of the campaign shown (including reused ones). Needs no human data, so it is useful while piloting.</p></div>`;
  const c = agentCmp;
  const label = (id: string) => c.configs.find((x) => x.id === id)?.label ?? id;
  const pct1 = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);
  const num = (x: number | null, d = 1) => (x == null ? "—" : x.toFixed(d));
  const rows = c.configs
    .map(
      (x) =>
        `<tr><td>${esc(x.label)}</td><td>${esc(x.level)}</td><td>${esc(x.model)}</td><td>${x.real} real${x.simulated ? ` + ${x.simulated} sim` : ""} / ${x.assigned}${x.basis === "simulated" ? '<br><span class="small">simulated only</span>' : x.real && x.simulated ? '<br><span class="small">simulated left out</span>' : ""}</td><td>${x.deviations || ""}</td><td>${pct1(x.consistency[domain])}${x.consistencyPairs ? `<br><span class="small">${x.consistencyPairs} pairs</span>` : ""}</td><td>${num(x.meanToolCalls)}</td><td>${x.meanFilesRead == null ? "—" : `${num(x.meanFilesRead)}${x.runsWithoutReads ? `<br><span class="small warn">${x.runsWithoutReads} run${x.runsWithoutReads === 1 ? "" : "s"} read none</span>` : ""}`}</td><td>${num(x.meanWallMinutes)}</td><td>${money(x.meanCostUsd)}</td><td>${money(x.totalCostUsd)}</td></tr>`,
    )
    .join("");
  const ids = c.configs.map((x) => x.id);
  const cell = (a: string, b: string) => {
    if (a === b) return `<td class="heat-self">—</td>`;
    const p = c.pairs.find((x) => x.domain === domain && ((x.a === a && x.b === b) || (x.a === b && x.b === a)));
    const v = p?.agreement ?? null;
    const bucket = v == null ? "none" : String(Math.min(4, Math.floor(v * 5)));
    return `<td class="heat heat-${bucket}" title="${esc(label(a))} vs ${esc(label(b))}: ${p?.outcomes ?? 0} shared outcomes">${pct1(v)}</td>`;
  };
  const matrix = `<div class="table-scroll"><table class="matrix"><thead><tr><th></th>${ids.map((id) => `<th>${esc(label(id))}</th>`).join("")}</tr></thead><tbody>${ids.map((a) => `<tr><th>${esc(label(a))}</th>${ids.map((b) => cell(a, b)).join("")}</tr>`).join("")}</tbody></table></div>`;
  // Simulated runs are named as such: they test the pipeline, not how well agents forecast.
  const simulated = c.configs.filter((x) => x.basis === "simulated").map((x) => x.label);
  const simNotice = simulated.length
    ? `<div class="notice"><strong>Simulated runs:</strong> ${esc(simulated.join(", "))} ${simulated.length === 1 ? "is" : "are"} described by invented forecasts. They test the pipeline, not how well agents forecast${study?.synthetic ? "" : ", and in this research study they are never scored against the human data"}.</div>`
    : "";
  return `${simNotice}<div class="card"><div class="row"><label class="field">Domain<select id="an-domain"><option value="subjective" ${domain === "subjective" ? "selected" : ""}>Subjective</option><option value="objective" ${domain === "objective" ? "selected" : ""}>Objective</option></select></label></div><div class="actions">${btn("compare-agents", "Recompute")}</div>
    <h2>Configurations</h2><div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Level</th><th>Model</th><th>Runs</th><th>Deviations</th><th>Run-to-run agreement</th><th>Tool calls</th><th title="Project files opened per run, for configurations that can read them: a check that the ingredient they add was delivered">Files read</th><th>Minutes</th><th>Cost / session</th><th>Total cost</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h2>Agreement between configurations (${domain})</h2><p class="caption">How often two configurations order each pair of designs the same way, on their average forecasts and the outcomes both predict. 100% = same pattern, 50% = unrelated, 0% = opposite.</p>${matrix}
    <ul class="notes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`;
}

/** Which human design differences the scores use, in words. */
function pairRuleText(a: AnalysisView) {
  // Counted per domain, like the figure: the design pairs of this domain's measures.
  const pairs = (((showSignificantOnly && a.significantOnly ? a.significantOnly.humanPairs : a.humanPairs) ?? []) as HumanPairView[]).filter((p) => a.outcomes.find((o) => o.id === p.outcomeId)?.domain === domain);
  const used = pairs.filter((p) => p.used).length;
  if (a.design === "between-subjects")
    return `Between-subjects: agents are scored only on design pairs where the human groups differ significantly (Mann–Whitney U, Holm within each measure, α = .05): ${used} of ${plural(pairs.length, "design pair")} (${domain} measures). Preference rankings and individual forecasts do not apply.${used ? "" : " Nothing can be scored yet: no difference between the groups is significant. With fewer than 2 people in a group no test is possible, and small groups rarely reach significance."}`;
  if (showSignificantOnly)
    return `Second view: only design pairs with a significant paired human difference (Wilcoxon signed-rank, Holm within each measure, α = .05): ${used} of ${plural(pairs.length, "design pair")} (${domain} measures). Population configurations only.`;
  return "Within-subjects: agents are scored on every difference of the human design means (main analysis).";
}
/** The human design differences per measure, with their test, and whether agents are scored on them. */
function humanPairsCard(a: AnalysisView) {
  const pairs = ((showSignificantOnly && a.significantOnly ? a.significantOnly.humanPairs : a.humanPairs) ?? []).filter((p) => a.outcomes.find((o) => o.id === p.outcomeId)?.domain === domain);
  if (!pairs.length) return "";
  const label = (id: string) => a.outcomes.find((o) => o.id === id)?.label ?? id;
  const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
  const p = (x: number | null) => (x == null ? "—" : x < 0.001 ? "< .001" : x.toFixed(3).replace(/^0/, ""));
  return `<div class="card"><h2>Human design differences (${domain})</h2><p class="caption">${esc(pairs[0].test)} for every pair of designs; Holm-adjusted within each measure. "Scored" marks the pairs agents are judged on.</p><div class="table-scroll"><table><thead><tr><th>Measure</th><th>Designs</th><th>Means</th><th>p (Holm)</th><th>Scored</th></tr></thead><tbody>${pairs
    .map((x) => `<tr><td>${esc(label(x.outcomeId))}</td><td>${esc(x.a)} vs ${esc(x.b)}</td><td>${fmt(x.meanA)} vs ${fmt(x.meanB)}</td><td>${p(x.pHolm)}${x.significant ? " *" : ""}</td><td>${x.used ? "yes" : '<span class="small">no</span>'}</td></tr>`)
    .join("")}</tbody></table></div></div>`;
}
/** Absolute values: each population configuration's mean prediction against the human group's 95% CI. */
function absoluteCard(a: AnalysisView) {
  const fit = (a.absoluteFit ?? []).filter((f) => a.outcomes.find((o) => o.id === f.outcomeId)?.domain === domain && (!selected.size || selected.has(f.agentId)));
  if (!fit.length) return "";
  const label = (id: string) => a.configs.find((c) => c.id === id)?.label ?? id;
  const outcome = (id: string) => a.outcomes.find((o) => o.id === id);
  const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2));
  const byAgent = new Map<string, typeof fit>();
  fit.forEach((f) => byAgent.set(f.agentId, [...(byAgent.get(f.agentId) ?? []), f]));
  const rows = [...byAgent]
    .map(([id, list]) => {
      const inside = list.filter((f) => f.inside).length;
      const detail = list
        .map((f) => `<tr class="${f.inside ? "" : "miss"}"><td>${esc(outcome(f.outcomeId)?.label ?? f.outcomeId)}</td><td>${esc(f.conditionId)}</td><td>${fmt(f.agent)}</td><td>${fmt(f.human)} [${fmt(f.low)}, ${fmt(f.high)}]${clippedToScale(study?.outcomes.find((o) => o.id === f.outcomeId)?.scale, study?.conditions.length ?? 0, f.low, f.high, f.degenerate, study?.outcomes.find((o) => o.id === f.outcomeId)?.range) ? ' <span class="small">(clipped to the scale)</span>' : ""}, n = ${f.n}${f.degenerate ? ` <span class="small" title="${esc(f.note ?? "")}">(all gave the same value)</span>` : ""}</td><td>${f.error >= 0 ? "+" : ""}${fmt(f.error)}</td><td>${f.inside ? (f.degenerate ? "exact match" : "inside") : "outside"}</td></tr>`)
        .join("");
      return `<details data-key="abs-${esc(id)}"><summary data-key="abs-${esc(id)}"><strong>${esc(label(id))}</strong>: ${inside} of ${list.length} values inside the human 95% CI</summary><div class="table-scroll"><table><thead><tr><th>Measure</th><th>Design</th><th>Agent (mean of runs)</th><th>Human mean [95% CI]</th><th>Agent − human</th><th></th></tr></thead><tbody>${detail}</tbody></table></div></details>`;
    })
    .join("");
  return `<div class="card"><h2>Absolute values (${domain})</h2><p class="caption">Population configurations: is the mean of the runs' predictions inside the human group's 95% confidence interval (t interval; geometric measures on the log scale; an interval that would pass a bound of its scale, such as 0–1 for proportions, 1–k for mean ranks or a declared range, is cut there and marked "clipped to the scale")? ${a.design === "between-subjects" ? "Between subjects, these group values are what the study compares." : ""}</p>${rows}</div>`;
}

let humanFig: any = null;
let humanSvg = "";
let humanOutcome = "";
/** Human data only: no configuration and no agent run needed. */
function humanCard() {
  if (!ws || !study) return "";
  if (!ws.hasHuman) return `<div class="card"><h2>Human data</h2><p class="caption">This study has no human reference (human.json) yet.</p></div>`;
  const options = study.outcomes.map((o) => `<option value="${esc(o.id)}" ${o.id === (humanOutcome || study!.outcomes[0].id) ? "selected" : ""}>${esc(o.label)} (${o.domain})</option>`).join("");
  const f = humanFig;
  const num = (x: number) => (Number.isFinite(x) ? (Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(2)) : "—");
  const pv = (x: number | null) => (x == null ? "not testable" : x < 0.001 ? "< .001" : x.toFixed(3).replace(/^0/, ""));
  const label = (id: string) => study!.conditions.find((c) => c.id === id)?.label ?? id;
  const tables = f
    ? `<div class="table-scroll"><table><thead><tr><th>Design</th><th>n</th><th>${f.logScale ? "Geometric mean" : "Mean"} [95% CI]</th><th>Median</th>${f.logScale ? "" : "<th>SD</th>"}</tr></thead><tbody>${f.summary
        .map((r: any) => `<tr><td>${esc(r.label)}</td><td>${r.n}</td><td>${num(r.mean)} [${num(r.low)}, ${num(r.high)}]${clippedToScale(f.outcome?.scale, study!.conditions.length, r.low, r.high, r.degenerate, study!.outcomes.find((o) => o.id === f.outcome?.id)?.range) ? ' <span class="small">(clipped to the scale)</span>' : ""}</td><td>${num(r.median)}</td>${f.logScale ? "" : `<td>${num(r.sd)}</td>`}</tr>`)
        .join("")}</tbody></table></div>
      <div class="table-scroll"><table><thead><tr><th>Designs</th><th>Test</th><th>p</th><th>p (Holm)</th></tr></thead><tbody>${f.brackets
        .map((b: any) => `<tr><td>${esc(label(b.a))} vs ${esc(label(b.b))}</td><td>${esc(b.test)}</td><td>${pv(b.p)}</td><td>${pv(b.holm)} ${b.stars}</td></tr>`)
        .join("")}</tbody></table></div><p class="caption">${esc(f.note)}</p>`
    : "";
  return `<div class="card"><h2>Human data</h2><p class="caption">The participants' values per design for one measure, with the test that fits the ${esc(study.design)} design. No configuration or agent run is needed.</p>
    <div class="row"><label class="field">Measure<select id="hu-outcome">${options}</select></label></div>
    <div class="actions">${btn("draw-human", "Show human data", analyzerNext() === "draw-human")}${humanSvg ? btn("save-human-svg", "Save SVG") + btn("save-human-png", "Save PNG") : ""}</div>
    ${humanSvg ? `<div class="figure">${humanSvg}</div>${tables}` : ""}</div>`;
}

/** The analyzer's views. Between subjects there are no individual forecasts, so no participant lines. */
function analyzerViews(a: AnalysisView): [View, string][] {
  const views: [View, string][] = [
    ["agreement", "Agreement"],
    ["agent-vs-human", "Agent vs human"],
    ["correlation", "Correlation"],
    ["population-vs-individual", "Population vs individual"],
    ["trajectories", "Participants"],
  ];
  return a.design === "between-subjects" ? views.filter(([v]) => v !== "trajectories") : views;
}
/**
 * Why nothing can be scored for these configurations in this domain, or null when something can.
 * The Agreement and Population vs individual views then say so instead of plotting empty or zero values.
 */
function nothingScored(a: AnalysisView, ids: string[]): string | null {
  const rows = (showSignificantOnly && a.significantOnly ? a.significantOnly.summaries : a.summaries).filter((s) => s.domain === domain && ids.includes(s.agentId));
  if (rows.some((s) => s.agreement != null)) return null;
  const pairs = ((showSignificantOnly && a.significantOnly ? a.significantOnly.humanPairs : a.humanPairs) ?? []).filter((p) => a.outcomes.find((o) => o.id === p.outcomeId)?.domain === domain);
  if (!rows.length) return `The selected configurations predict no ${domain} measure.`;
  if (pairs.length && !pairs.some((p) => p.used))
    return a.design === "between-subjects"
      ? `Nothing can be scored (${domain}): no difference between the human groups is significant (0 of ${pairs.length} design pairs), so there is no human pattern to agree with. Small groups rarely reach significance.`
      : `Nothing can be scored (${domain}): no human design difference is used (0 of ${pairs.length} pairs).`;
  return `Nothing can be scored (${domain}) for the selected configurations: they have no scoreable run yet${rows.some((s) => s.simulated && !s.real) && !a.synthetic ? " (simulated runs are never scored in a research study)" : ""}.`;
}
function renderHumans() {
  const ws_ = ws!;
  if (!analysis)
    return (
      `<div class="card"><h2>Agents against the humans</h2><p class="caption">Reads the human reference and the finished runs of the campaign shown (including reused runs from earlier campaigns).</p><div class="actions">${btn("analyze", "Analyze campaign", analyzerNext() === "analyze")}${btn("exec-import", "Load runs zip")}</div><p class="caption">Human reference: ${ws_.hasHuman ? "available" : "missing (human.json)"}.</p></div>`
    );
  const a = analysis;
  const level = (id: string) => a.configs.find((c) => c.id === id)?.level;
  const views = analyzerViews(a);
  const outcomeOptions = a.outcomes.map((o) => `<option value="${o.id}" ${o.id === outcomeId ? "selected" : ""}>${esc(o.label)}</option>`).join("");
  const usedPairs = ((showSignificantOnly && a.significantOnly ? a.significantOnly.humanPairs : a.humanPairs) ?? []).filter((p) => p.used && a.outcomes.find((o) => o.id === p.outcomeId)?.domain === domain).length;
  const summaryRows = (showSignificantOnly && a.significantOnly ? a.significantOnly.summaries : a.summaries)
    .filter((s) => s.domain === domain)
    .map((s) => {
      const c = a.configs.find((x) => x.id === s.agentId);
      // Runs that could be scored, next to an agreement of "—": say why nothing was scored.
      const why = s.agreement == null && s.scoreable && !usedPairs ? `<br><span class="small">none scored: no ${a.design === "between-subjects" || showSignificantOnly ? "significant " : ""}design pair</span>` : "";
      return `<tr><td>${esc(c?.label ?? s.agentId)}</td><td>${esc(s.level ?? c?.level)}</td><td>${esc(c?.model.model)}</td><td>${pct(s.agreement)}</td><td>${s.ci95 ? `${pct(s.ci95.low)} – ${pct(s.ci95.high)}` : "—"}</td><td>${s.scoreable} / ${s.assigned}${why}${s.simulated ? `<br><span class="small">${s.real ? `${s.real} real + ${s.simulated} simulated; simulated left out` : `${s.simulated} simulated`}</span>` : ""}</td></tr>`;
    })
    .join("");
  const name = (id: string) => a.configs.find((c) => c.id === id)?.label ?? id;
  return (
    `<p class="caption">Select the configurations to compare. Brackets use rank tests with Holm correction: Mann–Whitney U between independent population runs, Wilcoxon signed-rank for participants paired across individual configurations.</p>` +
    (a.synthetic ? `<div class="notice">Synthetic study: no result is evidence about real people or agents.</div>` : "") +
    (a.progress && a.progress.finished < a.progress.sessions
      ? `<div class="notice"><strong>Interim analysis:</strong> ${a.progress.finished} of ${a.progress.sessions} sessions finished (${a.progress.failed} failed or stopped, ${a.progress.notStarted} not run yet${a.progress.reusedNeverRan ? `, of which ${a.progress.reusedNeverRan} ${a.progress.reusedNeverRan === 1 ? "was" : "were"} marked reused by an earlier continuation but never ran: continue the campaign to run ${a.progress.reusedNeverRan === 1 ? "it" : "them"}` : ""}). Numbers change as more sessions finish. Saved figures are marked as interim. The analysis is final when every session is finished or has failed for good.</div>`
      : "") +
    (a.audits.length ? `<div class="notice">${a.audits.length} session(s) that ran are not scoreable or deviated from their protocol (for example simulated runs on a real study, simulated runs left out next to real ones, or failed runs).</div>` : "") +
    `<div class="card"><div class="config-picks">${a.configs
      .map((c) => `<label class="check"><input type="checkbox" data-pick="${esc(c.id)}" ${selected.has(c.id) ? "checked" : ""}> ${esc(c.label)} <small>(${c.level}, ${esc(c.model.model)})</small></label>`)
      .join("")}</div>
    <div class="tabs" role="tablist" aria-label="Figure view">${views.map(([v, l]) => `<button class="tab ${view === v ? "active" : ""}" role="tab" id="tab-${v}" aria-selected="${view === v}" aria-controls="figure-panel" tabindex="${view === v ? 0 : -1}" data-view="${v}">${l}</button>`).join("")}</div>
    <div class="row"><label class="field">Domain<select id="an-domain"><option value="subjective" ${domain === "subjective" ? "selected" : ""}>Subjective</option><option value="objective" ${domain === "objective" ? "selected" : ""}>Objective</option></select></label>${view === "agent-vs-human" ? `<label class="field">Measure<select id="an-outcome">${outcomeOptions}</select></label>` : ""}</div>
    <div class="actions">${btn("draw", "Draw figure", analyzerNext() === "draw")}${figureSvg ? btn("save-svg", "Save SVG") + btn("save-png", "Save PNG") : ""}${btn("analyze", "Re-analyze")}${btn("explain", "Explain with assistant")}${btn("exec-import", "Load runs zip")}</div>
    ${view === "trajectories" && [...selected].some((id) => level(id) !== "individual") ? '<p class="caption">Participant lines use individual configurations only; population configurations are ignored here.</p>' : ""}
    <div class="figure" id="figure-panel" role="tabpanel" aria-labelledby="tab-${view}">${figureSvg || (figureData?.empty ? `<p class="caption warn">${esc(figureData.note)}</p>` : '<p class="caption">Choose configurations and a view, then draw the figure.</p>')}</div>${figureData?.omitted?.length ? `<div class="notice">${figureData.omitted.map((n: string) => esc(n)).join("<br>")}</div>` : ""}${figureData?.note && !figureData.empty ? `<p class="caption">${esc(figureData.note)}</p>` : ""}
    ${
      figureData?.discrepancies
        ? `<div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Design</th><th>Human</th><th>Agent</th><th>Discrepancy</th><th>Test</th><th>Holm p</th></tr></thead><tbody>${figureData.discrepancies
            .map((r: any) => `<tr${r.simulated ? ' class="simulated-row"' : ""}><td>${esc(name(r.agentId))}${r.simulated ? ' <span class="small warn">(simulated)</span>' : ""}</td><td>${esc(study?.conditions.find((c) => c.id === r.conditionId)?.label ?? r.conditionId)}</td><td>${Number(r.humanCentre).toFixed(2)}</td><td>${Number(r.agentCentre).toFixed(2)}</td><td>${Number(r.discrepancy).toFixed(2)}</td><td class="small">${esc(r.test ?? "")}</td><td>${r.holm == null ? "—" : r.holm.toFixed(3)} ${r.stars}</td></tr>`)
            .join("")}</tbody></table></div>`
        : ""
    }${explainText ? `<div class="notice neutral explain"><p class="explain-by">The assistant's explanation:</p>${markdownToHtml(explainText)}</div>` : ""}</div>
    <div class="card"><h2>Scores (${domain})${showSignificantOnly ? " · significant human differences only" : ""}</h2><p class="caption">${pairRuleText(a)}</p>${a.significantOnly ? `<div class="actions">${btn("toggle-significant", showSignificantOnly ? "Show scores on all mean differences" : "Show scores on significant differences only")}</div>` : ""}<div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Level</th><th>Model</th><th>Agreement</th><th>95% interval</th><th>Scoreable runs</th></tr></thead><tbody>${summaryRows}</tbody></table></div></div>
    ${humanPairsCard(a)}${absoluteCard(a)}
    <div class="card"><h2>Planned comparisons</h2><p class="caption">Chosen at analysis (they are not needed for data collection). One Holm correction covers all of them; choosing them changes no other number.</p><div class="table-scroll"><table><thead><tr><th>Candidate − baseline</th><th>Domain</th><th>Difference</th><th>95% interval</th><th>Holm p</th><th></th></tr></thead><tbody>${comparisons
      .map((c, i) => {
        const r = a.contrasts.find((x) => x.candidate === c.candidate && x.baseline === c.baseline && x.domain === c.domain);
        return `<tr><td>${esc(name(c.candidate))} − ${esc(name(c.baseline))}</td><td>${c.domain}</td><td>${r?.difference == null ? "—" : (r.difference * 100).toFixed(1) + " pp"}</td><td>${r?.ci95 ? `${pct(r.ci95.low)} – ${pct(r.ci95.high)}` : "—"}</td><td>${r?.holmP == null ? (r?.status.startsWith("Not tested") ? `<span class="small warn">${esc(r.status)}</span>` : "—") : r.holmP.toFixed(3)}</td><td>${btn(`cmp-remove:${i}`, "Remove")}</td></tr>`;
      })
      .join("")}<tr><td><select id="cmp-a" aria-label="Candidate">${a.configs.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("")}</select> − <select id="cmp-b" aria-label="Baseline">${a.configs.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join("")}</select></td><td><select id="cmp-d" aria-label="Domain"><option>subjective</option><option>objective</option></select></td><td></td><td></td><td></td><td>${btn("cmp-add", "Add")}</td></tr></tbody></table></div><div class="actions">${btn("cmp-save", "Save comparisons")}</div></div>
    ${a.exclusions.length || a.notes.length ? `<div class="card"><details data-key="notes"><summary data-key="notes">Notes and exclusions</summary><ul>${[...a.exclusions, ...a.notes].map((n) => `<li class="caption">${esc(n)}</li>`).join("")}</ul></details></div>` : ""}`
  );
}

function renderContinue() {
  if (!ws) return "";
  const base = contBase ?? campaignId;
  if (!base) return heading("7 · PLANNER", "Continue or rerun.", "") + `<div class="notice">Freeze a campaign first.</div>`;
  // The rows belong to the campaign continued from: another campaign starts them afresh.
  if (contRowsFor !== base) (contRows = {}), (contRowsFor = base);
  const models = campaignOf(base)?.models ?? {};
  const rows = contConfigs(base)
    .map((a) => {
      const r = (contRows[a.id] ??= { repetitions: a.runs, arm: false, rerun: false, drop: false });
      const added = !agents.some((x) => x.id === a.id);
      return `<tr><td>${esc(a.label)}${models[a.id] ? `<br><span class="small">${esc(modelText(models[a.id]))}${added ? " · model added by a continuation" : ""}</span>` : ""}</td><td><input type="number" min="1" max="${a.individual ? 50 : 1000}" data-cont="${esc(a.id)}" data-field="repetitions" value="${r.repetitions}" aria-label="Runs of ${esc(a.label)}"></td><td><input type="checkbox" data-cont="${esc(a.id)}" data-field="arm" ${r.arm ? "checked" : ""} aria-label="Add a model next to ${esc(a.label)}"></td><td><input type="checkbox" data-cont="${esc(a.id)}" data-field="rerun" ${r.rerun ? "checked" : ""} aria-label="Rerun ${esc(a.label)}"></td><td><input type="checkbox" data-cont="${esc(a.id)}" data-field="drop" ${r.drop ? "checked" : ""} aria-label="Drop ${esc(a.label)}"></td></tr>`;
    })
    .join("");
  const p = contPreview;
  return (
    heading("7 · PLANNER", "Continue with new models or setups.", "A continuation reuses every finished run whose setup is unchanged; only new or changed sessions go to the executor. Failed or never-started sessions are retried. To simply retry failed sessions, use Rerun failed in the executor.") +
    `<div class="card"><label class="field">Continue from<select id="cont-base">${ws.campaigns.map((c) => `<option value="${c.id}" ${c.id === base ? "selected" : ""}>${esc(campaignName(c))}${c.id === campaignId ? " (shown)" : ""} · ${esc(new Date(c.createdAt).toLocaleString())} · ${c.jobs} sessions</option>`).join("")}</select></label>
    <div class="notice neutral cont-help"><p><strong>Runs</strong>: more runs than before add sessions; finished ones are reused.</p><p><strong>Changing a model</strong> is done on <strong>Agent configurations</strong>: change the configuration's model there and save. Continue then runs that configuration again in full with its new model; its runs with the old model are not reused.</p><p><strong>Add model</strong> appends a model: the configuration stays as it is (its finished runs are reused) and a copy with the added model joins it, so both models can be compared with the method held fixed.</p><p><strong>Rerun</strong>: fresh sessions with the same setup. <strong>Drop</strong>: leave the configuration out.</p></div>
    ${modelChanges(base).length ? `<div class="notice">Model changed on Agent configurations since this campaign: ${modelChanges(base).map((m) => `${esc(m.label)} (${esc(m.from)} → ${esc(m.to)})`).join("; ")}. Continue runs ${modelChanges(base).length === 1 ? "it" : "them"} again with the new model.</div>` : ""}
    <div class="table-scroll"><table class="continuation-table"><thead><tr><th>Configuration</th><th>Runs</th><th>Add model</th><th>Rerun</th><th>Drop</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h2 class="subhead">Model for "Add model"</h2>
    <div class="row3"><label class="field">Provider<input id="cont-arm-provider" value="${esc(contArmModel.provider)}"></label><label class="field">Model<input id="cont-arm-model" value="${esc(contArmModel.model)}" placeholder="exact model ID"></label><label class="field">Effort${effortSelect('id="cont-arm-reasoning"', contArmModel.reasoning)}</label></div>
    <label class="field">Name of the added copy: suffix<input id="cont-suffix" value="${esc(contSuffix)}" placeholder="from the model ID, e.g. uses-app-fable-5-2"></label>
    <p class="caption">Effort is how much the model thinks before answering (Claude Code's --effort); "default" leaves it to Claude Code.</p>
    <label class="field">Note<input id="cont-note" value="${esc(contNote)}" placeholder="why this continuation"></label>
    <label class="check"><input type="checkbox" id="cont-keep-sim" ${contKeepSimulated ? "checked" : ""}> Keep simulated runs</label>
    <p class="caption">Off: sessions that were only simulated run again, like sessions that never ran (choose this before running real agents). On: finished simulated runs are reused, for trying the pipeline.</p>
    <div class="actions">${btn("cont-preview", p ? "Preview again" : "Preview", !p)}${p ? btn("cont-adopt", "Create continuation", true) : ""}</div>${
      p
        ? (() => {
            const sim = contPreviewSim;
            const reused = p.jobs.filter((j: any) => j.inheritedFrom).length;
            const simLine = sim?.reused
              ? ` ${sim.reused} of the reused runs ${sim.reused === 1 ? "is" : "are"} simulated (invented); they test the pipeline, not prediction quality.`
              : "";
            const againLine = sim?.runAgain ? ` ${sim.runAgain} session${sim.runAgain === 1 ? " was" : "s were"} only simulated and run${sim.runAgain === 1 ? "s" : ""} again.` : "";
            return `<div class="divider"></div>${contPreviewSources.map((n) => `<div class="notice">${esc(n)}</div>`).join("")}<p class="caption">${plural(p.jobs.filter((j: any) => j.kind === "llm" && !j.inheritedFrom).length, "new session")}, ${reused} reused (only sessions with an accepted forecast are reused).${simLine}${againLine}</p><div class="table-scroll"><table><thead><tr><th>Configuration</th><th>Model</th><th>Sessions</th><th>Reused</th></tr></thead><tbody>${p.suite.conditions
              .map((c: any) => {
                const jobs = p.jobs.filter((j: any) => j.conditionId === c.id);
                const s = sim?.byCondition[c.id];
                return `<tr><td>${esc(c.label)}</td><td>${esc(modelText(p.conditionModels?.[c.id] ?? p.model))}</td><td>${jobs.length}</td><td>${jobs.filter((j: any) => j.inheritedFrom).length}${s?.reused ? `<br><span class="small warn">${s.reused} simulated</span>` : ""}${s?.runAgain ? `<br><span class="small">${s.runAgain} simulated run again</span>` : ""}</td></tr>`;
              })
              .join("")}</tbody></table></div>`;
          })()
        : ""
    }</div>`
  );
}
/**
 * The configurations of the campaign continued from, including model copies that earlier
 * continuations added (they are not in agents.json), with their runs in that campaign. A campaign
 * summary from before this list existed falls back to agents.json.
 */
function contConfigs(baseId: string | null): { id: string; label: string; individual: boolean; runs: number }[] {
  const listed = campaignOf(baseId)?.configs;
  if (listed?.length) return listed;
  return agents.map((a) => ({ id: a.id, label: a.label, individual: isIndividual(a), runs: runsOf(a) }));
}
/** Configurations whose model (provider, model or effort) differs from the campaign continued from. */
function modelChanges(baseId: string | null) {
  const c = campaignOf(baseId);
  if (!c) return [];
  return agents.flatMap((a) => {
    const old = c.models[a.id];
    // "high" and "effort=high" are the same effort.
    if (!old || (old.provider === a.model.provider && old.model === a.model.model && effortLevel(old.reasoning) === effortLevel(a.model.reasoning))) return [];
    return [{ id: a.id, label: a.label, from: modelText(old), to: modelText(a.model) }];
  });
}
/** Preview or create the continuation; "nothing changes" is said in words, not in the change set's field names. */
async function continueCampaign(preview: boolean): Promise<any> {
  try {
    return await api("workspace/continue", { id: ws!.id, campaignId: contBase ?? campaignId, changes: continuationChanges(), keepSimulated: contKeepSimulated, ...(preview ? { preview: true } : {}) });
  } catch (err) {
    if (/^A continuation needs at least one change/.test((err as Error).message))
      throw new Error("Nothing to continue: every session of this campaign finished and would be reused as it is. Raise the runs, tick Add model, Rerun or Drop for a configuration, or change a model on Agent configurations, then preview again.");
    throw err;
  }
}
function continuationChanges() {
  const changes: Record<string, any> = {};
  // Every configuration of the campaign continued from, model copies added earlier included.
  const configs = contConfigs(contBase ?? campaignId);
  const live = configs.filter((a) => !contRows[a.id]?.drop);
  // Models changed on Agent configurations since the campaign continued from.
  const changed = modelChanges(contBase ?? campaignId).filter((m) => live.some((a) => a.id === m.id));
  if (changed.length) changes.conditionModels = Object.fromEntries(changed.map((m) => [m.id, { ...agents.find((a) => a.id === m.id)!.model }]));
  const drop = configs.filter((a) => contRows[a.id]?.drop).map((a) => a.id);
  if (drop.length) changes.dropConditions = drop;
  const rerun = live.filter((a) => contRows[a.id]?.rerun).map((a) => a.id);
  if (rerun.length) changes.rerunConditions = rerun;
  const reps: Record<string, number> = {};
  live.forEach((a) => {
    if (contRows[a.id] && contRows[a.id].repetitions > a.runs) reps[a.id] = contRows[a.id].repetitions;
  });
  const arms = live.filter((a) => contRows[a.id]?.arm);
  if (arms.length) {
    if (!contArmModel.model.trim()) throw new Error('Enter the model for "Add model".');
    const suffix = (contSuffix.trim() || contArmModel.model.toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/^-|-$/g, "").slice(0, 24);
    changes.cloneConditions = arms.map((a) => ({ from: a.id, id: `${a.id}-${suffix}`, model: { ...contArmModel } }));
    arms.forEach((a) => (reps[`${a.id}-${suffix}`] = contRows[a.id].repetitions));
  }
  if (Object.keys(reps).length) changes.repetitions = reps;
  if (contNote.trim()) changes.note = contNote.trim();
  return changes;
}

/** Command-line arguments as typed: whitespace-separated, double quotes keep spaces (Windows paths). */
const splitArgs = (text: string) => [...text.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
const joinArgs = (args: string[]) => args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

function renderSettings() {
  const s = settings!;
  return (
    heading("SETTINGS", "Agents and runtimes on this machine.", "Stored in private/settings.json (not in git). No API keys are stored here: Claude Code uses your own login.") +
    `<div class="grid"><section><div class="card"><h2>Assistant for workbench buttons</h2><p class="caption">Answers "Understand study" and "Explain with assistant". It can differ from the coding agent that opened this repository.</p><div class="row"><label class="field">Agent<select id="set-assistant">${["claude-code", "codex", "api"].map((k) => `<option ${s.assistant.kind === k ? "selected" : ""}>${k}</option>`).join("")}</select></label><label class="field">Model<input id="set-assistant-model" value="${esc(s.assistant.model)}"></label></div></div>
    <div class="card"><h2>Default forecasting model</h2><p class="caption">Your planned usage for new agent configurations: headless Claude Code sessions.</p><div class="row3"><label class="field">Provider<input id="set-f-provider" value="${esc(s.forecasting.provider)}"></label><label class="field">Model<input id="set-f-model" value="${esc(s.forecasting.model)}"></label><label class="field">Effort${effortSelect('id="set-f-reasoning"', s.forecasting.reasoning)}</label></div><p class="caption">Effort is how much the model thinks before answering (Claude Code's --effort); "default" leaves it to Claude Code.</p></div>
    <div class="card"><h2>Runtimes (MCP servers)</h2><p class="caption">WebXR is built in. For Unreal, Unity or Apple Vision Pro, give the command that starts that engine's MCP server on this machine (for example your study bridge). Quote arguments that contain spaces. {jobDir}, {jobFile} and {trace} in the arguments are replaced for each session. Leave empty if the runtime is not available here; those configurations can then only be simulated.</p>${["unreal", "unity", "visionos"]
      .map((r) => `<div class="row"><label class="field">${r} command<input id="set-rt-${r}" value="${esc(s.runtimes[r]?.command ?? "")}" placeholder="not configured"></label><label class="field">${r} arguments<input id="set-rt-${r}-args" value="${esc(joinArgs(s.runtimes[r]?.args ?? []))}"></label></div><label class="field">${r} capabilities (comma-separated, e.g. screenshot, phase-events)<input id="set-rt-${r}-caps" value="${esc((s.runtimes[r]?.capabilities ?? []).join(", "))}"></label><div class="row"><label class="field">${r} time limit per session (minutes)<input type="number" min="1" id="set-rt-${r}-timeout" value="${s.runtimes[r]?.timeoutMinutes ?? ""}" placeholder="${Math.max(90, s.jobTimeoutMinutes)} (default)"></label><label class="field">${r} sessions at the same time<input type="number" min="1" id="set-rt-${r}-parallel" value="${s.runtimes[r]?.maxParallel ?? ""}" placeholder="1 (default: one editor, one session)"></label></div><label class="field">${r}: how agents should use its tools (optional)<textarea id="set-rt-${r}-help" rows="2">${esc(s.runtimes[r]?.instructions ?? "")}</textarea></label>`)
      .join("")}<label class="field">Chrome path (WebXR)<input id="set-chrome" value="${esc(s.chromePath)}"></label></div></section>
    <aside><div class="card"><h2>Execution</h2><label class="field">Parallel sessions<input type="number" id="set-concurrency" min="1" max="8" value="${s.concurrency}"></label><label class="field">Session time limit (minutes)<input type="number" id="set-timeout" min="1" value="${s.jobTimeoutMinutes}"></label><p class="caption">Parallel sessions is the overall limit, for all campaigns together (simulated sessions have their own limit of 8, or more if this is higher). Engine runtimes (Unreal, Unity, visionOS) also have their own limits under Runtimes: by default one session at a time and at least 90 minutes each.</p><div class="actions">${btn("save-settings", "Save settings", true)}</div></div></aside></div>`
  );
}

// ---------- figure ----------
async function drawFigure() {
  if (!ws || !campaignId || !analysis) return;
  const ids = [...selected];
  if (!ids.length) throw new Error("Select at least one configuration.");
  const order = analysis.configs.map((c) => c.id);
  const domainLabel = domain === "subjective" ? "Subjective" : "Objective";
  const kindIds = view === "trajectories" ? ids.filter((id) => analysis!.configs.find((c) => c.id === id)?.level === "individual") : ids;
  if (!kindIds.length) throw new Error("Participant lines need at least one individual configuration.");
  // Agreement views say when nothing can be scored, instead of plotting zeros.
  const none = view === "agreement" || view === "population-vs-individual" ? nothingScored(analysis, kindIds) : null;
  if (none) {
    figureData = { empty: true, note: none };
    figureSvg = "";
    return;
  }
  const [forStudy, forCampaign] = [ws.id, campaignId];
  const data = await api("workspace/figure", { id: ws.id, campaignId, comparisons, kind: view, agentIds: kindIds, domain, outcomeId: outcomeId || analysis.outcomes[0].id });
  // A study or campaign switched while the figure was computed: it belongs to neither.
  if (ws?.id !== forStudy || campaignId !== forCampaign || !analysis) return;
  figureData = data;
  // The figure says itself why nothing can be drawn (for example participant lines without an individual configuration).
  if (figureData.empty) {
    figureSvg = "";
    return;
  }
  if ((view === "agreement" || view === "population-vs-individual") && Array.isArray(figureData.groups) && figureData.groups.every((g: { values: number[] }) => !g.values.length)) {
    figureData = { empty: true, note: `Nothing can be scored (${domain}) for the selected configurations: no run or participant has an agreement score here.` };
    figureSvg = "";
    return;
  }
  // Interim figures say so in their title, which is saved with the SVG/PNG.
  const p = analysis.progress;
  const interim = p && p.finished < p.sessions ? ` (INTERIM: ${p.finished} of ${p.sessions} sessions)` : "";
  figureSvg =
    view === "agreement"
      ? agreementPlot(figureData, `${domainLabel} agreement per run / participant${interim}`, order)
      : view === "population-vs-individual"
      ? agreementPlot(figureData, `${domainLabel}: population runs vs individual forecasts averaged to the cohort${interim}`, order)
      : view === "agent-vs-human"
      ? agentVsHumanPlot(figureData, `${figureData.outcome.label}: agents vs humans${interim}`, order)
      : view === "correlation"
      ? correlationPlot(figureData, `Pattern across designs: agents vs humans${interim}`, order)
      : trajectoryPlot(figureData, `${domainLabel} agreement per participant${interim}`);
}

// ---------- actions ----------
async function action(name: string) {
  const [verb, arg] = name.includes(":") ? [name.slice(0, name.indexOf(":")), name.slice(name.indexOf(":") + 1)] : [name, ""];
  switch (verb) {
    case "open":
      if (ws && ws.id !== arg && unsavedWork() && !confirm("This study has unsaved changes. Open the other study and lose them?")) break;
      await openWorkspace(arg);
      page = "study";
      break;
    case "goto":
      if (arg === "continue" && page !== "continue") enterContinue();
      page = arg as Page;
      if (page === "evidence") {
        evidence = null;
        void loadEvidence();
      }
      break;
    case "create-study": {
      const r = await api("workspace/create", { name: $<HTMLInputElement>("new-study-name").value.trim() });
      workspaces = await api("workspaces");
      await openWorkspace(r.id);
      page = "study";
      toast("Study folder created. Now use Understand study with your document.");
      break;
    }
    case "pick-doc": {
      const f = await pickFile(".pdf,.docx,.md,.markdown,.txt");
      if (f) {
        doc = { name: f.name, base64: await toBase64(f) };
        docDrafted = false;
      }
      break;
    }
    case "pick-participants": {
      const f = await pickFile(".csv,.txt");
      if (f) participantsCsv = await f.text();
      break;
    }
    case "understand":
      if (!doc) throw new Error("Choose the document first.");
      toast("The assistant is reading the document; this can take a minute.");
      understanding = await api("assistant/understand", { id: ws!.id, ...doc, participantsCsv });
      docDrafted = true;
      break;
    case "use-draft": {
      if (!understanding) break;
      const draftBrief = $<HTMLTextAreaElement>("ud-brief")?.value ?? understanding.brief?.text ?? "";
      study = structuredClone(understanding.study);
      study.id = ws!.study.id;
      agents = agents.filter((a) => (a.targets ?? []).every((t) => study!.outcomes.some((o) => o.id === t)) && (a.inputs ?? []).every((t) => study!.outcomes.some((o) => o.id === t)));
      briefDraft = draftBrief.trim() ? draftBrief : null;
      understanding = null;
      toast(briefDraft !== null ? "Draft and brief applied. Check the tables, then save." : "Draft applied. Check the tables, then save. Write the study brief on Evidence & knowledge.");
      break;
    }
    case "discard-draft":
      understanding = null;
      break;
    case "save": {
      const wrote = await saveStudy();
      toast(wrote ? `Saved to the study folder, with the study brief (${wrote}).` : "Saved to the study folder.");
      break;
    }
    case "approve":
      if (unsaved()) throw new Error(problemBlock() ? `Approval waits: ${problemBlock()}` : "Save first.");
      if (ws!.problem) throw new Error("Approval waits: the saved agent configurations do not fit the saved study (see the notice at the top). Fix them, save, then approve.");
      await api("workspace/approve", { id: ws!.id, note: $<HTMLInputElement>("approve-note")?.value ?? "" });
      await refreshWorkspace();
      toast("Approved.");
      break;
    case "remove-outcome": {
      const o = study!.outcomes.find((x) => x.id === arg)!;
      if (study!.outcomes.length === 1) throw new Error("A study needs at least one measure.");
      if (!confirm(`Remove the measure "${o.label}"? Configurations stop predicting or receiving it. Frozen campaigns keep it; human data for it is no longer used.`)) break;
      study!.outcomes = study!.outcomes.filter((x) => x.id !== arg);
      if (!study!.outcomes.some((x) => x.family === o.family)) delete study!.analysis.familyWeights[o.family];
      for (const a of agents) {
        if (a.targets) a.targets = a.targets.filter((x) => x !== arg);
        if (a.targets && !a.targets.length) delete a.targets;
        if (a.inputs) a.inputs = a.inputs.filter((x) => x !== arg);
        if (a.inputs && !a.inputs.length) delete a.inputs;
      }
      toast(`Removed ${o.label}. Save to keep it.`);
      break;
    }
    case "use-webxr-profile":
      study!.runtime.deviceProfile = WEBXR_PROFILE;
      toast("Device set to the WebXR runtime's profile. Save to keep it.");
      break;
    case "download-study":
      download("study.json", JSON.stringify(study, null, 2) + "\n");
      break;
    case "import-study": {
      const f = await pickFile(".json");
      if (f) {
        let loaded: Study;
        try {
          loaded = JSON.parse(await f.text());
        } catch {
          throw new Error(`${f.name} is not valid JSON.`);
        }
        if (!loaded || typeof loaded !== "object" || !Array.isArray(loaded.conditions) || !Array.isArray(loaded.outcomes)) throw new Error(`${f.name} does not look like a study.json (designs and measures are missing).`);
        // The study keeps its own ID: human data, campaigns and approvals refer to it.
        const other = loaded.id && loaded.id !== ws!.study.id ? loaded.id : null;
        const wasSynthetic = !!study?.synthetic;
        study = { ...loaded, id: ws!.study.id };
        followStudyKind(wasSynthetic, !!study.synthetic);
        toast(other ? `Loaded. The file's study ID "${other}" was replaced by this study's ID "${ws!.study.id}". Save to keep it.` : "Loaded. Save to keep it.");
      }
      break;
    }
    case "apply-default-model":
      agents.forEach((a) => (a.model = { ...settings!.forecasting }));
      break;
    case "add-config": {
      const template = $<HTMLSelectElement>("template").value;
      const proposals = (await api<{ agents: AgentProtocol[] }>("propose", { study })).agents;
      const t = proposals.find((p) => p.id === template);
      if (!t) throw new Error(`The study has no source for the ${template} template (for example no evidence or participant information).`);
      let id = t.id,
        n = 2;
      while (agents.some((a) => a.id === id)) id = `${t.id}-${n++}`;
      agents.push({ ...t, id, model: { ...settings!.forecasting }, maxOutputTokens: 64000 });
      break;
    }
    case "add-custom": {
      const proposals = (await api<{ agents: AgentProtocol[] }>("propose", { study })).agents;
      const base = proposals.find((p) => p.id === "text-only")!;
      const n = agents.filter((x) => x.id.startsWith("custom")).length + 1;
      const id = uniqueConfigId(`custom-${n}`);
      agents.push({ ...structuredClone(base), id, label: `Custom configuration ${n}`, rationale: "Your own combination of what the agent gets.", model: { ...settings!.forecasting }, maxOutputTokens: 64000, maxTokens: 100_000 });
      toast(`Added ${id}. Choose what it gets on its card, then save.`);
      break;
    }
    case "duplicate-config": {
      const a = agents.find((x) => x.id === arg)!;
      const copy = structuredClone(a);
      copy.id = uniqueConfigId(`${a.id}-copy`);
      copy.label = `${a.label} (copy)`;
      agents.splice(agents.indexOf(a) + 1, 0, copy);
      toast(`Copied as ${copy.id}. Change what it gets or its model, then save.`);
      break;
    }
    case "remove-config":
      agents = agents.filter((a) => a.id !== arg);
      break;
    case "fix-config": {
      // Remove what the study does not have (sources, measures, tasks); the rest of the configuration stays.
      const a = agents.find((x) => x.id === arg);
      if (!a) break;
      const u = unknownRefs(a);
      setAccess(a, a.sourceIds, a.tools.includes("xr-interact"));
      a.requiredCaseIds = a.requiredCaseIds.filter((id) => !u.cases.includes(id));
      if (a.targets) a.targets = a.targets.filter((id) => !u.outcomes.includes(id));
      if (a.targets && !a.targets.length) delete a.targets;
      if (a.inputs) a.inputs = a.inputs.filter((id) => !u.outcomes.includes(id));
      if (a.inputs && !a.inputs.length) delete a.inputs;
      const removed = [u.sources.length ? named("source", u.sources) : "", u.outcomes.length ? named("measure", u.outcomes) : "", u.cases.length ? named("task", u.cases) : ""].filter(Boolean).join(", ");
      toast(`Removed ${removed} from ${a.label}. Save the configurations to write the fix to agents.json.`);
      // The fix button is gone: the focus goes to the next step, Save configurations (if this page has it).
      if (page === "configs") focusNext = { key: "BUTTON|data-action=save", index: 0 };
      break;
    }
    case "freeze": {
      newRepetitions = Number($<HTMLInputElement>("new-reps").value) || 1;
      if (problemBlock()) throw new Error(`Freezing waits: ${problemBlock()}`);
      if (ws!.problem && !unsaved()) throw new Error("Freezing waits: the saved agent configurations do not fit the saved study (see the notice at the top). Fix them on Agent configurations and save.");
      if (unsaved() || briefDraft !== null) await saveStudy();
      const check = await api<{ duplicates: { id: string; label: string | null; createdAt: string }[]; jobs: number }>("workspace/freeze", { id: ws!.id, repetitions: newRepetitions, check: true });
      if (check.duplicates.length) {
        const d = check.duplicates.at(-1)!;
        const name = d.label ?? `campaign ${d.id.slice(9, 17)}`;
        if (!confirm(`${check.duplicates.length === 1 ? "A campaign" : `${check.duplicates.length} campaigns`} with exactly these configurations, models and ${check.jobs} sessions already exist${check.duplicates.length === 1 ? "s" : ""} (${name}, frozen ${new Date(d.createdAt).toLocaleString()}).\n\nOK freezes another one anyway. Cancel opens ${name} instead.`)) {
          // The label was meant for the campaign not frozen; it does not wait for the next freeze.
          newLabel = "";
          showCampaign(d.id);
          page = "executor";
          break;
        }
      }
      const r = await api("workspace/freeze", { id: ws!.id, repetitions: newRepetitions, label: newLabel });
      newLabel = "";
      await refreshWorkspace();
      showCampaign(r.campaignId);
      page = "executor";
      toast(`Campaign frozen with ${r.jobs} sessions. The executor now shows it.`);
      break;
    }
    case "delete-campaign": {
      // The summary asks with the latest numbers (also sessions that failed a moment ago).
      ws!.campaigns = await api<CampaignInfo[]>(`workspace/campaigns?id=${encodeURIComponent(ws!.id)}`);
      const c = campaignOf(arg)!;
      if (!confirm(`Delete ${campaignName(c)}?\n\n${c.jobs} sessions: ${c.done} done (${c.real} real, ${c.simulated} simulated), ${c.failed} failed${c.costUsd != null ? `, ${money(c.costUsd)} spent` : ""}.\n\nThe campaign and its runs move to the study's deleted/ folder (remove that folder to free the space). A campaign that another one continues from cannot be deleted.`)) break;
      const r = await api<{ movedTo: string }>("workspace/campaign-delete", { id: ws!.id, campaignId: arg });
      await refreshWorkspace();
      if (campaignId === arg) showCampaign(ws!.campaigns.at(-1)?.id ?? null);
      toast(`Deleted. Moved to ${r.movedTo}.`);
      break;
    }
    case "use-campaign":
      showCampaign(arg);
      break;
    case "exec-start": {
      await saveConcurrency();
      const pendingJobs = chosenRunnable().length ? chosenRunnable() : (snapshot?.jobs.filter(canRun) ?? []);
      if (!pendingJobs.length) throw new Error("Nothing to run: every session is finished, running or reused.");
      let toRun = pendingJobs;
      let blockedMsg = "";
      if (mode === "agent") {
        const blocked = await api<{ message: string; configs: string[] }[]>("executor/blockers", { id: ws!.id, campaignId, jobIds: pendingJobs.map((j) => j.jobId) });
        if (blocked.length) {
          toRun = pendingJobs.filter((j) => !blocked.some((b) => b.configs.includes(j.label)));
          blockedMsg = blocked.map((b) => `${b.message}\nNeeded by: ${b.configs.join(", ")}`).join("\n\n");
          if (!toRun.length) throw new Error(blockedMsg);
        }
        if (!confirm((blockedMsg ? `${blockedMsg}\n\nThese cannot run. ` : "") + (await runSummary(toRun)))) break;
      }
      await api("executor/start", { id: ws!.id, campaignId, mode, jobIds: toRun.map((j) => j.jobId) });
      chosen = new Set();
      pickConfigs = new Set();
      break;
    }
    case "pick-first": {
      if (!pickConfigs.size) throw new Error("Check one or more configurations first.");
      chosen = new Set();
      for (const id of pickConfigs) (snapshot?.jobs.filter((j) => j.agentId === id && canRun(j)) ?? []).slice(0, pickK).forEach((j) => chosen.add(j.jobId));
      break;
    }
    case "rerun-configs": {
      if (!pickConfigs.size) throw new Error("Check one or more configurations first.");
      const ids = [...pickConfigs];
      const labels = ids.map((id) => snapshot?.jobs.find((j) => j.agentId === id)?.label ?? id);
      const fresh = (snapshot?.jobs ?? []).filter((j) => pickConfigs.has(j.agentId)).length;
      // The mode is the one chosen above (Run agents or Simulate).
      // Simulated runs are reused only while you are simulating; before real agents they run again.
      const keepSimulated = mode === "simulate";
      if (!confirm(`Rerun ${labels.join(", ")} (${fresh} sessions) from scratch?\n\nFinished runs are never overwritten: this makes a new campaign that continues this one. The checked configurations get fresh sessions; every other configuration reuses its finished runs${keepSimulated ? "" : " (sessions that were only simulated run again, because the mode is Run agents)"}. Sessions that failed, stopped or never ran are run again. This campaign stays as it is.\n\nNothing starts until you press Start.`)) break;
      const r = await api<{ campaignId: string; reused: number; jobs: number }>("workspace/continue", { id: ws!.id, campaignId, changes: { rerunConditions: ids, note: `Rerun of ${labels.join(", ")}` }, keepSimulated });
      await refreshWorkspace();
      showCampaign(r.campaignId);
      toast(`New campaign: ${r.jobs - r.reused} sessions to run, ${r.reused} reused. The executor now shows it; press Start, or choose a few first.`);
      break;
    }
    case "pick-clear":
      chosen = new Set();
      pickConfigs = new Set();
      break;
    case "exec-one": {
      // One session first: the cautious way to try a new runtime or model before starting all.
      if (mode === "agent") {
        const blocked = await api<{ message: string; configs: string[] }[]>("executor/blockers", { id: ws!.id, campaignId, jobIds: [arg] });
        if (blocked.length) throw new Error(blocked.map((b) => b.message).join("\n"));
        if (!confirm(await runSummary(snapshot!.jobs.filter((j) => j.jobId === arg)))) break;
      }
      await api("executor/start", { id: ws!.id, campaignId, mode, jobIds: [arg] });
      break;
    }
    case "exec-pause":
      await api("executor/pause", { id: ws!.id, campaignId });
      break;
    case "exec-resume":
      await api("executor/resume", { id: ws!.id, campaignId });
      break;
    case "exec-stop":
      if (confirm("Stop running sessions now? They are recorded as stopped and can be rerun.")) await api("executor/stop", { id: ws!.id, campaignId });
      break;
    case "exec-rerun": {
      const failed = snapshot?.jobs.filter((j) => j.status === "failed" || j.status === "stopped").map((j) => j.jobId) ?? [];
      if (!failed.length) throw new Error("No failed or stopped sessions.");
      if (mode === "agent" && !confirm(`Rerun ${failed.length} session(s) with Claude Code?`)) break;
      await api("executor/start", { id: ws!.id, campaignId, mode, jobIds: failed });
      break;
    }
    case "exec-export":
      location.href = `/api/runs/export?id=${encodeURIComponent(ws!.id)}&campaign=${encodeURIComponent(campaignId!)}`;
      break;
    case "exec-import": {
      const f = await pickFile(".zip");
      if (!f) break;
      const r = await api("runs/import", { id: ws!.id, base64: await toBase64(f) });
      await refreshWorkspace();
      showCampaign(r.campaign);
      toast(`Loaded runs: ${r.written} file(s) added, ${r.updated ? `${r.updated} brought up to date, ` : ""}${r.kept} already present${r.receipts ? `; ${r.receipts} new session record(s)` : ""}.${r.skipped ? ` ${r.skipped} file(s) of unfinished attempts were not loaded.` : ""}${r.skippedAtSave ? ` When these runs were saved, ${r.skippedAtSave} entry(ies) were left out (links, unfinished attempts or names a zip cannot carry).` : ""}`);
      break;
    }
    case "k-add":
    case "k-replace": {
      const f = await pickFile(verb === "k-replace" ? ".csv,.tsv,.pdf,.docx,.md,.markdown,.txt" : ".pdf,.docx,.md,.markdown,.txt,.csv,.tsv");
      if (!f) break;
      toast(/\.(csv|tsv)$/i.test(f.name) ? "Reading the table…" : "The assistant is reading the file…");
      knowledgeDraft = await api<KnowledgeDraft>("workspace/knowledge-draft", { id: ws!.id, name: f.name, base64: await toBase64(f) });
      if (verb === "k-replace") {
        const old = study!.sources.find((x) => x.id === arg)!;
        if (knowledgeDraft.kind !== "participant") throw new Error(`${f.name} does not hold one row per participant, so it cannot replace ${old.label}.`);
        Object.assign(knowledgeDraft, { replaces: arg, sourceId: arg, label: old.label, description: old.description, path: ws!.manifest.sources?.[arg] ?? knowledgeDraft.path });
      }
      break;
    }
    case "k-discard":
      knowledgeDraft = null;
      break;
    case "k-add-save": {
      const d = knowledgeDraft!;
      const label = $<HTMLInputElement>("kd-label").value.trim() || d.label;
      const description = $<HTMLInputElement>("kd-desc").value.trim() || d.description;
      let text = d.text;
      if (d.kind === "general") {
        text = $<HTMLTextAreaElement>("kd-text").value;
        if (!text.trim()) throw new Error("The knowledge text is empty.");
        study!.sources.push({ id: d.sourceId, label, kind: "evidence", description });
      } else {
        const fields = Array.from(document.querySelectorAll<HTMLInputElement>("[data-kdfield]")).filter((x) => x.checked).map((x) => x.dataset.kdfield!);
        if (!fields.length) throw new Error("Choose at least one field agents may see.");
        const old = study!.sources.find((x) => x.id === d.sourceId);
        if (old) Object.assign(old, { label, description, fields });
        else study!.sources.push({ id: d.sourceId, label, kind: "demographics", description, fields });
      }
      await saveKnowledge([{ sourceId: d.sourceId, path: d.path, text }]);
      knowledgeDraft = null;
      toast(`${label} saved. Choose on Agent configurations which configurations get it.`);
      break;
    }
    case "brief-edit": {
      if (brief?.exists) {
        const r = await fetch(`/api/workspace/source?id=${encodeURIComponent(ws!.id)}&source=${encodeURIComponent(brief.id)}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({ error: "Could not read the brief." }))).error);
        briefEdit = await r.text();
      } else briefEdit = briefDraft ?? "";
      break;
    }
    case "brief-cancel":
      briefEdit = null;
      break;
    case "brief-save": {
      const text = $<HTMLTextAreaElement>("brief-text").value;
      if (!text.trim()) throw new Error("The brief is empty. Describe the task, the designs, the procedure and the measures as participants experienced them.");
      // Other planner edits are saved first, so the brief and the study stay in step.
      if (unsaved()) {
        checkSavable();
        await api("workspace/save", { id: ws!.id, study, agents });
        saved = JSON.stringify({ study, agents });
      }
      const r = await api<{ path: string }>("workspace/brief-save", { id: ws!.id, text });
      briefEdit = null;
      briefDraft = null;
      await refreshWorkspace();
      await loadEvidence();
      toast(`Study brief saved (${r.path}). Every configuration that gets the brief reads it.`);
      break;
    }
    case "k-cancel":
      knowledgeEdit = null;
      break;
    case "k-rename":
      knowledgeEdit = { id: arg, mode: "rename" };
      break;
    case "k-rename-save": {
      const src = study!.sources.find((x) => x.id === arg)!;
      src.label = $<HTMLInputElement>("k-label").value.trim() || src.label;
      src.description = $<HTMLInputElement>("k-desc").value.trim() || src.description;
      await saveKnowledge();
      knowledgeEdit = null;
      break;
    }
    case "k-text": {
      const r = await fetch(`/api/workspace/source?id=${encodeURIComponent(ws!.id)}&source=${encodeURIComponent(arg)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({ error: "Could not read the text." }))).error);
      knowledgeEdit = { id: arg, mode: "text", text: await r.text() };
      break;
    }
    case "k-text-save": {
      const e = evidence!.find((x) => x.id === arg)!;
      await saveKnowledge([{ sourceId: arg, path: e.path!, text: $<HTMLTextAreaElement>("k-text").value }]);
      knowledgeEdit = null;
      break;
    }
    case "k-fields":
      knowledgeEdit = { id: arg, mode: "fields" };
      break;
    case "k-fields-save": {
      const fields = Array.from(document.querySelectorAll<HTMLInputElement>("[data-kfield]")).filter((x) => x.checked).map((x) => x.dataset.kfield!);
      if (!fields.length) throw new Error("Choose at least one field agents may see.");
      study!.sources.find((x) => x.id === arg)!.fields = fields;
      await saveKnowledge();
      knowledgeEdit = null;
      break;
    }
    case "k-delete": {
      const src = study!.sources.find((x) => x.id === arg)!;
      const users = usedBy(arg);
      if (!confirm(`Delete ${src.label} from this study's knowledge?${users.length ? `\n\n${users.length} configuration(s) get it and will no longer: ${users.map((a) => a.label).join(", ")}.` : ""}\n\nThe file stays in the study folder${ws!.manifest.sources?.[arg] ? ` (${ws!.manifest.sources[arg]})` : ""}; frozen campaigns keep what they froze.`)) break;
      for (const a of users) setAccess(a, a.sourceIds.filter((x) => x !== arg), a.tools.includes("xr-interact"));
      study!.sources = study!.sources.filter((x) => x.id !== arg);
      await saveKnowledge(undefined, [arg]);
      toast(`${src.label} deleted.`);
      break;
    }
    case "preview-none":
      watched = new Set();
      watchRunning = false;
      selectedJob = null;
      break;
    case "preview-close":
      watched.delete(arg);
      if (selectedJob === arg) selectedJob = null;
      break;
    case "toggle-runtimes":
      showAllRuntimes = !showAllRuntimes;
      break;
    case "toggle-significant":
      showSignificantOnly = !showSignificantOnly;
      break;
    case "compare-campaigns": {
      const { before, after } = comparedCampaigns();
      if (before === after) throw new Error("Choose two different campaigns.");
      const r = await api<{ rows: CampaignCmpRow[]; notes: string[] }>("workspace/compare", { id: ws!.id, before, after, comparisons });
      campaignCmp = { before, after, rows: r.rows, notes: r.notes };
      break;
    }
    case "compare-agents":
      agentCmp = await api<AgentCmp>("workspace/compare-agents", { id: ws!.id, campaignId });
      break;
    case "analyze": {
      // A fresh analysis: nothing drawn or explained for an earlier one stays on the page.
      resetAnalyzer();
      const a = await api<AnalysisView>("workspace/analyze", { id: ws!.id, campaignId, comparisons });
      analysis = a;
      if (!selected.size || [...selected].some((id) => !a.configs.some((c) => c.id === id)))
        selected = new Set(a.configs.filter((c) => c.level === "population").slice(0, 3).map((c) => c.id));
      if (!a.outcomes.some((o) => o.id === outcomeId)) outcomeId = a.outcomes[0]?.id ?? "";
      if (!analyzerViews(a).some(([v]) => v === view)) view = "agreement";
      break;
    }
    case "draw":
      await drawFigure();
      break;
    case "draw-human": {
      const o = humanOutcome || study!.outcomes[0].id;
      humanFig = await api("workspace/human-figure", { id: ws!.id, campaignId, outcomeId: o });
      humanSvg = humanPlot(humanFig, `${humanFig.outcome.label}: human participants`);
      break;
    }
    case "save-human-svg":
      downloadSvg(humanSvg, `human-${humanOutcome || "measure"}`);
      break;
    case "save-human-png":
      downloadPng(humanSvg, `human-${humanOutcome || "measure"}`);
      break;
    case "save-svg":
      downloadSvg(figureSvg, `${view}-${domain}`);
      break;
    case "save-png":
      downloadPng(figureSvg, `${view}-${domain}`);
      break;
    case "explain":
      toast("Asking the assistant…");
      explainText = (await api("assistant/explain", { id: ws!.id, campaignId, comparisons })).text;
      break;
    case "cmp-add": {
      const c: Comparison = { candidate: $<HTMLSelectElement>("cmp-a").value, baseline: $<HTMLSelectElement>("cmp-b").value, domain: $<HTMLSelectElement>("cmp-d").value as Domain };
      if (c.candidate === c.baseline) throw new Error("Choose two different configurations.");
      comparisons.push(c);
      analysis = await api("workspace/analyze", { id: ws!.id, campaignId, comparisons });
      break;
    }
    case "cmp-remove":
      comparisons.splice(Number(arg), 1);
      analysis = await api("workspace/analyze", { id: ws!.id, campaignId, comparisons });
      break;
    case "cmp-save":
      await api("workspace/save", { id: ws!.id, comparisons });
      toast("Comparisons saved to comparisons.json.");
      break;
    case "cont-preview": {
      const r = await continueCampaign(true);
      contPreview = r.campaign;
      contPreviewSim = r.simulated ?? null;
      contPreviewSources = r.sourceChanges ?? [];
      break;
    }
    case "cont-adopt": {
      const r = await continueCampaign(false);
      await refreshWorkspace();
      showCampaign(r.campaignId);
      contRows = {};
      page = "executor";
      toast(`Continuation created: ${r.reused} of ${r.jobs} sessions reused${r.reusedSimulated ? ` (${r.reusedSimulated} simulated)` : ""}.${r.sourceChanges?.length ? ` ${r.sourceChanges.join(" ")}` : ""} The executor now shows the new campaign.`);
      break;
    }
    case "save-settings": {
      const v = (id: string) => $<HTMLInputElement>(id).value;
      const num = (id: string) => (v(id).trim() ? Number(v(id)) : undefined);
      // Keep what this page does not show (claudePath written by setup, runtime notes).
      const next: Settings = {
        ...settings!,
        assistant: { kind: v("set-assistant"), model: v("set-assistant-model") },
        forecasting: { provider: v("set-f-provider"), model: v("set-f-model"), reasoning: v("set-f-reasoning") },
        runtimes: {
          ...settings!.runtimes,
          ...Object.fromEntries(["unreal", "unity", "visionos"].map((r) => [r, { ...settings!.runtimes[r], command: v(`set-rt-${r}`).trim() || undefined, args: splitArgs(v(`set-rt-${r}-args`)), instructions: v(`set-rt-${r}-help`).trim() || undefined, capabilities: v(`set-rt-${r}-caps`).split(",").map((x) => x.trim()).filter(Boolean), timeoutMinutes: num(`set-rt-${r}-timeout`), maxParallel: num(`set-rt-${r}-parallel`) }])),
        },
        chromePath: v("set-chrome"),
        concurrency: Number(v("set-concurrency")),
        jobTimeoutMinutes: Number(v("set-timeout")),
      };
      settings = await api("settings", { settings: next });
      if (ws) runtimes = await api(`runtimes?id=${encodeURIComponent(ws.id)}`);
      toast("Settings saved.");
      break;
    }
  }
}
/** Save the study and configurations, and a brief taken from Understand study. Returns where the brief was written. */
async function saveStudy(): Promise<string | null> {
  checkSavable();
  await api("workspace/save", { id: ws!.id, study, agents });
  saved = JSON.stringify({ study, agents });
  let wrote: string | null = null;
  if (briefDraft !== null) {
    wrote = (await api<{ path: string }>("workspace/brief-save", { id: ws!.id, text: briefDraft })).path;
    briefDraft = null;
  }
  await refreshWorkspace();
  return wrote;
}
async function saveConcurrency() {
  const n = Number($<HTMLInputElement>("exec-concurrency")?.value);
  if (settings && n && n !== settings.concurrency) settings = await api("settings", { settings: { ...settings, concurrency: n } });
}
/** A new visit to Continue / rerun starts from the campaign shown in the executor and analyzer. */
function enterContinue() {
  contBase = null;
  contPreview = null;
  contPreviewSim = null;
  contPreviewSources = [];
}
function syncContinuation() {
  const v = (id: string) => $<HTMLInputElement>(id)?.value;
  if (!$("cont-arm-provider")) return;
  // "Continue from" is not read back here: it is the campaign shown unless you pick another (see the change handler).
  contArmModel = { provider: v("cont-arm-provider"), model: v("cont-arm-model"), reasoning: v("cont-arm-reasoning") };
  contSuffix = v("cont-suffix");
  contNote = v("cont-note");
}

// ---------- events ----------
/** Preview a session of the executor table (one, or several with Ctrl, ⌘ or Shift); again closes it. */
function togglePreview(id: string, several: boolean) {
  if (several) watched.has(id) ? watched.delete(id) : watched.add(id);
  else watched = watched.size === 1 && watched.has(id) ? new Set() : new Set([id]);
  selectedJob = watched.size === 1 ? [...watched][0] : null;
  render();
  if (selectedJob) void loadAttempts(selectedJob).catch(() => undefined);
}
/** Show the figure view of a tab (Agreement, Agent vs human, …); the old figure belongs to the old view. */
function chooseView(v: View) {
  view = v;
  figureSvg = "";
  figureData = null;
  render();
}
document.addEventListener("click", async (e) => {
  const t = e.target as HTMLElement;
  const skip = t.closest<HTMLElement>(".skip-link");
  if (skip) {
    // To the page title, without changing the address (the study stays in it).
    e.preventDefault();
    focusHeading();
    return;
  }
  const nav = t.closest<HTMLElement>("[data-page]");
  if (nav) {
    if (page === "continue") syncContinuation();
    const from = page;
    page = nav.dataset.page as Page;
    if (page === "continue" && from !== "continue") enterContinue();
    if (page === "evidence") evidence = null;
    // A new page: the focus goes to its title, so keyboard and screen reader users start there.
    focusNext = "heading";
    render();
    window.scrollTo(0, 0);
    if (page === "evidence") void loadEvidence();
    return;
  }
  const row = t.closest<HTMLElement>("[data-job]");
  if (row && !t.closest("button") && !t.closest("input")) {
    const me = e as MouseEvent;
    togglePreview(row.dataset.job!, me.metaKey || me.ctrlKey || me.shiftKey);
    return;
  }
  const tab = t.closest<HTMLElement>("[data-view]");
  if (tab) {
    chooseView(tab.dataset.view as View);
    return;
  }
  const b = t.closest<HTMLElement>("[data-action]");
  if (!b || busy) return;
  if (page === "continue") syncContinuation();
  const from = page;
  // The button is disabled while its action runs, which takes the focus away: it comes back after the redraw.
  if ($("content").contains(b)) focusNext = markOf(b);
  try {
    busy = true;
    b.setAttribute("disabled", "");
    await action(b.dataset.action!);
  } catch (err) {
    toast((err as Error).message, true);
  } finally {
    busy = false;
    if (page !== from) focusNext = "heading";
    render();
  }
});
document.addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement;
  // Executor table rows: Enter or Space previews the session, as a click does.
  if (t.matches?.("tr[data-job]") && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault();
    togglePreview(t.dataset.job!, e.ctrlKey || e.metaKey || e.shiftKey);
    return;
  }
  // Figure views are tabs: arrow keys, Home and End move between them and show the view.
  if (t.matches?.("[role=tab][data-view]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
    const tabs = Array.from(t.parentElement!.querySelectorAll<HTMLElement>("[role=tab][data-view]"));
    const i = tabs.indexOf(t);
    const j = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault();
    focusNext = markOf(tabs[j]);
    chooseView(tabs[j].dataset.view as View);
  }
});
// What is typed into a text field survives a redraw until its change event takes it.
document.addEventListener("input", (e) => {
  const el = e.target;
  if ((el instanceof HTMLInputElement && !["checkbox", "radio", "file"].includes(el.type)) || el instanceof HTMLTextAreaElement) typing = el;
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement & HTMLSelectElement;
  if (typing === (el as unknown)) typing = null;
  // The continuation's text fields are read before a redraw, so nothing typed there is lost.
  if (page === "continue") syncContinuation();
  if (el.id === "an-domain" || el.id === "an-outcome") {
    // Scores, human differences and absolute values follow the domain at once; a drawn figure belongs to the old choice.
    if (el.id === "an-domain") domain = el.value as Domain;
    else outcomeId = el.value;
    figureSvg = "";
    figureData = null;
    renderSoon();
    return;
  }
  if (el.id === "hu-outcome") {
    humanOutcome = el.value;
    humanFig = null;
    humanSvg = "";
    renderSoon();
    return;
  }
  if (el.name === "exec-mode") {
    mode = el.value === "agent" ? "agent" : "simulate";
    renderSoon();
    return;
  }
  if (el.id === "watch-running") {
    watchRunning = el.checked;
    renderSoon();
    return;
  }
  if (el.id === "campaign-switch") {
    showCampaign(el.value);
    renderSoon();
    return;
  }
  if (el.dataset.campaignLabel) {
    void api("workspace/campaign-label", { id: ws!.id, campaignId: el.dataset.campaignLabel, label: el.value })
      .then(refreshWorkspace)
      .then(render)
      .catch((err) => toast((err as Error).message, true));
    return;
  }
  if (el.id === "new-label") {
    newLabel = el.value;
    return;
  }
  if (el.dataset.pickJob || el.dataset.pickConfig || el.id === "pick-k") {
    if (el.dataset.pickJob) el.checked ? chosen.add(el.dataset.pickJob) : chosen.delete(el.dataset.pickJob);
    if (el.dataset.pickConfig) el.checked ? pickConfigs.add(el.dataset.pickConfig) : pickConfigs.delete(el.dataset.pickConfig);
    if (el.id === "pick-k") pickK = Math.min(1000, Math.max(1, Math.round(Number(el.value)) || 1));
    renderSoon();
    return;
  }
  if (el.id === "cont-base") {
    contBase = el.value;
    contPreview = null;
    renderSoon();
    return;
  }
  if (el.id === "new-reps") {
    newRepetitions = Math.min(50, Math.max(1, Math.round(Number(el.value)) || 1));
    renderSoon();
    return;
  }
  if (!study) return;
  if (el.dataset.edit) {
    const v = el.value;
    const o = study.outcomes.find((x) => x.id === el.dataset.id);
    switch (el.dataset.edit) {
      case "title":
        study.title = v;
        break;
      case "rq":
        study.researchQuestion = v;
        break;
      case "agent-questions":
        if (v.trim()) study.agentQuestions = v;
        else delete study.agentQuestions;
        break;
      case "agent-title":
        if (v.trim()) study.agentTitle = v;
        else delete study.agentTitle;
        break;
      case "design":
        study.design = v as Study["design"];
        break;
      case "timing":
        study.predictionTiming = v as Study["predictionTiming"];
        if (v === "before-experience") agents.forEach((a) => delete a.inputs);
        break;
      case "engine":
        study.runtime.engine = v as Study["runtime"]["engine"];
        break;
      case "observation":
        study.runtime.observation = v as Study["runtime"]["observation"];
        agents.forEach((a) => a.tools.includes("xr-interact") && (a.observation = study!.runtime.observation));
        break;
      case "device":
        study.runtime.deviceProfile = v;
        break;
      case "condition": {
        const c = study.conditions.find((x) => x.id === el.dataset.id);
        if (c && v.trim()) c.label = v.trim();
        break;
      }
      case "outcome-label":
        if (o && v.trim()) o.label = v.trim();
        break;
      case "outcome-unit":
        if (o && v.trim()) o.unit = v.trim();
        break;
      case "outcome-weight":
        if (o && Number(v) > 0) o.weight = Number(v);
        break;
      case "outcome-domain":
        if (o && (v === "objective" || v === "subjective")) o.domain = v;
        break;
      case "outcome-scale":
        if (o && ["continuous", "proportion", "ordinal", "rank", "count"].includes(v)) {
          o.scale = v as typeof o.scale;
          // A ranking's range is always 1 to the number of designs; counts are averaged arithmetically.
          if (o.scale === "rank") delete o.range;
          if (o.scale === "count") o.aggregation = "arithmetic";
        }
        break;
      case "outcome-range": {
        // Optional: "1–7", "1-7", "0 to 100" or "0, 100". Empty removes the key (never set it to undefined).
        if (!o) break;
        const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:–|—|-|to|,)\s*(-?\d+(?:\.\d+)?)\s*$/i.exec(v);
        if (!v.trim()) delete o.range;
        else if (m && Number(m[1]) < Number(m[2])) o.range = [Number(m[1]), Number(m[2])];
        else toast(`Write the range of ${o.label} as lowest–highest, for example 1–7.`, true);
        break;
      }
      case "outcome-aggregation":
        if (o && (v === "arithmetic" || v === "geometric")) o.aggregation = v;
        break;
      case "family-weight":
        if (Number(v) > 0) study.analysis.familyWeights[el.dataset.id!] = Number(v);
        break;
    }
    renderSoon();
    return;
  }
  if (el.dataset.cfg) {
    const a = agents.find((x) => x.id === el.dataset.cfg)!;
    const f = el.dataset.field!;
    if (f === "label") a.label = el.value;
    else if (f === "level") {
      a.level = el.value as AgentProtocol["level"];
      // Movement recordings are per participant: a population configuration cannot get them.
      const movement = a.sourceIds.filter((id) => study!.sources.find((x) => x.id === id)?.kind === "trajectory");
      if (a.level === "population" && movement.length) {
        setAccess(a, a.sourceIds.filter((id) => !movement.includes(id)), a.tools.includes("xr-interact"));
        toast(`Movement recordings are per participant, so ${a.label} no longer gets them.`);
      }
    }
    else if (f === "repetitions") el.value ? (a.repetitions = Number(el.value)) : delete a.repetitions;
    else if (f === "runtime") {
      // A runtime is what plays the app: "none" unticks the app, another runtime ticks it.
      if (el.value === "none") setAccess(a, a.sourceIds, false);
      else {
        if (!a.tools.includes("xr-interact")) setAccess(a, a.sourceIds, true);
        a.runtime = el.value;
      }
    }
    else if (f === "maxToolCalls") a.maxToolCalls = Number(el.value);
    else if (f === "maxTokens") el.value ? (a.maxTokens = Math.round(Number(el.value))) : delete a.maxTokens;
    else if (f === "provider" || f === "model" || f === "reasoning") a.model = { ...a.model, [f]: el.value };
    renderSoon();
    return;
  }
  if (el.dataset.src || el.dataset.app) {
    const id = el.dataset.app ?? el.dataset.src!.split("|")[0];
    const a = agents.find((x) => x.id === id)!;
    let ids = [...a.sourceIds];
    if (el.dataset.src) {
      const src = el.dataset.src.split("|")[1];
      ids = el.checked ? [...ids, src] : ids.filter((x) => x !== src);
    }
    setAccess(a, ids, el.dataset.app ? el.checked : a.tools.includes("xr-interact"));
    if (evidence) evidence = evidence.map((e) => ({ ...e, configs: agents.filter((x) => x.sourceIds.includes(e.id)).map((x) => x.id) }));
    renderSoon();
    return;
  }
  if (el.dataset.target || el.dataset.input) {
    const [id, outcome] = (el.dataset.target ?? el.dataset.input)!.split("|");
    const a = agents.find((x) => x.id === id)!;
    const all = study.outcomes.map((x) => x.id);
    if (el.dataset.target) {
      const cur = new Set((a.targets ?? all).filter((x) => !a.inputs?.includes(x)));
      el.checked ? cur.add(outcome) : cur.delete(outcome);
      a.targets = all.filter((x) => cur.has(x));
      if (a.targets.length === all.length && !a.inputs?.length) delete a.targets;
      if (el.checked && a.inputs?.includes(outcome)) a.inputs = a.inputs.filter((x) => x !== outcome);
    } else {
      const cur = new Set(a.inputs ?? []);
      el.checked ? cur.add(outcome) : cur.delete(outcome);
      a.inputs = all.filter((x) => cur.has(x));
      if (!a.inputs.length) delete a.inputs;
      if (el.checked && a.targets) a.targets = a.targets.filter((x) => x !== outcome);
    }
    renderSoon();
    return;
  }
  if (el.dataset.pick) {
    el.checked ? selected.add(el.dataset.pick) : selected.delete(el.dataset.pick);
    return;
  }
  if (el.dataset.cont) {
    const r = contRows[el.dataset.cont];
    const f = el.dataset.field!;
    if (f === "repetitions") r.repetitions = Number(el.value);
    else (r as any)[f] = el.checked;
    // A preview of other choices is gone: Create continuation waits for a new preview.
    contPreview = null;
    renderSoon();
    return;
  }
  if (el.id === "cont-keep-sim") {
    contKeepSimulated = el.checked;
    contPreview = null;
    renderSoon();
    return;
  }
  if (el.id === "cmp-before" || el.id === "cmp-after") {
    if (el.id === "cmp-before") cmpBefore = el.value;
    else cmpAfter = el.value;
    campaignCmp = null;
    renderSoon();
    return;
  }
});

/** Edits a reload or a closed tab would lose: changed study or configurations, drafts not added yet. */
function unsavedWork() {
  if (!ws) return false;
  const typedBrief = briefEdit !== null && ($<HTMLTextAreaElement>("brief-text")?.value ?? briefEdit) !== briefEdit;
  return JSON.stringify({ study, agents }) !== baseline || briefDraft !== null || typedBrief || !!knowledgeDraft || !!understanding;
}
window.addEventListener("beforeunload", (e) => {
  if (!unsavedWork()) return;
  e.preventDefault();
  e.returnValue = "";
});
async function start() {
  settings = await api("settings");
  workspaces = await api("workspaces");
  const wanted = new URL(location.href).searchParams.get("study");
  if (wanted && workspaces.some((w) => w.id === wanted)) {
    await openWorkspace(wanted);
    if (page === "home") page = "study";
  }
  render();
}
start().catch((e) => ($("content").innerHTML = `<div class="error">${esc((e as Error).message)}</div>`));
