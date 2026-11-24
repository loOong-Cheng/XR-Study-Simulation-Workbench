import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, proposeAgents, withDefaultRuns } from "../src/core/planner.js";
import { validateAgents, validateHumanData, validateStudy } from "../src/core/validation.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { holm, mannWhitney, wilcoxonSignedRank } from "../src/core/figures.js";
import type { AgentProtocol, AnalysisReport, Comparison, HumanData, Study } from "../src/core/types.js";
import { until } from "./until.js";

// Run from the repository root (npm test).
const example = (p: string) => resolve("examples/graphics-quality", p);
const json = async <T>(p: string) => JSON.parse(await readFile(example(p), "utf8")) as T;

test("graphics-quality workspace: study, configs, human data and the campaign path stay valid", async () => {
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const human = await json<HumanData>("human.json");
  validateHumanData(study, human);
  assert.equal(human.measurements.length, 18 * 3 * 7);
  assert.ok(agents.some((a) => a.level === "individual") && agents.some((a) => a.inputs?.length));
  const plan = freezePlan(study, agents, 2, "2026-11-23T10:00:00.000Z");
  const c = campaignFromPlan(plan, undefined, "toy", "2026-11-23T10:00:00.000Z");
  const run = syntheticCampaignExecution(c);
  const comparisons = await json<Comparison[]>("comparisons.json");
  const result = analyzeCampaign(c, human, [run.results], comparisons);
  assert.ok(result.report.audits.every((a) => a.scoreable));
  // Per-level analysis and per-config targets: the measured-data config is scored on subjective targets only.
  const levels = new Set(result.report.summaries.map((s) => s.level));
  assert.deepEqual([...levels].sort(), ["individual", "population"]);
  assert.deepEqual(
    result.report.summaries.filter((s) => s.agentId === "text-with-task-data").map((s) => s.domain),
    ["subjective"],
  );
  assert.ok((result.report.runScores ?? []).some((r) => r.level === "individual"));
  assert.ok((result.report.humanValues ?? []).length > 0);
  // Choosing comparisons changes no other number.
  const without = analyzeCampaign(c, human, [run.results]);
  assert.deepEqual(without.report.summaries, result.report.summaries);
  // A comparison across levels is skipped with a note; the rest of the analysis stands.
  const mixed = analyzeCampaign(c, human, [run.results], [...comparisons, { candidate: "uses-app", baseline: "knows-participant", domain: "subjective" }]);
  assert.ok(mixed.report.notes.some((n) => /Skipped 1 comparison\(s\): Comparison uses-app − knows-participant mixes population and individual configs/.test(n)), JSON.stringify(mixed.report.notes));
  assert.equal(mixed.report.contrasts.length, result.report.contrasts.length);
  assert.deepEqual(mixed.report.summaries, result.report.summaries);
});

test("a config cannot predict what it is given, and inputs need after-experience forecasts", async () => {
  const study = validateStudy(await json("study.json"));
  const [a] = await proposeAgents(study);
  assert.throws(() => validateAgents(study, [{ ...a, targets: ["presence"], inputs: ["presence"] }]), /cannot predict an outcome it is given/);
  assert.throws(() => validateAgents({ ...study, predictionTiming: "before-experience" } as Study, [{ ...a, inputs: ["search-time"] }]), /after-experience/);
});

test("rank tests match R and Holm adjusts step-down", () => {
  // R: wilcox.test(x, y, paired = TRUE) -> p = 0.03906; wilcox.test(a, b) -> W = 35, p = 0.2544
  const x = [1.83, 0.5, 1.62, 2.48, 1.68, 1.88, 1.55, 3.06, 1.3],
    y = [0.878, 0.647, 0.598, 2.05, 1.06, 1.29, 1.06, 3.14, 1.29];
  assert.ok(Math.abs(wilcoxonSignedRank(x.map((v, i) => v - y[i])).p! - 0.0390625) < 1e-9);
  assert.ok(Math.abs(mannWhitney([0.8, 0.83, 1.89, 1.04, 1.45, 1.38, 1.91, 1.64, 0.73, 1.46], [1.15, 0.88, 0.9, 0.74, 1.21]).p! - 0.2544122544) < 1e-6);
  // The untestable comparison (null) counts in the family size (m = 5, not 4).
  const adjusted = holm([0.01, 0.04, 0.03, null, 0.005]);
  [0.04, 0.09, 0.09, null, 0.025].forEach((p, i) => assert.ok(p === null ? adjusted[i] === null : Math.abs(adjusted[i]! - p) < 1e-12, `${adjusted[i]} vs ${p}`));
});

test("agent-drafted readings need exact quotes; human data mismatches are named", async () => {
  const { extractProposal, checkedReading } = await import("../src/core/proposal.js");
  const { humanCoverage } = await import("../src/core/explain.js");
  const doc = await extractProposal("proposal.md", await readFile(example("proposal.md")));
  const fact = (value: string, quote: string) => ({ value, quote });
  const facts = {
    title: fact("Graphics quality", "Graphics quality and subjective experience in a WebXR room"),
    researchQuestion: fact("RQ", "How does the graphics quality"),
    design: fact("within-subjects", "Design: within-subjects"),
    participantCount: fact("18", "Participants: 18"),
    conditions: fact("Low\nMedium\nHigh", "Conditions: Low quality; Medium quality; High quality"),
    task: fact("", ""),
    objectiveOutcomes: fact("Search time", "Objective outcomes: Search time"),
    subjectiveOutcomes: fact("Presence", "Subjective outcomes: Presence"),
  };
  const reader = { mode: "agent" as const, provider: "coding-agent", model: "test", usage: null };
  assert.deepEqual(checkedReading(doc, { facts }, reader).missing, ["task"]);
  assert.throws(() => checkedReading(doc, { facts: { ...facts, participantCount: fact("20", "Participants: 20") } }, reader), /copied exactly/);
  const study = validateStudy(await json("study.json"));
  const human = await json<HumanData>("human.json");
  human.measurements[0].participantId = "P01";
  const cov = humanCoverage(study, human);
  assert.deepEqual(cov.unknownPeople, ["P01"]);
  assert.equal(cov.missing.length, 1);
});

// ---------- executor: runs in a throw-away study folder under private/studies ----------
async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  // The files and folders behind the study's sources (workspace.json → sources), so configurations can run.
  const manifest = existsSync(join(from, "workspace.json")) ? JSON.parse(await readFile(join(from, "workspace.json"), "utf8")) : {};
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}
// On Windows a just-exited session's MCP children can still hold the folder for a moment (EBUSY).
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });

test("executor: simulated runs, runtime blockers, zip export and import", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { exportRuns, importRuns } = await import("../src/executor/archive.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const b = await tempWorkspace(resolve("examples/selection"));
  // Test-only settings with no runtimes: the blocker check must not depend on this machine's private/settings.json.
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "exec-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const blocked = await ex.blockers([...ex.jobs.keys()]);
    assert.equal(blocked.length, 1);
    assert.match(blocked[0].message, /Unity MCP runtime is not configured/);
    await assert.rejects(ex.start("agent"), /Unity MCP runtime is not configured/);
    await ex.start("simulate");
    await until(() => ex.snapshot().counts.done === ex.jobs.size, "every session to finish", { executor: ex });
    assert.equal(ex.snapshot().counts.done, ex.jobs.size);
    const zip = await exportRuns(a.id, c.id);
    await saveCampaign(b.id, c);
    const r = await importRuns(b.id, zip);
    assert.ok(r.written >= ex.jobs.size);
    const again = await importRuns(b.id, zip);
    assert.equal(again.written, 0);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(b.dir);
    await removeDir(cfg);
  }
});

test("executor: an agent session goes through the study MCP server and passes the audit (fake claude CLI)", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readHuman, readResults, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  // A stand-in for `claude -p`: starts the MCP servers from --mcp-config, submits a valid
  // forecast through the study server, and prints stream-json like the real CLI.
  // It is a .cjs file named in a test-only settings file, so it runs on Windows too and the
  // machine's real Claude Code (private/settings.json → claudePath) is never started.
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2); const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const model = args[args.indexOf("--model") + 1];
const s = cfg.mcpServers.study; const p = spawn(s.command, s.args); let buf = ""; const wait = {}; let id = 0;
p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id] && wait[m.id](m); } });
const call = (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); });
(async () => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session", model, claude_code_version: "fake", mcp_servers: [{ name: "study", status: "connected" }] }));
  await call("initialize", {});
  const job = JSON.parse(fs.readFileSync(s.args[1] + "/job.json", "utf8"));
  const predictions = [];
  for (const d of job.designs) for (const t of job.targets) {
    const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
    predictions.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value });
  }
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__study__submit_forecast", input: {} }] } }));
  const r = await call("tools/call", { name: "submit_forecast", arguments: { predictions, uncertainty: "test" } });
  console.log(JSON.stringify({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 1 }));
  p.stdin.end(); process.exit(0);
})();`,
  );
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!.filter((x) => x.id === "text-only").map((x) => ({ ...x, repetitions: 1 }));
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "agent-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent");
    await until(() => ex.snapshot().counts.done === 1 || !!ex.snapshot().counts.failed, "the session to end", { executor: ex });
    assert.equal(ex.snapshot().counts.done, 1, JSON.stringify(ex.snapshot().jobs.map((j) => j.error)));
    // The session must have been the stand-in, never a real (billed) Claude Code session.
    const manifest = JSON.parse(await readFile(join(runDir(a.id, c.id), "jobs", c.jobs[0].id, "a1", "execution-manifest.json"), "utf8"));
    assert.equal(manifest.cliVersion, "fake");
    const human = (await readHuman(a.id))!;
    const result = analyzeCampaign(c, human, await readResults(a.id, ws.study, [c.id]));
    const audit = result.report.audits[0];
    assert.ok(audit.scoreable && audit.compliant, JSON.stringify(audit.issues));
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    if (!process.env.KEEP_TEST_STUDY) await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("default runs: per participant for individual configurations, participants × that for population ones", async () => {
  const { withDefaultRuns } = await import("../src/core/planner.js");
  const study = validateStudy(await json("study.json"));
  const n = study.participants.length;
  const agents = (await json<AgentProtocol[]>("agents.json")).map(({ repetitions, ...a }) => a as AgentProtocol);
  const resolved = withDefaultRuns(study, agents, 2);
  for (const a of resolved) assert.equal(a.repetitions, (a.level ?? study.predictionLevel) === "individual" ? 2 : 2 * n, a.id);
  // A configuration's own (lower) count is kept, and the frozen plan states every count.
  const own = withDefaultRuns(study, [{ ...agents[0], repetitions: 3 }, agents[1]], 1);
  assert.deepEqual(own.map((a) => a.repetitions), [3, n]);
  const plan = freezePlan(study, own, 1);
  assert.equal(plan.jobs.filter((j) => j.agentId === agents[1].id).length, n);
  // Population counts above 50 are allowed (participants × runs); individual ones stay at most 50 per person.
  assert.doesNotThrow(() => validateAgents(study, [{ ...agents[0], level: "population", repetitions: 72 }]));
  assert.throws(() => validateAgents(study, [{ ...agents[0], level: "individual", repetitions: 72 }]), /1–50 runs per participant/);
  assert.throws(() => withDefaultRuns(study, agents, 0), /1–50 runs per participant/);
});

test("executor: reasoning settings map to Claude Code --effort; unknown ones are refused", async () => {
  const { effortArgs, playInstructions } = await import("../src/executor/runner.js");
  assert.deepEqual(effortArgs("default"), []);
  assert.deepEqual(effortArgs("effort=high"), ["--effort", "high"]);
  assert.deepEqual(effortArgs("xhigh"), ["--effort", "xhigh"]);
  assert.throws(() => effortArgs("budget=8000"), /not understood/);
  const study = await json<Study>("study.json");
  const ids = study.cases.map((c) => c.id);
  assert.match(playInstructions("webxr", ["low"], study, ids), /open_design/);
  const ue = playInstructions("unreal", ["low"], study, ids, "Call load_level first.");
  assert.doesNotMatch(ue, /open_design/);
  assert.match(ue, /look-around, select-target/);
  assert.match(ue, /How to use the unreal tools: Call load_level first\./);
});

/** Writes a fake study bridge (bridge.cjs) and a fake `claude -p` (claude.cjs) into bin. */
async function writeFakeEngine(bin: string) {
  // A stand-in for a study bridge over an engine MCP: one `play` tool that walks every case
  // in job.json and logs the trace events a real bridge would log while the agent plays.
  await writeFile(
    join(bin, "bridge.cjs"),
    `const fs = require("fs"); const rl = require("readline").createInterface({ input: process.stdin });
const jobFile = process.argv[2];
if (process.env.XR_STUDY_JOB_FILE !== jobFile) { console.error("env and {jobFile} differ"); process.exit(3); }
const log = (event) => fs.appendFileSync(process.env.XR_STUDY_TRACE, JSON.stringify({ t: Date.now(), server: "unreal", event }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line); const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
  if (m.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-ue", version: "1" } });
  if (m.method === "tools/call") {
    const app = JSON.parse(fs.readFileSync(jobFile, "utf8")).app;
    log(JSON.parse(process.env.FAKE_RUNTIME_EVENT || JSON.stringify({ type: "runtime", engine: "unreal", engineVersion: "5.7-fake", backend: "editor", deviceProfile: "webxr-desktop-browser-1280x720", observation: "mono", capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"] })));
    for (const c of app.cases) {
      log({ type: "phase", phaseId: c.phaseId });
      log({ type: "case-start", caseId: c.caseId, phaseId: c.phaseId });
      log({ type: "observation", caseId: c.caseId, phaseId: c.phaseId, captures: [{ eye: "mono", sha256: "0".repeat(64), frameId: c.caseId, simulationTimeMs: 0 }] });
      for (const action of c.requiredActions) log({ type: "action", caseId: c.caseId, phaseId: c.phaseId, action, completed: true });
      // One answer per trial, up to the task's minActions (job.json carries it for bridges).
      const answers = c.requiredActions.filter((x) => x !== "complete-task");
      for (let n = answers.length; n < (c.minActions || 0); n++) log({ type: "action", caseId: c.caseId, phaseId: c.phaseId, action: answers[answers.length - 1] || "answer", completed: true });
      log({ type: "case-end", caseId: c.caseId, phaseId: c.phaseId, submitted: true });
    }
    return reply({ content: [{ type: "text", text: "played " + app.cases.length + " cases" }] });
  }
});`,
  );
  await writeFile(
    join(bin, "claude.cjs"),
    `const { spawn } = require("child_process"); const fs = require("fs");
const args = process.argv.slice(2); fs.writeFileSync("args.json", JSON.stringify(args));
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const start = (s) => { const p = spawn(s.command, s.args, { env: { ...process.env, ...(s.env || {}) } }); let buf = ""; const wait = {}; let id = 0;
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); wait[m.id] && wait[m.id](m); } });
  return { p, call: (method, params) => new Promise((r) => { const n = ++id; wait[n] = r; p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\\n"); }) }; };
(async () => {
  console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session", model: args[args.indexOf("--model") + 1], claude_code_version: "fake" }));
  const study = start(cfg.mcpServers.study), ue = cfg.mcpServers.unreal ? start(cfg.mcpServers.unreal) : null;
  const tl = (what) => process.env.FAKE_TIMELINE && fs.appendFileSync(process.env.FAKE_TIMELINE, JSON.stringify({ what, unreal: !!ue, t: Date.now() }) + "\\n");
  tl("start");
  await study.call("initialize", {});
  // FAKE_READ: open the first project file, as a configuration that reads the project must.
  const spec0 = JSON.parse(fs.readFileSync(cfg.mcpServers.study.args[1] + "/job.json", "utf8"));
  if (process.env.FAKE_READ && spec0.projectDir) {
    const listed = await study.call("tools/call", { name: "list_files", arguments: {} });
    const first = listed.result.content[0].text.split("\\n").find((n) => !n.endsWith("/"));
    if (first) await study.call("tools/call", { name: "read_file", arguments: { path: first } });
  }
  if (ue) {
    await ue.call("initialize", {});
    console.log(JSON.stringify({ type: "assistant", message: { id: "msg-1", usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 50 }, content: [{ type: "tool_use", name: "mcp__unreal__play", input: {} }] } }));
    await ue.call("tools/call", { name: "play", arguments: {} });
  }
  await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLEEP || 0)));
  tl("end");
  const job = JSON.parse(fs.readFileSync(cfg.mcpServers.study.args[1] + "/job.json", "utf8"));
  const predictions = [];
  for (const d of job.designs) for (const t of job.targets)
    predictions.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value: t.scale === "proportion" ? 0.5 : 3 });
  const r = await study.call("tools/call", { name: "submit_forecast", arguments: { predictions, uncertainty: "test" } });
  console.log(JSON.stringify({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1 }));
  study.p.stdin.end(); ue && ue.p.stdin.end(); process.exit(0);
})();`,
  );
}

test("executor: an external runtime gets the job folder, writes the audit trace, and the session passes the audit", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readHuman, readResults, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-ue-"));
  await writeFakeEngine(bin);
  await writeFile(
    join(bin, "settings.json"),
    JSON.stringify({ claudePath: join(bin, "claude.cjs"), runtimes: { unreal: { command: process.execPath, args: [join(bin, "bridge.cjs"), "{jobFile}"], instructions: "Call play.", capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"] } } }),
  );
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  process.env.FAKE_READ = "1";
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!
      .filter((x) => x.id === "uses-app")
      .map((x) => ({ ...x, repetitions: 1, runtime: "unreal", model: { ...x.model, reasoning: "effort=high" } }));
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "external-runtime-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent");
    await until(() => ex.snapshot().counts.done === 1 || !!ex.snapshot().counts.failed, "the session to end", { executor: ex });
    assert.equal(ex.snapshot().counts.done, 1, JSON.stringify(ex.snapshot().jobs.map((j) => j.error)));
    const jobDir = join(runDir(a.id, c.id), "jobs", c.jobs[0].id, "a1");
    const args = JSON.parse(await readFile(join(jobDir, "session", "args.json"), "utf8")) as string[];
    assert.equal(args[args.indexOf("--effort") + 1], "high");
    assert.match(args[args.indexOf("--system-prompt") + 1], /How to use the unreal tools: Call play\./);
    const manifest = JSON.parse(await readFile(join(jobDir, "execution-manifest.json"), "utf8"));
    assert.equal(manifest.cliVersion, "fake");
    assert.equal(manifest.effort, "high");
    assert.equal(manifest.runtimeCommand.args[1], join(jobDir, "job.json"));
    const result = analyzeCampaign(c, (await readHuman(a.id))!, await readResults(a.id, ws.study, [c.id]));
    const audit = result.report.audits[0];
    assert.ok(audit.scoreable && audit.compliant, JSON.stringify(audit.issues));
    // The execution record carries what the runtime reported, not a copy of study.json.
    const run = (await readResults(a.id, ws.study, [c.id]))[0].runs[0];
    assert.equal(run.execution.engine, "unreal");
    assert.equal(run.execution.versions.engine, "unreal 5.7-fake");
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_READ;
    if (!process.env.KEEP_TEST_STUDY) await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("synthetic Ecolar suite: valid, complete, mixed levels, inputs and movement reach only individual jobs", async () => {
  const { trajectory } = await import("../src/executor/runner.js");
  const dir = resolve("examples/ecolar");
  const read = async <T>(p: string) => JSON.parse(await readFile(join(dir, p), "utf8")) as T;
  const study = validateStudy(await read("study.json"));
  assert.equal(study.synthetic, true);
  const agents = validateAgents(study, await read<AgentProtocol[]>("agents.json"));
  const human = await read<HumanData>("human.json");
  validateHumanData(study, human);
  assert.equal(human.synthetic, true);
  assert.equal(human.measurements.length, 24 * 4 * 14);
  assert.equal(agents.length, 16);
  // Williams square: every design appears once in every position across each block of four orders.
  for (let pos = 0; pos < 4; pos++) assert.equal(new Set(study.participants.slice(0, 4).map((p) => p.conditionOrder[pos])).size, 4);
  const plan = freezePlan(study, agents, 1, "2026-11-24T10:00:00.000Z");
  assert.equal(plan.jobs.length, 10 * 10 + 24 * (4 * 3 + 2 * 1));
  const c = campaignFromPlan(plan, undefined, "synthetic-ecolar", "2026-11-24T10:00:00.000Z");
  const run = syntheticCampaignExecution(c);
  const result = analyzeCampaign(c, human, [run.results], await read<Comparison[]>("comparisons.json"));
  assert.deepEqual([...new Set(result.report.summaries.map((s) => s.level))].sort(), ["individual", "population"]);
  // UDO and later predict only subjective measures; their objective measures are inputs.
  assert.deepEqual([...new Set(result.report.summaries.filter((s) => s.agentId === "UDO").map((s) => s.domain))], ["subjective"]);
  const fields = study.sources.find((s) => s.id === "trajectory")!.fields!;
  const compact = await trajectory(join(dir, "data/raw/trajectories_main.csv"), "P03", fields);
  assert.match(compact, /^participant,design,phase/);
  assert.ok(compact.split("\n").slice(1).every((l) => l.startsWith("P03,") && l.includes(",main,")));
  assert.equal(compact.split("\n").length, 1 + 4);
  assert.match(await trajectory(join(dir, "data/raw/trajectories.csv"), undefined, fields), /none for population/);
});

test("executor: a source without a file blocks the configurations that read it; nothing is substituted", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  try {
    // The brief exists; project and evidence have no file on this machine.
    await writeFile(join(a.dir, "workspace.json"), JSON.stringify({ title: "test", sources: { brief: "agent-brief.md" } }));
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!;
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "missing-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const blocked = await ex.blockers([...ex.jobs.keys()]);
    const byMessage = Object.fromEntries(blocked.map((b) => [b.message, b.configs]));
    const project = Object.keys(byMessage).find((m) => /Source 'project'/.test(m))!;
    const evidence = Object.keys(byMessage).find((m) => /Source 'evidence'/.test(m))!;
    assert.ok(project && evidence, JSON.stringify(blocked));
    const label = (id: string) => agents.find((x) => x.id === id)!.label;
    const reading = (src: string) => agents.filter((x) => x.sourceIds.includes(src)).map((x) => x.label).sort();
    assert.deepEqual(byMessage[project].sort(), reading("project"));
    assert.ok(reading("project").includes(label("uses-app")) && reading("project").includes(label("reads-project")));
    assert.deepEqual(byMessage[evidence], [label("reads-evidence")]);
    assert.ok(!blocked.some((b) => b.configs.includes(label("text-only"))), "text-only reads only the brief and must run");
    await assert.rejects(ex.start("agent"), /has no file on this machine/);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(cfg);
  }
});

test("executor: only the chosen sessions run; the others stay not started", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "pilot-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    assert.equal(ex.snapshot().counts["not-started"], ex.jobs.size, "nothing is queued before it is asked for");
    const firstTwo = [...ex.jobs.values()].filter((j) => j.agentId === "text-only").slice(0, 2).map((j) => j.jobId);
    const estimate = await ex.estimate(firstTwo);
    assert.deepEqual(estimate.map((e) => [e.agentId, e.sessions, e.perSession]), [["text-only", 2, null]]);
    await ex.start("simulate", firstTwo);
    await until(() => ex.snapshot().counts.done === 2, "two sessions to finish", { executor: ex });
    const counts = ex.snapshot().counts;
    assert.equal(counts.done, 2);
    assert.equal(counts["not-started"], ex.jobs.size - 2);
    assert.equal(counts.queued ?? 0, 0);
  } finally {
    await removeDir(a.dir);
  }
});

test("analyzer: real and simulated runs of a configuration are never pooled", async () => {
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json")).filter((a) => ["text-only", "reads-project"].includes(a.id));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "pool-test", new Date(Date.now() - 1000).toISOString());
  const human = await json<HumanData>("human.json");
  const run = syntheticCampaignExecution(c);
  // One text-only run is "real"; the rest are simulated. reads-project stays simulated only.
  const realJob = c.jobs.find((j) => j.conditionId === "text-only" && j.kind === "llm")!;
  run.results.runs.find((r) => r.jobId === realJob.id)!.execution.synthetic = false;
  const textRuns = run.results.runs.filter((r) => c.jobs.find((j) => j.id === r.jobId)!.conditionId === "text-only").length;
  const { report } = analyzeCampaign(c, human, [run.results]);
  for (const s of report.summaries.filter((s) => s.agentId === "text-only")) {
    assert.equal(s.real, 1);
    assert.equal(s.simulated, textRuns - 1);
    assert.equal(s.scoreable, 1, "scored on the real run only");
  }
  assert.ok(report.runScores!.filter((r) => r.agentId === "text-only").every((r) => r.unit === realJob.id));
  const leftOut = report.audits.filter((x) => x.issues.some((i) => /Simulated run left out/.test(i)));
  assert.equal(leftOut.length, textRuns - 1);
  assert.ok(report.notes.some((n) => /1 real \+ \d+ simulated/.test(n)));
  assert.ok(report.notes.some((n) => /simulated \(invented\) runs only: .*/.test(n)));
  for (const s of report.summaries.filter((s) => s.agentId === "reads-project")) assert.equal(s.scoreable, s.simulated);
});

test("executor: engine runtimes run one session at a time; app-free sessions still run in parallel", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-ue-"));
  await writeFakeEngine(bin);
  await writeFile(
    join(bin, "settings.json"),
    JSON.stringify({ claudePath: join(bin, "claude.cjs"), concurrency: 4, runtimes: { unreal: { command: process.execPath, args: [join(bin, "bridge.cjs"), "{jobFile}"], capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"] } } }),
  );
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  process.env.FAKE_TIMELINE = join(bin, "timeline.jsonl");
  process.env.FAKE_SLEEP = "700";
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!
      .filter((x) => x.id === "uses-app" || x.id === "text-only")
      .map((x) => ({ ...x, repetitions: 3, ...(x.id === "uses-app" ? { runtime: "unreal" } : {}) }));
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "parallel-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent");
    await until(() => (ex.snapshot().counts.done ?? 0) + (ex.snapshot().counts.failed ?? 0) >= 6, "six sessions to end", { executor: ex });
    assert.equal(ex.snapshot().counts.done, 6, JSON.stringify(ex.snapshot().jobs.map((j) => j.error)));
    const events = (await readFile(join(bin, "timeline.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { what: string; unreal: boolean; t: number }).sort((x, y) => x.t - y.t);
    let unreal = 0, all = 0, maxUnreal = 0, maxAll = 0;
    for (const e of events) {
      const d = e.what === "start" ? 1 : -1;
      all += d;
      if (e.unreal) unreal += d;
      maxUnreal = Math.max(maxUnreal, unreal);
      maxAll = Math.max(maxAll, all);
    }
    assert.equal(maxUnreal, 1, "two Unreal sessions overlapped");
    assert.ok(maxAll >= 2, "app-free sessions should run alongside");
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_TIMELINE;
    delete process.env.FAKE_SLEEP;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("audit: the runtime's own report is compared with the frozen recipe", async () => {
  const { auditRun } = await import("../src/core/protocol.js");
  const { runtimeStatus } = await import("../src/executor/runtimes.js");
  const { campaignPlan } = await import("../src/core/campaign.js");
  const dir = resolve("examples/selection");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const c = campaignFromPlan(freezePlan(study, agents, 1), undefined, "runtime-report", new Date(Date.now() - 1000).toISOString());
  const plan = campaignPlan(c);
  const run = syntheticCampaignExecution(c).results.runs.find((r) => c.jobs.find((j) => j.id === r.jobId)!.conditionId === "uses-app")!;
  const job = plan.jobs.find((j) => j.id === run.jobId)!;
  assert.ok(auditRun(plan, job, run).compliant, JSON.stringify(auditRun(plan, job, run).issues));
  // A bridge that reports mono for a stereo configuration makes the run non-compliant.
  const mono = structuredClone(run);
  const ev = mono.trace.find((e) => e.type === "runtime") as Extract<(typeof run.trace)[number], { type: "runtime" }>;
  ev.observation = "mono";
  const a1 = auditRun(plan, job, mono);
  assert.equal(a1.compliant, false);
  assert.ok(a1.issues.some((i) => /reported observation 'mono'/.test(i)), JSON.stringify(a1.issues));
  // No report at all: unverified.
  const silent = structuredClone(run);
  silent.trace = silent.trace.filter((e) => e.type !== "runtime");
  assert.ok(auditRun(plan, job, silent).issues.some((i) => /did not report itself/.test(i)));
  // Stereo support comes from the declared capability, not from being external.
  const s = (caps: string[]) => ({ runtimes: { unity: { command: "x", capabilities: caps } } }) as never;
  assert.deepEqual(runtimeStatus("unity", s(["screenshot"]), {}).observations, ["mono"]);
  assert.deepEqual(runtimeStatus("unity", s(["stereo-capture"]), {}).observations, ["mono", "stereo-pair"]);
});

test("planner: the least tool calls a protocol needs, from the study's tasks", async () => {
  const { minToolCalls } = await import("../src/core/planner.js");
  const dir = resolve("examples/ecolar");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const c = agents.find((a) => a.id === "C")!;
  // 4 designs + (4 × 3 practice + 4 × 12 main answers) + 8 views + 1 file read; the forecast is not counted.
  assert.equal(minToolCalls(study, c).min, 4 + 60 + 8 + 1);
  assert.equal(minToolCalls(study, agents.find((a) => a.id === "A")!).min, 0);
});

test("planner: token budgets below what the fewest tool calls need are warned about, not refused", async () => {
  const { callsForTokens, tokenBudgetWarning, tokensForCalls } = await import("../src/core/planner.js");
  const dir = resolve("examples/ecolar");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const c = agents.find((a) => a.id === "C")!;
  // Every call re-reads the growing context: 2 million tokens allow about 58 calls, not the 73 the tasks need.
  assert.equal(callsForTokens(2_000_000), 58);
  assert.ok(tokensForCalls(73) > 2_000_000 && tokensForCalls(73) < 3_500_000, String(tokensForCalls(73)));
  assert.ok(callsForTokens(60_000) < 10);
  assert.match(tokenBudgetWarning(study, { ...c, maxTokens: 2_000_000 }) ?? "", /^C: the token budget of 2\.0 million allows about 58 tool calls; the tasks need at least 73 \(about 3\.0 million tokens/);
  assert.match(tokenBudgetWarning(study, { ...c, maxTokens: 60_000 }) ?? "", /allows about \d tool calls; the tasks need at least 73/);
  assert.equal(tokenBudgetWarning(study, { ...c, maxTokens: 5_000_000 }), null);
  assert.equal(tokenBudgetWarning(study, { ...c, maxTokens: undefined }), null, "no budget, no warning");
  assert.equal(tokenBudgetWarning(study, { ...agents.find((a) => a.id === "A")!, maxTokens: 20_000 }), null, "no tool calls needed");
});

test("required capabilities the app does not declare are warned about before Start, and shown on the runtime card", async () => {
  const { capabilityWarnings, runtimeStatus } = await import("../src/executor/runtimes.js");
  const dir = resolve("examples/graphics-quality");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const manifest = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
  assert.deepEqual(capabilityWarnings(study, agents, manifest), [], "the example declares what its study requires");
  const strict = structuredClone(study);
  strict.runtime.requiredCapabilities = ["pointer-xy"];
  const [w] = capabilityWarnings(strict, agents, manifest);
  assert.match(w, /^The study requires pointer-xy, which the WebXR app does not declare \(workspace\.json → app\.capabilities: screenshot, look, pointer-select/);
  assert.match(w, /uses-app, uses-app-people cannot run as agents/);
  const settings = { chromePath: process.execPath, runtimes: {} } as never;
  assert.match(runtimeStatus("webxr", settings, manifest, ["pointer-xy"]).message, /^Ready, but the study requires pointer-xy, which the app \(workspace\.json → app\.capabilities\) does not declare/);
  assert.match(runtimeStatus("webxr", settings, manifest, ["look"]).message, /^Ready\. Mono screenshots only/);
});

test("campaign history: labels, lineage, progress, duplicate designs and every attempt of a session", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, runDir } = await import("../src/workspace.js");
  const { campaignSummaries, writeLabel, sameDesignKey, sessionAttempts } = await import("../src/history.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!;
    const c1 = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "hist-1", new Date(Date.now() - 2000).toISOString());
    const c2 = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "hist-2", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c1);
    await saveCampaign(a.id, c2);
    assert.equal(sameDesignKey(c1), sameDesignKey(c2), "same configurations, models and sessions");
    await writeLabel(a.id, c1.id, "  pilot   A×2 ");
    const ex = await Executor.open(a.id, c1.id);
    const first = [...ex.jobs.keys()][0];
    await ex.start("simulate", [first]);
    await until(() => ex.snapshot().counts.done === 1, "the session to finish", { executor: ex });
    // A stopped attempt leaves a folder but no receipt; it is still listed.
    await mkdir(join(runDir(a.id, c1.id), "jobs", [...ex.jobs.keys()][1], "a1"), { recursive: true });
    const list = await campaignSummaries(a.id);
    const s1 = list.find((x) => x.id === c1.id)!;
    assert.equal(s1.label, "pilot A×2");
    assert.equal(s1.done, 1);
    assert.equal(s1.simulated, 1);
    assert.equal(s1.notStarted, s1.jobs - 1);
    assert.equal(s1.costUsd, null);
    const done = await sessionAttempts(a.id, c1, first);
    assert.deepEqual(done.attempts.map((x) => [x.attempt, x.status, x.counts]), [[1, "completed", true]]);
    const stopped = await sessionAttempts(a.id, c1, [...ex.jobs.keys()][1]);
    assert.deepEqual(stopped.attempts.map((x) => [x.attempt, x.status, x.counts]), [[1, "stopped", false]]);
    // Simulated sessions report no token usage.
    assert.equal(ex.jobs.get(first)!.tokensIn, null);
  } finally {
    await removeDir(a.dir);
  }
});

test("compare agents: run-to-run agreement, agreement between configurations, never pooling real and simulated", async () => {
  const { compareAgents, directional } = await import("../src/core/agent-comparison.js");
  const { campaignPlan } = await import("../src/core/campaign.js");
  assert.equal(directional([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(directional([1, 2, 3], [3, 2, 1]), 0);
  assert.equal(directional([1, 1, 2], [1, 2, 3]), (0.5 + 1 + 1) / 3);
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json")).filter((x) => ["text-only", "reads-project"].includes(x.id));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "cmp-test", new Date(Date.now() - 1000).toISOString());
  const runs = syntheticCampaignExecution(c).results.runs;
  const realJob = c.jobs.find((j) => j.conditionId === "text-only" && j.kind === "llm")!;
  runs.find((r) => r.jobId === realJob.id)!.execution.synthetic = false;
  const out = compareAgents(campaignPlan(c), runs, { [realJob.id]: { costUsd: 0.09 } });
  const text = out.configs.find((x) => x.id === "text-only")!;
  assert.equal(text.basis, "real");
  assert.equal(text.real, 1);
  assert.equal(text.consistencyPairs, 0, "one real run has no pairs");
  assert.equal(text.meanCostUsd, 0.09);
  const proj = out.configs.find((x) => x.id === "reads-project")!;
  assert.equal(proj.basis, "simulated");
  assert.ok(proj.consistencyPairs > 0 && proj.consistency.subjective !== null);
  assert.equal(proj.meanToolCalls, null, "no tool calls for simulated runs");
  assert.ok(out.pairs.some((p) => p.a === "text-only" && p.b === "reads-project" && p.agreement !== null));
  assert.ok(out.notes.some((n) => /1 real \+ \d+ simulated/.test(n)));
});

test("sources: read what agents get; outcome-blind check counts only", async () => {
  const { sourceText, leakCheck, evidenceOverview } = await import("../src/sources.js");
  const { readWorkspace, readHuman } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  try {
    assert.match(await sourceText(a.id, "brief"), /\w/);
    await assert.rejects(sourceText(a.id, "demographics"), /Only the brief, project and evidence/);
    const ws = await readWorkspace(a.id);
    // A number equal to a human design mean (2 decimals) and a participant ID are flagged by count only.
    const human = (await readHuman(a.id))!;
    const { measurementValue } = await import("../src/core/validation.js");
    const o = ws.study.outcomes[0], d = ws.study.conditions[0];
    const vals = human.measurements.filter((m) => m.outcomeId === o.id && m.conditionId === d.id).map((m) => measurementValue(ws.study, m));
    const mean = (vals.reduce((s, x) => s + x, 0) / vals.length).toFixed(2);
    const leaky = `People rated it ${mean} on average; ${ws.study.participants[0].id} liked it.`;
    assert.deepEqual(await leakCheck(a.id, ws.study, leaky), { participantIds: 1, humanMeanMatches: 1, checkedAgainstHuman: true, predictions: [] });
    // A prediction about a measure is no leak by count, but is flagged for the researcher to confirm (the text's own sentence, never human data).
    assert.deepEqual(await leakCheck(a.id, ws.study, "A model predicts higher presence at high quality."), { participantIds: 0, humanMeanMatches: 0, checkedAgainstHuman: true, predictions: ["A model predicts higher presence at high quality."] });
    const overview = await evidenceOverview(a.id, ws.agents ?? []);
    assert.ok(overview.some((e) => e.id === "evidence" && e.exists));
  } finally {
    await removeDir(a.dir);
  }
});

test("knowledge: drafted, reviewed, saved, renamed, edited and deleted; participant tables must be complete", async () => {
  const { knowledgeDraft, saveKnowledge } = await import("../src/sources.js");
  const { readWorkspace } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-assistant-"));
  // A stand-in for the assistant (claude -p --output-format json): it reads the prompt on stdin and
  // drafts a general note, or, for a document about the participants, one row per participant.
  await writeFile(
    join(bin, "claude.cjs"),
    `let prompt = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (prompt += d));
process.stdin.on("end", () => {
if (!prompt.includes("Participant IDs") || process.argv.some((a) => a.includes("Participant IDs"))) throw new Error("the prompt belongs on stdin, not the command line");
const ids = (prompt.match(/Participant IDs: ([^\\n]*)\\./) || [, ""])[1].split(", ").filter(Boolean);
const draft = /handedness/.test(prompt)
  ? { kind: "participant", label: "Handedness", description: "From the session notes.", participants: { fields: ["handedness"], rows: ids.map((id) => ({ id, handedness: "right" })) }, notes: "" }
  : { kind: "general", label: "Fidelity and presence", description: "Summary of a paper.", evidence: "# Fidelity and presence\\nHigher fidelity tends to raise presence.", notes: "Left out the paper's own study results." };
console.log(JSON.stringify({ result: JSON.stringify(draft) }));
});`,
  );
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  try {
    let ws = await readWorkspace(a.id);
    const ids = ws.study.participants.map((p) => p.id);
    // A paper (here as text) is read by the assistant and drafted as general knowledge.
    const paper = await knowledgeDraft(a.id, "Fidelity paper.md", Buffer.from("A study found that higher visual fidelity raised presence."));
    assert.equal(paper.kind, "general");
    assert.equal(paper.via, "assistant");
    assert.match(paper.text, /Higher fidelity/);
    assert.match(paper.path, /^evidence\/[a-z0-9-]+\.md$/);
    assert.match(paper.notes, /Left out/);
    // Saving adds it to the study and writes the reviewed text.
    const study = structuredClone(ws.study);
    study.sources.push({ id: paper.sourceId, label: paper.label, kind: "evidence", description: paper.description });
    await saveKnowledge(a.id, { study, agents: ws.agents, write: [{ sourceId: paper.sourceId, path: paper.path, text: paper.text }] });
    ws = await readWorkspace(a.id);
    assert.equal(ws.manifest.sources?.[paper.sourceId], paper.path);
    assert.match(await readFile(join(a.dir, paper.path), "utf8"), /Higher fidelity/);
    // A document about the participants becomes a participant table.
    const notes = await knowledgeDraft(a.id, "session notes.txt", Buffer.from("Notes on each participant's handedness."));
    assert.equal(notes.kind, "participant");
    assert.deepEqual(notes.columns!.map((c) => [c.name, c.missing.length]), [["handedness", 0]]);
    assert.deepEqual(notes.problems, []);
    // A table with this study's IDs is participant-specific as it is (no assistant); a column named like a measure is left out.
    const table = await knowledgeDraft(a.id, "background.csv", Buffer.from(`participant,age_band,presence\n${ids.map((p, i) => `${p},"25-34, urban",${i}`).join("\n")}\n`));
    assert.equal(table.kind, "participant");
    assert.equal(table.via, "table");
    assert.deepEqual(table.columns!.map((c) => c.name), ["age_band"]);
    assert.match(table.notes, /Left out presence/);
    // Incomplete tables are drafted with their problems, and refused on saving.
    const partial = await knowledgeDraft(a.id, "partial.csv", Buffer.from(`participant,age_band\n${ids[0]},18-24\n`));
    assert.ok(partial.problems.some((p) => /^has no entry for /.test(p)));
    const s2 = structuredClone(ws.study);
    s2.sources.push({ id: partial.sourceId, label: "Partial", kind: "demographics", description: "x", fields: ["age_band"] });
    await assert.rejects(saveKnowledge(a.id, { study: s2, agents: ws.agents, write: [{ sourceId: partial.sourceId, path: partial.path, text: partial.text }] }), /Partial has no entry for .*exactly one complete entry per participant/);
    assert.equal(existsSync(join(a.dir, partial.path)), false, "nothing written when refused");
    // Rename and edit text.
    const s3 = structuredClone(ws.study);
    s3.sources.find((x) => x.id === paper.sourceId)!.label = "Renamed";
    await saveKnowledge(a.id, { study: s3, agents: ws.agents, write: [{ sourceId: paper.sourceId, path: paper.path, text: "# Edited\n" }] });
    ws = await readWorkspace(a.id);
    assert.equal(ws.study.sources.find((x) => x.id === paper.sourceId)!.label, "Renamed");
    assert.equal(await readFile(join(a.dir, paper.path), "utf8"), "# Edited\n");
    // Writing outside evidence/ or data/ is refused.
    await assert.rejects(saveKnowledge(a.id, { study: ws.study, agents: ws.agents, write: [{ sourceId: paper.sourceId, path: "../../escape.md", text: "x" }] }), /evidence\/ or data\//);
    // Delete: gone from the study and the map; the file stays.
    const s4 = structuredClone(ws.study);
    s4.sources = s4.sources.filter((x) => x.id !== paper.sourceId);
    await saveKnowledge(a.id, { study: s4, agents: ws.agents, unmap: [paper.sourceId] });
    ws = await readWorkspace(a.id);
    assert.equal(ws.study.sources.some((x) => x.id === paper.sourceId), false);
    assert.equal(ws.manifest.sources?.[paper.sourceId], undefined);
    assert.ok(existsSync(join(a.dir, paper.path)));
    // Without the assistant, the extracted text is offered as the draft.
    await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "missing-claude.cjs") }));
    const raw = await knowledgeDraft(a.id, "notes.md", Buffer.from("Plain notes."));
    assert.equal(raw.via, "raw");
    assert.match(raw.text, /Plain notes/);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("stream log: image data is replaced by its hash, size and the saved screenshot", async () => {
  const { compactStreamLine, ScreenshotIndex } = await import("../src/executor/stream-log.js");
  const { createHash } = await import("node:crypto");
  const dir = await mkdtemp(join(tmpdir(), "xr-stream-"));
  try {
    const png = Buffer.from("not really a png, but bytes");
    await mkdir(join(dir, "screenshots"));
    await writeFile(join(dir, "screenshots", "001-low.jpg"), png);
    const b64 = png.toString("base64");
    const line = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: b64 } }, { type: "image", data: b64, mimeType: "image/jpeg" }, { type: "text", text: "ok" }] }] } });
    const out = JSON.parse(await compactStreamLine(line, new ScreenshotIndex(join(dir, "screenshots"))));
    const [anth, mcp, txt] = out.message.content[0].content;
    const hash = createHash("sha256").update(png).digest("hex");
    for (const holder of [anth.source, mcp]) {
      assert.equal(holder.data, undefined);
      assert.equal(holder.sha256, hash);
      assert.equal(holder.bytes, png.length);
      assert.equal(holder.file, "screenshots/001-low.jpg");
    }
    assert.equal(txt.text, "ok");
    const plain = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "no images" }] } });
    assert.equal(await compactStreamLine(plain, new ScreenshotIndex(join(dir, "screenshots"))), plain);
  } finally {
    await removeDir(dir);
  }
});

test("suite 3 app runs offline: three.js is vendored, no network imports", async () => {
  const html = await readFile(example("webxr-app/index.html"), "utf8");
  assert.doesNotMatch(html, /https?:\/\//);
  for (const f of ["build/three.module.js", "examples/jsm/controls/OrbitControls.js", "examples/jsm/webxr/VRButton.js", "examples/jsm/environments/RoomEnvironment.js", "LICENSE"])
    assert.ok(existsSync(example(`webxr-app/vendor/three/${f}`)), f);
  const main = await readFile(example("webxr-app/main.js"), "utf8");
  assert.match(main, /trial \$\{n\} of 4/);
});

test("suite 2: valid, background reaches only individual jobs, and background drives the invented outcomes", async () => {
  const dir = resolve("examples/selection");
  const study = validateStudy(JSON.parse(await readFile(join(dir, "study.json"), "utf8")));
  const agents = validateAgents(study, JSON.parse(await readFile(join(dir, "agents.json"), "utf8")));
  const human = JSON.parse(await readFile(join(dir, "human.json"), "utf8")) as HumanData;
  validateHumanData(study, human);
  const plan = freezePlan(study, withDefaultRuns(study, agents, 1), 1);
  assert.equal(plan.jobs.length, 36);
  const individual = agents.filter((a) => a.level === "individual").map((a) => a.id).sort();
  assert.deepEqual(individual, ["knows-participant", "uses-app-people"]);
  assert.ok(agents.filter((a) => a.sourceIds.includes("demographics")).every((a) => a.level === "individual"));
  // No XR experience → slower with direct touch than frequent users (invented effect).
  const dem = (await readFile(join(dir, "data/raw/demographics.csv"), "utf8")).trim().split("\n").slice(1).map((l) => l.split(","));
  const xp = new Map(dem.map((r) => [r[0], r[2]]));
  const time = (level: string) => {
    const v = human.measurements.filter((m) => m.outcomeId === "completion-time" && m.conditionId === "direct" && xp.get(m.participantId!) === level).map((m) => m.value!);
    return v.reduce((s, x) => s + x, 0) / v.length;
  };
  assert.ok(time("none") > time("frequent") * 1.3, `${time("none")} vs ${time("frequent")}`);
});

test("between-subjects end to end: no rankings, no individual configs, significant group differences, absolute fit, figures", async () => {
  const { agreementFigure, agentVsHumanFigure, correlationFigure } = await import("../src/core/figures.js");
  const within = validateStudy(await json("study.json"));
  const humanWithin = await json<HumanData>("human.json");
  // Suite 3 as a between-subjects study: each of the 18 people keeps only the first level of their order.
  const s = structuredClone(within) as Study;
  s.design = "between-subjects";
  s.participants = s.participants.map((p) => ({ id: p.id, stratum: `group-${p.conditionOrder[0]}`, conditionOrder: [p.conditionOrder[0]] }));
  assert.throws(() => validateStudy(s), /ranking of the designs/);
  s.outcomes = s.outcomes.filter((o) => o.scale !== "rank");
  s.analysis.familyWeights = Object.fromEntries(Object.entries(s.analysis.familyWeights).filter(([f]) => s.outcomes.some((o) => o.family === f)));
  const study = validateStudy(s);
  const assigned = new Map(study.participants.map((p) => [p.id, p.conditionOrder[0]]));
  const human: HumanData = { ...humanWithin, measurements: humanWithin.measurements.filter((m) => assigned.get(m.participantId!) === m.conditionId && study.outcomes.some((o) => o.id === m.outcomeId)) };
  validateHumanData(study, human);
  const raw = (await json<AgentProtocol[]>("agents.json")).map((a) => ({ ...a, targets: a.targets?.filter((t) => study.outcomes.some((o) => o.id === t)), inputs: a.inputs?.filter((t) => study.outcomes.some((o) => o.id === t)) }));
  assert.throws(() => validateAgents(study, raw), /individual level, which needs every person/);
  const agents = validateAgents(study, raw.filter((a) => a.level !== "individual" && !a.inputs?.length));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "between-e2e", new Date(Date.now() - 1000).toISOString());
  const { report } = analyzeCampaign(c, human, [syntheticCampaignExecution(c).results]);
  assert.equal(report.pairRule, "significant");
  assert.ok(report.humanPairs!.length > 0 && report.humanPairs!.every((p) => p.test === "Mann–Whitney U"));
  assert.ok(report.notes.some((n) => /Mann–Whitney U between the independent groups/.test(n)));
  // Only significant pairs are scored; an outcome without one is excluded for every configuration.
  for (const o of study.outcomes) {
    const pairs = report.humanPairs!.filter((p) => p.outcomeId === o.id);
    assert.ok(pairs.every((p) => p.used === (p.significant && p.meanA !== p.meanB)));
    if (!pairs.some((p) => p.used)) assert.ok(report.exclusions.some((e) => e.startsWith(`${o.label}:`)));
  }
  assert.equal(report.significantOnly, undefined, "the second view is for within-subjects studies");
  // Absolute values: every population configuration × predicted measure × design, inside or outside the human 95% CI.
  const fit = report.absoluteFit!;
  assert.ok(fit.length > 0);
  for (const f of fit) {
    assert.ok(f.low <= f.human && f.human <= f.high && f.n >= 2);
    assert.equal(f.inside, f.agent >= f.low - 1e-9 && f.agent <= f.high + 1e-9);
  }
  // Figures work on a between-subjects report.
  const ids = agents.map((a) => a.id);
  const labels = Object.fromEntries(agents.map((a) => [a.id, a.label]));
  assert.ok(agreementFigure(report, ids, "subjective", labels));
  assert.ok(agentVsHumanFigure(study, report, ids, study.outcomes[0].id, labels));
  assert.ok(correlationFigure(study, report, ids, labels));
});

test("within-subjects: main scores keep mean differences; a second view uses significant paired differences", async () => {
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "within-views", new Date(Date.now() - 1000).toISOString());
  const { report } = analyzeCampaign(c, await json<HumanData>("human.json"), [syntheticCampaignExecution(c).results]);
  assert.equal(report.pairRule, "means");
  const sig = report.significantOnly!;
  assert.ok(sig.humanPairs.length > 0 && sig.humanPairs.every((p) => p.test === "Wilcoxon signed-rank"));
  assert.ok(sig.humanPairs.every((p) => p.used === (p.significant && p.meanA !== p.meanB)));
  const population = agents.filter((a) => (a.level ?? study.predictionLevel) === "population").map((a) => a.id);
  assert.deepEqual([...new Set(sig.summaries.map((x) => x.agentId))].sort(), population.sort());
});

test("token budget: validated, enforced by the study server at 90%, and audited", async (t) => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const { auditRun } = await import("../src/core/protocol.js");
  const { campaignPlan } = await import("../src/core/campaign.js");
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  assert.throws(() => validateAgents(study, agents.map((a) => (a.id === "text-only" ? { ...a, maxTokens: 500 } : a))), /at least 20,000 tokens: the first turn alone/);
  // Templates come with a budget sized to what the configuration does.
  const proposed = await proposeAgents(study);
  assert.ok(proposed.every((a) => a.maxTokens! >= 100_000));
  assert.ok(proposed.find((a) => a.id === "uses-app")!.maxTokens! > proposed.find((a) => a.id === "text-only")!.maxTokens!);
  // The study server refuses tools once 90% is used; submitting stays possible.
  const dir = await mkdtemp(join(tmpdir(), "xr-tokens-"));
  try {
    await writeFile(join(dir, "job.json"), JSON.stringify({ jobId: "t", budget: 50, tokenBudget: 10_000, projectDir: dir, participantId: null, designs: [], targets: [] }));
    await writeFile(join(dir, "usage.json"), JSON.stringify({ tokens: 9_500, budget: 10_000 }));
    const child = spawn(process.execPath, [resolve("dist/runtimes/study-mcp.js"), dir], { stdio: ["pipe", "pipe", "ignore"] });
    t.after(() => child.kill()); // also when an assertion below fails
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: child.stdout! }).on("line", (l) => {
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    });
    let seq = 0;
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((ok) => {
        const id = ++seq;
        waiting.set(id, ok);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    await rpc("initialize");
    const listed = await rpc("tools/call", { name: "list_files", arguments: {} });
    assert.match(listed.result.content[0].text, /Token budget of 10000 tokens is nearly used up/);
    const submitted = await rpc("tools/call", { name: "submit_forecast", arguments: { predictions: [] } });
    assert.doesNotMatch(submitted.result.content[0].text, /Token budget/);
    child.stdin!.end();
    await new Promise((ok) => child.on("exit", ok));
  } finally {
    await removeDir(dir);
  }
  // The audit flags a real session above its token budget.
  const withBudget = agents.map((a) => (a.id === "text-only" ? { ...a, maxTokens: 20_000 } : a));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, withBudget, 1), 1), undefined, "tokens", new Date(Date.now() - 1000).toISOString());
  const plan = campaignPlan(c);
  const run = syntheticCampaignExecution(c).results.runs.find((r) => c.jobs.find((j) => j.id === r.jobId)!.conditionId === "text-only")!;
  Object.assign(run.execution, { synthetic: false, inputTokens: 1_000, cacheReadTokens: 21_000, cacheWriteTokens: 0, outputTokens: 500 });
  const audit = auditRun(plan, plan.jobs.find((j) => j.id === run.jobId)!, run);
  assert.ok(audit.issues.some((i) => /Token budget exceeded: 22500 of 20000/.test(i)), JSON.stringify(audit.issues));
});

test("human data only: per-design values with the design's test, matching the analyzer's human pairs", async () => {
  const { humanFigure } = await import("../src/core/figures.js");
  const study = validateStudy(await json("study.json"));
  const human = await json<HumanData>("human.json");
  const fig = humanFigure(study, human, "presence");
  assert.equal(fig.groups.length, 3);
  assert.ok(fig.groups.every((g) => g.stats.n === 18));
  assert.ok(fig.brackets.every((b) => b.test === "Wilcoxon signed-rank"));
  assert.ok(fig.summary.every((r) => r.low <= r.mean && r.mean <= r.high));
  // Same tests as the analyzer's significant-only view.
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "human-only", new Date(Date.now() - 1000).toISOString());
  const { report } = analyzeCampaign(c, human, [syntheticCampaignExecution(c).results]);
  for (const b of fig.brackets) {
    const p = report.significantOnly!.humanPairs.find((x) => x.outcomeId === "presence" && x.a === b.a && x.b === b.b)!;
    assert.ok(Math.abs((p.pHolm ?? 1) - (b.holm ?? 1)) < 1e-12, `${b.a}-${b.b}`);
  }
  // A geometric measure: both test each person's log ratio (the figure used raw differences, so its
  // Holm p-values were .0179/.0025/.0898 against the analyzer's .0132/.0013/.0665). R, exact:
  // wilcox.test(log(b) - log(a)) -> .0065765, .00041962, .066536 (no ties).
  const geo = humanFigure(study, human, "search-time");
  const exact: Record<string, [number, number]> = {
    "low-medium": [0.0065765380859375, 0.013153076171875],
    "low-high": [0.00041961669921875, 0.00125885009765625],
    "medium-high": [0.06653594970703125, 0.06653594970703125],
  };
  assert.equal(geo.brackets.length, 3);
  for (const b of geo.brackets) {
    const p = report.significantOnly!.humanPairs.find((x) => x.outcomeId === "search-time" && x.a === b.a && x.b === b.b)!;
    assert.equal(b.p, p.p, `${b.a}-${b.b}`);
    assert.equal(b.holm, p.pHolm, `${b.a}-${b.b}`);
    assert.ok(Math.abs(b.p! - exact[`${b.a}-${b.b}`][0]) < 1e-12 && Math.abs(b.holm! - exact[`${b.a}-${b.b}`][1]) < 1e-12, `${b.a}-${b.b}: ${b.p} ${b.holm}`);
  }
  // Between subjects: independent groups, Mann–Whitney U.
  const s = structuredClone(study) as Study;
  s.design = "between-subjects";
  s.participants = s.participants.map((p) => ({ id: p.id, stratum: `group-${p.conditionOrder[0]}`, conditionOrder: [p.conditionOrder[0]] }));
  s.outcomes = s.outcomes.filter((o) => o.scale !== "rank");
  const assigned = new Map(s.participants.map((p) => [p.id, p.conditionOrder[0]]));
  const between = humanFigure(s, { ...human, measurements: human.measurements.filter((m) => assigned.get(m.participantId!) === m.conditionId) }, "realism");
  assert.ok(between.brackets.every((b) => b.test === "Mann–Whitney U"));
  assert.ok(between.groups.every((g) => g.stats.n === 6));
});

test("population vs individual figure scores each population run exactly as the analyzer", async () => {
  const { populationVsIndividualFigure } = await import("../src/core/figures.js");
  const same = (study: Study, report: AnalysisReport, ids: string[]) => {
    let n = 0;
    for (const domain of ["objective", "subjective"] as const)
      for (const g of populationVsIndividualFigure(study, report, ids, domain).groups)
        g.units.forEach((u, k) => {
          const r = report.runScores!.find((x) => x.agentId === g.id && x.unit === u && x.domain === domain)!;
          assert.ok(Math.abs(r.agreement! - g.values[k]) < 1e-12, `${g.id} ${u} ${domain}: ${g.values[k]} vs ${r.agreement}`);
          n++;
        });
    return n;
  };
  // Within subjects: every difference of the design means.
  const within = validateStudy(await json("study.json"));
  const humanWithin = await json<HumanData>("human.json");
  const agents = validateAgents(within, await json<AgentProtocol[]>("agents.json"));
  const population = agents.filter((a) => (a.level ?? within.predictionLevel) === "population").map((a) => a.id);
  const cw = campaignFromPlan(freezePlan(within, withDefaultRuns(within, agents, 1), 1), undefined, "fig4-within", new Date(Date.now() - 1000).toISOString());
  assert.ok(same(within, analyzeCampaign(cw, humanWithin, [syntheticCampaignExecution(cw).results]).report, population) > 0);
  // Between subjects: only the significant group differences count (the figure scored every mean
  // difference: text-only run 1 got .647 where the analyzer gave .714).
  const s = structuredClone(within) as Study;
  s.design = "between-subjects";
  s.participants = s.participants.map((p) => ({ id: p.id, stratum: `group-${p.conditionOrder[0]}`, conditionOrder: [p.conditionOrder[0]] }));
  s.outcomes = s.outcomes.filter((o) => o.scale !== "rank");
  s.analysis.familyWeights = Object.fromEntries(Object.entries(s.analysis.familyWeights).filter(([f]) => s.outcomes.some((o) => o.family === f)));
  const study = validateStudy(s);
  const assigned = new Map(study.participants.map((p) => [p.id, p.conditionOrder[0]]));
  const human: HumanData = { ...humanWithin, measurements: humanWithin.measurements.filter((m) => assigned.get(m.participantId!) === m.conditionId && study.outcomes.some((o) => o.id === m.outcomeId)) };
  const raw = (await json<AgentProtocol[]>("agents.json")).map((a) => ({ ...a, targets: a.targets?.filter((t) => study.outcomes.some((o) => o.id === t)), inputs: a.inputs?.filter((t) => study.outcomes.some((o) => o.id === t)) }));
  const between = validateAgents(study, raw.filter((a) => a.level !== "individual" && !a.inputs?.length));
  const cb = campaignFromPlan(freezePlan(study, withDefaultRuns(study, between, 2), 2), undefined, "fig4-between", new Date(Date.now() - 1000).toISOString());
  const rb = analyzeCampaign(cb, human, [syntheticCampaignExecution(cb).results]).report;
  assert.ok(rb.humanPairs!.some((p) => !p.used), "some mean differences are not scored");
  assert.ok(same(study, rb, between.map((a) => a.id)) > 0);
  // A measure without any scored pair is left out of the weights (the figure kept its weight: 1/3).
  const toy = {
    design: "within-subjects",
    conditions: [{ id: "A" }, { id: "B" }],
    participants: [{ id: "p1" }],
    outcomes: ["o1", "o2", "o3"].map((id, i) => ({ id, domain: "subjective", family: i < 2 ? "F1" : "F2", weight: 1, aggregation: "arithmetic", scale: "continuous" })),
    analysis: { tieTolerance: 1e-8, familyWeights: { F1: 1, F2: 1 } },
  } as unknown as Study;
  const row = (o: string, a: number, b: number) => [
    { outcomeId: o, conditionId: "A", value: a },
    { outcomeId: o, conditionId: "B", value: b },
  ];
  const humanValues = [...row("o1", 1, 2), ...row("o2", 3, 3), ...row("o3", 1, 2)].map((v) => ({ participantId: "p1", ...v }));
  const values = [...row("o1", 1, 2), ...row("o2", 5, 4), ...row("o3", 2, 1)].map((v) => ({ agentId: "x", level: "population" as const, unit: "run1", repetition: 1, ...v }));
  const toyFigure = populationVsIndividualFigure(toy, { values, humanValues } as unknown as AnalysisReport, ["x"], "subjective");
  assert.deepEqual(toyFigure.groups[0].values, [0.5]);
});

test("agent vs human figure: paired test for individual configs, one-sample test against the mean forecast for population runs", async () => {
  const { agentVsHumanFigure } = await import("../src/core/figures.js");
  const study = {
    design: "within-subjects",
    conditions: [{ id: "A", label: "A" }],
    outcomes: [{ id: "t", label: "Time", unit: "s", domain: "objective", scale: "continuous", aggregation: "geometric" }],
    analysis: { tieTolerance: 1e-8 },
  } as unknown as Study;
  const people = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const humans = [10, 12, 15, 20, 30, 41],
    perPerson = [11, 13, 14, 25, 33, 52],
    runs = [12, 18];
  const report = {
    humanValues: people.map((p, i) => ({ participantId: p, outcomeId: "t", conditionId: "A", value: humans[i] })),
    values: [
      ...runs.map((v, i) => ({ agentId: "pop", level: "population", unit: `run${i}`, repetition: 1, outcomeId: "t", conditionId: "A", value: v })),
      ...people.map((p, i) => ({ agentId: "ind", level: "individual", unit: p, participantId: p, repetition: 1, outcomeId: "t", conditionId: "A", value: perPerson[i] })),
    ],
  } as unknown as AnalysisReport;
  const fig = agentVsHumanFigure(study, report, ["pop", "ind"], "t");
  const [pop, ind] = fig.discrepancies;
  // R, exact permutation on the log scale (11/10 and 33/30 tie):
  // wilcox.test(log(h), mu = mean(log(c(12, 18)))) -> .4375; paired log(f) − log(h) -> .0625.
  assert.equal(pop.test, "One-sample Wilcoxon signed-rank vs mean forecast");
  assert.ok(Math.abs(pop.p! - 0.4375) < 1e-12 && pop.n === 6);
  assert.equal(ind.test, "Wilcoxon signed-rank, paired by participant");
  assert.ok(Math.abs(ind.p! - 0.0625) < 1e-12 && ind.n === 6);
  assert.deepEqual([pop.holm, ind.holm], [0.4375, 0.125]);
});

test("figures: a configuration that does not predict a measure gets no row and is not in the Holm family", async () => {
  const { agentVsHumanFigure, agreementFigure } = await import("../src/core/figures.js");
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "holm-family", new Date(Date.now() - 1000).toISOString());
  const { report } = analyzeCampaign(c, await json<HumanData>("human.json"), [syntheticCampaignExecution(c).results]);
  // text-with-task-data is given search time as an input and predicts subjective measures only.
  const both = agentVsHumanFigure(study, report, ["text-with-task-data", "text-only"], "search-time");
  const alone = agentVsHumanFigure(study, report, ["text-only"], "search-time");
  assert.ok(both.discrepancies.length > 0 && both.discrepancies.every((r) => r.agentId === "text-only"));
  assert.deepEqual(both.discrepancies.map((r) => r.holm), alone.discrepancies.map((r) => r.holm));
  assert.ok(both.designs.every((d) => d.groups.every((g) => g.id !== "text-with-task-data")));
  const objective = agreementFigure(report, ["text-with-task-data", "text-only", "uses-app"], "objective");
  assert.deepEqual(objective.groups.map((g) => g.id), ["text-only", "uses-app"]);
  assert.equal(objective.brackets.length, 1);
});

test("executor: token counts show live while a session runs", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-ue-"));
  await writeFakeEngine(bin);
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs"), runtimes: { unreal: { command: process.execPath, args: [join(bin, "bridge.cjs"), "{jobFile}"], capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"] } } }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  process.env.FAKE_SLEEP = "1500";
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!.filter((x) => x.id === "uses-app").map((x) => ({ ...x, repetitions: 1, runtime: "unreal" }));
    const c = campaignFromPlan(freezePlan(ws.study, agents, 1), undefined, "live-tokens", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("agent");
    let live: { in: number | null; out: number | null } | null = null;
    // Checked on every executor event, so the counts are seen while the session runs however slow the machine.
    await until(
      () => {
        const j = ex.snapshot().jobs[0];
        if (!live && j.status === "running" && j.tokensIn != null) live = { in: j.tokensIn, out: j.tokensOut };
        return !!live || ["done", "failed"].includes(j.status);
      },
      "live token counts",
      { executor: ex },
    );
    assert.deepEqual(live,{ in: 1000, out: 50 }, "input = uncached + cache writes + cache reads, while the session runs");
    await until(() => ex.snapshot().counts.done === 1 || !!ex.snapshot().counts.failed, "the session to end", { executor: ex });
    assert.equal(ex.snapshot().counts.done, 1, JSON.stringify(ex.snapshot().jobs.map((j) => j.error)));
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    delete process.env.FAKE_SLEEP;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});

test("participant-specific knowledge: complete for everyone, or the configurations that get it are blocked", async () => {
  const { missingSources, readWorkspace } = await import("../src/workspace.js");
  const { participantKnowledgeOverview } = await import("../src/sources.js");
  const { backgroundText, participantProblems } = await import("../src/participant-knowledge.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  try {
    const ws = await readWorkspace(a.id);
    const src = ws.study.sources.find((x) => x.kind === "demographics")!;
    const path = join(a.dir, ws.manifest.sources![src.id]);
    assert.deepEqual(missingSources(a.dir, ws.study, ws.manifest, [src.id]), [], "the example is complete");
    const overview = (await participantKnowledgeOverview(a.id, ws.agents ?? [])).find((x) => x.id === src.id)!;
    assert.deepEqual(overview.problems, []);
    // Population configurations get the cohort summary, individual ones the person's own entry.
    assert.match(overview.population!, /^age_band: .*\(n=18\)/m);
    assert.match(overview.individual!.text, /^age_band: /m);
    // One person missing, one empty value: incomplete, and configurations that get it are blocked.
    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const head = lines[0].split(","), first = lines[1].split(",");
    first[head.indexOf("xr_experience")] = " ";
    await writeFile(path, [lines[0], first.join(","), ...lines.slice(3)].join("\n") + "\n");
    const problems = participantProblems(ws.study, "demographics", path, src.fields ?? []);
    assert.ok(problems.some((p) => /^has no entry for /.test(p)), JSON.stringify(problems));
    assert.ok(problems.some((p) => /^has an empty xr_experience for /.test(p)), JSON.stringify(problems));
    const blocked = missingSources(a.dir, ws.study, ws.manifest, [src.id]);
    assert.match(blocked[0].message, /has no entry for .*exactly one complete entry per participant/);
    // "none" is an answer, not a missing value.
    assert.equal(backgroundText("participant,xr\np1,none\np2,some\n", ["xr"], "p1"), "xr: none");
  } finally {
    await removeDir(a.dir);
  }
});

test("rerun selected configurations: a new campaign with fresh sessions for them, all others reused", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readReceipts, readCampaign } = await import("../src/workspace.js");
  const { continueFromStatus } = await import("../src/core/campaign.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, ws.agents!, 1), 1), undefined, "rerun-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("simulate");
    await until(() => ex.snapshot().counts.done === ex.jobs.size, "every session to finish", { executor: ex });
    assert.equal(ex.snapshot().counts.done, ex.jobs.size);
    // What the executor's "Rerun the checked configurations" sends to workspace/continue.
    const next = continueFromStatus(c, await readReceipts(a.id, [c.id]), { rerunConditions: ["text-only"], note: "Rerun of Text only" });
    const llm = next.jobs.filter((j) => j.kind === "llm");
    assert.ok(llm.filter((j) => j.conditionId === "text-only").every((j) => !j.inheritedFrom), "fresh sessions for the rerun configuration");
    assert.ok(llm.filter((j) => j.conditionId !== "text-only").every((j) => j.inheritedFrom), "finished runs of the others are reused");
    assert.equal(next.parentDigest, c.digest);
    // The original campaign stays as it was.
    assert.equal((await readCampaign(a.id, c.id)).digest, c.digest);
  } finally {
    await removeDir(a.dir);
  }
});

// ---------- found by the exploratory test round (Nov 2026) ----------
test("create study: the placeholder is valid, and a refused name creates nothing", async () => {
  const { createStudy, readWorkspace } = await import("../src/workspace.js");
  const name = `zz-test-create-${Date.now().toString(36)}`;
  const r = await createStudy(`  ${name.toUpperCase()}  `);
  const dir = resolve("private/studies", name);
  try {
    assert.equal(r.id, `private/studies/${name}`);
    const ws = await readWorkspace(r.id);
    assert.equal(ws.study.id, name);
    await assert.rejects(createStudy(name), /already exists/);
    await assert.rejects(createStudy("!"), /Give the study folder a name/);
    assert.equal(existsSync(resolve("private/studies", "-")), false);
  } finally {
    await removeDir(dir);
  }
});

test("understand study: the assistant's words are normalised and a new study's placeholder is replaced", async () => {
  const { understandStudy } = await import("../src/assistant.js");
  const { extractProposal } = await import("../src/core/proposal.js");
  const { createStudy, readWorkspace } = await import("../src/workspace.js");
  const text = "Material cues in VR\nTwo designs: matte and glossy. Within-subjects.\n";
  const doc = await extractProposal("doc.md", Buffer.from(text));
  const empty = { value: "", quote: "" };
  const draft = {
    facts: { title: { value: "Material cues in VR", quote: "Material cues in VR" }, researchQuestion: empty, design: empty, participantCount: empty, conditions: empty, task: empty, objectiveOutcomes: empty, subjectiveOutcomes: empty },
    study: {
      title: "Material cues in VR",
      design: "within-subjects",
      conditions: [{ id: "matte", label: "Matte" }, { id: "glossy", label: "Glossy" }],
      outcomes: [
        { id: "Task Time (s)", label: "Task time", domain: "Objective", scale: "continuous (seconds)", aggregation: "geometric (times)", family: "time", phaseIds: ["main"] },
        { id: "", label: "Realism", domain: "subjective rating", scale: "ordinal 1-7", aggregation: "", components: [1, 2] },
      ],
    },
    questions: ["Which headset?"],
  };
  const bin = await mkdtemp(join(tmpdir(), "fake-assistant-"));
  await writeFile(join(bin, "claude.cjs"), `console.log(JSON.stringify({ result: ${JSON.stringify(JSON.stringify(draft))} }));`);
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  const name = `zz-test-understand-${Date.now().toString(36)}`;
  try {
    const { id } = await createStudy(name);
    const placeholder = (await readWorkspace(id)).study;
    const csv = "participant,order\nq1,matte glossy\nq2,glossy matte\n";
    const r = await understandStudy(doc, csv, placeholder);
    assert.equal(r.valid, true, r.questions.join(" | "));
    assert.equal(r.study.id, name, "the folder's study ID is kept");
    assert.deepEqual(r.study.conditions.map((c) => c.id), ["matte", "glossy"], "the placeholder designs are not kept");
    const [time, realism] = r.study.outcomes;
    assert.deepEqual([time.id, time.domain, time.scale, time.aggregation], ["task-time-s", "objective", "continuous", "geometric"]);
    assert.deepEqual([realism.id, realism.domain, realism.scale, realism.aggregation, realism.components], ["measure-2", "subjective", "ordinal", "arithmetic", ["1", "2"]]);
    assert.ok(r.study.cases.every((c) => c.requiredActions.includes("complete-task")));
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(resolve("private/studies", name));
    await removeDir(bin);
  }
});

test("runs zip: refused for another study or a non-zip, and a refused zip writes nothing", async () => {
  const { exportRuns, importRuns } = await import("../src/executor/archive.js");
  const { readWorkspace, saveCampaign, listCampaigns } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const b = await tempWorkspace(resolve("examples/graphics-quality"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "zip-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const zip = await exportRuns(a.id, c.id);
    await assert.rejects(importRuns(b.id, zip), /belong to study "synthetic-selection", but this study's ID is "toy-graphics-quality"/);
    assert.equal(existsSync(join(b.dir, "campaigns", c.id)), false, "nothing written");
    assert.equal((await listCampaigns(b.id)).length, 0);
    await assert.rejects(importRuns(b.id, Buffer.from("not a zip")), /This file is not a zip/);
  } finally {
    await removeDir(a.dir);
    await removeDir(b.dir);
  }
});

test("campaign delete: moves the campaign and its runs to deleted/, never one another campaign continues from", async () => {
  const { readWorkspace, saveCampaign, listCampaigns, runDir } = await import("../src/workspace.js");
  const { deleteCampaign, writeLabel, readLabels } = await import("../src/history.js");
  const { continueCampaign } = await import("../src/core/campaign.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const parent = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "del-parent", new Date(Date.now() - 2000).toISOString());
    await saveCampaign(a.id, parent);
    const child = continueCampaign(parent, { rerunConditions: [ws.agents![0].id] });
    await saveCampaign(a.id, child);
    await mkdir(join(runDir(a.id, child.id), "results"), { recursive: true });
    await writeLabel(a.id, child.id, "to delete");
    await assert.rejects(deleteCampaign(a.id, parent.id), /continue from this one/);
    const r = await deleteCampaign(a.id, child.id);
    assert.match(r.movedTo, /^deleted\/\d{8}-\d{6}-campaign-/);
    assert.ok(existsSync(join(a.dir, r.movedTo, "campaign", "campaign.json")));
    assert.ok(existsSync(join(a.dir, r.movedTo, "runs", "results")));
    assert.deepEqual((await listCampaigns(a.id)).map((c) => c.id), [parent.id]);
    assert.equal((await readLabels(a.id))[child.id], undefined);
    // With its child gone, the parent can be deleted too.
    await deleteCampaign(a.id, parent.id);
    assert.equal((await listCampaigns(a.id)).length, 0);
    await assert.rejects(deleteCampaign(a.id, parent.id), /This campaign was already deleted/);
    await assert.rejects(deleteCampaign(a.id, "campaign-never-made"), /Unknown campaign/);
  } finally {
    await removeDir(a.dir);
  }
});

test("human data and designs: removed measures are skipped; renamed designs, missing people and wrong orders are named", async () => {
  const study = validateStudy(await json("study.json"));
  const human = await json<HumanData>("human.json");
  const fewer = structuredClone(study);
  fewer.outcomes = fewer.outcomes.filter((o) => o.id !== "preference");
  assert.doesNotThrow(() => validateHumanData(fewer, human));
  const renamed = structuredClone(study);
  const old = renamed.conditions[0].id;
  renamed.conditions[0].id = "renamed";
  renamed.participants.forEach((p) => (p.conditionOrder = p.conditionOrder.map((x) => (x === old ? "renamed" : x))));
  assert.throws(() => validateHumanData(renamed, human), new RegExp(`design "${old}", which this study does not have.*renamed`));
  const fewerPeople = structuredClone(study);
  const gone = fewerPeople.participants.pop()!.id;
  assert.throws(() => validateHumanData(fewerPeople, human), new RegExp(`participant "${gone}", who is not in this study`));
  const between = structuredClone(study);
  between.design = "between-subjects";
  assert.throws(() => validateStudy(between), /In a between-subjects study each person experiences one design, but \S+ has 3/);
  const twice = structuredClone(study);
  twice.participants[0].conditionOrder = [old, old, twice.conditions[2].id];
  assert.throws(() => validateStudy(twice), /must list known designs .* each at most once/);
});

test("two eyes: simulated stereo sessions pass the audit; the built-in WebXR runtime refuses them with a way out", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), JSON.stringify({ chromePath: process.execPath }));
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  try {
    const ws = await readWorkspace(a.id);
    const study = structuredClone(ws.study);
    study.runtime.observation = "stereo-pair";
    const agents = ws.agents!.filter((x) => x.id === "uses-app" || x.id === "text-only").map((x) => ({ ...x, repetitions: 2, observation: x.tools.includes("xr-interact") ? ("stereo-pair" as const) : x.observation }));
    const plan = freezePlan(validateStudy(study), validateAgents(study, agents), 1);
    const c = campaignFromPlan(plan, undefined, "stereo-test", new Date(Date.now() - 1000).toISOString());
    const run = syntheticCampaignExecution(c);
    const result = analyzeCampaign(c, await json<HumanData>("human.json"), [run.results]);
    assert.deepEqual(result.report.audits.filter((x) => !x.compliant).map((x) => x.issues), [], "simulated stereo sessions are compliant");
    assert.ok(result.report.audits.length > 0);
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const blocked = await ex.blockers([...ex.jobs.keys()]);
    assert.equal(blocked.length, 1);
    assert.deepEqual(blocked[0].configs, [agents.find((x) => x.id === "uses-app")!.label]);
    assert.match(blocked[0].message, /mono screenshots only.*Single image \(mono\).*or simulate/);
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(cfg);
  }
});

// ---------- found by the second test round (T2, Nov 2026) ----------
test("audit: a token-budget overrun is one deviation among the others; only tokens up to the forecast count", async () => {
  const { auditRun } = await import("../src/core/protocol.js");
  const { campaignPlan } = await import("../src/core/campaign.js");
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json")).map((a) => (a.id === "uses-app" ? { ...a, maxTokens: 60_000 } : a));
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "audit-all", new Date(Date.now() - 1000).toISOString());
  const plan = campaignPlan(c);
  const run = syntheticCampaignExecution(c).results.runs.find((r) => c.jobs.find((j) => j.id === r.jobId)!.conditionId === "uses-app")!;
  const job = plan.jobs.find((j) => j.id === run.jobId)!;
  Object.assign(run.execution, { synthetic: false, inputTokens: 20_000, cacheReadTokens: 70_000, cacheWriteTokens: 0, outputTokens: 7_712 });
  // The session took no screenshots: that must be reported next to the budget, not hidden by it.
  run.trace = run.trace.filter((e) => e.type !== "observation");
  const over = auditRun(plan, job, run);
  assert.ok(over.issues.includes("Token budget exceeded: 97712 of 60000 tokens."), JSON.stringify(over.issues));
  const required = plan.study.cases.filter((x) => plan.agents.find((a) => a.id === "uses-app")!.requiredCaseIds.includes(x.id));
  for (const x of required) assert.ok(over.issues.includes(`No valid observation for required case ${x.id}.`), x.id);
  assert.equal(over.scoreable, true, "deviations do not drop a usable forecast");
  assert.equal(over.compliant, false);
  // With the tokens counted when the forecast was accepted, the closing turn does not count …
  const within = structuredClone(run);
  Object.assign(within.execution, { tokensAtSubmit: 55_000 });
  const ok = auditRun(plan, job, within);
  assert.ok(!ok.issues.some((i) => /Token budget/.test(i)), JSON.stringify(ok.issues));
  assert.ok(ok.issues.some((i) => /No valid observation/.test(i)));
  // … and an overrun before the forecast names the closing turn separately.
  Object.assign(within.execution, { tokensAtSubmit: 72_000 });
  assert.ok(
    auditRun(plan, job, within).issues.includes(
      "Token budget exceeded: 72000 of 60000 tokens before the forecast was accepted (the closing turn after it used 25712 more, which the budget does not count).",
    ),
  );
  // A run without an execution record is listed, not thrown.
  const bare = structuredClone(run) as unknown as Record<string, unknown>;
  delete bare.execution;
  const missing = auditRun(plan, job, bare as never);
  assert.equal(missing.scoreable, false);
  assert.ok(missing.issues.some((i) => /Missing execution record/.test(i)));
  assert.ok(missing.issues.some((i) => /No valid observation/.test(i)));
});

/**
 * Writes what the executor leaves behind for some jobs of a saved campaign: results, receipts and
 * execution manifests. "real" and "simulated" sessions finished; "failed" ones have only a receipt.
 */
async function writeRuns(wsId: string, c: import("../src/core/campaign.js").Campaign, jobs: Record<string, { kind: "real" | "simulated" | "failed"; costUsd?: number }>) {
  const { runDir } = await import("../src/workspace.js");
  const dir = runDir(wsId, c.id);
  const made = syntheticCampaignExecution(c);
  await mkdir(join(dir, "results"), { recursive: true });
  const lines: string[] = [];
  for (const [jobId, { kind, costUsd }] of Object.entries(jobs)) {
    const run = structuredClone(made.results.runs.find((r) => r.jobId === jobId)!);
    const receipt = structuredClone(made.receipts.find((r) => r.jobId === jobId)!);
    if (kind === "failed") {
      lines.push(JSON.stringify({ ...receipt, status: "failed", output: null, error: "Session ended: error." }));
      continue;
    }
    run.execution.synthetic = kind === "simulated";
    await writeFile(join(dir, "results", `${jobId}.json`), JSON.stringify(run));
    const manifest = `jobs/${jobId}/a1/execution-manifest.json`;
    await mkdir(join(dir, "jobs", jobId, "a1"), { recursive: true });
    await writeFile(join(dir, manifest), JSON.stringify({ costUsd: costUsd ?? null }));
    lines.push(JSON.stringify({ ...receipt, executionManifest: { path: manifest, sha256: "0".repeat(64) } }));
  }
  await writeFile(join(dir, "receipts.jsonl"), lines.join("\n") + "\n");
}
const post = async (path: string, body: Record<string, unknown>) => {
  const { handlePost } = await import("../src/routes.js");
  let out: any;
  assert.ok(await handlePost(path, body, (v) => (out = v)), path);
  return out;
};

test("continue (website): only sessions with an accepted forecast are reused; simulated ones run again unless kept", async () => {
  const { readWorkspace, saveCampaign, readCampaign, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, ws.agents!, 1), 1), undefined, "cont-web", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const text = c.jobs.filter((j) => j.conditionId === "text-only");
    const project = c.jobs.filter((j) => j.conditionId === "reads-project");
    // text-only: r1 real, r2 simulated, r3 failed; reads-project r1 stopped (a folder, no receipt); the rest never started.
    await writeRuns(a.id, c, { [text[0].id]: { kind: "real" }, [text[1].id]: { kind: "simulated" }, [text[2].id]: { kind: "failed" } });
    await mkdir(join(runDir(a.id, c.id), "jobs", project[0].id, "a1"), { recursive: true });
    const changes = { repetitions: { "text-only": 4 } };
    const reusedFrom = (next: { jobs: { inheritedFrom?: { jobId: string } }[] }) => next.jobs.flatMap((j) => (j.inheritedFrom ? [j.inheritedFrom.jobId] : [])).sort();
    // Called as T2 did, without useReceipts: still only the accepted real forecast is reused.
    const preview = await post("/api/workspace/continue", { id: a.id, campaignId: c.id, changes, preview: true });
    assert.deepEqual(reusedFrom(preview.campaign), [text[0].id]);
    assert.deepEqual(preview.simulated.byCondition["text-only"], { reused: 0, runAgain: 1 });
    assert.equal(preview.keepSimulated, false);
    // "Keep simulated runs": the simulated one is reused too, and the preview says so.
    const kept = await post("/api/workspace/continue", { id: a.id, campaignId: c.id, changes, keepSimulated: true, preview: true });
    assert.deepEqual(reusedFrom(kept.campaign), [text[0].id, text[1].id].sort());
    assert.deepEqual(kept.simulated.byCondition["text-only"], { reused: 1, runAgain: 0 });
    assert.equal(kept.simulated.reused, 1);
    // Created: the new campaign runs the failed, stopped, never-started and simulated sessions.
    const made = await post("/api/workspace/continue", { id: a.id, campaignId: c.id, changes });
    assert.equal(made.reused, 1);
    assert.equal(made.reusedSimulated, 0);
    const child = await readCampaign(a.id, made.campaignId);
    const fresh = new Set(child.jobs.filter((j) => !j.inheritedFrom).map((j) => j.templateJobId));
    for (const j of [text[1], text[2], project[0]]) assert.ok(fresh.has(j.templateJobId), j.id);
    // Continuing again from the child still reuses that one run, from the campaign that made it.
    const again = await post("/api/workspace/continue", { id: a.id, campaignId: child.id, changes: { repetitions: { "text-only": 5 } }, preview: true });
    assert.deepEqual(reusedFrom(again.campaign), [text[0].id]);
  } finally {
    await removeDir(a.dir);
  }
});

test("compare agents: cost, tool calls and minutes include the runs a continuation reuses", async () => {
  const { readWorkspace, saveCampaign, readCampaign } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, ws.agents!, 1), 1), undefined, "cost-web", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const text = c.jobs.filter((j) => j.conditionId === "text-only");
    await writeRuns(a.id, c, { [text[0].id]: { kind: "real", costUsd: 0.04 }, [text[1].id]: { kind: "real", costUsd: 0.0449 } });
    const made = await post("/api/workspace/continue", { id: a.id, campaignId: c.id, changes: { repetitions: { "text-only": 4 } } });
    const child = await readCampaign(a.id, made.campaignId);
    const own = child.jobs.find((j) => j.conditionId === "text-only" && j.repetition === 4)!;
    await writeRuns(a.id, child, { [own.id]: { kind: "real", costUsd: 0.0308 } });
    const cmp = await post("/api/workspace/compare-agents", { id: a.id, campaignId: child.id });
    const row = cmp.configs.find((x: { id: string }) => x.id === "text-only");
    assert.equal(row.real, 3);
    assert.ok(Math.abs(row.totalCostUsd - (0.04 + 0.0449 + 0.0308)) < 1e-9, String(row.totalCostUsd));
    assert.ok(Math.abs(row.meanCostUsd - (0.04 + 0.0449 + 0.0308) / 3) < 1e-9);
    assert.notEqual(row.meanToolCalls, null);
    assert.notEqual(row.meanWallMinutes, null);
    assert.match(row.model, /^claude-/);
  } finally {
    await removeDir(a.dir);
  }
});

test("example data files use LF line endings, so a copied package and a clone hash them alike", async () => {
  const { readdir } = await import("node:fs/promises");
  // Folders the workbench writes when trying an example (not committed) and vendored code.
  const skip = new Set(["campaigns", "runs", "deleted", "node_modules", "vendor", "Library", "Temp"]);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true }))
      if (e.isDirectory()) {
        if (!skip.has(e.name)) await walk(join(dir, e.name));
      } else if (/\.(csv|json)$/i.test(e.name)) files.push(join(dir, e.name));
  };
  await walk(resolve("examples"));
  assert.ok(files.length >= 30, `found only ${files.length} example CSV/JSON files`);
  const withCr: string[] = [];
  for (const f of files) if ((await readFile(f)).includes(13)) withCr.push(f);
  assert.deepEqual(withCr, [], "these example files contain carriage returns (CRLF); write them with LF");
  // The generators and converters write LF and UTF-8 on every platform.
  for (const name of ["ecolar", "graphics-quality", "selection"]) {
    const generator = await readFile(resolve("examples", name, "data/generate_synthetic.py"), "utf8");
    assert.match(generator, /lineterminator="\\n"/, `${name}: generate_synthetic.py`);
    const converter = await readFile(resolve("examples", name, "data/convert_to_human.py"), "utf8");
    const opens = converter.split("\n").filter((line) => /\bopen\(/.test(line));
    assert.ok(opens.length >= 2, `${name}: convert_to_human.py opens no files?`);
    for (const line of opens) assert.match(line, /encoding="utf-8"/, `${name}: ${line.trim()}`);
  }
});

test("figures: simulated configurations are marked and never tested against real ones or the human data", async () => {
  const figures = await import("../src/core/figures.js");
  const { agentVsHumanFigure, agreementFigure, correlationFigure, populationVsIndividualFigure, simulatedConfigs, trajectoryFigure } = figures;
  const { agreementPlot, agentVsHumanPlot, correlationPlot } = await import("../src/web/plots.js");
  const study = validateStudy(await json("study.json"));
  const agents = validateAgents(study, await json<AgentProtocol[]>("agents.json"));
  const human = await json<HumanData>("human.json");
  const c = campaignFromPlan(freezePlan(study, withDefaultRuns(study, agents, 1), 1), undefined, "sim-marks", new Date(Date.now() - 1000).toISOString());
  const config = new Map(c.jobs.map((j) => [j.id, j.conditionId]));
  // Every configuration ran with real agents except uses-app and reads-evidence (simulated only).
  const simulatedIds = new Set(["uses-app", "reads-evidence"]);
  const results = syntheticCampaignExecution(c).results;
  for (const r of results.runs) r.execution.synthetic = simulatedIds.has(config.get(r.jobId)!);
  // The simulated app configuration's invented app actions are marked unchecked; it counts as simulated.
  assert.ok(results.runs.some((r) => config.get(r.jobId) === "uses-app" && r.trace.some((e) => e.type === "action" && e.checked === false)));
  const comparisons: Comparison[] = [
    { candidate: "uses-app", baseline: "text-only", domain: "subjective" },
    { candidate: "reads-project", baseline: "text-only", domain: "subjective" },
  ];
  const { report } = analyzeCampaign(c, human, [results], comparisons);
  assert.deepEqual([...simulatedConfigs(report)].sort(), ["reads-evidence", "uses-app"]);
  const labels = Object.fromEntries(c.suite.conditions.map((x) => [x.id, x.label]));
  const ids = ["text-only", "reads-project", "uses-app", "reads-evidence"];

  // Agreement: labels and flags; brackets only within one kind, each kind its own Holm family.
  const fig = agreementFigure(report, ids, "subjective", labels);
  for (const g of fig.groups) {
    assert.equal(!!g.simulated, simulatedIds.has(g.id), g.id);
    assert.equal(g.label.endsWith("(simulated)"), simulatedIds.has(g.id), g.label);
  }
  assert.ok(fig.brackets.length === 2, JSON.stringify(fig.brackets));
  for (const b of fig.brackets) {
    assert.equal(simulatedIds.has(b.a), simulatedIds.has(b.b), `${b.a} vs ${b.b} mixes real and simulated`);
    assert.equal(!!b.simulated, simulatedIds.has(b.a));
  }
  const realOnly = agreementFigure(report, ["text-only", "reads-project"], "subjective", labels);
  assert.deepEqual(fig.brackets.filter((b) => !b.simulated).map((b) => b.holm), realOnly.brackets.map((b) => b.holm));
  assert.deepEqual(fig.groups.filter((g) => !g.simulated).map((g) => g.vsChance), realOnly.groups.map((g) => g.vsChance));
  assert.ok(fig.groups.filter((g) => g.simulated).every((g) => g.vsChance?.p === null));
  assert.match(fig.note, /\(simulated\)/);
  assert.doesNotMatch(realOnly.note, /simulated/);
  const svg = agreementPlot(fig, "t", ids);
  assert.match(svg, /stroke-dasharray="4 3"/);
  assert.match(svg, /invented forecasts that only test/);
  assert.equal(svg.match(/>\(simulated\)</g)?.length, 2, "both simulated labels keep their (simulated) line, also a long one");
  assert.doesNotMatch(agreementPlot(realOnly, "t", ids), /stroke-dasharray="4 3"|invented/);
  // A configuration without runs shows "no data" and no mean above it (not "0.0").
  const empty = { ...realOnly, groups: [...realOnly.groups, { ...realOnly.groups[0], id: "none-ran", label: "None ran", values: [], units: [], stats: { ...realOnly.groups[0].stats, n: 0, mean: 0 } }] };
  const emptySvg = agreementPlot(empty, "t", [...ids, "none-ran"]);
  assert.match(emptySvg, /no data/);
  assert.equal(emptySvg.match(/>0\.0</g), null, emptySvg.match(/>[\d.]+</g)?.join(" "));

  // Agent vs human: simulated configurations are described, not tested, and outside the Holm family.
  const vs = agentVsHumanFigure(study, report, ids, "search-time", labels);
  const vsReal = agentVsHumanFigure(study, report, ["text-only", "reads-project"], "search-time", labels);
  const simRows = vs.discrepancies.filter((r) => simulatedIds.has(r.agentId));
  assert.ok(simRows.length > 0 && simRows.every((r) => r.simulated && r.p === null && r.holm === null && r.test.startsWith("Not tested")));
  assert.ok(simRows.every((r) => Number.isFinite(r.discrepancy)));
  assert.deepEqual(vs.discrepancies.filter((r) => !r.simulated).map((r) => r.holm), vsReal.discrepancies.map((r) => r.holm));
  assert.ok(vs.designs.every((d) => d.groups.filter((g) => simulatedIds.has(g.id)).every((g) => g.simulated && g.label.endsWith("(simulated)"))));
  assert.match(agentVsHumanPlot(vs, "t", ids), /invented forecasts/);

  // Population vs individual and correlation: the same marking and bracket rule.
  const pvi = populationVsIndividualFigure(study, report, ids, "subjective", labels);
  assert.ok(pvi.brackets.every((b) => simulatedIds.has(b.a) === simulatedIds.has(b.b)));
  const cor = correlationFigure(study, report, ids, labels);
  assert.deepEqual(cor.series.filter((s) => s.label.endsWith("(simulated)")).map((s) => s.id).sort(), ["reads-evidence", "uses-app"]);
  assert.match(correlationPlot(cor, "t", ids), /invented forecasts/);

  // Planned comparisons: simulated against real is shown, not tested.
  const mixed = report.contrasts.find((x) => x.candidate === "uses-app")!;
  assert.equal(mixed.p, null);
  assert.match(mixed.status, /Not tested: compares simulated/);
  assert.notEqual(report.contrasts.find((x) => x.candidate === "reads-project")!.status, mixed.status);

  // An earlier report without the list: the summaries' run counts give the same answer.
  const older = { ...report, simulatedConfigs: undefined };
  assert.deepEqual([...simulatedConfigs(older)].sort(), ["reads-evidence", "uses-app"]);

  // Participant lines with population configurations only say why there is nothing to draw.
  const lines = trajectoryFigure(report, ["text-only", "reads-project"], "subjective", labels);
  assert.equal((lines as { empty?: boolean }).empty, true);
  assert.match(lines.note, /needs? an individual-level configuration/);
  const mixedLines = trajectoryFigure(report, ["text-only", "knows-participant"], "subjective", labels);
  assert.deepEqual(mixedLines.configs.map((x) => x.id), ["knows-participant"]);
  assert.match(mixedLines.note, /Left out \(population-level/);
});

test("submit_forecast refuses values outside a declared range and negative counts", async () => {
  const { spawn } = await import("node:child_process");
  const { createInterface } = await import("node:readline");
  const dir = await mkdtemp(join(tmpdir(), "xr-range-"));
  try {
    const targets = [
      { id: "comfort", label: "Comfort", unit: "1–7", scale: "ordinal", aggregation: "arithmetic", range: [1, 7] },
      { id: "collisions", label: "Collisions", unit: "collisions", scale: "count", aggregation: "arithmetic" },
      { id: "ssq", label: "SSQ", unit: "0–235.62", scale: "continuous", aggregation: "arithmetic", range: [0, 235.62], components: ["n", "o", "d"], componentRule: "sum", componentWeights: { n: 3.74, o: 3.74, d: 3.74 } },
    ];
    await writeFile(join(dir, "job.json"), JSON.stringify({ jobId: "r", budget: 50, projectDir: null, participantId: null, designs: [{ id: "a", label: "A" }], targets }));
    const child = spawn(process.execPath, [resolve("dist/runtimes/study-mcp.js"), dir], { stdio: ["pipe", "pipe", "ignore"] });
    const waiting = new Map<number, (m: any) => void>();
    createInterface({ input: child.stdout! }).on("line", (l) => {
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    });
    let seq = 0;
    const rpc = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<any>((ok) => {
        const id = ++seq;
        waiting.set(id, ok);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    await rpc("initialize");
    const submit = (comfort: number, collisions: number, items: Record<string, number>) =>
      rpc("tools/call", { name: "submit_forecast", arguments: { predictions: [{ design: "a", outcome: "comfort", value: comfort }, { design: "a", outcome: "collisions", value: collisions }, { design: "a", outcome: "ssq", items }] } });
    // One rejection lists every problem, grouped by measure, each with what the measure needs.
    const tools = await rpc("tools/list");
    const description = tools.result.tools.find((t: { name: string }) => t.name === "submit_forecast").description;
    assert.match(description, /comfort: give "value" on 1–7/);
    assert.match(description, /collisions: give "value", a count of 0 or more/);
    assert.match(description, /ssq: give "items" n, o, d .*the weighted sum of the items is the score, on 0–235\.62/);
    const refused = (await submit(8, -1, { n: 30, o: 20, d: 20 })).result.content[0].text;
    assert.match(refused, /comfort needs "value" on 1–7 .* for every design: out of range for a\./);
    assert.match(refused, /collisions needs "value", a count of 0 or more .* for every design: out of range for a\./);
    assert.match(refused, /ssq needs "items" n, o, d .* for every design: out of range for a \(the items give 261\.8\)\./);
    const accepted = (await submit(7, 1.5, { n: 2, o: 3, d: 1 })).result.content[0].text;
    assert.match(accepted, /Forecast accepted/);
    child.stdin!.end();
    await new Promise((ok) => child.on("exit", ok));
  } finally {
    await removeDir(dir);
  }
});

test("reused sessions: simulated ones say so; ones an early continuation reused without a result never ran and are not finished; added models are listed for Continue", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { continueCampaign } = await import("../src/core/campaign.js");
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const { campaignSummaries } = await import("../src/history.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, ws.agents!, 1), 1), undefined, "reuse-kinds", new Date(Date.now() - 2000).toISOString());
    await saveCampaign(a.id, c);
    const llm = c.jobs.filter((j) => j.kind === "llm");
    const text = llm.filter((j) => j.conditionId === "text-only");
    // Every session was simulated except text-only r2 and r3 (never ran); text-only r1 ran for real.
    const runs: Record<string, { kind: "real" | "simulated" }> = Object.fromEntries(llm.filter((j) => j.id !== text[1].id && j.id !== text[2].id).map((j) => [j.id, { kind: "simulated" as const }]));
    runs[text[0].id] = { kind: "real" };
    await writeRuns(a.id, c, runs);
    // A continuation as made before reuse needed an accepted forecast: every unchanged session is
    // marked reused, also the two that never ran. It also adds a model copy of text-only.
    const early = continueCampaign(c, { cloneConditions: [{ from: "text-only", id: "text-only-fable", model: { provider: "claude-code", model: "fable-5", reasoning: "default" } }] }, undefined, new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, early);
    const ex = await Executor.open(a.id, early.id);
    const row = (from: { templateJobId: string }) => [...ex.jobs.values()].find((j) => j.status === "reused" && early.jobs.find((x) => x.id === j.jobId)!.templateJobId === from.templateJobId)!;
    assert.deepEqual([row(text[0]).simulated, !!row(text[0]).noResult], [false, false], "the reused real run");
    const sim = llm.find((j) => j.conditionId !== "text-only")!;
    assert.deepEqual([row(sim).simulated, !!row(sim).noResult], [true, false], "a reused simulated run shows it is simulated");
    // Also a simulated app session (its invented app actions are marked checked: false).
    const app = llm.find((j) => j.conditionId === "uses-app")!;
    assert.deepEqual([row(app).simulated, !!row(app).noResult], [true, false], "a reused simulated app run shows it is simulated");
    for (const never of [text[1], text[2]]) {
      assert.equal(row(never).noResult, true);
      assert.match(row(never).warning!, /never ran/);
    }
    // Analysis progress counts only sessions with an accepted result.
    const analysed = await post("/api/workspace/analyze", { id: a.id, campaignId: early.id });
    const sessions = early.jobs.filter((j) => j.kind === "llm").length;
    const copies = early.jobs.filter((j) => j.conditionId === "text-only-fable").length;
    assert.equal(analysed.progress.sessions, sessions);
    assert.equal(analysed.progress.finished, llm.length - 2);
    assert.equal(analysed.progress.reusedNeverRan, 2);
    assert.equal(analysed.progress.notStarted, copies + 2);
    const neverIds = early.jobs.filter((j) => j.inheritedFrom && [text[1], text[2]].some((t) => t.templateJobId === j.templateJobId)).map((j) => j.id);
    assert.equal(neverIds.length, 2);
    assert.ok(analysed.audits.every((x: { jobId: string }) => !neverIds.includes(x.jobId)), "never-ran sessions are not listed as lost runs");
    // Continue / rerun lists the campaign's configurations, the added model copy included.
    const summary = (await campaignSummaries(a.id)).find((x) => x.id === early.id)!;
    const copy = summary.configs.find((x) => x.id === "text-only-fable")!;
    const original = summary.configs.find((x) => x.id === "text-only")!;
    assert.ok(copy, JSON.stringify(summary.configs));
    assert.notEqual(copy.label, original.label);
    assert.deepEqual([copy.individual, copy.runs], [original.individual, original.runs]);
    assert.equal(original.runs, text.length);
    assert.ok(!ws.agents!.some((x) => x.id === "text-only-fable"), "the copy is not in agents.json");
    assert.ok(summary.configs.find((x) => x.id === "knows-participant")!.individual);
  } finally {
    await removeDir(a.dir);
  }
});
