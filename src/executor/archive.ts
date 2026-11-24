// Save runs as a zip (any time, also mid-run) and load such a zip into a study
// workspace for the analyzer. The zip carries the campaign and its ancestors so
// reused results can be matched to the campaign that executed them.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { verifyCampaign, type Campaign, type CampaignReceipt } from "../core/campaign.js";
import { requireThat } from "../core/validation.js";
import { listCampaigns, readCampaign, runDir, studyWriteTarget, workspaceDir } from "../workspace.js";
import { readJsonFile } from "../files.js";

const JSZip = createRequire(import.meta.url)("jszip") as typeof import("jszip");
const sha = (x: Buffer | string) => createHash("sha256").update(x).digest("hex");

async function files(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...(await files(p)));
    else out.push(p);
  }
  return out;
}
/** Zip of a campaign's runs plus every ancestor campaign in its lineage (for reused jobs). */
export async function exportRuns(workspaceId: string, campaignId: string): Promise<Buffer> {
  const campaign = await readCampaign(workspaceId, campaignId);
  const all = await listCampaigns(workspaceId);
  const lineage = [...(campaign.lineage ?? []).map((d) => all.find((c) => c.digest === d)).filter((c): c is Campaign => !!c), campaign];
  const zip = new JSZip();
  const hashes: Record<string, string> = {};
  for (const c of lineage) {
    const cj = JSON.stringify(c, null, 2) + "\n";
    zip.file(`campaigns/${c.id}/campaign.json`, cj);
    hashes[`campaigns/${c.id}/campaign.json`] = sha(cj);
    const dir = runDir(workspaceId, c.id);
    for (const f of await files(dir)) {
      if (f.includes(`${sep}session${sep}`)) continue; // empty agent working folders
      const name = `runs/${c.id}/${relative(dir, f).split(sep).join("/")}`;
      const data = await readFile(f);
      zip.file(name, data);
      hashes[name] = sha(data);
    }
  }
  zip.file(
    "manifest.json",
    JSON.stringify({ schemaVersion: "xr-study-runs/1", workspace: workspaceId, campaign: campaign.id, campaignDigest: campaign.digest, exportedAt: new Date().toISOString(), files: hashes }, null, 2),
  );
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ---------- loading a runs zip ----------

/**
 * Limits on what a zip may unpack to, checked from the sizes the zip declares before anything is
 * unpacked, and again while unpacking (a file larger than it declares is refused).
 */
export const IMPORT_LIMITS = { totalBytes: 2 * 1024 ** 3, fileBytes: 500 * 1024 ** 2, files: 200_000 };
const MB = (n: number) => `${Math.round(n / 1024 ** 2).toLocaleString("en")} MB`;
const short = (name: string) => (name.length > 160 ? name.slice(0, 160) + "…" : name);

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

/**
 * A zip entry name that is safe on every system: "/" separators only, no backslash, drive letter or
 * other ":" , no absolute name, and no empty, "." or ".." part (Windows also drops trailing dots
 * and spaces, so those are refused too).
 */
export function safeZipName(name: string): boolean {
  if (typeof name !== "string" || !name || name.length > 500 || name.startsWith("/") || /[\\:*?"<>|\0-\x1f]/.test(name)) return false;
  return name.split("/").every((p) => p !== "" && p !== "." && p !== ".." && !/[. ]$/.test(p));
}
type Entry =
  | { kind: "campaign"; name: string; campaign: string }
  | { kind: "receipts" | "events"; name: string; campaign: string }
  | { kind: "result"; name: string; campaign: string; jobId: string }
  | { kind: "job"; name: string; campaign: string; jobId: string; attempt: number };
/** The kinds of file Save runs as zip writes; anything else is refused. */
function classify(name: string): Entry | null {
  let m = /^campaigns\/([A-Za-z0-9_-]{1,200})\/campaign\.json$/.exec(name);
  if (m) return { kind: "campaign", name, campaign: m[1] };
  m = /^runs\/([A-Za-z0-9_-]{1,200})\/(receipts|events)\.jsonl$/.exec(name);
  if (m) return { kind: m[2] as "receipts" | "events", name, campaign: m[1] };
  m = /^runs\/([A-Za-z0-9_-]{1,200})\/results\/([A-Za-z0-9_-]{1,400})\.json$/.exec(name);
  if (m) return { kind: "result", name, campaign: m[1], jobId: m[2] };
  m = /^runs\/([A-Za-z0-9_-]{1,200})\/jobs\/([A-Za-z0-9_-]{1,400})\/a(\d{1,6})\/(.+)$/.exec(name);
  // Agent working folders are never exported; no file named human.json belongs in a runs zip.
  if (m && !m[4].split("/").includes("session") && !name.split("/").some((p) => p.toLowerCase() === "human.json"))
    return { kind: "job", name, campaign: m[1], jobId: m[2], attempt: Number(m[3]) };
  return null;
}
const lines = (text: string) => text.split(/\r?\n/).filter((l) => l.trim());
const receiptKey = (r: Pick<CampaignReceipt, "campaignDigest" | "jobId" | "attempt">) => `${r.campaignDigest}|${r.jobId}|${r.attempt}`;

/**
 * Load a runs zip into a workspace. Everything is checked before anything is written, so a refused
 * zip leaves nothing behind:
 * - sizes (IMPORT_LIMITS), safe names, and only the files Save runs as zip writes;
 * - every campaign verifies, sits in the folder named after its ID, belongs to this study, and
 *   matches a campaign of the same ID already here; runs only for campaigns in the zip or here,
 *   and only for their sessions; checksums of every file.
 * Existing files are never overwritten, with two exceptions that keep the records consistent:
 * receipts.jsonl and events.jsonl are append-only and get the lines they lack (a receipt that
 * differs from the one here for the same session attempt is a conflict and refuses the zip), and
 * the files of an attempt this study saw unfinished (no receipt here) are replaced by the zip's
 * finished attempt. `beforeWrite` gets the campaigns that will change, after every check.
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
  let manifest: { files?: unknown; campaign?: unknown };
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
  for (const [name, digest] of Object.entries(listed as Record<string, string>)) {
    requireThat(safeZipName(name), `Unsafe path in zip: ${short(name)}.`);
    const e = classify(name);
    requireThat(e, `Unexpected file in zip: ${short(name)}. A runs zip holds only campaigns/<id>/campaign.json and runs/<id>/… as written by Save runs as zip.`);
    requireThat(zip.file(name), `Missing file in zip: ${short(name)}.`);
    planned.push({ ...e!, digest });
  }

  // 4. Campaigns: verified, in their own folder, of this study, and the same as any campaign here with that ID.
  const studyId = (await readJsonFile<{ id: string }>(join(root, "study.json"))).id;
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
  const appends = new Map<string, { campaign: string; target: string; add: string[] }>();
  const receiptsHere = new Map<string, Set<string>>(); // campaign → attempts with a receipt here ("job|attempt")
  const receiptsNew = new Map<string, Set<string>>(); // campaign → attempts whose receipt the zip adds
  let newReceipts = 0;
  for (const e of planned.filter((x) => x.kind === "receipts" || x.kind === "events")) {
    const c = campaignOf(e.campaign)!;
    const { digest, bytes } = await unpack(zip.file(e.name)!, true);
    requireThat(digest === e.digest, `Checksum mismatch: ${short(e.name)}.`);
    const target = studyWriteTarget(root, e.name, { records: true });
    const local = existsSync(target) ? lines(await readFile(target, "utf8")) : [];
    const incoming = lines(bytes!.toString("utf8"));
    if (e.kind === "events") {
      // As many copies of a line as are here already are skipped (identical events can share a millisecond).
      const have = new Map<string, number>();
      for (const l of local) have.set(l, (have.get(l) ?? 0) + 1);
      const add = incoming.filter((l) => {
        const n = have.get(l) ?? 0;
        if (n) have.set(l, n - 1);
        return !n;
      });
      if (add.length) appends.set(e.name, { campaign: e.campaign, target, add });
      continue;
    }
    const parse = (l: string, where: string) => {
      let r: CampaignReceipt;
      try {
        r = JSON.parse(l);
      } catch {
        throw new Error(`receipts.jsonl of campaign ${e.campaign} ${where} has a line that is not valid JSON.`);
      }
      requireThat(r && typeof r.jobId === "string" && Number.isInteger(r.attempt) && r.campaignDigest === c.digest && c.jobs.some((j) => j.id === r.jobId), `receipts.jsonl of campaign ${e.campaign} ${where} has a receipt of another campaign or an unknown session.`);
      return r;
    };
    const byKey = new Map(local.map((l) => [receiptKey(parse(l, "in this study")), l]));
    receiptsHere.set(e.campaign, new Set([...byKey.values()].map((l) => JSON.parse(l) as CampaignReceipt).map((r) => `${r.jobId}|${r.attempt}`)));
    const add: string[] = [];
    for (const l of incoming) {
      const r = parse(l, "in the zip");
      const key = receiptKey(r);
      const mine = byKey.get(key);
      if (mine === undefined) {
        byKey.set(key, l);
        add.push(l);
        receiptsNew.set(e.campaign, (receiptsNew.get(e.campaign) ?? new Set()).add(`${r.jobId}|${r.attempt}`));
      } else
        requireThat(
          JSON.stringify(JSON.parse(mine)) === JSON.stringify(r),
          `Session ${short(r.jobId)}, attempt ${r.attempt} of campaign ${e.campaign} was run both here and in the zip, with different records. Load the zip into a fresh copy of the study, or delete this campaign here first.`,
        );
    }
    newReceipts += add.length;
    if (add.length) appends.set(e.name, { campaign: e.campaign, target, add });
  }

  // 6. Every other file: checksum, then new, already here, or the finished version of an attempt seen unfinished here.
  const writes: { campaign: string; target: string; bytes: Buffer; replace: boolean }[] = [];
  let kept = 0;
  for (const e of planned) {
    if (e.kind === "receipts" || e.kind === "events") continue;
    const target = studyWriteTarget(root, e.name, { records: true });
    const exists = existsSync(target);
    const finishedNow = e.kind === "job" && receiptsNew.get(e.campaign)?.has(`${e.jobId}|${e.attempt}`) && !receiptsHere.get(e.campaign)?.has(`${e.jobId}|${e.attempt}`);
    const write = !exists || !!finishedNow;
    const { digest, bytes } = await unpack(zip.file(e.name)!, write);
    requireThat(digest === e.digest, `Checksum mismatch: ${short(e.name)}.`);
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

  // 7. Write. Campaigns whose records change are handed to beforeWrite first (it may refuse).
  beforeWrite?.([...new Set([...writes, ...appends.values()].map((w) => w.campaign))]);
  let written = 0,
    updated = 0;
  for (const w of writes) {
    await mkdir(dirname(w.target), { recursive: true });
    await writeFile(w.target, w.bytes, { flag: w.replace ? "w" : "wx" });
    w.replace ? updated++ : written++;
  }
  for (const a of appends.values()) {
    await mkdir(dirname(a.target), { recursive: true });
    const before = existsSync(a.target) ? await readFile(a.target, "utf8") : "";
    await appendFile(a.target, (before && !before.endsWith("\n") ? "\n" : "") + a.add.join("\n") + "\n");
    before ? updated++ : written++;
  }
  return { campaign: manifest.campaign as string, written, updated, kept, receipts: newReceipts };
}
