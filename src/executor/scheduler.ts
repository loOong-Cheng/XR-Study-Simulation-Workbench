// One scheduler for the whole workbench: Settings → Parallel sessions limits the real sessions of
// all campaigns together, each runtime's "sessions at the same time" holds across campaigns (one
// Unreal or Unity editor is one editor, whichever campaign asks), and simulated sessions have their
// own, higher limit. Free slots go to the campaign with the fewest sessions running (on a tie, the
// one served longest ago), so two campaigns started together share the slots.
import { readSettings, runtimeLimits, type Settings } from "../settings.js";

export interface Schedulable {
  /** "agent": real sessions; "simulate": simulated ones. */
  readonly mode: "agent" | "simulate";
  /** Sessions waiting to start, in queue order (none while paused). */
  waitingSessions(): { id: string; runtime: string }[];
  /** The runtime of every session running now. */
  runningRuntimes(): string[];
  /** Start this session now: it leaves the queue and holds its slot at once. */
  launch(id: string, settings: Settings): void;
  /** Says why sessions wait when another campaign holds the slots; null otherwise. */
  setWaiting(text: string | null): void;
}
/** Simulated sessions call no model and no app, so they get more slots (all campaigns together). */
export const simulatedLimit = (s: Pick<Settings, "concurrency">) => Math.max(s.concurrency, 8);
export const WAITING_FOR_SLOT = "Waiting for a free slot (another campaign is running).";

const members = new Set<Schedulable>();
const served = new Map<Schedulable, number>();
let tick = 0;
export function joinScheduler(m: Schedulable) {
  members.add(m);
}
export function leaveScheduler(m: Schedulable) {
  members.delete(m);
  served.delete(m);
}

let pass: Promise<void> | null = null;
let again = false;
/** Start what fits now. Calls while a pass runs are folded into one more pass. */
export function schedule(): Promise<void> {
  if (pass) {
    again = true;
    return pass;
  }
  pass = (async () => {
    try {
      do {
        again = false;
        dispatch(await readSettings());
      } while (again);
    } catch (e) {
      // Unreadable settings: sessions stay queued; the next start or end tries again.
      console.error("Executor: could not start queued sessions:", (e as Error).message);
    } finally {
      pass = null;
    }
  })();
  return pass;
}

function dispatch(settings: Settings) {
  const list = [...members];
  const limit = (mode: Schedulable["mode"]) => (mode === "agent" ? settings.concurrency : simulatedLimit(settings));
  const used = { agent: 0, simulate: 0 };
  // Real sessions per runtime, across campaigns.
  const engaged = new Map<string, number>();
  const take = (m: Schedulable, runtime: string) => {
    used[m.mode]++;
    if (m.mode === "agent") engaged.set(runtime, (engaged.get(runtime) ?? 0) + 1);
  };
  for (const m of list) for (const r of m.runningRuntimes()) take(m, r);
  const fits = (m: Schedulable, runtime: string) =>
    used[m.mode] < limit(m.mode) && (m.mode !== "agent" || (engaged.get(runtime) ?? 0) < runtimeLimits(settings, runtime).maxParallel);
  for (;;) {
    const ready = list.flatMap((m) => {
      const next = m.waitingSessions().find((s) => fits(m, s.runtime));
      return next ? [{ m, next }] : [];
    });
    if (!ready.length) break;
    ready.sort((a, b) => a.m.runningRuntimes().length - b.m.runningRuntimes().length || (served.get(a.m) ?? 0) - (served.get(b.m) ?? 0));
    const { m, next } = ready[0];
    m.launch(next.id, settings);
    served.set(m, ++tick);
    take(m, next.runtime);
  }
  // What still waits: held up by another campaign's sessions, or only by this campaign's own?
  for (const m of list) {
    const waiting = m.waitingSessions();
    const others = list.filter((o) => o !== m && o.mode === m.mode && o.runningRuntimes().length);
    const held =
      waiting.length > 0 &&
      others.length > 0 &&
      (used[m.mode] >= limit(m.mode) || (m.mode === "agent" && waiting.some((s) => others.some((o) => o.runningRuntimes().includes(s.runtime)))));
    m.setWaiting(held ? WAITING_FOR_SLOT : null);
  }
}
