// Save runs as a zip (any time, also mid-run) and load such a zip into a study
// workspace for the analyzer. The zip carries the campaign and its ancestors so
// reused results can be matched to the campaign that executed them.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { verifyCampaign, type Campaign, type CampaignReceipt } from "../core/campaign.js";
import { requireThat } from "../core/validation.js";
import { listCampaigns, readCampaign, runDir, studyWriteTarget, workspaceDir } from "../workspace.js";

const JSZip = createRequire(import.meta.url)("jszip") as typeof import("jszip");
const sha = (x: Buffer | string) => createHash("sha256").update(x).digest("hex");
const within = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// ---------- names, as every disk sees them ----------

/**
 * A name as a disk that ignores letter case and Unicode normalisation sees it (macOS, Windows):
 * "NOTE.txt" and "note.txt", or "café" written in NFC and in NFD, are one file there. Zips are
 * checked with this on every system, so a zip loads (or is refused) the same everywhere.
 */
export const foldName = (s: string) => s.normalize("NFKC").toUpperCase().toLowerCase().normalize("NFC");
/** Longest part of a name (between "/"), in UTF-8 bytes; disks allow 255. */
export const NAME_PART_LIMIT = 200;
/** Names Windows reserves for devices (also with an extension). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/;
const short = (name: string) => (name.length > 160 ? name.slice(0, 160) + "…" : name);

/**
 * Why a zip entry name is not safe on every system, or null: "/" separators only, no backslash,
 * drive letter or other ":", no absolute name, no empty, "." or ".." part, no part ending in a dot
 * or space (Windows drops them), no device name (CON, NUL, COM1…), and no part longer than
 * NAME_PART_LIMIT bytes.
 */
export function zipNameProblem(name: string): string | null {
  const unsafe = `Unsafe path in zip: ${short(String(name))}.`;
  if (typeof name !== "string" || !name || name.length > 500 || name.startsWith("/")) return unsafe;
  for (const p of name.split("/")) {
    // Checked as written and as a disk may normalise it ("／" and "：" become "/" and ":").
    if (p === "" || p === "." || p === ".." || /[. ]$/.test(p) || /[/\\:*?"<>|\0-\x1f]/.test(p.normalize("NFKC")) || RESERVED.test(foldName(p))) return unsafe;
    if (Buffer.byteLength(p, "utf8") > NAME_PART_LIMIT) return `A name in this zip has a part longer than ${NAME_PART_LIMIT} characters, which some disks cannot store: ${short(name)}.`;
  }
  return null;
}
export const safeZipName = (name: string): boolean => zipNameProblem(name) === null;

/** A plain relative name of a file in a run folder ("jobs/<job>/a1/execution-manifest.json"). */
const recordName = (rel: unknown): rel is string => typeof rel === "string" && safeZipName(rel);
/**
 * A file a receipt names (its output or execution manifest), given relative to the campaign's run
 * folder: its path there, or null when the name is not a plain relative path or leads out of the
 * run folder (also through a link).
 */
export function runRecordPath(dir: string, rel: unknown): string | null {
  if (!recordName(rel)) return null;
  const root = resolve(dir);
  const path = resolve(root, rel);
  if (!within(root, path) || path === root) return null;
  try {
    if (existsSync(path) && !within(realpathSync(root), realpathSync(path))) return null;
  } catch {
    return null;
  }
  return path;
}

/** JSON with its object keys sorted: two records that differ only in key order compare equal. */
export function canonicalJson(x: unknown): string {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(sorted(x));
}

// ---------- what Save runs as zip writes ----------

/** Campaign IDs as the workbench writes them: lower case only ("campaign-" + a UUID). */
const CAMPAIGN = "[a-z0-9_-]{1,200}";
/**
 * Never in an attempt folder of a runs zip (compared as a case- and accent-insensitive disk does):
 * the agent's working folder (Claude Code starts there and reads its settings), Claude Code's
 * settings and memory files, and human results.
 */
const NEVER = new Set(["session", ".claude", "claude.md", "claude.local.md", "human.json"]);
type Entry =
  | { kind: "campaign"; name: string; campaign: string }
  | { kind: "receipts" | "events"; name: string; campaign: string }
  | { kind: "result"; name: string; campaign: string; jobId: string }
  | { kind: "job"; name: string; campaign: string; jobId: string; attempt: number; file: string };
/** The kinds of file Save runs as zip writes; anything else is refused. */
function classify(name: string): Entry | null {
  let m = new RegExp(`^campaigns/(${CAMPAIGN})/campaign\\.json$`).exec(name);
  if (m) return { kind: "campaign", name, campaign: m[1] };
  m = new RegExp(`^runs/(${CAMPAIGN})/(receipts|events)\\.jsonl$`).exec(name);
  if (m) return { kind: m[2] as "receipts" | "events", name, campaign: m[1] };
  m = new RegExp(`^runs/(${CAMPAIGN})/results/([A-Za-z0-9_-]{1,400})\\.json$`).exec(name);
  if (m) return { kind: "result", name, campaign: m[1], jobId: m[2] };
  m = new RegExp(`^runs/(${CAMPAIGN})/jobs/([A-Za-z0-9_-]{1,400})/a([1-9]\\d{0,5})/(.+)$`).exec(name);
  if (m && !m[4].split("/").some((p) => NEVER.has(foldName(p)))) return { kind: "job", name, campaign: m[1], jobId: m[2], attempt: Number(m[3]), file: m[4] };
  return null;
}
/** The campaign ID a zip name is filed under, as written (any letter case), or null. */
const campaignFolder = (name: string) => /^(?:campaigns|runs)\/([A-Za-z0-9_-]{1,200})(?:\/|$)/.exec(name)?.[1] ?? null;
const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim());
const receiptKey = (r: Pick<CampaignReceipt, "campaignDigest" | "jobId" | "attempt">) => `${r.campaignDigest}|${r.jobId}|${r.attempt}`;
/** Receipts of a campaign's run folder (finished attempts: "job|attempt"); unreadable lines are left out. */
async function finishedAttempts(dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const path = join(dir, "receipts.jsonl");
  if (!existsSync(path)) return out;
  for (const l of lines(await readFile(path, "utf8")))
    try {
      const r = JSON.parse(l) as CampaignReceipt;
      if (r && typeof r.jobId === "string" && Number.isInteger(r.attempt)) out.add(`${r.jobId}|${r.attempt}`);
    } catch {
      // not a receipt
    }
  return out;
}

// ---------- saving ----------

/** What Save runs as zip left out, by reason. */
export interface ExportSkipped {
  /** Links (never followed) and anything else that is not a regular file. */
  notFiles: number;
  /** Files of attempts without a receipt (running, or ended without one): a loaded zip never carries them. */
  unfinished: number;
  /** Files whose names a zip cannot carry safely (see zipNameProblem), or that would be one file on another disk. */
  names: number;
}
/**
 * Regular files under a folder, as paths relative to it ("/" separators). Links are never
 * followed and, like anything else that is not a file or folder, only counted. Agent working
 * folders (session/) are never exported.
 */
async function regularFiles(root: string, skipped: ExportSkipped, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(join(root, rel))).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = await lstat(join(root, r));
    if (st.isDirectory()) {
      if (foldName(name) !== "session") out.push(...(await regularFiles(root, skipped, r)));
    } else if (st.isFile()) out.push(r);
    else skipped.notFiles++;
  }
  return out;
}
/** Zip of a campaign's runs plus every ancestor campaign in its lineage (for reused jobs), and what was left out. */
export async function exportRunsReport(workspaceId: string, campaignId: string): Promise<{ zip: Buffer; skipped: ExportSkipped }> {
  const campaign = await readCampaign(workspaceId, campaignId);
  const all = await listCampaigns(workspaceId);
  const lineage = [...(campaign.lineage ?? []).map((d) => all.find((c) => c.digest === d)).filter((c): c is Campaign => !!c), campaign];
  const zip = new JSZip();
  const hashes: Record<string, string> = {};
  const skipped: ExportSkipped = { notFiles: 0, unfinished: 0, names: 0 };
  const taken = new Set<string>();
  for (const c of lineage) {
    const cj = JSON.stringify(c, null, 2) + "\n";
    zip.file(`campaigns/${c.id}/campaign.json`, cj);
    hashes[`campaigns/${c.id}/campaign.json`] = sha(cj);
    taken.add(foldName(`campaigns/${c.id}/campaign.json`));
    const dir = runDir(workspaceId, c.id);
    const st = await lstat(dir).catch(() => null);
    if (!st) continue;
    if (!st.isDirectory()) {
      skipped.notFiles++;
      continue;
    }
    const finished = await finishedAttempts(dir);
    for (const rel of await regularFiles(dir, skipped)) {
      const name = `runs/${c.id}/${rel}`;
      const e = classify(name);
      if (e?.kind === "job" && !finished.has(`${e.jobId}|${e.attempt}`)) {
        skipped.unfinished++;
        continue;
      }
      // Only what Load runs zip accepts, so a saved zip always loads.
      if (!e || zipNameProblem(name) || taken.has(foldName(name))) {
        skipped.names++;
        continue;
      }
      taken.add(foldName(name));
      const data = await readFile(join(dir, ...rel.split("/")));
      zip.file(name, data);
      hashes[name] = sha(data);
    }
  }
  zip.file(
    "manifest.json",
    JSON.stringify(
      { schemaVersion: "xr-study-runs/1", workspace: workspaceId, campaign: campaign.id, campaignDigest: campaign.digest, exportedAt: new Date().toISOString(), skipped, files: hashes },
      null,
      2,
    ),
  );
  return { zip: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), skipped };
}
/** Zip of a campaign's runs plus every ancestor campaign in its lineage (for reused jobs). */
export async function exportRuns(workspaceId: string, campaignId: string): Promise<Buffer> {
  return (await exportRunsReport(workspaceId, campaignId)).zip;
}

// ---------- loading a runs zip ----------

/**
 * Limits on what a zip may unpack to, checked from the sizes the zip declares before anything is
 * unpacked, and again while unpacking (a file larger than it declares is refused).
 */
export const IMPORT_LIMITS = { totalBytes: 2 * 1024 ** 3, fileBytes: 500 * 1024 ** 2, files: 200_000 };
const MB = (n: number) => `${Math.round(n / 1024 ** 2).toLocaleString("en")} MB`;

type ZipFile = import("jszip").JSZipObject;
/** The uncompressed size a zip entry declares (JSZip keeps it from the zip's central directory). */
const declaredSize = (f: ZipFile) => Number((f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize);
/**
 * Unpack one entry while counting: stops as soon as it exceeds the size it declares (already
 * checked against IMPORT_LIMITS), so a zip bomb with false sizes never fills memory. Returns the
 * SHA-256 and, when `keep`, the bytes.
 */
function unpack(f: ZipFile, keep: boolean): Promise<{ digest: string; bytes: Buffer | null }> {
  const limit = Math.min(declaredSize(f), IMPORT_LIMITS.fileBytes);
  return new Promise((ok, fail) => {
    const hash = createHash("sha256");
    const parts: Buffer[] = [];
    let size = 0,
      settled = false;
    const stream = (f as unknown as { internalStream(t: string): { on(e: string, fn: (x: Uint8Array) => void): unknown; pause(): void; resume(): void } }).internalStream("uint8array");
    const stop = (e: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      fail(e);
    };
    stream.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) return stop(new Error(`${short(f.name)} in this zip is larger than it declares. The zip is damaged; save the runs again with Save runs as zip.`));
      hash.update(chunk);
      if (keep) parts.push(Buffer.from(chunk));
    });
    stream.on("error", () => stop(new Error(`${short(f.name)} in this zip cannot be unpacked. The zip is damaged; save the runs again with Save runs as zip.`)));
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      ok({ digest: hash.digest("hex"), bytes: keep ? Buffer.concat(parts) : null });
    });
    stream.resume();
  });
}

// ---------- contents: the types Save runs as zip writes ----------

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => !!x && typeof x === "object" && !Array.isArray(x);
const isNum = (x: unknown) => typeof x === "number" && Number.isFinite(x);
const numOrNull = (x: unknown) => x === null || isNum(x);
const isStr = (x: unknown) => typeof x === "string";
const has = (o: Obj, k: string, ok: (x: unknown) => boolean) => !Object.prototype.hasOwnProperty.call(o, k) || ok(o[k]);
const SHA = /^[0-9a-f]{64}$/;
const measurementOk = (m: unknown) =>
  isObj(m) &&
  isStr(m.conditionId) &&
  isStr(m.outcomeId) &&
  has(m, "participantId", isStr) &&
  has(m, "value", numOrNull) &&
  has(m, "components", (c) => isObj(c) && Object.values(c).every(numOrNull)) &&
  ("value" in m || "components" in m);
/** Why a session result (results/<job>.json, an attempt's result.json) is not one of `jobId`, or null. */
function runResultProblem(x: unknown, jobId: string): string | null {
  if (!isObj(x) || !isStr(x.planDigest) || !isStr(x.sessionId) || !["completed", "failed"].includes(x.status as string) || !has(x, "error", isStr)) return "is not a session result";
  if (x.jobId !== jobId) return "is the result of another session";
  const e = x.execution;
  if (
    !isObj(e) ||
    typeof e.synthetic !== "boolean" ||
    !["engine", "backend", "observation", "deviceProfile", "provider", "model", "reasoning", "startedAt"].every((k) => has(e, k, isStr)) ||
    !["toolCalls", "outputTokens", "inferenceWallTimeMs", "simulationTimeMs", "technicalRetries", "tokensAtSubmit"].every((k) => has(e, k, isNum)) ||
    !["inputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "humanTimeEstimateMs"].every((k) => has(e, k, numOrNull)) ||
    !has(e, "capabilities", (c) => Array.isArray(c) && c.every(isStr)) ||
    !has(e, "versions", (v) => isObj(v) && Object.values(v).every(isStr))
  )
    return "has no valid execution record";
  if (!Array.isArray(x.measurements) || !x.measurements.every(measurementOk)) return "has invalid measurements";
  if (!Array.isArray(x.trace) || !x.trace.every((t) => isObj(t) && isStr(t.type))) return "has an invalid trace";
  return null;
}
/** Why a line of receipts.jsonl is not a receipt of a session of campaign `c`, or null. */
function receiptProblem(r: unknown, c: Campaign): string | null {
  if (!isObj(r)) return "has a line that is not a receipt";
  if (r.campaignDigest !== c.digest || !isStr(r.jobId) || !c.jobs.some((j) => j.id === r.jobId)) return "has a receipt of another campaign or an unknown session";
  const file = (f: unknown) => f === null || (isObj(f) && isStr(f.sha256) && SHA.test(f.sha256 as string) && recordName(f.path));
  const ok =
    Number.isInteger(r.attempt) &&
    (r.attempt as number) >= 1 &&
    (r.attempt as number) <= 999_999 &&
    ["completed", "failed"].includes(r.status as string) &&
    (r.actualModel === null || (isObj(r.actualModel) && ["provider", "model", "reasoning"].every((k) => isStr((r.actualModel as Obj)[k])))) &&
    isStr(r.sessionId) &&
    ["freshSession", "freshPIE", "freshScreenshots"].every((k) => typeof r[k] === "boolean") &&
    isObj(r.assetHashes) &&
    Object.values(r.assetHashes).every(isStr) &&
    isObj(r.usage) &&
    Object.values(r.usage).every((v) => numOrNull(v) || isStr(v)) &&
    has(r, "error", isStr);
  if (!ok) return "has a line that is not a valid receipt";
  // Files a receipt names are read later: only inside the campaign's run folder.
  if (!file(r.output) || !file(r.executionManifest)) return "has a receipt that names a file outside the campaign's run folder";
  return null;
}
/** Why a line of events.jsonl is not an executor event, or null. */
const eventProblem = (x: unknown) =>
  isObj(x) && isNum(x.t) && ["job", "log", "state"].includes(x.type as string) && has(x, "jobId", isStr) && has(x, "text", isStr) ? null : "has a line that is not an executor event";
/** Why a file of an attempt folder is not what the executor or the runtimes write there, or null. */
function attemptFileProblem(file: string, jobId: string, text: string): string | null {
  const base = file.split("/").at(-1)!;
  if (base.endsWith(".jsonl")) {
    // stream.jsonl keeps Claude Code's output as it came, lines that are not JSON included.
    if (base === "stream.jsonl") return null;
    for (const l of lines(text))
      try {
        if (!isObj(JSON.parse(l))) return "has a line that is not a record";
      } catch {
        return "has a line that is not valid JSON";
      }
    return null;
  }
  if (!base.endsWith(".json")) return null;
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return "is not valid JSON";
  }
  if (file === "result.json") return runResultProblem(x, jobId);
  if (file === "execution-manifest.json")
    return isObj(x) && has(x, "costUsd", numOrNull) && has(x, "usage", isObj) && has(x, "tokensAtSubmit", numOrNull) ? null : "is not an execution manifest";
  if (file === "usage.json") return isObj(x) && Object.values(x).every((v) => numOrNull(v) || typeof v === "boolean") ? null : "is not a usage record";
  if (file === "forecast.json") return isObj(x) && Array.isArray(x.measurements) && x.measurements.every(measurementOk) ? null : "is not a forecast";
  if (file === "job.json" || file === "mcp.json") return isObj(x) ? null : "is not a session description";
  return null;
}
const isText = (name: string) => /\.jsonl?$/.test(name);

// ---------- the disk the zip is loaded onto ----------

/**
 * The names already in the study, compared as a case- and accent-insensitive disk does: a zip
 * name that differs from one here only in letter case or accents is refused on every system, as
 * is a file where the study has a folder (or the other way round).
 */
class DiskNames {
  private cache = new Map<string, Map<string, { name: string; file: boolean; dir: boolean }[]> | null>();
  constructor(private readonly root: string) {}
  private list(dir: string) {
    if (!this.cache.has(dir)) {
      let names: Map<string, { name: string; file: boolean; dir: boolean }[]> | null = null;
      try {
        names = new Map();
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          let isDir = e.isDirectory();
          if (e.isSymbolicLink())
            try {
              isDir = statSync(join(dir, e.name)).isDirectory(); // a linked folder; studyWriteTarget keeps it inside the study
            } catch {
              isDir = false;
            }
          const key = foldName(e.name);
          names.set(key, [...(names.get(key) ?? []), { name: e.name, file: e.isFile(), dir: isDir }]);
        }
      } catch {
        names = null; // not there yet
      }
      this.cache.set(dir, names);
    }
    return this.cache.get(dir)!;
  }
  problem(rel: string): string | null {
    const parts = rel.split("/");
    let dir = this.root;
    for (let i = 0; i < parts.length; i++) {
      const entries = this.list(dir);
      if (!entries) return null;
      const same = entries.get(foldName(parts[i])) ?? [];
      const other = same.find((x) => x.name !== parts[i]);
      if (other)
        return `${short(rel)} in this zip differs only in letter case or accents from ${short([...parts.slice(0, i), other.name].join("/"))} in this study; most disks store them as one. Load the zip into a fresh copy of the study.`;
      const exact = same[0];
      if (!exact) return null;
      const last = i === parts.length - 1;
      if (last && !exact.file) return `${short(rel)} is a folder or a link in this study, but a file in this zip.`;
      if (!last && !exact.dir) return `${short(parts.slice(0, i + 1).join("/"))} is a file in this study, but a folder in this zip.`;
      dir = join(dir, parts[i]);
    }
    return null;
  }
}

type Write = { campaign: string; target: string; replace: boolean } & ({ bytes: Buffer; append?: undefined } | { append: string[]; bytes?: undefined });
/**
 * Write all files of a zip, or none: each is written into a staging folder inside the study, then
 * moved into place (a file it replaces is moved aside first). Lines for receipts.jsonl and
 * events.jsonl are added to the file as it is at that moment, written last. If anything fails,
 * the files moved in are removed, those moved aside are put back, the folders made for this zip
 * are removed, and the staging folder goes.
 */
async function writeAll(root: string, writes: Write[]) {
  const staging = join(root, `.runs-import-${randomUUID()}`);
  const done: { target: string; backup: string | null; placed: boolean }[] = [];
  const made: string[] = [];
  const order = [...writes.filter((w) => !w.append), ...writes.filter((w) => w.append)];
  try {
    await mkdir(join(staging, "new"), { recursive: true });
    await mkdir(join(staging, "old"));
    for (const [i, w] of order.entries()) if (w.bytes) await writeFile(join(staging, "new", String(i)), w.bytes, { flag: "wx" });
    for (const [i, w] of order.entries()) {
      const missing: string[] = [];
      for (let d = dirname(w.target); !lstatSync(d, { throwIfNoEntry: false }); d = dirname(d)) missing.unshift(d);
      for (const d of missing) {
        await mkdir(d);
        made.push(d);
      }
      if (w.append) {
        const before = existsSync(w.target) ? await readFile(w.target, "utf8") : "";
        await writeFile(join(staging, "new", String(i)), before + (before && !before.endsWith("\n") ? "\n" : "") + w.append.join("\n") + "\n", { flag: "wx" });
      }
      const here = !!lstatSync(w.target, { throwIfNoEntry: false });
      if (!w.append) requireThat(here === w.replace, "The study changed while the zip was loading; load it again.");
      const entry = { target: w.target, backup: here ? join(staging, "old", String(i)) : null, placed: false };
      done.push(entry);
      if (entry.backup) await rename(w.target, entry.backup);
      await rename(join(staging, "new", String(i)), w.target);
      entry.placed = true;
    }
  } catch (e) {
    for (const d of done.reverse()) {
      if (d.placed) await rm(d.target, { force: true }).catch(() => undefined);
      if (d.backup) await rename(d.backup, d.target).catch(() => undefined);
    }
    for (const d of made.reverse()) await rmdir(d).catch(() => undefined);
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code ? `The runs could not be written (${code}); nothing from this zip was kept.` : (e as Error).message);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Load a runs zip into a workspace. Everything is checked before anything is written, and the
 * writing itself is all or nothing (see writeAll), so a refused zip leaves nothing behind:
 * - sizes (IMPORT_LIMITS), safe names (zipNameProblem), only the files Save runs as zip writes,
 *   and no two names that one disk would store as one file (letter case, accents, a file and a
 *   folder of the same name), within the zip or with the study;
 * - every campaign verifies, sits in the folder named after its ID (lower case, as the workbench
 *   writes it), belongs to this study, and matches a campaign of the same ID already here; runs
 *   only for campaigns in the zip or here, and only for their sessions; checksums of every file;
 * - contents: receipts, events, results and the records of attempt folders have the types the
 *   exporter writes; files a receipt names are inside the campaign's run folder.
 * Files of attempts without a receipt (in the zip or here) are not loaded: an executor never
 * reuses an attempt folder, so they could only be planted. Existing files are never overwritten,
 * with two exceptions that keep the records consistent: receipts.jsonl and events.jsonl are
 * append-only and get the lines they lack (a receipt that differs from the one here for the same
 * session attempt, keys in any order, is a conflict and refuses the zip), and the files of an
 * attempt this study saw unfinished (no receipt here) are replaced by the zip's finished attempt.
 * `beforeWrite` gets the campaigns that will change, after every check.
 */
export async function importRuns(workspaceId: string, data: Buffer, beforeWrite?: (campaignIds: string[]) => void) {
  const root = workspaceDir(workspaceId);
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error("This file is not a zip. Choose a runs zip saved with Save runs as zip.");
  }
  // 1. Declared sizes, before anything is unpacked.
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  requireThat(entries.length <= IMPORT_LIMITS.files, `This zip holds more than ${IMPORT_LIMITS.files.toLocaleString("en")} files; a runs zip never does.`);
  let total = 0;
  for (const f of entries) {
    const n = declaredSize(f);
    requireThat(Number.isSafeInteger(n) && n >= 0, "This zip is damaged; save the runs again with Save runs as zip.");
    requireThat(n <= IMPORT_LIMITS.fileBytes, `${short(f.name)} in this zip would unpack to ${MB(n)}; files over ${MB(IMPORT_LIMITS.fileBytes)} are not loaded.`);
    total += n;
  }
  requireThat(total <= IMPORT_LIMITS.totalBytes, `This zip would unpack to ${MB(total)}; runs zips over ${MB(IMPORT_LIMITS.totalBytes)} are not loaded. Save fewer campaigns per zip.`);

  // 2. The manifest: which files, with which checksums.
  const manifestFile = zip.file("manifest.json");
  requireThat(manifestFile, "This zip has no manifest.json; export runs from the executor.");
  let manifest: { files?: unknown; campaign?: unknown; skipped?: unknown };
  try {
    manifest = JSON.parse((await unpack(manifestFile!, true)).bytes!.toString("utf8"));
  } catch (e) {
    throw new Error(/damaged/.test((e as Error).message) ? (e as Error).message : "This zip's manifest.json is not valid; save the runs again with Save runs as zip.");
  }
  const listed = manifest?.files;
  requireThat(
    listed && typeof listed === "object" && !Array.isArray(listed) && Object.values(listed).every((d) => typeof d === "string" && /^[0-9a-f]{64}$/.test(d)),
    "This zip's manifest.json is not valid; save the runs again with Save runs as zip.",
  );

  // 3. Names and kinds of file, before unpacking any of them.
  const planned: (Entry & { digest: string })[] = [];
  const byFold = new Map<string, string>();
  for (const [name, digest] of Object.entries(listed as Record<string, string>)) {
    const unsafe = zipNameProblem(name);
    requireThat(!unsafe, unsafe!);
    const id = campaignFolder(name);
    requireThat(
      !id || id === id.toLowerCase(),
      `This zip files runs under the campaign ID ${short(id ?? "")}, which is not written in lower case as the workbench writes campaign IDs. Save the runs again with Save runs as zip.`,
    );
    const e = classify(name);
    requireThat(e, `Unexpected file in zip: ${short(name)}. A runs zip holds only campaigns/<id>/campaign.json and runs/<id>/… as written by Save runs as zip.`);
    requireThat(zip.file(name), `Missing file in zip: ${short(name)}.`);
    const twin = byFold.get(foldName(name));
    requireThat(!twin, `${short(twin ?? "")} and ${short(name)} in this zip differ only in letter case or accents; most disks store them as one file.`);
    byFold.set(foldName(name), name);
    planned.push({ ...e!, digest });
  }
  const folders = new Map<string, string>(); // folder as a disk sees it → as written
  for (const name of byFold.values()) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      const seen = folders.get(foldName(folder));
      requireThat(seen === undefined || seen === folder, `${short(seen ?? "")} and ${short(folder)} in this zip differ only in letter case or accents; most disks store them as one folder.`);
      folders.set(foldName(folder), folder);
    }
  }
  for (const [folded, name] of byFold) requireThat(!folders.has(folded), `${short(name)} in this zip is both a file and a folder.`);
  const disk = new DiskNames(root);
  for (const e of planned) {
    const clash = disk.problem(e.name);
    requireThat(!clash, clash!);
  }

  // 4. Campaigns: verified, in their own folder, of this study, and the same as any campaign here with that ID.
  const studyId = (JSON.parse(await readFile(join(root, "study.json"), "utf8")) as { id: string }).id;
  const here = new Map((await listCampaigns(workspaceId)).map((c) => [c.id, c]));
  const inZip = new Map<string, Campaign>();
  for (const e of planned.filter((x) => x.kind === "campaign")) {
    const { digest, bytes } = await unpack(zip.file(e.name)!, true);
    requireThat(digest === e.digest, `Checksum mismatch: ${short(e.name)}.`);
    let c: Campaign;
    try {
      c = JSON.parse(bytes!.toString("utf8")) as Campaign;
    } catch {
      throw new Error(`${short(e.name)} in this zip is not valid JSON.`);
    }
    requireThat(c && typeof c === "object" && c.id === e.campaign, `${short(e.name)} holds a campaign with another ID. A campaign must be in the folder named after its ID.`);
    verifyCampaign(c);
    const runsOf = c.suite?.study?.id;
    requireThat(runsOf === studyId, `These runs belong to study "${runsOf ?? "unknown"}", but this study's ID is "${studyId}". Load them into the study they were made for (on another machine: the same study.json).`);
    const mine = here.get(c.id);
    requireThat(!mine || mine.digest === c.digest, `This study already has a different campaign with the ID ${c.id}. Load the zip into a fresh copy of the study.`);
    inZip.set(c.id, c);
  }
  requireThat(typeof manifest.campaign === "string" && inZip.has(manifest.campaign), "This zip's manifest.json names a campaign the zip does not hold; save the runs again with Save runs as zip.");
  const campaignOf = (id: string) => inZip.get(id) ?? here.get(id);
  for (const e of planned) {
    if (e.kind === "campaign") continue;
    const c = campaignOf(e.campaign);
    requireThat(c, `The zip has runs of campaign ${e.campaign}, but neither the zip nor this study has that campaign.`);
    if (e.kind === "result" || e.kind === "job") requireThat(c!.jobs.some((j) => j.id === e.jobId), `The zip has runs of a session that campaign ${e.campaign} does not have (${short(e.jobId)}).`);
  }

  // 5. Append-only records: the lines this study lacks. Receipts are matched by session attempt.
  const appends: Write[] = [];
  const receiptsHere = new Map<string, Set<string>>(); // campaign → attempts with a receipt here ("job|attempt")
  const receiptsZip = new Map<string, Set<string>>(); // campaign → attempts with a receipt in the zip
  const receiptsNew = new Map<string, Set<string>>(); // campaign → attempts whose receipt the zip adds
  let newReceipts = 0;
  for (const e of planned.filter((x) => x.kind === "receipts" || x.kind === "events")) {
    const c = campaignOf(e.campaign)!;
    const { digest, bytes } = await unpack(zip.file(e.name)!, true);
    requireThat(digest === e.digest, `Checksum mismatch: ${short(e.name)}.`);
    const target = studyWriteTarget(root, e.name, { records: true });
    const local = existsSync(target) ? lines(await readFile(target, "utf8")) : [];
    const incoming = lines(bytes!.toString("utf8"));
    const parse = (l: string, where: string, problem: (x: unknown) => string | null) => {
      let x: unknown;
      try {
        x = JSON.parse(l);
      } catch {
        throw new Error(`${e.kind}.jsonl of campaign ${e.campaign} ${where} has a line that is not valid JSON.`);
      }
      const p = problem(x);
      requireThat(!p, `${e.kind}.jsonl of campaign ${e.campaign} ${where} ${p}.`);
      return x;
    };
    if (e.kind === "events") {
      // As many copies of a line as are here already are skipped (identical events can share a millisecond).
      const have = new Map<string, number>();
      for (const l of local) {
        let key = l;
        try {
          key = canonicalJson(JSON.parse(l));
        } catch {
          // a line written otherwise is compared as it is
        }
        have.set(key, (have.get(key) ?? 0) + 1);
      }
      const add = incoming.filter((l) => {
        const key = canonicalJson(parse(l, "in the zip", eventProblem));
        const n = have.get(key) ?? 0;
        if (n) have.set(key, n - 1);
        return !n;
      });
      if (add.length) appends.push({ campaign: e.campaign, target, append: add, replace: false });
      continue;
    }
    const receipt = (l: string, where: string) => parse(l, where, (x) => receiptProblem(x, c)) as CampaignReceipt;
    const byKey = new Map<string, CampaignReceipt>();
    for (const l of local) {
      const r = receipt(l, "in this study");
      byKey.set(receiptKey(r), r);
    }
    receiptsHere.set(e.campaign, new Set([...byKey.values()].map((r) => `${r.jobId}|${r.attempt}`)));
    const add: string[] = [];
    for (const l of incoming) {
      const r = receipt(l, "in the zip");
      const key = receiptKey(r);
      receiptsZip.set(e.campaign, (receiptsZip.get(e.campaign) ?? new Set()).add(`${r.jobId}|${r.attempt}`));
      const mine = byKey.get(key);
      if (mine === undefined) {
        byKey.set(key, r);
        add.push(l);
        receiptsNew.set(e.campaign, (receiptsNew.get(e.campaign) ?? new Set()).add(`${r.jobId}|${r.attempt}`));
      } else
        requireThat(
          canonicalJson(mine) === canonicalJson(r),
          receiptsNew.get(e.campaign)?.has(`${r.jobId}|${r.attempt}`)
            ? `The zip has two different records of session ${short(r.jobId)}, attempt ${r.attempt} of campaign ${e.campaign}. Save the runs again with Save runs as zip.`
            : `Session ${short(r.jobId)}, attempt ${r.attempt} of campaign ${e.campaign} was run both here and in the zip, with different records. Load the zip into a fresh copy of the study, or delete this campaign here first.`,
        );
    }
    newReceipts += add.length;
    if (add.length) appends.push({ campaign: e.campaign, target, append: add, replace: false });
  }
  // Campaigns whose receipts.jsonl the zip does not carry: their finished attempts are the ones here.
  for (const e of planned)
    if (e.kind === "job" && !receiptsHere.has(e.campaign)) receiptsHere.set(e.campaign, await finishedAttempts(runDir(workspaceId, e.campaign)));
  const finished = (e: { campaign: string; jobId: string; attempt: number }) =>
    !!receiptsHere.get(e.campaign)?.has(`${e.jobId}|${e.attempt}`) || !!receiptsZip.get(e.campaign)?.has(`${e.jobId}|${e.attempt}`);

  // 6. Every other file: checksum and contents, then new, already here, or the finished version of an attempt seen unfinished here.
  const writes: Write[] = [];
  let kept = 0,
    skipped = 0;
  for (const e of planned) {
    if (e.kind === "receipts" || e.kind === "events") continue;
    if (e.kind === "job" && !finished(e)) {
      skipped++;
      continue;
    }
    const target = studyWriteTarget(root, e.name, { records: true });
    const exists = existsSync(target);
    const finishedNow = e.kind === "job" && receiptsNew.get(e.campaign)?.has(`${e.jobId}|${e.attempt}`) && !receiptsHere.get(e.campaign)?.has(`${e.jobId}|${e.attempt}`);
    const write = !exists || !!finishedNow;
    const { digest, bytes } = await unpack(zip.file(e.name)!, write || isText(e.name));
    requireThat(digest === e.digest, `Checksum mismatch: ${short(e.name)}.`);
    let problem: string | null = null;
    if (e.kind === "result")
      try {
        problem = runResultProblem(JSON.parse(bytes!.toString("utf8")), e.jobId);
      } catch {
        problem = "is not valid JSON";
      }
    else if (e.kind === "job" && isText(e.name)) problem = attemptFileProblem(e.file, e.jobId, bytes!.toString("utf8"));
    requireThat(!problem, `${short(e.name)} in this zip ${problem}. Save the runs again with Save runs as zip.`);
    if (write) {
      if (!exists || sha(await readFile(target)) !== digest) writes.push({ campaign: e.campaign, target, bytes: bytes!, replace: exists });
      else kept++;
      continue;
    }
    // The selected result of a session is the same wherever it ran; a different one is a conflict.
    if (e.kind === "result")
      requireThat(sha(await readFile(target)) === digest, `The result of session ${short(e.jobId)} in campaign ${e.campaign} differs from the one here. Load the zip into a fresh copy of the study, or delete this campaign here first.`);
    kept++;
  }

  // 7. Write, all or nothing. Campaigns whose records change are handed to beforeWrite first (it may refuse).
  const all = [...writes, ...appends];
  beforeWrite?.([...new Set(all.map((w) => w.campaign))]);
  // Counted before writing: a record file that is here already is brought up to date.
  const updated = writes.filter((w) => w.replace).length + appends.filter((a) => existsSync(a.target)).length;
  const added = all.length - updated;
  await writeAll(root, all);
  const s = manifest.skipped;
  const skippedAtSave = isObj(s) ? Object.values(s).reduce<number>((n, v) => n + (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0), 0) : 0;
  return { campaign: manifest.campaign as string, written: added, updated, kept, receipts: newReceipts, skipped, skippedAtSave };
}
