// What a session did with the app before its forecast, from the audit trace. Used by the study
// server (submit_forecast waits for the required cases) and by the executor (row warnings).
import { readFile } from "node:fs/promises";

type Ev = { type?: unknown; caseId?: unknown };

/**
 * Required cases the trace does not show as both started (case-start) and ended (case-end)
 * before the forecast boundary. `events` are trace events (TraceEvent), in order.
 */
export function unfinishedCases(required: string[], events: unknown[]): string[] {
  const started = new Set<string>(),
    ended = new Set<string>();
  for (const e of events as Ev[]) {
    if (!e || typeof e !== "object") continue;
    if (e.type === "forecast") break;
    if (e.type === "case-start" && typeof e.caseId === "string") started.add(e.caseId);
    else if (e.type === "case-end" && typeof e.caseId === "string" && started.has(e.caseId)) ended.add(e.caseId);
  }
  return required.filter((id) => !ended.has(id));
}

/** The events of <job>/trace.jsonl (each line's `event`), in order; unreadable lines are skipped. */
export async function traceEvents(tracePath: string): Promise<unknown[]> {
  let body = "";
  try {
    body = await readFile(tracePath, "utf8");
  } catch {
    return [];
  }
  const events: unknown[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { event?: unknown };
      if (entry && entry.event) events.push(entry.event);
    } catch {
      // a line being written right now, or not JSON
    }
  }
  return events;
}
