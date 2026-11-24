// Save runs as a zip (any time, also mid-run) and load such a zip into a study
// workspace for the analyzer. The zip carries the campaign and its ancestors so
// reused results can be matched to the campaign that executed them.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { verifyCampaign, type Campaign } from "../core/campaign.js";
import { requireThat } from "../core/validation.js";
import { listCampaigns, readCampaign, runDir, workspaceDir } from "../workspace.js";

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
/** Load a runs zip into a workspace. Existing files are never overwritten; checksums and campaigns are verified. */
export async function importRuns(workspaceId: string, data: Buffer) {
  let zip: Awaited<ReturnType<typeof JSZip.loadAsync>>;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new Error("This file is not a zip. Choose a runs zip saved with Save runs as zip.");
  }
  const manifestFile = zip.file("manifest.json");
  requireThat(manifestFile, "This zip has no manifest.json; export runs from the executor.");
  const manifest = JSON.parse(await manifestFile!.async("string")) as { files: Record<string, string>; campaign: string };
  const root = workspaceDir(workspaceId);
  // Check every file before writing any, so a bad zip leaves nothing behind.
  const files: { name: string; target: string; bytes: Buffer }[] = [];
  let campaign: Campaign | null = null;
  for (const [name, digest] of Object.entries(manifest.files)) {
    const f = zip.file(name);
    requireThat(f, `Missing file in zip: ${name}.`);
    const bytes = await f!.async("nodebuffer");
    requireThat(sha(bytes) === digest, `Checksum mismatch: ${name}.`);
    requireThat(/^(campaigns|runs)\/[a-zA-Z0-9_-]+\//.test(name) && !name.split("/").includes(".."), `Unexpected path in zip: ${name}.`);
    if (name.endsWith("campaign.json")) {
      campaign = JSON.parse(bytes.toString("utf8")) as Campaign;
      verifyCampaign(campaign);
    }
    const target = resolve(root, name);
    requireThat(target.startsWith(root + sep), "Unsafe path in zip.");
    files.push({ name, target, bytes });
  }
  // Runs belong to one study: the campaign's study ID must be this study's ID.
  const studyId = (JSON.parse(await readFile(join(root, "study.json"), "utf8")) as { id: string }).id;
  const runsOf = campaign?.suite.study?.id;
  requireThat(!runsOf || runsOf === studyId, `These runs belong to study "${runsOf}", but this study's ID is "${studyId}". Load them into the study they were made for (on another machine: the same study.json).`);
  let written = 0,
    kept = 0;
  for (const f of files) {
    if (existsSync(f.target)) {
      kept++;
      continue;
    }
    await mkdir(dirname(f.target), { recursive: true });
    await writeFile(f.target, f.bytes);
    written++;
  }
  return { campaign: manifest.campaign, written, kept };
}
