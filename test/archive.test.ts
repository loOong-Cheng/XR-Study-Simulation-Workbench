// Runs zips moved between machines (Save runs as zip / Load runs zip): what a zip may plant, how
// names behave on every disk, all-or-nothing loading, contents, and what a new attempt reuses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan, freezeCampaign, type Campaign } from "../src/core/campaign.js";
import type { AgentProtocol, Study } from "../src/core/types.js";
import { until } from "./until.js";

const JSZip = createRequire(import.meta.url)("jszip") as typeof import("jszip");
const sha = (x: Buffer | string) => createHash("sha256").update(x).digest("hex");
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = existsSync(join(from, "workspace.json")) ? JSON.parse(await readFile(join(from, "workspace.json"), "utf8")) : {};
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}
function smallPlan(ws: { study: Study; agents: AgentProtocol[] | null }, repetitions: number) {
  const study = { ...ws.study, analysis: { ...ws.study.analysis, contrasts: [] } };
  return freezePlan(study, ws.agents!.filter((x) => x.id === "text-only").map((x) => ({ ...x, repetitions })), 1);
}
/** Rebuild a runs zip after editing its files; the manifest gets fresh checksums. */
async function rezip(zip: Buffer, edit: (files: Map<string, Buffer>) => void, campaign?: string) {
  const z = await JSZip.loadAsync(zip);
  const manifest = JSON.parse(await z.file("manifest.json")!.async("string"));
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(manifest.files)) files.set(name, await z.file(name)!.async("nodebuffer"));
  edit(files);
  const out = new JSZip();
  for (const [n, b] of files) out.file(n, b);
  out.file("manifest.json", JSON.stringify({ ...manifest, campaign: campaign ?? manifest.campaign, files: Object.fromEntries([...files].map(([n, b]) => [n, sha(b)])) }));
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
/** Every file and folder under a study's campaigns/ and runs/ (and leftovers of a load), with file contents. */
async function snapshot(dir: string) {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && !/^(campaigns|runs|\.runs-import)/.test(e.name)) continue;
      if (e.isDirectory()) {
        out.push(r + "/");
        await walk(r);
      } else out.push(`${r} ${sha(await readFile(join(dir, r)))}`);
    }
  };
  await walk("");
  return out.sort();
}
const lines = (b: Buffer) => b.toString("utf8").split("\n").filter(Boolean);

/**
 * A study (selection example) with one campaign of simulated sessions: z1 after the first, z2
 * after all `n`. Removed by `done()`.
 */
async function simulatedRuns(n: number) {
  const { Executor } = await import("../src/executor/runner.js");
  const { exportRuns } = await import("../src/executor/archive.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const ws = await readWorkspace(a.id);
  const c = campaignFromPlan(smallPlan(ws, n), undefined, `zip-${Math.random().toString(36).slice(2, 8)}`, new Date(Date.now() - 1000).toISOString());
  await saveCampaign(a.id, c);
  const ex = await Executor.open(a.id, c.id);
  const ids = [...ex.jobs.keys()];
  await ex.start("simulate", ids.slice(0, 1));
  await until(() => (ex.snapshot().counts.done ?? 0) >= 1, "the first session to finish", { executor: ex });
  const z1 = await exportRuns(a.id, c.id);
  if (n > 1) await ex.start("simulate");
  await until(() => (ex.snapshot().counts.done ?? 0) >= n, "every session to finish", { executor: ex });
  assert.equal(ex.snapshot().counts.done, n);
  const z2 = await exportRuns(a.id, c.id);
  return { a, c, ids, z1, z2, done: () => removeDir(a.dir) };
}

test("runs zip: only files of finished attempts load; never an agent working folder or Claude Code files, in any letter case or form", async () => {
  const { importRuns } = await import("../src/executor/archive.js");
  const { runDir } = await import("../src/workspace.js");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(2);
  const { c, ids, z2 } = runs;
  const fresh = await tempWorkspace(resolve("examples/selection"));
  try {
    const refuse = async (zip: Buffer, expected: RegExp) => {
      await assert.rejects(importRuns(fresh.id, zip), expected);
      assert.equal(existsSync(join(fresh.dir, "campaigns")) || existsSync(join(fresh.dir, "runs")), false, `nothing written for ${expected}`);
    };
    const a1 = `runs/${c.id}/jobs/${ids[0]}/a1`;
    // The agent's working folder (Claude Code starts there with --setting-sources local), Claude
    // Code's own files and human results: as any disk that ignores case and accents would see them.
    for (const bad of ["SESSION/.claude/settings.local.json", "session/x", "Session/CLAUDE.md", "ſession/x", "ｓｅｓｓｉｏｎ/x", "x/.CLAUDE/settings.json", "CLAUDE.md", "screenshots/claude.local.MD", "Human.JSON", "human.jſon"])
      await refuse(await rezip(z2, (f) => f.set(`${a1}/${bad}`, Buffer.from("{}"))), /Unexpected file in zip/);
    // Attempts without a receipt (in the zip or here) are not loaded: an attempt that has not run
    // yet, and the attempt whose receipt the zip leaves out (V2's planted forecast and tool log).
    const planted = await rezip(z2, (f) => {
      f.set(`runs/${c.id}/jobs/${ids[0]}/a2/forecast.json`, Buffer.from(JSON.stringify({ measurements: [] })));
      f.set(`runs/${c.id}/jobs/${ids[0]}/a2/calls.log`, Buffer.from("x\n".repeat(500)));
      const rk = `runs/${c.id}/receipts.jsonl`;
      f.set(rk, Buffer.from(lines(f.get(rk)!).filter((l) => JSON.parse(l).jobId !== ids[1]).join("\n") + "\n"));
    });
    const r = await importRuns(fresh.id, planted);
    const unfinished = (await JSZip.loadAsync(planted)).file(new RegExp(`^runs/${c.id}/jobs/(${ids[0]}/a2|${ids[1]}/a1)/`)).length;
    assert.equal(r.skipped, unfinished);
    assert.ok(unfinished >= 3, String(unfinished));
    assert.equal(existsSync(join(runDir(fresh.id, c.id), "jobs", ids[0], "a2")), false);
    assert.equal(existsSync(join(runDir(fresh.id, c.id), "jobs", ids[1])), false);
    assert.equal(r.receipts, 1);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(fresh.dir);
    await removeDir(cfg);
  }
});

test("executor: every attempt starts in a fresh, empty folder; only the forecast the study server accepted in it counts", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readReceipts, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  // A stand-in for `claude -p` that never submits a forecast: it writes one into the attempt
  // folder itself (as a planted file would be), records what its working folder holds, and ends.
  await writeFile(
    join(bin, "claude.cjs"),
    `const fs = require("fs"); const path = require("path");
const args = process.argv.slice(2); const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const jobDir = cfg.mcpServers.study.args[1];
fs.writeFileSync(path.join(jobDir, "cwd.json"), JSON.stringify(fs.readdirSync(process.cwd(), { recursive: true })));
fs.writeFileSync(path.join(jobDir, "forecast.json"), JSON.stringify({ measurements: [{ conditionId: "x", outcomeId: "y", value: 1 }], submittedAt: new Date().toISOString() }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session", model: "m", claude_code_version: "fake", mcp_servers: [] }));
console.log(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1 }));`,
  );
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!.filter((x) => x.id === "text-only").map((x) => ({ ...x, repetitions: 2 }));
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "fresh-attempts", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const [j0, j1] = c.jobs.filter((j) => j.kind === "llm").map((j) => j.id);
    // What an earlier zip could have planted in the folder of attempt 1 of both sessions.
    for (const j of [j0, j1]) {
      const a1 = join(runDir(a.id, c.id), "jobs", j, "a1");
      await mkdir(join(a1, "session", ".claude"), { recursive: true });
      await writeFile(join(a1, "session", ".claude", "settings.local.json"), JSON.stringify({ apiKeyHelper: "echo planted" }));
      await writeFile(join(a1, "forecast.json"), JSON.stringify({ measurements: [] }));
      await writeFile(join(a1, "calls.log"), "x\n".repeat(500));
      await writeFile(join(a1, "usage.json"), JSON.stringify({ tokens: 1, submitNow: true }));
    }
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent", [j0]);
    await until(() => !!ex.snapshot().counts.done || !!ex.snapshot().counts.failed, "the session to end", { executor: ex });
    const s0 = ex.snapshot().jobs.find((j) => j.jobId === j0)!;
    // The forecast in the attempt folder was not written by the study server for this attempt.
    assert.equal(s0.status, "failed", JSON.stringify(s0));
    assert.match(s0.error ?? "", /without an accepted forecast/);
    assert.equal(s0.attempts, 2);
    assert.equal(s0.toolCalls, 0); // the planted tool log is not this attempt's
    const a2 = join(runDir(a.id, c.id), "jobs", j0, "a2");
    assert.deepEqual(JSON.parse(await readFile(join(a2, "cwd.json"), "utf8")), []); // Claude Code started in an empty folder
    assert.equal(JSON.parse(await readFile(join(a2, "result.json"), "utf8")).status, "failed");
    assert.ok(typeof JSON.parse(await readFile(join(a2, "job.json"), "utf8")).attemptId === "string");
    assert.deepEqual(JSON.parse(await readFile(join(runDir(a.id, c.id), "jobs", j0, "a1", "forecast.json"), "utf8")), { measurements: [] }); // left as it was
    assert.deepEqual((await readReceipts(a.id, [c.id])).map((r) => [r.jobId, r.attempt, r.status]), [[j0, 2, "failed"]]);
    // A simulated attempt, too, never reuses a folder, and a rerun takes the next free number.
    await ex.start("simulate", [j1]);
    await until(() => ex.snapshot().jobs.find((j) => j.jobId === j1)!.status === "done", "the simulated rerun to finish", { executor: ex });
    assert.equal(ex.snapshot().jobs.find((j) => j.jobId === j1)!.attempts, 2);
    assert.ok(existsSync(join(runDir(a.id, c.id), "jobs", j1, "a2", "result.json")));
    assert.equal(await readFile(join(runDir(a.id, c.id), "jobs", j1, "a1", "calls.log"), "utf8"), "x\n".repeat(500));
    await mkdir(join(runDir(a.id, c.id), "jobs", j0, "a3"));
    await ex.start("simulate", [j0]);
    await until(() => ex.snapshot().jobs.find((j) => j.jobId === j0)!.status === "done", "the simulated rerun to finish", { executor: ex });
    assert.equal(ex.snapshot().jobs.find((j) => j.jobId === j0)!.attempts, 4);
    assert.deepEqual(await readdir(join(runDir(a.id, c.id), "jobs", j0, "a3")), []);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("runs zip: names one disk would store as one file are refused on every system; loading is all or nothing", async () => {
  const { importRuns, safeZipName, zipNameProblem } = await import("../src/executor/archive.js");
  const { closeExecutor } = await import("../src/executor/runner.js");
  const { readReceipts, runDir } = await import("../src/workspace.js");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(2);
  const { c, ids, z1, z2 } = runs;
  const b = await tempWorkspace(resolve("examples/selection"));
  const fresh = await tempWorkspace(resolve("examples/selection"));
  const into = (zip: Buffer) => importRuns(b.id, zip, (cs) => cs.forEach((x) => closeExecutor(b.id, x)));
  try {
    const refuse = async (zip: Buffer, expected: RegExp) => {
      await assert.rejects(importRuns(fresh.id, zip), expected);
      assert.deepEqual(await snapshot(fresh.dir), [], `nothing written for ${expected}`);
    };
    const a1 = `runs/${c.id}/jobs/${ids[0]}/a1`;
    const two = (x: string, y: string) => rezip(z2, (f) => (f.set(`${a1}/${x}`, Buffer.from("1\n")), f.set(`${a1}/${y}`, Buffer.from("2\n"))));
    await refuse(await two("note.txt", "NOTE.txt"), /differ only in letter case or accents/);
    await refuse(await two("caf\u00e9.txt", "cafe\u0301.txt"), /differ only in letter case or accents/);
    await refuse(await two("x", "x/y"), /both a file and a folder/);
    await refuse(await two("Shots/x.png", "shots/y.png"), /differ only in letter case or accents/);
    await refuse(await rezip(z2, (f) => f.set(`${a1}/${"x".repeat(300)}`, Buffer.from("1"))), /longer than 200 characters/);
    await refuse(await rezip(z2, (f) => f.set(`${a1}/${"é".repeat(150)}`, Buffer.from("1"))), /longer than 200 characters/);
    for (const bad of ["runs/c/CON", "runs/c/nul.txt", "runs/c/a／b", "runs/c/a：b"]) assert.equal(safeZipName(bad), false, bad);
    assert.equal(zipNameProblem(`${a1}/${"x".repeat(200)}`), null);

    // A name that differs only in case from a file already in the study, and a file where the study has a folder.
    await into(z1);
    await writeFile(join(runDir(b.id, c.id), "jobs", ids[0], "a1", "Note.txt"), "here");
    await assert.rejects(into(await rezip(z2, (f) => f.set(`${a1}/note.txt`, Buffer.from("zip")))), /differs only in letter case or accents from .*Note\.txt in this study/);
    await mkdir(join(runDir(b.id, c.id), "jobs", ids[0], "a1", "folder"));
    await assert.rejects(into(await rezip(z2, (f) => f.set(`${a1}/folder`, Buffer.from("zip")))), /is a folder or a link in this study/);
    await rm(join(runDir(b.id, c.id), "jobs", ids[0], "a1", "Note.txt"));
    await rm(join(runDir(b.id, c.id), "jobs", ids[0], "a1", "folder"), { recursive: true });

    // All or nothing: a write that fails late (the results folder cannot be written) leaves the
    // study exactly as it was, with no staging folder; the same zip then loads in full.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const before = await snapshot(b.dir);
      const results = join(runDir(b.id, c.id), "results");
      await chmod(results, 0o555);
      try {
        await assert.rejects(into(z2), /could not be written \(E[A-Z]+\); nothing from this zip was kept/);
      } finally {
        await chmod(results, 0o755);
      }
      assert.deepEqual(await snapshot(b.dir), before);
    }
    const r = await into(z2);
    assert.equal(r.receipts, 1);
    assert.equal((await readReceipts(b.id, [c.id])).length, 2);
    const again = await into(z2);
    assert.deepEqual([again.written, again.updated, again.receipts], [0, 0, 0]);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(b.dir);
    await removeDir(fresh.dir);
    await removeDir(cfg);
  }
});

test("runs zip: lower-case campaign IDs, checked contents, files a receipt names stay in its run folder, key order", async () => {
  const { importRuns, runRecordPath } = await import("../src/executor/archive.js");
  const { closeExecutor } = await import("../src/executor/runner.js");
  const { listCampaigns, readReceipts, runDir } = await import("../src/workspace.js");
  const { handlePost } = await import("../src/routes.js");
  const { campaignSummaries } = await import("../src/history.js");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(2);
  const { c, ids, z2 } = runs;
  const b = await tempWorkspace(resolve("examples/selection"));
  const fresh = await tempWorkspace(resolve("examples/selection"));
  const outside = await mkdtemp(join(tmpdir(), "xr-outside-"));
  const into = (zip: Buffer) => importRuns(b.id, zip, (cs) => cs.forEach((x) => closeExecutor(b.id, x)));
  try {
    const refuse = async (zip: Buffer, expected: RegExp) => {
      await assert.rejects(importRuns(fresh.id, zip), expected);
      assert.deepEqual(await snapshot(fresh.dir), [], `nothing written for ${expected}`);
    };
    const rk = `runs/${c.id}/receipts.jsonl`;
    const res = `runs/${c.id}/results/${ids[0]}.json`;

    // A valid campaign whose ID differs only in letter case: refused before anything is written,
    // and the genuine zip still loads afterwards.
    const U = c.id.toUpperCase();
    const forged = freezeCampaign(c.suite, c.model, null, U, c.createdAt, c.conditionModels) as Campaign;
    const fj = forged.jobs.find((j) => j.kind === "llm")!;
    const forgedZip = await rezip(
      z2,
      (f) => {
        const result = JSON.parse(f.get(res)!.toString());
        f.clear();
        f.set(`campaigns/${U}/campaign.json`, Buffer.from(JSON.stringify(forged, null, 2) + "\n"));
        f.set(`runs/${U}/results/${fj.id}.json`, Buffer.from(JSON.stringify({ ...result, jobId: fj.id })));
      },
      U,
    );
    await refuse(forgedZip, /not written in lower case/);
    await refuse(await rezip(z2, (f) => f.set(`runs/${U}/results/${fj.id}.json`, f.get(res)!)), /not written in lower case/);
    await into(await rezip(z2, (f) => [...f.keys()].filter((n) => n.startsWith("runs/")).forEach((n) => f.delete(n))));
    await assert.rejects(into(forgedZip), /not written in lower case/);
    assert.equal((await into(z2)).receipts, 2);
    assert.deepEqual((await listCampaigns(b.id)).map((x) => x.id), [c.id]);

    // Contents: every JSON and JSONL file has the type the exporter writes; refused with its name.
    const result = JSON.parse((await (await JSZip.loadAsync(z2)).file(res)!.async("string")) as string);
    const set = (name: string, body: string) => rezip(z2, (f) => f.set(name, Buffer.from(body)));
    await refuse(await set(res, "garbage, not json"), new RegExp(`results/${ids[0]}\\.json in this zip is not valid JSON`));
    await refuse(await set(res, JSON.stringify({ ...result, measurements: "nope" })), /results\/.* has invalid measurements/);
    await refuse(await set(res, JSON.stringify({ ...result, jobId: 42 })), /results\/.* is the result of another session/);
    await refuse(await set(res, JSON.stringify({ ...result, execution: { ...result.execution, synthetic: "yes" } })), /no valid execution record/);
    const ev = `runs/${c.id}/events.jsonl`;
    const evZip = async (extra: string) => rezip(z2, (f) => f.set(ev, Buffer.concat([f.get(ev)!, Buffer.from(extra)])));
    await refuse(await evZip("this is not json\n"), /events\.jsonl of campaign .* has a line that is not valid JSON/);
    await refuse(await evZip('{"type":"__proto__"}\n'), /events\.jsonl .* not an executor event/);
    const receipts = async (edit: (r: Record<string, unknown>) => Record<string, unknown>) =>
      rezip(z2, (f) => f.set(rk, Buffer.from(lines(f.get(rk)!).map((l) => JSON.stringify(edit(JSON.parse(l)))).join("\n") + "\n")));
    await refuse(await receipts(({ sessionId, ...r }) => (void sessionId, r)), /receipts\.jsonl .* not a valid receipt/);
    await refuse(await receipts((r) => ({ ...r, attempt: "1" })), /not a valid receipt/);
    await refuse(await set(`runs/${c.id}/jobs/${ids[0]}/a1/result.json`, "{"), /a1\/result\.json in this zip is not valid JSON/);
    await refuse(await set(`runs/${c.id}/jobs/${ids[0]}/a1/usage.json`, '{"tokens":"many"}'), /usage\.json in this zip is not a usage record/);
    await refuse(await set(`runs/${c.id}/jobs/${ids[0]}/a1/trace.jsonl`, "{}\nnope\n"), /trace\.jsonl in this zip has a line that is not valid JSON/);

    // Files a receipt names: only inside the campaign's run folder, when loading and when reading.
    await writeFile(join(outside, "cost.json"), JSON.stringify({ costUsd: 31337 }));
    const away = relative(runDir(fresh.id, c.id), join(outside, "cost.json")).split("\\").join("/");
    for (const path of [away, "/etc/passwd", "jobs/../../x.json", "C:/x.json"])
      await refuse(await receipts((r) => ({ ...r, executionManifest: { path, sha256: "0".repeat(64) } })), /names a file outside the campaign's run folder/);
    assert.equal(runRecordPath(runDir(b.id, c.id), away), null);
    assert.equal(runRecordPath(runDir(b.id, c.id), "jobs/x/a1/execution-manifest.json"), join(runDir(b.id, c.id), "jobs", "x", "a1", "execution-manifest.json"));
    // A receipt written before this check (here on disk) is not followed out of the run folder either.
    const receiptsPath = join(runDir(b.id, c.id), "receipts.jsonl");
    const original = await readFile(receiptsPath, "utf8");
    const toOutside = relative(runDir(b.id, c.id), join(outside, "cost.json")).split("\\").join("/");
    await writeFile(receiptsPath, lines(Buffer.from(original)).map((l) => JSON.stringify({ ...JSON.parse(l), executionManifest: { path: toOutside, sha256: "0".repeat(64) } })).join("\n") + "\n");
    let out: unknown;
    assert.ok(await handlePost("/api/workspace/compare-agents", { id: b.id, campaignId: c.id }, (v) => (out = v)));
    assert.doesNotMatch(JSON.stringify(out), /31337/);
    assert.doesNotMatch(JSON.stringify(await campaignSummaries(b.id)), /31337/);
    await writeFile(receiptsPath, original);

    // The same receipt with its keys in another order is the same record, not a conflict.
    const reordered = await receipts((r) => Object.fromEntries(Object.entries(r).reverse()));
    const r = await into(reordered);
    assert.deepEqual([r.receipts, r.updated], [0, 0]);
    assert.equal((await readReceipts(b.id, [c.id])).length, 2);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(b.dir);
    await removeDir(fresh.dir);
    await removeDir(outside);
    await removeDir(cfg);
  }
});

test("save runs as zip: links and anything that is not a regular file are left out and counted; the zip still loads", async () => {
  const { exportRunsReport, importRuns } = await import("../src/executor/archive.js");
  const { runDir } = await import("../src/workspace.js");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(1);
  const { a, c, ids } = runs;
  const fresh = await tempWorkspace(resolve("examples/selection"));
  try {
    const a1 = join(runDir(a.id, c.id), "jobs", ids[0], "a1");
    await mkdir(join(a1, "screenshots"), { recursive: true });
    let links = 0;
    try {
      await symlink(join(a.dir, "human.json"), join(a1, "screenshots", "sym.png"), "file");
      links++;
      await symlink(a.dir, join(a1, "linked-folder"), "junction");
      links++;
    } catch {
      // symlinks need extra rights on Windows
    }
    // An attempt without a receipt (running, or ended without one) and an agent working folder.
    await mkdir(join(runDir(a.id, c.id), "jobs", ids[0], "a2", "Session"), { recursive: true });
    await writeFile(join(runDir(a.id, c.id), "jobs", ids[0], "a2", "calls.log"), "x\n");
    await writeFile(join(runDir(a.id, c.id), "jobs", ids[0], "a2", "Session", "notes.txt"), "x\n");
    await mkdir(join(a1, "SESSION"));
    await writeFile(join(a1, "SESSION", "notes.txt"), "x\n");
    const { zip, skipped } = await exportRunsReport(a.id, c.id);
    assert.deepEqual(skipped, { notFiles: links, unfinished: 1, names: 0, invalid: 0, records: 0, reasons: [] });
    const z = await JSZip.loadAsync(zip);
    const names = Object.keys(z.files).filter((n) => !z.files[n].dir);
    assert.ok(!names.some((n) => /sym\.png|linked-folder|\/a2\/|session/i.test(n)), names.join("\n"));
    assert.deepEqual(JSON.parse(await z.file("manifest.json")!.async("string")).skipped, skipped);
    assert.ok(!(await z.file(new RegExp(`a1/screenshots/`))).length);
    const r = await importRuns(fresh.id, zip);
    assert.equal(r.skippedAtSave, links + 1);
    assert.equal(r.skipped, 0);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(fresh.dir);
    await removeDir(cfg);
  }
});

test("runs zip: the WebXR runtime's app logs and object IDs are saved and loaded; a malformed app log is refused", async () => {
  const { exportRuns, importRuns } = await import("../src/executor/archive.js");
  const { runDir } = await import("../src/workspace.js");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(1);
  const { a, c, ids } = runs;
  const fresh = await tempWorkspace(resolve("examples/selection"));
  const other = await tempWorkspace(resolve("examples/selection"));
  try {
    // What a WebXR session leaves in its attempt folder besides the trace (see webxr-mcp.ts).
    const a1 = join(runDir(a.id, c.id), "jobs", ids[0], "a1");
    const files: Record<string, string> = {
      "app-logs/01-ray.json": JSON.stringify({ design: "ray", opened: 1, savedAt: new Date().toISOString(), entries: [{ t: 1, type: "select", hit: true }] }) + "\n",
      "app-logs/02-direct.json": JSON.stringify({ design: "direct", opened: 2, savedAt: new Date().toISOString(), entries: null }) + "\n",
      "object-ids.jsonl": JSON.stringify({ t: 1, design: "ray", shownToApp: { "obj-1": "cube" } }) + "\n",
    };
    await mkdir(join(a1, "app-logs"));
    for (const [rel, text] of Object.entries(files)) await writeFile(join(a1, ...rel.split("/")), text);
    const zip = await exportRuns(a.id, c.id);
    const inZip = Object.keys((await JSZip.loadAsync(zip)).files);
    for (const rel of Object.keys(files)) assert.ok(inZip.includes(`runs/${c.id}/jobs/${ids[0]}/a1/${rel}`), rel);
    await importRuns(fresh.id, zip);
    for (const [rel, text] of Object.entries(files)) assert.equal(await readFile(join(runDir(fresh.id, c.id), "jobs", ids[0], "a1", ...rel.split("/")), "utf8"), text, rel);
    // Runs saved before the app-log format hold what the app's log() returned as it is (any JSON): they load.
    const prefix = `runs/${c.id}/jobs/${ids[0]}/a1/app-logs`;
    for (const body of ["[1, 2]\n", JSON.stringify({ design: "ray", entries: [] }), "null\n"]) {
      const legacy = await tempWorkspace(resolve("examples/selection"));
      try {
        await importRuns(legacy.id, await rezip(zip, (f) => f.set(`${prefix}/01-ray.json`, Buffer.from(body))));
        assert.equal(await readFile(join(runDir(legacy.id, c.id), "jobs", ids[0], "a1", "app-logs", "01-ray.json"), "utf8"), body);
      } finally {
        await removeDir(legacy.dir);
      }
    }
    // Not an app log as the runtime writes it: refused before anything is written.
    for (const [name, body] of [
      ["01-ray.json", JSON.stringify({ design: 5, opened: 1, savedAt: "x", entries: [] })],
      ["01-ray.json", JSON.stringify({ design: "ray", opened: "first", savedAt: "x", entries: [] })],
      ["notes.json", JSON.stringify({ design: "ray", opened: 1, savedAt: "x", entries: [] })],
    ]) {
      const bad = await rezip(zip, (f) => f.set(`${prefix}/${name}`, Buffer.from(body)));
      await assert.rejects(importRuns(other.id, bad), /app-logs\/.* in this zip is not an app log/);
      assert.equal(existsSync(join(other.dir, "runs")), false);
    }
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(fresh.dir);
    await removeDir(other.dir);
    await removeDir(cfg);
  }
});

test("loading a zip holds its campaign: no session starts and no executor reads it until the zip is written; never while its sessions run", async () => {
  const { importRuns } = await import("../src/executor/archive.js");
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { holdForLoading } = await import("../src/executor/loading.js");
  const { readReceipts } = await import("../src/workspace.js");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(2);
  const { c, z2 } = runs;
  const b = await tempWorkspace(resolve("examples/selection"));
  const e = await tempWorkspace(resolve("examples/selection"));
  try {
    // The campaign alone first (as V3b's race did), so the study has an executor for it when the runs arrive.
    const campaignOnly = await rezip(z2, (f) => [...f.keys()].filter((n) => n.startsWith("runs/")).forEach((n) => f.delete(n)));
    await importRuns(b.id, campaignOnly);
    const before = await Executor.open(b.id, c.id);
    const refusal = (p: Promise<unknown>) => p.then(() => "not refused", (e: Error) => e.message);
    const during: { start?: Promise<string>; again?: Promise<string>; open?: ReturnType<typeof Executor.open> } = {};
    await importRuns(b.id, z2, (ids) => {
      // While the zip is held: Start refuses, a second zip into the campaign refuses, and opening
      // the campaign (after the zip closed its executor) waits until the zip is written.
      during.start = refusal(before.start("simulate"));
      during.again = refusal((async () => holdForLoading(b.id, [c.id]))());
      ids.forEach((x) => closeExecutor(b.id, x));
      during.open = Executor.open(b.id, c.id);
    });
    assert.match(await during.start!, /Runs are being loaded into this campaign; try again in a moment/);
    assert.match(await during.again!, /already being loaded into campaign/);
    const ex = await during.open!;
    assert.notEqual(ex, before);
    // Read from disk after the zip was written: both sessions finished, nothing to run again.
    assert.equal(ex.snapshot().counts.done, 2);
    await assert.rejects(ex.start("simulate"), /Nothing to run/);
    await assert.rejects(before.start("simulate"), /reloaded meanwhile/);
    const keys = (await readReceipts(b.id, [c.id])).map((r) => `${r.jobId}|${r.attempt}`);
    assert.equal(keys.length, 2);
    assert.equal(new Set(keys).size, keys.length);

    // A zip is not loaded into a campaign whose sessions run or wait to run.
    await importRuns(e.id, campaignOnly);
    const running = await Executor.open(e.id, c.id);
    await running.start("simulate");
    await assert.rejects(importRuns(e.id, z2), /Sessions of this campaign are (running|waiting to run)/);
    running.stop();
    await until(() => running.running.size === 0, "the stopped session to end", { executor: running });
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(b.dir);
    await removeDir(e.dir);
    await removeDir(cfg);
  }
});

test("save runs as zip: only what Load accepts (reasons in manifest.json), this machine's folders as placeholders; a completed session needs its result", async () => {
  const { exportRunsReport, importRuns } = await import("../src/executor/archive.js");
  const { runDir, repoRoot, receiptsWithResults, RESULT_MISSING } = await import("../src/workspace.js");
  const { continueFromStatus } = await import("../src/core/campaign.js");
  const { homedir } = await import("node:os");
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const runs = await simulatedRuns(2);
  const { a, c, ids } = runs;
  const fresh = await tempWorkspace(resolve("examples/selection"));
  const other = await tempWorkspace(resolve("examples/selection"));
  try {
    const dir = runDir(a.id, c.id);
    const a1 = join(dir, "jobs", ids[0], "a1");
    const inZip = (job: string, rel: string) => `runs/${c.id}/jobs/${job}/a1/${rel}`;
    // This machine's folders in an attempt's records, as a real session writes them (mcp.json, prompt.md).
    const mcp = { mcpServers: { study: { command: "node", args: [join(repoRoot, "dist", "runtimes", "study-mcp.js"), a1] }, tool: { command: join(homedir(), "bin", "tool") } } };
    await writeFile(join(a1, "mcp.json"), JSON.stringify(mcp, null, 2));
    await writeFile(join(a1, "prompt.md"), `Notes in ${join(homedir(), "notes")} and ${repoRoot}.\n`);
    // Records Load refuses: a trace line that is JSON but not an object, and a result whose bridge
    // reported its capabilities as objects. An app log written before the app-log format loads.
    await writeFile(join(a1, "trace.jsonl"), JSON.stringify({ t: 1, type: "phase" }) + "\n[1, 2]\n");
    const resultFile = join(dir, "results", `${ids[1]}.json`);
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    result.execution.capabilities = [{ name: "look" }];
    await writeFile(resultFile, JSON.stringify(result, null, 2));
    await mkdir(join(a1, "app-logs"));
    await writeFile(join(a1, "app-logs", "01-ray.json"), "[1, 2]\n");

    const { zip, skipped } = await exportRunsReport(a.id, c.id);
    assert.equal(skipped.invalid, 2, skipped.reasons.join("\n"));
    assert.equal(skipped.records, 1, skipped.reasons.join("\n"));
    assert.ok(skipped.reasons.some((r) => r.includes(inZip(ids[0], "trace.jsonl")) && /not a record/.test(r)), skipped.reasons.join("\n"));
    assert.ok(skipped.reasons.some((r) => r.includes(`results/${ids[1]}.json`) && /no valid execution record/.test(r)));
    assert.ok(skipped.reasons.some((r) => r.includes(ids[1]) && /recorded as completed but has a result that cannot be loaded/.test(r)));
    const z = await JSZip.loadAsync(zip);
    const manifest = JSON.parse(await z.file("manifest.json")!.async("string"));
    assert.deepEqual(manifest.skipped, skipped);
    // Checksums are over what the zip holds; no file of an attempt names this machine's home folder.
    for (const [name, digest] of Object.entries<string>(manifest.files)) {
      const bytes = await z.file(name)!.async("nodebuffer");
      assert.equal(sha(bytes), digest, name);
      if (name.includes("/jobs/")) assert.ok(!bytes.toString("utf8").includes(homedir()), name);
    }
    assert.ok(manifest.paths.files >= 2 && manifest.paths.replaced["<repo>"] && manifest.paths.replaced["~"]);
    const zmcp = JSON.parse(await z.file(inZip(ids[0], "mcp.json"))!.async("string"));
    assert.deepEqual(zmcp.mcpServers.study.args, [join("<repo>", "dist", "runtimes", "study-mcp.js"), join("<repo>", relative(repoRoot, a1))]);
    assert.equal(zmcp.mcpServers.tool.command, join("~", "bin", "tool"));
    assert.equal(await z.file(inZip(ids[0], "prompt.md"))!.async("string"), `Notes in ${join("~", "notes")} and <repo>.\n`);
    assert.equal(z.file(inZip(ids[0], "trace.jsonl")), null);
    assert.ok(z.file(inZip(ids[0], "app-logs/01-ray.json")));
    // The second session's record goes with its result: neither is in the zip, nor its attempt.
    assert.equal(z.file(new RegExp(`(results|jobs)/${ids[1]}`)).length, 0);
    assert.ok(!(await z.file(`runs/${c.id}/receipts.jsonl`)!.async("string")).includes(ids[1]));

    // Every saved zip loads; the placeholders are kept as written.
    const r = await importRuns(fresh.id, zip);
    assert.equal(r.receipts, 1);
    assert.equal(await readFile(join(runDir(fresh.id, c.id), "jobs", ids[0], "a1", "prompt.md"), "utf8"), `Notes in ${join("~", "notes")} and <repo>.\n`);

    // Load: a completed session needs its result, in the zip or in the study already.
    const noResult = await rezip(zip, (f) => [...f.keys()].filter((n) => n.includes(`results/${ids[0]}.json`) || n.includes(`jobs/${ids[0]}/`)).forEach((n) => f.delete(n)));
    await assert.rejects(importRuns(other.id, noResult), new RegExp(`session ${ids[0]} \\(attempt 1\\) of campaign ${c.id} as completed, but neither the zip nor this study has its result`));
    assert.equal(existsSync(join(other.dir, "runs")), false);
    await importRuns(fresh.id, noResult); // the study that has it already

    // Analyze and continue: a completed receipt whose result file is gone counts as not finished.
    await rm(join(dir, "results", `${ids[0]}.json`));
    const receipts = await receiptsWithResults(a.id, [c.id]);
    const r0 = receipts.find((x) => x.jobId === ids[0])!;
    assert.equal(r0.status, "failed");
    assert.equal(r0.error, RESULT_MISSING);
    const next = continueFromStatus(c, receipts, {}, undefined, undefined, { receiptsComplete: true });
    const template = (id: string) => c.jobs.find((j) => j.id === id)!.templateJobId;
    assert.equal(next.jobs.find((j) => j.templateJobId === template(ids[0]))!.inheritedFrom, undefined);
    assert.ok(next.jobs.find((j) => j.templateJobId === template(ids[1]))!.inheritedFrom);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await runs.done();
    await removeDir(fresh.dir);
    await removeDir(other.dir);
    await removeDir(cfg);
  }
});
