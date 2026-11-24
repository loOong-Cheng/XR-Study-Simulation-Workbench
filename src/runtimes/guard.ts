// What the runtime MCP servers never hand to an agent, whatever folder they were given: human
// results and run records. A second guard behind the source rule (workspace.ts → sourceLocation).
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

/** True when p is root or inside it (both already resolved). */
export const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * Hidden from agents: any file named human.json, and the campaigns/, runs/ and deleted/ folders
 * (and human.json) of any study folder (a folder with a study.json) on the way up.
 * `real` must be a resolved real path.
 */
export function hiddenFromAgents(real: string): boolean {
  if (basename(real).toLowerCase() === "human.json") return true;
  let child = real;
  for (let dir = dirname(real); dir !== child; child = dir, dir = dirname(dir))
    if (/^(campaigns|runs|deleted)$/i.test(basename(child)) && existsSync(join(dir, "study.json"))) return true;
  return false;
}

/**
 * The real path of `target` if it exists, stays inside `root` (a real path) after resolving
 * symlinks, and is not hidden from agents; otherwise null.
 */
export function agentPath(root: string, target: string): string | null {
  if (!within(root, target) || !existsSync(target)) return null;
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return null;
  }
  return within(root, real) && !hiddenFromAgents(real) ? real : null;
}
