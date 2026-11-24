// What the runtime MCP servers never hand to an agent, whatever folder they were given: human
// results and run records. A second guard behind the source rule (workspace.ts → sourceLocation),
// which uses the same checks.
//
// Names are never compared as the caller spelled them. macOS (APFS) and Windows (NTFS) volumes are
// usually case-insensitive and fold more than letter case: "HUMAN.JSON", "human.jſon" (long s) and,
// on Windows, "human.json." / "human.json " (trailing dot or space), 8.3 short names (HUMAN~1.JSO)
// and "human.json::$DATA" (a data stream) all open human.json. So every path is first resolved to
// the names it really has on disk (realPath), and only then checked.
import { constants, existsSync, lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

type Platform = NodeJS.Platform;
const lib = (platform: Platform) => (platform === "win32" ? path.win32 : path.posix);

/**
 * Files and folders that are never part of a source or app, on any system: dot files (.DS_Store,
 * ._*, .git), Windows clutter (desktop.ini, Thumbs.db, $RECYCLE.BIN), macOS folder icons (Icon\r)
 * and Office lock files (~$…). One list for source and app fingerprints and for what agents can
 * list or read (agentFileList, agentPath), so a folder hashes the same on Windows and macOS.
 */
export function ignoredName(name: string): boolean {
  return (
    name.startsWith(".") ||
    name.startsWith("~$") ||
    /^(desktop\.ini|thumbs\.db|ehthumbs(_vista)?\.db|icon\r|\$recycle\.bin|system volume information)$/i.test(name)
  );
}

/**
 * The real path with every name as it is on disk: symlinks and junctions resolved, the on-disk
 * letter case, Windows long names instead of 8.3 short names, and look-alikes the volume folds to
 * one name (long s, trailing dots) replaced by that name. Falls back to Node's own resolver only
 * where the system call fails for another reason than a missing path (some network or RAM drives).
 * Throws when the path does not exist.
 */
export function realPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch (e) {
    if (["ENOENT", "ENOTDIR", "ELOOP", "ENAMETOOLONG"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
    return realpathSync(p);
  }
}

/** Unicode normalized (NFC) and case-folded per character, so "ſ" → "s" and "K" (Kelvin sign) → "k". */
function fold(s: string): string {
  let out = "";
  for (const c of s.normalize("NFC")) {
    const upper = c.toUpperCase();
    out += (upper.length === c.length ? upper : c).toLowerCase();
  }
  return out;
}
/**
 * A path as compared on this system: Unicode normalized (NFC), and on macOS and Windows, whose
 * volumes are case-insensitive by default, case-folded (see fold).
 */
export const pathKey = (p: string, platform: Platform = process.platform): string => (platform === "win32" || platform === "darwin" ? fold(p) : p.normalize("NFC"));
/** A file or folder name as checked against protected names: folded on every system (refusing "HUMAN.JSON" on Linux too is harmless). */
export const nameKey = (name: string): string => fold(name);

/**
 * True when p is root or inside it, compared with pathKey (letter case ignored on macOS and
 * Windows). Use real paths (realPath) on both sides. Used for refusals: being generous is safe.
 */
export function within(root: string, p: string, platform: Platform = process.platform): boolean {
  const sep = lib(platform).sep;
  const r = pathKey(root, platform),
    x = pathKey(p, platform);
  return x === r || x.startsWith(r.endsWith(sep) ? r : r + sep);
}
/**
 * True when p is root or really inside it: within() and, on a case-sensitive volume, not a sibling
 * folder whose name differs only in letter case. Used where being inside grants access.
 */
export function inside(root: string, p: string, platform: Platform = process.platform): boolean {
  if (!within(root, p, platform)) return false;
  const rel = lib(platform).relative(root, p);
  return rel === "" || (rel.split(/[\\/]/)[0] !== ".." && !lib(platform).isAbsolute(rel));
}

/**
 * Why a path, as written by a person or an agent, may name a different file on Windows than it
 * seems to, or null. On Windows: a ":" after the drive (a data stream such as "human.json::$DATA",
 * or a device), or a name ending in a dot or space ("human.json." opens human.json). Other systems
 * keep such names as they are.
 */
export function windowsAliasProblem(p: string, platform: Platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const rest = p.replace(/^[A-Za-z]:/, "");
  if (rest.includes(":")) return 'has a ":" after the drive; on Windows that names a data stream of a file';
  for (const part of rest.split(/[\\/]/))
    if (part !== "." && part !== ".." && /[. ]$/.test(part)) return `has a name ending in a dot or space (${JSON.stringify(part)}); Windows drops those`;
  return null;
}
/** A Windows 8.3 short name such as HUMAN~1.JSO or CAMPAI~1. */
export const looksLikeShortName = (name: string) => /^[^.~]{1,6}~\d{1,6}(\.[^.]{0,3})?$/.test(name);

const PROTECTED_FOLDER = new Set(["campaigns", "runs", "deleted"]);
export type Refusal = "human" | "records" | "hardlink" | "alias";
/**
 * Why an agent may not get a file or folder, or null. `real` must be a real path (realPath).
 * - any file named human.json (letter case and look-alikes folded);
 * - campaigns/, runs/ and deleted/ of any study folder (a folder with a study.json) on the way up,
 *   so a study nested in another one is covered too;
 * - a file with more than one name on disk (a hard link): its other name may be a human.json or a
 *   run record, and nothing tells which;
 * - on Windows, a name that is still an 8.3 short name after resolving.
 */
export function agentRefusal(real: string, platform: Platform = process.platform): Refusal | null {
  const p = lib(platform);
  if (nameKey(p.basename(real)) === "human.json") return "human";
  let child = real;
  for (let dir = p.dirname(real); dir !== child; child = dir, dir = p.dirname(dir)) {
    if (PROTECTED_FOLDER.has(nameKey(p.basename(child))) && existsSync(p.join(dir, "study.json"))) return "records";
    if (platform === "win32" && looksLikeShortName(p.basename(child))) return "alias";
  }
  try {
    const s = statSync(real);
    if (s.isFile() && s.nlink > 1) return "hardlink";
  } catch {
    // gone meanwhile: the caller's own checks say so
  }
  return null;
}
/** True when an agent may not get this real path (see agentRefusal). */
export const hiddenFromAgents = (real: string): boolean => agentRefusal(real) !== null;

/** agentPath with a root that is already a real path. */
function agentPathIn(realRoot: string, target: string): string | null {
  if (windowsAliasProblem(target) || !existsSync(target)) return null;
  let real: string;
  try {
    real = realPath(target);
  } catch {
    return null;
  }
  // OS clutter and dot files are not part of the folder, as written or as resolved.
  const rel = path.relative(realRoot, real);
  if (rel && (ignoredName(path.basename(target)) || rel.split(/[\\/]/).some(ignoredName))) return null;
  return inside(realRoot, real) && !hiddenFromAgents(real) ? real : null;
}
/**
 * The real path of `target` if it exists, stays inside `root` after resolving symlinks, and is not
 * hidden from agents; otherwise null. `root` is resolved here as well.
 */
export function agentPath(root: string, target: string): string | null {
  try {
    return agentPathIn(realPath(root), target);
  } catch {
    return null;
  }
}

/**
 * The files of a folder as agents may see them ("sub/file.txt", at most `max`): dot files, OS
 * clutter (ignoredName) and everything agentPath would refuse (hidden from agents, or a link leading out of the folder) left
 * out, so a listing never names a file that reading would refuse. One list for the website, the
 * prompt and list_files.
 */
export async function agentFileList(root: string, max = 500): Promise<string[]> {
  const realRoot = realPath(root);
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(path.join(realRoot, rel), { withFileTypes: true })) {
      if (out.length >= max) return;
      const real = ignoredName(e.name) ? null : agentPathIn(realRoot, path.join(realRoot, rel, e.name));
      if (!real) continue;
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(name);
      else out.push(name);
    }
  };
  await walk("");
  return out;
}
/** The entries of one folder that agents may see (see agentFileList), folders with a trailing "/". */
export async function agentFolderEntries(dir: string, root: string): Promise<string[]> {
  const realRoot = realPath(root);
  return (await readdir(dir, { withFileTypes: true }))
    .filter((e) => !ignoredName(e.name) && agentPathIn(realRoot, path.join(dir, e.name)))
    .map((e) => (e.isDirectory() ? e.name + "/" : e.name));
}

// ---------- reading a checked file ----------

/** Why readChecked refused a file; `problem` completes "The file …" or "Source '<id>' …". */
export class ReadRefused extends Error {
  constructor(
    readonly reason: "missing" | "not-file" | "link" | "hardlink" | "protected" | "changed" | "too-large",
    readonly problem: string,
  ) {
    super(`The file ${problem}.`);
  }
}
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const changed = () => new ReadRefused("changed", "was replaced or moved while it was read. Try again; if this keeps happening, check what else changes the study folder");
/** Test hooks: run before a checked file is opened and between opening and checking it (to put another file in its place). */
export const readCheckedHooks: { beforeOpen?: (path: string) => void; afterOpen?: (path: string) => void } = {};
/**
 * The bytes of a file that was checked by its path (sourceLocation, agentPath, the screenshot
 * route), read so that what is read is the file that was checked. Between a check by path and a
 * read by path, another process could put another file there (a hard link to human.json, a link, a
 * renamed file). So the file is opened once, without following a link in its last name
 * (O_NOFOLLOW where the system has it), and the open file is checked:
 * - a regular file with exactly one name on disk (a hard link's other name may be human.json);
 * - not one of the `protect` files (same device and inode, e.g. the study's human.json);
 * - still the file the checked path names, with one name, and the path still resolves to itself
 *   (nothing on the way was replaced by a link meanwhile).
 * Only then is it read, from that open file. A refusal is a ReadRefused with a plain message.
 */
export async function readChecked(real: string, opts: { protect?: string[]; maxBytes?: number } = {}): Promise<Buffer> {
  const protectedFiles = (opts.protect ?? []).map((p) => statSync(p, { bigint: true, throwIfNoEntry: false })).filter((s): s is BigIntStats => !!s);
  let fh: Awaited<ReturnType<typeof open>>;
  readCheckedHooks.beforeOpen?.(real);
  try {
    // O_NONBLOCK: a pipe put in the file's place does not hang the read (no effect on regular files).
    fh = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK") throw new ReadRefused("link", "is a link now (it was checked as a plain file). Point at the file itself");
    if (code === "ENOENT" || code === "ENOTDIR") throw new ReadRefused("missing", "does not exist");
    if (code === "EISDIR") throw new ReadRefused("not-file", "is a folder, not a file");
    throw new ReadRefused("missing", `cannot be opened (${code ?? "unknown error"})`);
  }
  try {
    readCheckedHooks.afterOpen?.(real);
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw new ReadRefused("not-file", "is not a plain file");
    if (protectedFiles.some((p) => sameFile(p, st))) throw new ReadRefused("protected", "is the study's human results (human.json), which are never shown or given to agents");
    if (st.nlink === 0n) throw changed();
    if (st.nlink !== 1n) throw new ReadRefused("hardlink", "has more than one name on disk (a hard link), which may be human results or run records. Copy the file instead of linking it");
    let now: BigIntStats | undefined, resolved: string | null;
    try {
      now = lstatSync(real, { bigint: true, throwIfNoEntry: false });
      resolved = realPath(real);
    } catch {
      resolved = null;
    }
    // Windows has no O_NOFOLLOW: a link put in the file's place before the open was followed.
    if (now?.isSymbolicLink()) throw new ReadRefused("link", "is a link now (it was checked as a plain file). Point at the file itself");
    if (!now || !sameFile(now, st) || now.nlink !== 1n || resolved !== real)
      throw changed();
    const tooLarge = () => new ReadRefused("too-large", `is larger than ${Math.round(opts.maxBytes! / 1e6)} MB`);
    if (opts.maxBytes !== undefined && st.size > BigInt(opts.maxBytes)) throw tooLarge();
    const data = await fh.readFile();
    if (opts.maxBytes !== undefined && data.length > opts.maxBytes) throw tooLarge();
    return data;
  } finally {
    await fh.close().catch(() => undefined);
  }
}
