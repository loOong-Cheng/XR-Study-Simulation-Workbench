// Starter campaigns of the example suites (src/starters.ts): every suite keeps a current one in git
// (examples/<suite>/starter/), it is the campaign the website's Freeze makes, and it is installed
// into a study once, never over the researcher's campaigns and never into private/studies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyCampaign, type Campaign } from "../src/core/campaign.js";
import { until } from "./until.js";

const SUITES = ["examples/ecolar", "examples/graphics-quality", "examples/haptic-buttons", "examples/haptic-buttons-between", "examples/material-cues", "examples/selection", "examples/text-entry"];
const REBUILD = "Rebuild the starters from the suites' current files with `npm run starters` and commit examples/*/starter/.";
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

/** A copy of an example suite under private/studies (with its starter/ folder), as the other tests make. */
async function tempSuite(from: string) {
  const name = `__test-starter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md", "starter"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f), { recursive: true });
  const manifest = JSON.parse(await readFile(join(from, "workspace.json"), "utf8"));
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}

test("starters: every example suite has a starter that is current with its files and verifies", async () => {
  const { exampleSuites, starterProblems } = await import("../src/starters.js");
  assert.deepEqual(await exampleSuites(), SUITES, "every example suite (a folder in examples/ with a study.json) needs a starter");
  const stale: string[] = [];
  for (const id of SUITES) {
    const problems = await starterProblems(id);
    if (problems.length) stale.push(`${id}: ${problems.join("; ")}`);
  }
  assert.deepEqual(stale, [], `Out-of-date starter campaigns:\n${stale.join("\n")}\n${REBUILD}`);
  for (const id of SUITES) {
    const dir = resolve(id, "starter");
    const campaign = JSON.parse(await readFile(join(dir, "campaign.json"), "utf8")) as Campaign;
    const sources = JSON.parse(await readFile(join(dir, "sources.json"), "utf8"));
    const starter = JSON.parse(await readFile(join(dir, "starter.json"), "utf8"));
    verifyCampaign(campaign);
    assert.match(campaign.id, /^campaign-starter-[0-9a-f]{12}$/, id);
    assert.equal(sources.campaignId, campaign.id, id);
    assert.equal(starter.campaignId, campaign.id, id);
    assert.equal(starter.campaignDigest, campaign.digest, id);
    assert.equal(starter.sessions, campaign.jobs.filter((j) => j.kind === "llm").length, id);
    assert.equal(starter.sessions, starter.configurations.reduce((n: number, c: { sessions: number }) => n + c.sessions, 0), id);
    assert.equal(campaign.createdAt, "2026-01-01T00:00:00.000Z", id);
    assert.ok(!campaign.parentDigest && !campaign.continuation, `${id}: a starter is a fresh freeze`);
    // The engine suites say which configurations need a bridge; the others need none.
    const engine = starter.configurations.filter((c: { runtime: string }) => ["unreal", "unity", "visionos"].includes(c.runtime));
    assert.equal(engine.length > 0, ["examples/ecolar", "examples/selection"].includes(id), id);
    if (engine.length) assert.ok(starter.notes.some((n: string) => /study bridge in Settings → Runtimes; until one is set they can only be simulated/.test(n)), id);
  }
});

test("starters: a starter is the campaign the website's Freeze makes at 1 run per participant, with the same sources.json", async () => {
  const { handlePost } = await import("../src/routes.js");
  const { sameDesignKey } = await import("../src/history.js");
  for (const from of ["examples/graphics-quality", "examples/selection"]) {
    const a = await tempSuite(resolve(from));
    try {
      let out: Record<string, any> = {};
      await handlePost("/api/workspace/freeze", { id: a.id, repetitions: 1 }, (v) => (out = v as Record<string, any>));
      const frozen = JSON.parse(await readFile(join(a.dir, "campaigns", out.campaignId, "campaign.json"), "utf8")) as Campaign;
      const starter = JSON.parse(await readFile(resolve(from, "starter", "campaign.json"), "utf8")) as Campaign;
      // Same configurations, models and sessions (only the ID, the date and the plan digest in the notes differ).
      assert.equal(sameDesignKey(frozen), sameDesignKey(starter), from);
      assert.deepEqual(frozen.model, starter.model, from);
      assert.deepEqual(frozen.conditionModels, starter.conditionModels, from);
      assert.deepEqual(
        frozen.jobs.map((j) => [j.conditionId, j.participantId ?? null, j.repetition]),
        starter.jobs.map((j) => [j.conditionId, j.participantId ?? null, j.repetition]),
        from,
      );
      const written = JSON.parse(await readFile(join(a.dir, "campaigns", out.campaignId, "sources.json"), "utf8"));
      const shipped = JSON.parse(await readFile(resolve(from, "starter", "sources.json"), "utf8"));
      assert.deepEqual(Object.keys(written), Object.keys(shipped), "the same fields in the same order");
      assert.deepEqual({ ...written, campaignId: null, recordedAt: null }, { ...shipped, campaignId: null, recordedAt: null }, from);
    } finally {
      await removeDir(a.dir);
    }
  }
});

test("starters: installed once into a study without campaigns, labelled, ready to simulate; never again after a delete, never over campaigns, never when out of date", async () => {
  const { installStarter, installStarterFrom, STARTER_LABEL } = await import("../src/starters.js");
  const { listCampaigns, listWorkspaces, readStudyFolder, changedSources, changedApp } = await import("../src/workspace.js");
  const { deleteCampaign, readLabels, campaignSummaries } = await import("../src/history.js");
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const from = resolve("examples/haptic-buttons-between");
  const a = await tempSuite(from);
  const b = await tempSuite(from);
  const c = await tempSuite(from);
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  try {
    // Studies under private/studies never get one through installStarter.
    assert.equal((await installStarter(a.id)).state, "not-an-example");
    assert.equal(existsSync(join(a.dir, "campaigns")), false);
    // Two requests at once install it once.
    const [first, second] = await Promise.all([installStarterFrom(a.id, join(a.dir, "starter")), installStarterFrom(a.id, join(a.dir, "starter"))]);
    assert.equal(first.state, "installed", first.message);
    assert.equal(second.state, "installed-before");
    const shipped = JSON.parse(await readFile(join(from, "starter", "starter.json"), "utf8"));
    assert.equal(first.campaignId, shipped.campaignId);
    assert.equal(first.sessions, shipped.sessions);
    // The campaign and sources.json exactly as shipped, with its label; the marker is not counted as a campaign.
    for (const f of ["campaign.json", "sources.json"])
      assert.equal(await readFile(join(a.dir, "campaigns", first.campaignId!, f), "utf8"), await readFile(join(from, "starter", f), "utf8"), f);
    assert.equal((await readLabels(a.id))[first.campaignId!], STARTER_LABEL);
    assert.deepEqual((await listCampaigns(a.id)).map((x) => x.id), [first.campaignId]);
    assert.equal((await listWorkspaces()).find((w) => w.id === a.id)?.campaigns, 1);
    const [summary] = await campaignSummaries(a.id);
    assert.equal(summary.label, STARTER_LABEL);
    assert.equal(summary.notStarted, shipped.sessions);
    // The executor sees unchanged sources, and simulates its sessions.
    const campaign = (await listCampaigns(a.id))[0];
    const { manifest } = await readStudyFolder(a.id);
    assert.deepEqual(await changedSources(a.id, campaign, manifest), []);
    assert.equal(await changedApp(a.id, campaign, manifest), null);
    const ex = await Executor.open(a.id, campaign.id);
    const two = [...ex.jobs.keys()].slice(0, 2);
    await ex.start("simulate", two);
    await until(() => ex.snapshot().running === 0 && ex.snapshot().queued === 0, "two simulated sessions", { executor: ex });
    assert.deepEqual(two.map((j) => ex.jobs.get(j)!.status), ["done", "done"], JSON.stringify(ex.snapshot().counts));
    closeExecutor(a.id, campaign.id);
    // Deleted by the researcher: not installed again.
    await deleteCampaign(a.id, campaign.id);
    assert.equal((await installStarterFrom(a.id, join(a.dir, "starter"))).state, "installed-before");
    assert.deepEqual(await listCampaigns(a.id), []);

    // A study with a campaign of its own gets none.
    const { handlePost } = await import("../src/routes.js");
    let out: Record<string, any> = {};
    await handlePost("/api/workspace/freeze", { id: b.id, repetitions: 1 }, (v) => (out = v as Record<string, any>));
    assert.equal((await installStarterFrom(b.id, join(b.dir, "starter"))).state, "has-campaigns");
    assert.deepEqual((await listCampaigns(b.id)).map((x) => x.id), [out.campaignId]);

    // Files changed since the starter was built: it is not installed (the executor would refuse it).
    await writeFile(join(c.dir, "agent-brief.md"), (await readFile(join(c.dir, "agent-brief.md"), "utf8")) + "\nOne more line.\n");
    const stale = await installStarterFrom(c.id, join(c.dir, "starter"));
    assert.equal(stale.state, "out-of-date");
    assert.match(stale.message, /npm run starters/);
    assert.equal(existsSync(join(c.dir, "campaigns")), false, "nothing written");
    // The check behind the stale-starter test names it.
    const { starterProblems } = await import("../src/starters.js");
    assert.match((await starterProblems(c.id)).join("; "), /^starter\/ is out of date: the source "brief" \(agent-brief\.md\) changed$/);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(b.dir);
    await removeDir(c.dir);
    await removeDir(cfg);
  }
});
