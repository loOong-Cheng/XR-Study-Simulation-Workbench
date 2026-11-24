// The command line as coding agents use it: the built CLI (dist/cli.js) on copies of an
// example in a temporary folder. Run from the repository root after `npm run build` (npm test).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentProtocol, HumanData, Plan, ResultBundle } from "../src/core/types.js";
import type { CampaignScorecard } from "../src/core/campaign-comparison.js";

const cliPath = resolve("dist/cli.js");
interface Run {
  code: number;
  out: string;
  err: string;
}
/** Run the CLI in `cwd` with test-only settings (no runtimes, default forecasting model). */
function cli(cwd: string, ...args: string[]): Promise<Run> {
  return new Promise((done) =>
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, XR_STUDY_SETTINGS: join(cwd, "settings.json") }, maxBuffer: 64 * 1024 * 1024 },
      (error, out, err) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out, err }),
    ),
  );
}
const json = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;
/** A temporary folder with a copy of the graphics-quality example as gq/ (without its app). */
async function sandbox(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "xr-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(resolve("examples/graphics-quality"), join(dir, "gq"), {
    recursive: true,
    filter: (src) => !/[\\/](campaigns|runs|webxr-app|study\.approval\.json)$/.test(src),
  });
  await writeFile(join(dir, "settings.json"), "{}\n");
  return dir;
}
/** One run-result file per job, as the website writes runs/<campaign>/results/<job>.json. */
async function splitResults(bundleFile: string, folder: string) {
  const bundle = await json<ResultBundle>(bundleFile);
  await mkdir(folder, { recursive: true });
  for (const run of bundle.runs) await writeFile(join(folder, `${run.jobId}.json`), JSON.stringify(run, null, 2));
}
const ok = (r: Run) => assert.equal(r.code, 0, `expected success:\n${r.out}\n${r.err}`);
const fails = (r: Run, code: number, pattern: RegExp) => {
  assert.equal(r.code, code, `expected exit ${code}:\n${r.out}\n${r.err}`);
  assert.match(r.out + r.err, pattern);
  assert.doesNotMatch(r.err, /Cannot read properties|ENOENT|EEXIST|is not valid JSON \(Unexpected token u/);
};
const draftedModel = { provider: "claude-code", model: "claude-opus-5-5", reasoning: "default" };

test("cli: help lists every command; unknown commands and options fail plainly", async (t) => {
  const dir = await sandbox(t);
  const help = await cli(dir);
  ok(help);
  for (const name of [
    "review", "proposal", "proposal-check", "agents-draft", "study-check", "explain", "brief", "plan",
    "campaign-from-plan", "unpack", "campaign-status", "campaign-analyze", "campaign-compare", "analyze",
    "campaign-continue", "campaign-rerun", "campaign-verify", "campaign-example", "campaign-new",
    "campaign-preflight", "campaign-mock", "demo",
  ])
    assert.match(help.out, new RegExp(`^  ${name} `, "m"), `help lists ${name}`);
  assert.match(help.out, /"roots".*"files".*"attestations"/);
  fails(await cli(dir, "bogus"), 1, /Unknown command "bogus"\./);
  fails(await cli(dir, "plan", "gq/study.json", "p", "--bogus"), 1, /Unknown option --bogus for plan/);
  fails(await cli(dir, "review", "gq", "--agents", "gq/agents.json"), 1, /Unknown option --agents for review/);
});

test("cli: options anywhere, missing values, missing files and existing folders", async (t) => {
  const dir = await sandbox(t);
  const first = await cli(dir, "plan", "--agents", "gq/agents.json", "gq/study.json", "p1");
  ok(first);
  assert.match(first.out, /Frozen 126 jobs/);
  fails(await cli(dir, "plan", "gq/study.json", "p2", "--agents"), 1, /--agents needs a value/);
  fails(await cli(dir, "plan", "gq/study.json", "p1"), 1, /p1 already exists; choose a new folder/);
  fails(await cli(dir, "campaign-analyze", "c", "h", "o", "r", "--comparisons"), 1, /--comparisons needs a value/);
  fails(await cli(dir, "study-check", "nope.json"), 1, /Cannot find nope\.json/);
  fails(await cli(dir, "brief", "gq/study.json", "gq/agents.json"), 1, /already exists; choose a new file name/);
});

test("cli: plan uses agents.json beside the study; drafts carry the Settings forecasting model", async (t) => {
  const dir = await sandbox(t);
  const used = await cli(dir, "plan", "gq/study.json", "p");
  ok(used);
  assert.match(used.out, /Using gq[\\/]agents\.json/);
  const agents = await json<AgentProtocol[]>(join(dir, "gq/agents.json"));
  assert.deepEqual((await json<Plan>(join(dir, "p/plan.json"))).agents.map((a) => a.id), agents.map((a) => a.id));
  await mkdir(join(dir, "solo"));
  await cp(join(dir, "gq/study.json"), join(dir, "solo/study.json"));
  const drafted = await cli(dir, "plan", "solo/study.json", "p2");
  ok(drafted);
  assert.match(drafted.out, /No agents\.json next to the study/);
  for (const a of (await json<Plan>(join(dir, "p2/plan.json"))).agents) assert.deepEqual(a.model, draftedModel);
  ok(await cli(dir, "agents-draft", "gq/study.json", "drafted.json"));
  for (const a of await json<AgentProtocol[]>(join(dir, "drafted.json"))) assert.deepEqual(a.model, draftedModel);
  // A fresh draft passes the checks for new configurations.
  ok(await cli(dir, "study-check", "gq/study.json", "--agents", "drafted.json"));
});

test("cli: study-check reports human-data problems first and exits non-zero", async (t) => {
  const dir = await sandbox(t);
  const human = await json<HumanData>(join(dir, "gq/human.json"));
  const write = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value));
  await write("missing.json", { ...human, measurements: human.measurements.filter((m) => m.participantId !== "p03") });
  const missing = await cli(dir, "study-check", "gq/study.json", "--human", "missing.json");
  fails(missing, 2, /357 of 378 expected records present, 21 missing/);
  assert.match(missing.out, /Missing 21 records of 378 expected.*p03: all 21/);
  assert.doesNotMatch(missing.out, /Study is valid/);
  await write("other.json", { ...human, studyId: "another-study", measurements: [...human.measurements, { ...human.measurements[0], participantId: "p99" }] });
  const other = await cli(dir, "study-check", "gq/study.json", "--human", "other.json");
  fails(other, 2, /Participant IDs not in the study: p99/);
  assert.match(other.out, /## Problems\n\n- human\.json belongs to study "another-study"/);
  await write("empty.json", { schemaVersion: "1.0", studyId: human.studyId, synthetic: true });
  fails(await cli(dir, "study-check", "gq/study.json", "--human", "empty.json"), 2, /no list of measurements/);
  // The review suggestion names a folder the website can open, without options review does not take.
  const outside = await cli(dir, "study-check", "gq/study.json", "--agents", "gq/agents.json");
  ok(outside);
  assert.match(outside.out, /outside examples\/ and private\/studies\//);
  assert.doesNotMatch(outside.out, /review [^`]*--agents/);
  const inside = await cli(resolve("."), "study-check", "examples/graphics-quality/study.json", "--agents", "examples/graphics-quality/agents.json");
  ok(inside);
  assert.match(inside.out, /`node dist\/cli\.js review examples\/graphics-quality`|Approved by the researcher/);
  assert.match(inside.out, /\| Predicts \| Inputs \(measured\) \|/);
});

test("cli: explain recognises each file kind and verifies frozen files", async (t) => {
  const dir = await sandbox(t);
  const agents = await cli(dir, "explain", "gq/agents.json");
  ok(agents);
  assert.match(agents.out, /\| text-with-task-data \|.*\| search-time, selection-errors \|/);
  const human = await cli(dir, "explain", "gq/human.json");
  ok(human);
  assert.match(human.out, /378 of 378 expected records present/);
  const comparisons = await cli(dir, "explain", "gq/comparisons.json");
  ok(comparisons);
  assert.match(comparisons.out, /Uses the app − Text only/);
  await writeFile(join(dir, "gq/bad.json"), JSON.stringify([{ candidate: "uses-app", baseline: "text-only", domain: "both" }]));
  fails(await cli(dir, "explain", "gq/bad.json"), 2, /domain "both" is not allowed; use "objective" or "subjective"/);
  fails(await cli(dir, "explain", "gq/workspace.json"), 1, /explain accepts study, agents, human, comparisons, plan, campaign and campaign-suite files/);
  ok(await cli(dir, "plan", "gq/study.json", "p"));
  const planFile = join(dir, "p/plan.json");
  await writeFile(planFile, (await readFile(planFile, "utf8")).replace('"repetitions": 1,', '"repetitions": 2,'));
  fails(await cli(dir, "explain", "p/plan.json"), 1, /failed its integrity check/);
  fails(await cli(dir, "campaign-from-plan", "gq/study.json", "c"), 1, /is not a plan\.json \(it looks like a study\.json\); run plan first/);
});

test("cli: campaign-verify checks every file in the manifest and recognises reruns", async (t) => {
  const dir = await sandbox(t);
  ok(await cli(dir, "plan", "gq/study.json", "p"));
  ok(await cli(dir, "campaign-from-plan", "p", "c"));
  const clean = await cli(dir, "campaign-verify", "c");
  ok(clean);
  assert.match(clean.out, /All \d+ files listed in manifest\.json match/);
  ok(await cli(dir, "campaign-rerun", "c/campaign.json", "r", "claude-code", "claude-opus-5-5", "high"));
  const rerun = await cli(dir, "campaign-verify", "r/campaign.json", "c/campaign.json");
  ok(rerun);
  assert.match(rerun.out, /rerun of its parent/);
  fails(await cli(dir, "campaign-verify", "c/campaign.json", "r/campaign.json"), 1, /is not this campaign's parent/);
  const job = (await readFile(join(dir, "c/run-queue.jsonl"), "utf8")).split("\n")[0];
  await appendFile(join(dir, "c/jobs", `${JSON.parse(job).id}.json`), " ");
  fails(await cli(dir, "campaign-verify", "c/campaign.json"), 1, /jobs\/.+\.json differs from the manifest/);
});

test("cli: continuations, results folders, missing parent results, status and score comparison", async (t) => {
  const dir = await sandbox(t);
  ok(await cli(dir, "plan", "gq/study.json", "p"));
  ok(await cli(dir, "campaign-from-plan", "p", "c1"));
  const status = await cli(dir, "campaign-status", "c1");
  ok(status);
  assert.equal(JSON.parse(status.out).counts.pending, 126);
  ok(await cli(dir, "campaign-mock", "c1", "m1"));
  await splitResults(join(dir, "m1/results.synthetic.json"), join(dir, "runs1/results"));
  await writeFile(join(dir, "bogus.json"), JSON.stringify({ rerunConditions: ["uses-app"], bogusField: 1 }));
  fails(await cli(dir, "campaign-continue", "c1", "bogus.json", "x"), 1, /Unknown change "bogusField"; allowed: /);
  await writeFile(join(dir, "note.json"), JSON.stringify({ note: "only a note" }));
  const note = await cli(dir, "campaign-continue", "c1", "note.json", "x");
  fails(note, 1, /a note alone changes nothing/);
  assert.doesNotMatch(note.err, /retryJobs, note\)/);
  await writeFile(join(dir, "rerun.json"), JSON.stringify({ rerunConditions: ["uses-app"] }));
  ok(await cli(dir, "campaign-continue", "c1", "rerun.json", "c2", "--receipts", "m1/receipts.jsonl"));
  ok(await cli(dir, "campaign-mock", "c2", "m2"));
  await splitResults(join(dir, "m2/results.synthetic.json"), join(dir, "runs2/results"));
  const c1 = await json<{ id: string }>(join(dir, "c1/campaign.json"));
  const alone = await cli(dir, "campaign-analyze", "c2", "gq/human.json", "a2", "runs2");
  ok(alone);
  assert.match(alone.err, new RegExp(`their results were not given.*${c1.id}.*108 run`));
  ok(await cli(dir, "campaign-analyze", "c1", "gq/human.json", "a1", "runs1/results", "--comparisons", "gq/comparisons.json"));
  const lineage = await cli(dir, "campaign-analyze", "c2/campaign.json", "gq/human.json", "a3", "runs2/results", "runs1/results");
  ok(lineage);
  assert.match(lineage.out, /108 reused run/);
  assert.equal(lineage.err.trim(), "");
  ok(await cli(dir, "campaign-verify", "c2", "c1/campaign.json"));
  ok(await cli(dir, "campaign-compare", "c1/campaign.json", "a1/scorecard.json", "c2/campaign.json", "a3/scorecard.json", "cmp"));
  const [head, ...rows] = (await readFile(join(dir, "cmp/comparison.csv"), "utf8")).trim().split("\n");
  assert.equal(
    head,
    "condition,domain,before_agreement_pct,after_agreement_pct,change_pp,n_humans,before_runs,after_runs,status,before_model,after_model,model_changed,before_run_kind,after_run_kind,note",
  );
  const card = await json<CampaignScorecard>(join(dir, "a1/scorecard.json"));
  const row = rows.find((r) => r.startsWith("text-only,subjective,"))!.split(",");
  assert.equal(row[8], "comparable");
  const agreement = card.rows.find((r) => r.conditionId === "text-only" && r.domain === "subjective")!.agreement!;
  assert.ok(Math.abs(Number(row[2]) - agreement * 100) < 1e-3);
  assert.ok(Math.abs(Number(row[4])) < 1e-9, "a fully reused configuration changes by 0 percentage points");
});

test("cli: wrong inputs give plain messages", async (t) => {
  const dir = await sandbox(t);
  fails(await cli(dir, "unpack", "gq/study.json", "u"), 1, /is not a package container \(it looks like a study\.json\)/);
  ok(await cli(dir, "campaign-example", "suite.json"));
  await writeFile(join(dir, "empty.json"), "{}");
  const preflight = await cli(dir, "campaign-preflight", "suite.json", "empty.json");
  fails(preflight, 2, /Missing local asset binding/);
  await writeFile(join(dir, "bad-bindings.json"), JSON.stringify({ roots: [] }));
  fails(await cli(dir, "campaign-preflight", "suite.json", "bad-bindings.json"), 1, /is not a bindings file\. Expected \{"roots"/);
  const reading = {
    facts: {
      title: { value: "Graphics", quote: "Graphics quality and subjective experience in a WebXR room" },
      researchQuestion: { value: "RQ", quote: "not in the document" },
      design: { value: "within", quote: "Design: within-subjects" },
      participantCount: { value: "20", quote: "Participants: 20" },
      conditions: { value: "", quote: "" },
      task: { value: "", quote: "" },
      objectiveOutcomes: { value: "", quote: "" },
    },
  };
  await writeFile(join(dir, "reading.json"), JSON.stringify(reading));
  const checked = await cli(dir, "proposal-check", "gq/proposal.md", "reading.json");
  fails(checked, 1, /3 problem\(s\)/);
  assert.match(checked.err, /researchQuestion: the quote is not copied exactly/);
  assert.match(checked.err, /participantCount: the quote is not copied exactly/);
  assert.match(checked.err, /subjectiveOutcomes: missing/);
  ok(await cli(dir, "demo", "demo"));
  ok(await cli(dir, "analyze", "demo/plan.json", "demo/human.synthetic.json", "demo/results.synthetic.json", "demo-report"));
});
