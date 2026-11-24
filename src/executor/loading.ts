// Loading a runs zip holds the campaigns it writes to, from before its checks until its files are
// written: sessions of those campaigns (and of continuations of them) do not start meanwhile, and
// their executors are opened from disk only once the zip is written. Otherwise a session started
// while the zip is written takes an attempt number the zip also brings, and the study ends up with
// two different records of one attempt. The other way round, a zip is not loaded into a campaign
// whose sessions run or wait to run.
import { requireThat } from "../core/validation.js";

/** The refusal while a zip is loaded into the campaign (or into one it continues). */
export const LOADING = "Runs are being loaded into this campaign; try again in a moment.";

interface Hold {
  ids: Set<string>;
  digests: Set<string>;
}
/** Study ID (canonical, see workspaceDir) → the holds of zips being loaded into it. */
const holds = new Map<string, Set<Hold>>();
const waiting = new Set<() => void>();
/** Why sessions of a campaign keep a zip from loading (running or waiting to run), or null; set by the executor. */
let busy: (workspaceId: string, campaignId: string) => string | null = () => null;
export function setBusyCheck(check: (workspaceId: string, campaignId: string) => string | null) {
  busy = check;
}

/**
 * Hold campaigns for loading a zip into them: refused while another zip is loaded into one of
 * them, or while sessions of one of them run or wait to run. `digests` adds the campaigns' digests
 * once they are known (continuations name their parents by digest). Release when done (also on
 * failure).
 */
export function holdForLoading(workspaceId: string, campaignIds: Iterable<string>) {
  const ids = new Set(campaignIds);
  for (const h of holds.get(workspaceId) ?? [])
    for (const c of ids) requireThat(!h.ids.has(c), `Runs are already being loaded into campaign ${c}; try again when that has finished.`);
  for (const c of ids) {
    const why = busy(workspaceId, c);
    requireThat(!why, why ?? "");
  }
  const hold: Hold = { ids, digests: new Set() };
  holds.set(workspaceId, (holds.get(workspaceId) ?? new Set()).add(hold));
  let released = false;
  return {
    digests(digests: Iterable<string>) {
      for (const d of digests) hold.digests.add(d);
    },
    release() {
      if (released) return;
      released = true;
      const mine = holds.get(workspaceId)!;
      mine.delete(hold);
      if (!mine.size) holds.delete(workspaceId);
      for (const wake of [...waiting]) wake();
    },
  };
}

/** True while a zip is loaded into this campaign, or into a campaign it continues (`lineage`: digests). */
export function loadingInto(workspaceId: string, campaign: { id: string; lineage?: string[] }): boolean {
  for (const h of holds.get(workspaceId) ?? []) if (h.ids.has(campaign.id) || (campaign.lineage ?? []).some((d) => h.digests.has(d))) return true;
  return false;
}

/** Wait until no zip is loaded into this campaign (at most `timeoutMs`, then LOADING is the refusal). */
export async function untilLoaded(workspaceId: string, campaignId: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (loadingInto(workspaceId, { id: campaignId })) {
    requireThat(Date.now() < deadline, LOADING);
    await new Promise<void>((ok) => {
      const wake = () => {
        waiting.delete(wake);
        clearTimeout(timer);
        ok();
      };
      const timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
      waiting.add(wake);
    });
  }
}
