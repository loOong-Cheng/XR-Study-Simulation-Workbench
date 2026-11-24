// Checks every request to the local workbench passes, and the error text it may send back.
//  - Host: only localhost, 127.0.0.1 or [::1] (any port). A page on another site that points its own
//    name at 127.0.0.1 (DNS rebinding) sends its own name as Host and is refused, so it can never
//    read studies, sources, settings or runs.
//  - Origin (POST): only the workbench's own origin, so other sites cannot change anything.
//  - Errors: expected messages go back as they are; anything unexpected (a bug, a file system error)
//    becomes "Something went wrong: <short reason>". No absolute path of this machine is sent.
import { homedir } from "node:os";
import { sep } from "node:path";
import { repoRoot } from "./workspace.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** The Host header names this machine (any port). Missing or other names are refused. */
export function hostAllowed(host: string | undefined): boolean {
  if (typeof host !== "string") return false;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(host.trim());
  return !!m && LOCAL_HOSTS.has(m[1].toLowerCase());
}
/** A POST's Origin, when sent, must be the workbench's own. */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** The text with this machine's absolute paths removed: repository paths become relative, others keep their last part. */
export function scrubPaths(text: string): string {
  let out = text;
  for (const r of [repoRoot, repoRoot.split(sep).join("/")]) out = out.split(r + "/").join("").split(r + "\\").join("").split(r).join(".");
  const home = homedir();
  if (home.length > 3) out = out.split(home).join("~");
  // Any other absolute path (POSIX or Windows) with at least two parts: only its last part.
  return out.replace(/(^|[\s'"`(])((?:[A-Za-z]:)?[\\/](?:[^\s'"`()\\/]+[\\/])+([^\s'"`()\\/]*))/g, (_m, pre: string, _p: string, last: string) => `${pre}…/${last}`);
}

const REASONS: Record<string, string> = {
  ENOENT: "a file or folder it needs was not found",
  EACCES: "permission denied on a file or folder",
  EPERM: "the operation is not permitted on a file or folder",
  EISDIR: "a folder was found where a file was expected",
  ENOTDIR: "a file was found where a folder was expected",
  EBUSY: "a file is in use; try again in a moment",
  EMFILE: "too many files are open; try again in a moment",
  ENOSPC: "the disk is full",
};
/**
 * What a failed request returns. Errors thrown on purpose (plain Error with a message for the
 * researcher) are shown as they are (status 400); everything else is unexpected (status 500) and is
 * logged in full on the server console.
 */
export function publicError(error: unknown): { status: number; message: string; unexpected: boolean } {
  const e = error instanceof Error ? error : new Error(String(error));
  const code = (e as NodeJS.ErrnoException).code;
  // An expected error may carry its own status (404 for a file that is not there).
  const status = (e as { status?: unknown }).status;
  if (e.constructor === Error && !code) return { status: status === 404 ? 404 : 400, message: scrubPaths(e.message).slice(0, 4000), unexpected: false };
  const reason = (code && REASONS[code]) || scrubPaths(e.message).split("\n")[0].slice(0, 300) || e.name;
  return { status: 500, message: `Something went wrong: ${reason}. The full error is in the terminal running the workbench.`, unexpected: true };
}
