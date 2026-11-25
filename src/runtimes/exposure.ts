// What a session did with the app before its forecast, from the audit trace. Used by the study
// server (submit_forecast waits for the required cases) and by the executor (row warnings).
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

/**
 * Ask the session's WebXR runtime to record what the app did since its last tool call, including a
 * transition still pending after the last action (docs/runtime-adapters.md → "Delayed
 * transitions"): write <job>/flush-request.json {id} and wait for <job>/flush-done.json with that
 * id. Returns false when no answer came within `timeoutMs` (the runtime is busy or gone); the
 * caller then judges the trace as it is.
 */
export async function flushRuntime(jobDir: string, timeoutMs: number): Promise<boolean> {
  const id = randomUUID();
  const request = join(jobDir, "flush-request.json"),
    done = join(jobDir, "flush-done.json");
  await rm(done, { force: true }).catch(() => undefined);
  await writeFile(`${request}.tmp`, JSON.stringify({ id, t: Date.now() }));
  await rename(`${request}.tmp`, request);
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
    if (!existsSync(done)) continue;
    try {
      if ((JSON.parse(await readFile(done, "utf8")) as { id?: unknown }).id === id) {
        await rm(done, { force: true }).catch(() => undefined);
        return true;
      }
    } catch {
      // being written
    }
  }
  await rm(request, { force: true }).catch(() => undefined);
  return false;
}
