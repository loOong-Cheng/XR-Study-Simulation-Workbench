// Suite 8 (examples/graphics-quality-visionos): suite 3's study with an Apple Vision Pro app and a study
// bridge for the visionOS simulator. Checks that it is the same study as suite 3 apart from the
// runtime (same designs, measures, participants, synthetic data and configurations), that its files
// are valid and fair, that the bridge's projection math (calibration markers → screen positions) is
// right, and that a frozen simulated campaign analyses. The simulator itself is exercised in
// test/visionos-bridge.test.ts (skipped without one).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { freezePlan, withDefaultRuns } from "../src/core/planner.js";
import { validateAgents, validateHumanData, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { fairnessWarnings } from "../src/core/fairness.js";
import { runtimeFor } from "../src/executor/runtimes.js";
import type { AgentProtocol, HumanData, Study } from "../src/core/types.js";

// Run from the repository root (npm test).
const dir = resolve("examples/graphics-quality-visionos");
const suite3 = resolve("examples/graphics-quality");
const json = async <T>(base: string, p: string) => JSON.parse(await readFile(join(base, p), "utf8")) as T;

test("suite 8: the same study as suite 3, with the visionOS runtime for the app configurations", async () => {
  const study = validateStudy(await json<Study>(dir, "study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>(dir, "agents.json"));
  const human = await json<HumanData>(dir, "human.json");
  validateHumanData(study, human);
  const s3 = await json<Study>(suite3, "study.json");
  assert.equal(study.synthetic, true);
  // Designs, measures, participants, orders, cases and analysis: identical to suite 3.
  for (const k of ["design", "conditions", "phases", "cases", "participants", "outcomes", "analysis", "researchQuestion", "agentQuestions", "predictionLevel", "predictionTiming"] as const)
    assert.deepEqual(study[k], s3[k], k);
  assert.deepEqual(study.runtime, { ...s3.runtime, deviceProfile: "apple-vision-pro-simulator" });
  // The same invented people and answers, so the two runtimes can be compared on one reference.
  assert.equal(human.studyId, study.id);
  assert.deepEqual({ ...human, studyId: "" }, { ...(await json<HumanData>(suite3, "human.json")), studyId: "" });
  for (const f of await readdir(join(suite3, "data/raw"))) assert.equal(await readFile(join(dir, "data/raw", f), "utf8"), await readFile(join(suite3, "data/raw", f), "utf8"), f);
  // The configurations differ only in the runtime of the two app configurations.
  const a3 = await json<AgentProtocol[]>(suite3, "agents.json");
  assert.deepEqual(
    agents.map((a) => a.id),
    a3.map((a) => a.id),
  );
  const raw = await json<AgentProtocol[]>(dir, "agents.json");
  for (const [i, a] of raw.entries()) assert.deepEqual(a, a3[i].runtime === "webxr" ? { ...a3[i], runtime: "visionos" } : a3[i], a.id);
  assert.deepEqual(
    agents.filter((a) => runtimeFor(study, a) === "visionos").map((a) => a.id),
    ["uses-app", "uses-app-people"],
  );
  assert.deepEqual(fairnessWarnings(study, agents), fairnessWarnings(s3, validateAgents(s3, a3)));
  // Sources resolve inside the study folder; the project is the app's Swift sources, never its build.
  const ws = await json<{ sources: Record<string, string>; app?: unknown }>(dir, "workspace.json");
  assert.equal(ws.app, undefined, "no WebXR app: the visionOS app runs through the study bridge");
  for (const p of Object.values(ws.sources)) assert.ok(existsSync(join(dir, p)), p);
  assert.equal(ws.sources.project, "visionos-app/GraphicsQuality");
});

test("suite 8: the bridge finds the projection from calibration markers and maps head points to the screen", async () => {
  const sim = await import(pathToFileURL(join(dir, "runtime/sim.mjs")).href);
  // A pinhole view as the simulator's: 60° vertical field of view, 16:9, looking down -Z, slightly off centre.
  const f = 0.5 / Math.tan((30 * Math.PI) / 180);
  const truth = ([x, y, z]: number[]) => ({ x: 0.5 + ((f * 9) / 16) * (x / -z) + 0.01, y: 0.5 - f * (y / -z) });
  const pairs = sim.MARKERS.map((m: { head: number[] }) => ({ head: m.head, screen: [truth(m.head).x, truth(m.head).y] }));
  const fit = sim.fitProjection(pairs);
  assert.ok(fit.error < 1e-6, `fit error ${fit.error}`);
  for (const p of [[0, 0, -1.2], [0.3, -0.2, -0.9], [-0.5, 0.1, -2.5]]) {
    const q = sim.project(fit.P, p)!;
    assert.ok(Math.abs(q.x - truth(p).x) < 1e-6 && Math.abs(q.y - truth(p).y) < 1e-6, JSON.stringify({ p, q, t: truth(p) }));
  }
  assert.equal(sim.project(fit.P, [0, 0, 1]), null, "a point behind the viewer is not on the screen");
  assert.throws(() => sim.fitProjection(pairs.slice(0, 5)), /6 needed/);
  // Marker detection on a small synthetic BMP: two coloured blobs on black.
  const w = 40,
    h = 30,
    stride = Math.ceil((w * 3) / 4) * 4;
  const bmp = Buffer.alloc(54 + stride * h);
  bmp.write("BM", 0, "latin1");
  bmp.writeUInt32LE(54, 10);
  bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(w, 18);
  bmp.writeInt32LE(-h, 22); // top-down rows
  bmp.writeUInt16LE(24, 28);
  const paint = (cx: number, cy: number, [r, g, b]: number[]) => {
    for (let y = cy - 2; y <= cy + 2; y++)
      for (let x = cx - 2; x <= cx + 2; x++) {
        const i = 54 + y * stride + x * 3;
        bmp[i] = b;
        bmp[i + 1] = g;
        bmp[i + 2] = r;
      }
  };
  // Screenshots are Display P3: red as P3 (about 234, 51, 35), cyan as sRGB; both are found.
  assert.deepEqual(sim.srgbToP3([255, 0, 0]), [234, 51, 35]);
  paint(10, 8, sim.srgbToP3([255, 0, 0]));
  paint(30, 20, [0, 255, 255]);
  const found = sim.findMarkers(sim.readBmp(bmp));
  assert.deepEqual(Object.keys(found).map(Number).sort(), [0, 5]);
  assert.ok(Math.abs(found[0][0] - 10.5 / w) < 1e-9 && Math.abs(found[0][1] - 8.5 / h) < 1e-9, JSON.stringify(found));
});

test("suite 8: a frozen simulated campaign analyses without errors", async () => {
  const study = validateStudy(await json<Study>(dir, "study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>(dir, "agents.json"));
  const human = await json<HumanData>(dir, "human.json");
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "suite-8-test", new Date(Date.now() - 1000).toISOString());
  assert.equal(c.jobs.length, 126);
  const { report } = analyzeCampaign(c, human, [syntheticCampaignExecution(c).results]);
  assert.ok(report.audits.length > 0);
});

test("suite 8: files use LF line endings; the app's sources and the bridge are in place", async () => {
  const files: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }))
      if (e.isDirectory()) {
        if (!["campaigns", "runs", "deleted", "xcuserdata"].includes(e.name)) await walk(join(d, e.name));
      } else if ([".json", ".csv", ".md", ".py", ".mjs", ".swift", ".pbxproj", ".xcscheme"].includes(extname(e.name))) files.push(join(d, e.name));
  };
  await walk(dir);
  const withCr = [];
  for (const f of files) if ((await readFile(f)).includes(13)) withCr.push(f);
  assert.deepEqual(withCr, [], "these files contain carriage returns; write them with LF");
  assert.ok(files.some((f) => f.endsWith(".swift")), "the app's Swift sources");
  for (const f of ["runtime/bridge.mjs", "runtime/sim.mjs", "runtime/build.mjs", "visionos-app/GraphicsQuality.xcodeproj/project.pbxproj", "VISIONOS_SETUP.md", "README.md"]) assert.ok(existsSync(join(dir, f)), f);
  // The bridge offers the WebXR runtime's participant tools, so the two runtimes compare on one study.
  const bridge = await readFile(join(dir, "runtime/bridge.mjs"), "utf8");
  for (const tool of ["open_design", "screenshot", "app_state", "look", "list_objects", "select"]) assert.match(bridge, new RegExp(`name: "${tool}"`), tool);
});
