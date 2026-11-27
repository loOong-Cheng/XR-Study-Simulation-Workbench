// What an app session did with its required tasks before its forecast, from the audit trace.
// Pure, so the study server, the executor, the summaries and the analysis judge it the same way.
import type { RunResult } from "./types.js";

type Ev = { type?: unknown; caseId?: unknown; submitted?: unknown };

/**
 * Required cases the trace does not show as started (case-start) and then finished (a case-end
 * with `submitted: true`) before the forecast boundary. A case that ended unfinished
 * (`submitted: false`, e.g. the agent opened the next design first) counts as missing, unless it
 * was started again and finished later. `events` are trace events (TraceEvent), in order.
 */
export function unfinishedCases(required: string[], events: unknown[]): string[] {
  return caseProgress(required, events).missing;
}
/**
 * The required cases that are not finished (`missing`), and among them those that were started
 * (`started`: begun, then left unfinished or still open).
 */
export function caseProgress(required: string[], events: unknown[]): { missing: string[]; started: string[] } {
  const started = new Set<string>(),
    finished = new Set<string>();
  for (const e of events as Ev[]) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "forecast") break;
    if (e.type === "case-start" && typeof e.caseId === "string") started.add(e.caseId);
    else if (e.type === "case-end" && typeof e.caseId === "string" && started.has(e.caseId) && e.submitted === true) finished.add(e.caseId);
  }
  const missing = required.filter((id) => !finished.has(id));
  return { missing, started: missing.filter((id) => started.has(id)) };
}
/**
 * The required tasks a session left unfinished although its forecast was accepted: an incomplete
 * session (the study server accepts such a forecast only when a budget was nearly used up). Empty
 * for a complete session, a configuration that does not use the app, a failed run and a simulated
 * run (invented, it plays nothing).
 */
export function unfinishedTasks(protocol: { tools: string[]; requiredCaseIds: string[] } | null | undefined, run: Pick<RunResult, "status" | "trace"> & { execution?: { synthetic?: boolean } }): string[] {
  if (!protocol || !protocol.tools.includes("xr-interact") || !protocol.requiredCaseIds.length) return [];
  if (run.status !== "completed" || run.execution?.synthetic) return [];
  return caseProgress(protocol.requiredCaseIds, Array.isArray(run.trace) ? run.trace : []).missing;
}
/** What an incomplete session is called wherever it is listed. */
export const INCOMPLETE_TEXT = "incomplete: forecast accepted before every required task was finished";
