// What a new researcher runs into on the website (exploratory test round T3, Nov 2026): the study
// brief, simulating a research study, campaign progress, reused runs' cost, a frozen campaign's
// inputs, and the assistant's instructions. Studies are throw-away folders under private/studies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freezePlan, proposeAgents, withDefaultRuns } from "../src/core/planner.js";
import { campaignFromPlan, continueFromStatus } from "../src/core/campaign.js";
import type { Study } from "../src/core/types.js";
import { until } from "./until.js";

async function tempWorkspace(from: string, edit?: (study: Study) => void) {
  const name = `__test-flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = existsSync(join(from, "workspace.json")) ? JSON.parse(await readFile(join(from, "workspace.json"), "utf8")) : {};
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  if (edit) {
    const study = JSON.parse(await readFile(join(dir, "study.json"), "utf8")) as Study;
    edit(study);
    await writeFile(join(dir, "study.json"), JSON.stringify(study, null, 2));
    // human.json says whether it is invented, like the study.
    if (existsSync(join(dir, "human.json"))) {
      const human = JSON.parse(await readFile(join(dir, "human.json"), "utf8"));
      await writeFile(join(dir, "human.json"), JSON.stringify({ ...human, synthetic: study.synthetic }));
    }
  }
  return { id: `private/studies/${name}`, dir };
}
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
const research = (s: Study) => {
  s.synthetic = false;
};

test("simulated values lie on each measure's range; research studies can be simulated, never as real runs", async () => {
  const { exampleStudy, measureRange, simulatedResults, syntheticResults, typicalRange } = await import("../src/core/example.js");
  const { validateStudy } = await import("../src/core/validation.js");
  const o = (unit: string, scale: Study["outcomes"][number]["scale"] = "ordinal") => ({ id: "m", label: "M", domain: "subjective" as const, unit, scale, aggregation: "arithmetic" as const, family: "m", weight: 1, phaseIds: ["main"], description: "" });
  assert.deepEqual(measureRange(o("0-100")), [0, 100]);
  assert.deepEqual(measureRange(o("NASA-TLX score (0–100)")), [0, 100]);
  assert.deepEqual(measureRange(o("1–7 item mean")), [1, 7]);
  assert.deepEqual(measureRange(o("1 to 5")), [1, 5]);
  assert.deepEqual(measureRange(o("proportion correct", "proportion")), [0, 1]);
  assert.deepEqual(measureRange(o("% correct", "continuous")), [0, 100]);
  assert.equal(measureRange(o("seconds", "continuous")), null);
  assert.equal(measureRange(o("rank; 1 = best", "rank")), null);
  // Units and scales: points, proportions, a declared range before the unit.
  assert.deepEqual(measureRange(o("7-point Likert")), [1, 7]);
  assert.deepEqual(measureRange(o("1–10")), [1, 10]);
  assert.deepEqual(measureRange(o("proportion of trials", "continuous")), [0, 1]);
  assert.deepEqual(measureRange({ ...o("score", "continuous"), range: [0, 50] }), [0, 50]);
  assert.deepEqual(measureRange({ ...o("0–100", "continuous"), range: [0, 10] }), [0, 10], "a declared range wins over the unit");
  // Typical sizes of unbounded measures: times by their unit, counts, distances.
  assert.deepEqual(typicalRange(o("ms", "continuous")), [2000, 30000]);
  assert.deepEqual(typicalRange(o("reaction time (msec)", "continuous")), [2000, 30000]);
  for (const unit of ["s", "sec", "seconds", "time (s)", "seconds per main trial"]) assert.deepEqual(typicalRange(o(unit, "continuous")), [2, 30], unit);
  assert.deepEqual(typicalRange(o("min", "continuous")), [1, 10]);
  assert.deepEqual(typicalRange(o("collisions", "count")), [0, 8]);
  assert.deepEqual(typicalRange(o("wrong selections per main trial", "continuous")), [0, 3]);
  assert.equal(typicalRange(o("arbitrary units", "continuous")), null);

  // Simulated values follow the unit: thousands for "ms", whole non-negative numbers for counts,
  // the declared range for a rating whose unit does not say it.
  const units = exampleStudy();
  units.synthetic = true;
  const add = (id: string, unit: string, scale: Study["outcomes"][number]["scale"], extra: Partial<Study["outcomes"][number]> = {}) =>
    units.outcomes.push({ ...units.outcomes[0], id, label: id, unit, scale, aggregation: "arithmetic", components: undefined, ...extra });
  add("reaction-ms", "ms", "continuous");
  add("task-min", "minutes", "continuous");
  add("collisions", "collisions", "count");
  add("comfort", "rating", "ordinal", { range: [1, 5] });
  add("score-pct", "%", "continuous");
  units.outcomes.forEach((x) => {
    if (x.components === undefined) delete x.components;
  });
  const unitStudy = validateStudy(units);
  const sim = simulatedResults(freezePlan(unitStudy, await proposeAgents(unitStudy), 1), 3).runs;
  const of = (id: string) => sim.flatMap((r) => r.measurements.filter((m) => m.outcomeId === id).map((m) => m.value!));
  assert.ok(of("reaction-ms").length && of("reaction-ms").every((v) => v >= 2000 && v <= 30000), `ms: ${of("reaction-ms").slice(0, 3)}`);
  assert.ok(of("task-min").every((v) => v >= 1 && v <= 10));
  assert.ok(of("collisions").every((v) => Number.isInteger(v) && v >= 0 && v <= 8));
  assert.ok(of("comfort").every((v) => v >= 1 && v <= 5));
  assert.ok(of("score-pct").every((v) => v >= 0 && v <= 100) && of("score-pct").some((v) => v > 15));

  const a = await tempWorkspace(resolve("examples/graphics-quality"), (s) => {
    research(s);
    // The unit names the range (its declared 0–10 range is removed for this check).
    const discomfort = s.outcomes.find((x) => x.id === "visual-discomfort")!;
    discomfort.unit = "TLX-like workload (0–100)";
    delete discomfort.range;
  });
  try {
    const { readWorkspace } = await import("../src/workspace.js");
    const ws = await readWorkspace(a.id);
    const plan = freezePlan(ws.study, withDefaultRuns(ws.study, ws.agents!, 1), 1);
    assert.throws(() => syntheticResults(plan), /real execution/, "the demo generator still refuses a research study");
    const runs = simulatedResults(plan, 42).runs;
    assert.ok(runs.length > 0 && runs.every((r) => r.execution.synthetic === true), "every simulated run is labelled synthetic");
    const values = (id: string) => runs.flatMap((r) => r.measurements.filter((m) => m.outcomeId === id).map((m) => m.value ?? Object.values(m.components ?? {})[0]));
    const tlx = values("visual-discomfort");
    assert.ok(tlx.length && tlx.every((v) => v! >= 0 && v! <= 100), "on the 0–100 range");
    assert.ok(tlx.every((v) => v! > 15), "not values around 2–5 on a 0–100 scale");
    assert.ok(values("realism").every((v) => v! >= 1 && v! <= 7), "a 1-7 rating stays within 1–7");
  } finally {
    await removeDir(a.dir);
  }
});

test("simulate a research study: sessions finish, the analysis leaves every simulated run out with a note, progress matches the executor", async () => {
  const { Executor, liveStatuses } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readResults, readHuman } = await import("../src/workspace.js");
  const { campaignSummaries } = await import("../src/history.js");
  const { analyzeCampaign } = await import("../src/core/campaign-study.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"), research);
  try {
    const ws = await readWorkspace(a.id);
    const agents = ws.agents!.filter((x) => ["text-only", "reads-evidence"].includes(x.id));
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, agents, 1), 1), undefined, "sim-research", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("simulate");
    await until(() => ex.snapshot().counts.done === ex.jobs.size, "every session to finish", { executor: ex });
    assert.equal(ex.snapshot().counts.done, ex.jobs.size, `all simulated sessions finish: ${JSON.stringify(ex.snapshot().counts)}`);
    assert.ok([...ex.jobs.values()].every((j) => j.simulated && j.error === null));

    const report = analyzeCampaign(c, (await readHuman(a.id))!, await readResults(a.id, c.suite.study!, [c.id])).report;
    assert.ok(report.audits.every((x) => !x.scoreable && x.issues.some((i) => /cannot be scored against a real study/.test(i))), "never scored against real human data");
    assert.ok(report.notes.some((n) => /simulated \(invented\) run\(s\) left out: this is a research study/.test(n)));
    assert.ok(report.summaries.every((s) => s.agreement === null && s.scoreable === 0));

    // Campaign progress follows the executor table: a session that failed without a receipt counts as failed.
    const [first] = ex.jobs.keys();
    const live = (cid: string) => liveStatuses(a.id, cid);
    let s = (await campaignSummaries(a.id, live)).find((x) => x.id === c.id)!;
    assert.deepEqual([s.done, s.failed, s.notStarted, s.running], [ex.jobs.size, 0, 0, 0]);
    ex.jobs.get(first)!.status = "failed";
    s = (await campaignSummaries(a.id, live)).find((x) => x.id === c.id)!;
    assert.deepEqual([s.done, s.failed], [ex.jobs.size - 1, 1]);
    // Without an open executor the receipts count (all completed here).
    s = (await campaignSummaries(a.id)).find((x) => x.id === c.id)!;
    assert.equal(s.done, ex.jobs.size);
  } finally {
    await removeDir(a.dir);
  }
});

test("reused sessions keep the tokens and cost of the run they reuse; dropped configurations are named", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readWorkspace, saveCampaign, readReceipts, runDir } = await import("../src/workspace.js");
  const { campaignSummaries } = await import("../src/history.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    // The study's planned contrasts name uses-app and reads-project, so both stay.
    const agents = ws.agents!.filter((x) => ["text-only", "reads-project", "uses-app"].includes(x.id));
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, agents, 1), 1), undefined, "reuse-cost", new Date(Date.now() - 2000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    await ex.start("simulate");
    await until(() => ex.snapshot().counts.done === ex.jobs.size, "every session to finish", { executor: ex });
    // Turn one text-only run into a real one with usage and a reported cost, as a real session leaves it.
    const job = c.jobs.find((j) => j.conditionId === "text-only" && j.kind === "llm")!;
    const dir = runDir(a.id, c.id);
    const resultPath = join(dir, "results", `${job.id}.json`);
    const run = JSON.parse(await readFile(resultPath, "utf8"));
    Object.assign(run.execution, { synthetic: false, inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 250, outputTokens: 300 });
    await writeFile(resultPath, JSON.stringify(run));
    const manifest = `jobs/${job.id}/a1/execution-manifest.json`;
    await writeFile(join(dir, manifest), JSON.stringify({ costUsd: 0.42 }));
    const receipts = (await readFile(join(dir, "receipts.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    receipts.find((r) => r.jobId === job.id).executionManifest = { path: manifest, sha256: "0".repeat(64) };
    await writeFile(join(dir, "receipts.jsonl"), receipts.map((r) => JSON.stringify(r)).join("\n") + "\n");

    const next = continueFromStatus(c, await readReceipts(a.id, [c.id]), { rerunConditions: ["reads-project"], note: "Rerun of Reads the project" });
    await saveCampaign(a.id, next);
    const reused = next.jobs.find((j) => j.inheritedFrom?.jobId === job.id)!;
    const ex2 = await Executor.open(a.id, next.id);
    const row = ex2.jobs.get(reused.id)!;
    assert.equal(row.status, "reused");
    assert.deepEqual([row.simulated, row.tokensIn, row.tokensOut, row.costUsd], [false, 1750, 300, 0.42], "the reused real run shows its tokens and cost");
    const simRow = [...ex2.jobs.values()].find((j) => j.status === "reused" && j.jobId !== reused.id)!;
    assert.deepEqual([simRow.simulated, simRow.tokensIn, simRow.costUsd], [true, null, null], "a reused simulated run shows no usage");

    // A continuation that drops a configuration on purpose names it, so it is not reported as missing.
    const dropped = continueFromStatus(c, await readReceipts(a.id, [c.id]), { dropConditions: ["reads-project"] });
    await saveCampaign(a.id, dropped);
    const s = (await campaignSummaries(a.id)).find((x) => x.id === dropped.id)!;
    assert.deepEqual(s.dropped, ["reads-project"]);
    assert.deepEqual((await campaignSummaries(a.id)).find((x) => x.id === c.id)!.dropped, []);
  } finally {
    await removeDir(a.dir);
  }
});

test("study brief: written and edited from the website, mapped in workspace.json, outcome-blind check; a study without one gets it", async () => {
  const { createStudy, readWorkspace } = await import("../src/workspace.js");
  const { briefOverview, saveBrief } = await import("../src/brief.js");
  const name = `zz-test-brief-${Date.now().toString(36)}`;
  try {
    const { id } = await createStudy(name);
    const dir = resolve("private/studies", name);
    // A new study has a brief source but no file: nothing can run until the brief is written.
    const before = await briefOverview(id, []);
    assert.equal(before?.exists, false);
    await assert.rejects(saveBrief(id, "   "), /The brief is empty/);
    const r = await saveBrief(id, "# Task\nFind the target in each design.\n\nParticipant p01 rated 3.25.\n");
    assert.equal(r.path, "agent-brief.md");
    assert.equal(r.check.participantIds, 1, "the check counts participant IDs named in the brief");
    const ws = await readWorkspace(id);
    assert.equal(ws.manifest.sources?.brief, "agent-brief.md");
    const after = await briefOverview(id, [{ id: "text-only", sourceIds: ["brief"] }]);
    assert.equal(after?.exists, true);
    assert.deepEqual(after?.configs, ["text-only"]);
    assert.match(after!.preview, /Find the target/);
    // Editing writes the same file.
    await saveBrief(id, "# Task\nFind the target.\n");
    assert.equal(await readFile(join(dir, "agent-brief.md"), "utf8"), "# Task\nFind the target.\n");

    // A study whose brief source was removed gets one back, and every configuration gets it.
    const study = JSON.parse(await readFile(join(dir, "study.json"), "utf8"));
    study.sources = study.sources.filter((s: { kind: string }) => s.kind !== "brief");
    await writeFile(join(dir, "study.json"), JSON.stringify(study));
    const manifest = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
    delete manifest.sources.brief;
    manifest.sources.evidence = "agent-brief.md"; // a file another source uses is never overwritten
    await writeFile(join(dir, "workspace.json"), JSON.stringify(manifest));
    const { proposeAgents } = await import("../src/core/planner.js");
    const textOnly = (await proposeAgents(study)).filter((x) => x.id === "text-only").map((x) => ({ ...x, model: { provider: "claude-code", model: "claude-opus-5-5", reasoning: "default" } }));
    await writeFile(join(dir, "agents.json"), JSON.stringify(textOnly));
    const again = await saveBrief(id, "# Task\nAgain.\n");
    assert.equal(again.path, "agent-brief-2.md");
    const ws2 = await readWorkspace(id);
    assert.ok(ws2.study.sources.some((s) => s.kind === "brief" && s.id === again.sourceId));
    assert.ok(ws2.agents!.every((x) => x.sourceIds.includes(again.sourceId) && x.requiredSourceIds.includes(again.sourceId)), "every configuration gets the brief");
    assert.equal(await readFile(join(dir, "agent-brief.md"), "utf8"), "# Task\nFind the target.\n");
  } finally {
    await removeDir(resolve("private/studies", name));
  }
});

test("understand study drafts an outcome-blind brief; knowledge and explanations stay with the document and use names", async () => {
  const { understandStudy, understandPrompt, explainPrompt, KNOWLEDGE_SYSTEM } = await import("../src/assistant.js");
  const { extractProposal } = await import("../src/core/proposal.js");
  const { createStudy, readWorkspace } = await import("../src/workspace.js");
  const doc = await extractProposal("doc.md", Buffer.from("Material cues in VR\nTwo designs: matte and glossy.\n"));
  const p = understandPrompt(doc);
  assert.match(p.system, /NEVER contain results/);
  assert.match(p.prompt, /"brief"/);
  assert.match(p.prompt, /Leave out EVERYTHING about results/);
  assert.match(KNOWLEDGE_SYSTEM, /Use ONLY what the document itself says: add no outside knowledge/);

  const empty = { value: "", quote: "" };
  const draft = {
    facts: { title: { value: "Material cues in VR", quote: "Material cues in VR" }, researchQuestion: empty, design: empty, participantCount: empty, conditions: empty, task: empty, objectiveOutcomes: empty, subjectiveOutcomes: empty },
    study: { title: "Material cues in VR", design: "within-subjects", conditions: [{ id: "matte", label: "Matte" }, { id: "glossy", label: "Glossy" }], outcomes: [{ id: "realism", label: "Realism", domain: "subjective", unit: "1-7", scale: "ordinal" }] },
    brief: "# Task\nRate how real each material looks (1-7).",
    questions: [],
  };
  const bin = await mkdtemp(join(tmpdir(), "fake-assistant-"));
  await writeFile(join(bin, "claude.cjs"), `console.log(JSON.stringify({ result: ${JSON.stringify(JSON.stringify(draft))} }));`);
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  const name = `zz-test-understand-brief-${Date.now().toString(36)}`;
  try {
    const { id } = await createStudy(name);
    const r = await understandStudy(doc, "participant,order\nq1,matte glossy\nq2,glossy matte\n", (await readWorkspace(id)).study);
    assert.equal(r.brief, "# Task\nRate how real each material looks (1-7).\n");
    assert.ok(r.study.sources.some((s) => s.kind === "brief"));
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(resolve("private/studies", name));
    await removeDir(bin);
  }

  const e = explainPrompt(
    { summaries: [{ agentId: "custom-1", agreement: 0.6 }], contrasts: [{ candidate: "custom-1", baseline: "text-only" }] },
    [
      { id: "custom-1", name: "Reads the paper", level: "population", model: "claude-opus-5-5", effort: "effort=high", gets: ["the study description", "your evidence document"] },
      { id: "text-only", name: "Text only", level: "population", model: "claude-opus-5-5", effort: "default", gets: ["the study description"] },
    ],
  );
  assert.match(e.system, /by its name, never by its ID/);
  assert.match(e.system, /never invent differences/);
  assert.doesNotMatch(e.prompt, /custom-1/, "IDs are replaced by names");
  assert.match(e.prompt, /"agentId":"Reads the paper"/);
  assert.match(e.prompt, /"model":"claude-opus-5-5","effort":"effort=high"/);
});

test("what the agents of a frozen campaign get stays listed after a source is deleted from the study", async () => {
  const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
  const { saveKnowledge } = await import("../src/sources.js");
  const { handleGet } = await import("../src/routes.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, withDefaultRuns(ws.study, ws.agents!, 1), 1), undefined, "inputs", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    // Delete the evidence source as the Evidence & knowledge page does.
    const study = { ...ws.study, sources: ws.study.sources.filter((s) => s.id !== "evidence") };
    const agents = ws.agents!.map((x) => ({ ...x, sourceIds: x.sourceIds.filter((s) => s !== "evidence"), requiredSourceIds: x.requiredSourceIds.filter((s) => s !== "evidence"), tools: x.tools.filter((t) => t !== "read-evidence") }));
    await saveKnowledge(a.id, { study, agents, unmap: ["evidence"] });
    let out: any = null;
    const url = new URL(`http://127.0.0.1/api/workspace/campaign-inputs?id=${encodeURIComponent(a.id)}&campaign=${encodeURIComponent(c.id)}`);
    assert.equal(await handleGet("/api/workspace/campaign-inputs", url, {} as never, (v) => (out = v)), true);
    const evidence = out.find((s: { id: string }) => s.id === "evidence");
    assert.ok(evidence, "the frozen campaign still lists its evidence");
    assert.deepEqual([evidence.removed, evidence.readable, evidence.configs > 0], [true, false, true]);
    assert.deepEqual(out.find((s: { id: string }) => s.id === "brief").removed, false);
  } finally {
    await removeDir(a.dir);
  }
});
