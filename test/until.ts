// Waiting in tests on what happens, not on a fixed time: a slow CI runner only takes longer.
import type { Executor } from "../src/executor/runner.js";

/**
 * Resolves once `ready()` holds. It is checked after every event of `executor` (when given) and every
 * 50 ms; `limitMs` (default 3 minutes, far above any normal run) only keeps a broken test from
 * hanging, and the failure names `what` with the executor's counts.
 */
export async function until(ready: () => boolean | Promise<boolean>, what: string, opts: { executor?: Executor; limitMs?: number } = {}): Promise<void> {
  const limit = opts.limitMs ?? 180_000;
  const started = Date.now();
  let wake = () => undefined as void;
  const listener = () => wake();
  opts.executor?.listeners.add(listener);
  try {
    while (!(await ready())) {
      if (Date.now() - started > limit)
        throw new Error(`Waited ${Math.round(limit / 1000)} s for ${what}${opts.executor ? `; sessions: ${JSON.stringify(opts.executor.snapshot().counts)}` : ""}.`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, 50);
        wake = () => (clearTimeout(t), r());
      });
    }
  } finally {
    opts.executor?.listeners.delete(listener);
  }
}
