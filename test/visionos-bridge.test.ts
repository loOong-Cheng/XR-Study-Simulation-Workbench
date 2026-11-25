// Suite 3-a's study bridge (examples/graphics-quality/apple-vision-pro/runtime/bridge.mjs) against the real visionOS
// simulator: one "Uses the app" session through the executor, with a stand-in Claude Code
// (test/fixtures/fake-claude-bridge.cjs, plan "select") that does every task, then the audit.
// Skipped unless this is a Mac with a visionOS simulator runtime and the app is built
// (node examples/graphics-quality/apple-vision-pro/runtime/build.mjs). No real Claude Code session is started.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign } from "../src/core/campaign-study.js";
import type { TraceEvent } from "../src/core/types.js";
import { until } from "./until.js";

const suite = resolve("examples/graphics-quality/apple-vision-pro");
const bridge = join(suite, "runtime/bridge.mjs");
const app = resolve(".build/visionos-graphics-quality/Build/Products/Debug-xrsimulator/GraphicsQuality.app");
const fakeClaude = resolve("test/fixtures/fake-claude-bridge.cjs");
const hasRuntime = () => process.platform === "darwin" && /xrOS|visionOS/.test(spawnSync("xcrun", ["simctl", "list", "runtimes"], { encoding: "utf8" }).stdout ?? "");
const skip =
  process.platform !== "darwin" ? "needs macOS" : !hasRuntime() ? "no visionOS simulator runtime installed" : !existsSync(join(app, "Info.plist")) ? "the visionOS app is not built (runtime/build.mjs)" : false;
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

test("visionOS bridge: a session in the simulator does every task, takes screenshots, lists objects on screen and passes the audit", { skip, timeout: 900_000 }, async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readHuman, readResults, runDir } = await import("../src/workspace.js");
  const name = `__test-visionos-${Date.now().toString(36)}`;
  const studyDir = resolve("private/studies", name);
  const bin = await mkdtemp(join(tmpdir(), "xr-visionos-"));
  await mkdir(studyDir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"]) await cp(join(suite, f), join(studyDir, f));
  const manifest = JSON.parse(await readFile(join(suite, "workspace.json"), "utf8"));
  for (const rel of Object.values<string>(manifest.sources)) if (!existsSync(join(studyDir, rel))) await cp(join(suite, rel), join(studyDir, rel), { recursive: true });
  const id = `private/studies/${name}`;
  await writeFile(
    join(bin, "settings.json"),
    JSON.stringify({ claudePath: fakeClaude, runtimes: { visionos: { command: process.execPath, args: [bridge, "{jobFile}"], capabilities: ["screenshot", "look", "pointer-select", "phase-events", "quality-lock"], timeoutMinutes: 15 } } }),
  );
  // The app's hidden truths: the wooden box in practice; the glossy mug, metal bowl and glass vase in the scored trials.
  const env = { XR_STUDY_SETTINGS: join(bin, "settings.json"), FAKE_OUT: join(bin, "out.jsonl"), FAKE_PLAN: "select", FAKE_TARGETS: JSON.stringify({ practice: ["obj-7"], main: ["obj-1", "obj-3", "obj-5"] }) };
  Object.assign(process.env, env);
  try {
    const ws = await readWorkspace(id);
    const agents = ws.agents!.filter((x) => x.id === "uses-app").map((x) => ({ ...x, repetitions: 1 }));
    const study = { ...ws.study, analysis: { ...ws.study.analysis, contrasts: [] } };
    const c = campaignFromPlan(freezePlan(study, agents, 1), undefined, "visionos-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(id, c);
    const ex = await Executor.open(id, c.id);
    await ex.start("agent");
    await until(() => !!ex.snapshot().counts.done || !!ex.snapshot().counts.failed, "the visionOS session to end", { executor: ex, limitMs: 840_000 });
    const job = ex.snapshot().jobs[0];
    const jobDir = join(runDir(id, c.id), "jobs", c.jobs[0].id, "a1");
    const stderr = existsSync(join(jobDir, "bridge-stderr.log")) ? await readFile(join(jobDir, "bridge-stderr.log"), "utf8") : "";
    assert.equal(job.status, "done", `${JSON.stringify(job)}\n${stderr.slice(-2000)}`);
    const results = await readResults(id, ws.study, [c.id]);
    const audit = analyzeCampaign(c, (await readHuman(id))!, results).report.audits[0];
    assert.ok(audit.scoreable && audit.compliant, JSON.stringify(audit.issues));
    const run = results[0].runs[0];
    assert.equal(run.execution.engine, "realitykit");
    assert.equal(run.execution.observation, "mono");
    assert.equal(run.execution.runtimeStarts, 1);
    // Every case finished in order; every observation's image is in screenshots/ as a JPEG at most 1280 px wide.
    const trace = (await readFile(join(jobDir, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event).map((l) => l.event as TraceEvent);
    assert.deepEqual(
      trace.filter((e) => e.type === "case-end").map((e) => (e as { submitted: boolean }).submitted),
      ws.study.cases.map(() => true),
    );
    const captures = trace.flatMap((e) => (e.type === "observation" ? e.captures : []));
    const shots = await readdir(join(jobDir, "screenshots"));
    assert.equal(shots.length, captures.length);
    const jpg = await readFile(join(jobDir, "screenshots", shots[0]));
    assert.deepEqual([...jpg.subarray(0, 2)], [0xff, 0xd8]);
    // list_objects gives every object a neutral ID and the objects in view a screen position.
    const out = (await readFile(env.FAKE_OUT, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { what: string; text: string });
    const listed = JSON.parse(out.find((o) => o.what === "objects")!.text) as { id: string; x?: number; y?: number; onScreen: boolean }[];
    assert.deepEqual(listed.map((o) => o.id).sort(), Array.from({ length: 9 }, (_, i) => `obj-${i + 1}`).sort());
    const placed = listed.filter((o) => o.onScreen);
    assert.ok(placed.length >= 5 && placed.every((o) => o.x! >= 0 && o.x! <= 1 && o.y! >= 0 && o.y! <= 1), JSON.stringify(listed));
    // The app's own log of each design, with its four scored trials.
    const logs = await readdir(join(jobDir, "app-logs"));
    assert.equal(logs.length, 3);
    for (const f of logs) {
      const log = JSON.parse(await readFile(join(jobDir, "app-logs", f), "utf8"));
      assert.equal(log.entries.filter((e: { type: string; phase?: string }) => e.type === "trial-end" && e.phase === "main").length, 4, f);
    }
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    await removeDir(studyDir);
    await removeDir(bin);
  }
});
