// Files on Windows and on case-insensitive volumes: deleting a campaign while a file is open, names
// that open protected files under another spelling (letter case, long s, trailing dots, short
// names, streams, hard links, nested studies), JSON and CSV saved by Windows programs, names
// Windows keeps for devices, and pasted quoted paths. Windows-only behaviour is checked with
// path.win32 strings; parts that need a case-insensitive disk are skipped on other disks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan } from "../src/core/campaign.js";

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = JSON.parse(await readFile(join(from, "workspace.json"), "utf8"));
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}
const errno = (code: string) => Object.assign(new Error(`${code}: resource busy or locked, rename`), { code });

// ---------- D1. Deleting a campaign while a file is open ----------

test("campaign delete: runs move first, a locked folder is retried, and a failed move is rolled back", async () => {
  const { readWorkspace, saveCampaign, listCampaigns, runDir } = await import("../src/workspace.js");
  const { deleteCampaign, deleteMoves } = await import("../src/history.js");
  const original = { ...deleteMoves };
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "locked-delete", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    await mkdir(runDir(a.id, c.id), { recursive: true });
    await writeFile(join(runDir(a.id, c.id), "receipts.jsonl"), "");
    const untouched = async () => {
      assert.equal((await listCampaigns(a.id)).length, 1);
      assert.ok(existsSync(join(runDir(a.id, c.id), "receipts.jsonl")));
      assert.deepEqual(existsSync(join(a.dir, "deleted")) ? await readdir(join(a.dir, "deleted")) : [], []);
    };
    deleteMoves.retryMs = 300;
    deleteMoves.stepMs = 20;

    // The campaign file is open (Windows: EBUSY): retried, then the runs, already moved, move back.
    let tries = 0;
    deleteMoves.rename = async (from, to) => {
      if (String(from).includes(`${sep}campaigns${sep}`)) {
        tries++;
        throw errno("EBUSY");
      }
      return rename(from, to);
    };
    await assert.rejects(deleteCampaign(a.id, c.id), /A file in the campaign folder is open \(EBUSY.*Close it and try again\. Nothing was deleted\./);
    assert.ok(tries > 1, "a locked folder is tried again");
    await untouched();

    // A file in the runs folder is open (EPERM): nothing moves.
    deleteMoves.rename = async (from, to) => {
      if (String(from).includes(`${sep}runs${sep}`)) throw errno("EPERM");
      return rename(from, to);
    };
    await assert.rejects(deleteCampaign(a.id, c.id), /A file in the runs folder is open \(EPERM.*Nothing was deleted\./);
    await untouched();

    // The campaign cannot move and the runs cannot move back: the message says where they are.
    deleteMoves.rename = async (from, to) => {
      if (String(from).includes(`${sep}campaigns${sep}`) || String(from).includes(`${sep}deleted${sep}`)) throw errno("EBUSY");
      return rename(from, to);
    };
    const stuckError = await deleteCampaign(a.id, c.id).then(() => "", (e: Error) => e.message);
    assert.match(stuckError, /could not be moved back; move that folder back to runs\/locked-delete/);
    assert.doesNotMatch(stuckError, /Nothing was deleted/);
    const [stuck] = await readdir(join(a.dir, "deleted"));
    await rename(join(a.dir, "deleted", stuck, "runs"), runDir(a.id, c.id));
    await rm(join(a.dir, "deleted"), { recursive: true });
    await untouched();

    // What the old order left behind (campaign moved, runs still here): a retry finishes the delete.
    deleteMoves.rename = rename;
    const legacy = join(a.dir, "deleted", `20250101-000000-${c.id}`);
    await mkdir(legacy, { recursive: true });
    await rename(join(a.dir, "campaigns", c.id), join(legacy, "campaign"));
    assert.equal((await deleteCampaign(a.id, c.id)).movedTo, `deleted/20250101-000000-${c.id}`);
    assert.ok(existsSync(join(legacy, "runs", "receipts.jsonl")) && !existsSync(runDir(a.id, c.id)));
    await assert.rejects(deleteCampaign(a.id, c.id), /This campaign was already deleted/);
    await rename(join(legacy, "campaign"), join(a.dir, "campaigns", c.id));
    await rename(join(legacy, "runs"), runDir(a.id, c.id));
    await rm(join(a.dir, "deleted"), { recursive: true });
    await untouched();

    // A lock that is released while retrying: the campaign and its runs are deleted together.
    let busy = 2;
    deleteMoves.retryMs = 5000;
    deleteMoves.rename = async (from, to) => {
      if (busy-- > 0) throw errno("EACCES");
      return rename(from, to);
    };
    const r = await deleteCampaign(a.id, c.id);
    assert.equal((await listCampaigns(a.id)).length, 0);
    assert.ok(existsSync(join(a.dir, ...r.movedTo.split("/"), "runs", "receipts.jsonl")));
    assert.ok(existsSync(join(a.dir, ...r.movedTo.split("/"), "campaign", "campaign.json")));
    assert.ok(!existsSync(runDir(a.id, c.id)));
  } finally {
    Object.assign(deleteMoves, original);
    await removeDir(a.dir);
  }
});

