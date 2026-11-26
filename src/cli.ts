import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, isAbsolute, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { analyze } from "./core/analyzer.js";
import {
  exampleStudy,
  syntheticHumanData,
  syntheticResults,
} from "./core/example.js";
import {
  freezePlan,
  withDefaultRuns,
  handoffFiles,
  planningBrief,
  tokenBudgetWarning,
  proposeAgents,
  verifyPlan,
} from "./core/planner.js";
import {
  checkNewConfigurations,
  mixedLevels,
  requireThat,
  validateAgents,
  validateComparisons,
  validateHumanData,
  validateStudy,
} from "./core/validation.js";
import { reportCSV, reportHTML } from "./core/report.js";
import {
  explainAgents,
  explainCampaign,
  explainComparisons,
  explainHuman,
  explainPlan,
  explainStudy,
} from "./core/explain.js";
import { approvalState } from "./review.js";
import { capabilityWarnings, webxrActionWarnings, webxrDeviceWarning, webxrPointerProblem } from "./executor/runtimes.js";
import { fairnessWarnings } from "./core/fairness.js";
import {
  extractProposal,
  checkedReading,
  localReading,
  agentReading,
  proposalFields,
  readerConfig,
} from "./core/proposal.js";
import type {
  AgentProtocol,
  Comparison,
  HumanData,
  Plan,
  ResultBundle,
  RunResult,
  Study,
} from "./core/types.js";
import {
  campaignFiles,
  campaignPlan,
  campaignStatus,
  campaignSummary,
  campaignFromPlan,
  continueCampaign,
  continueFromStatus,
  freezeCampaign,
  rerunCampaign,
  validateSuite,
  verifyCampaign,
  verifyContinuation,
  type Campaign,
  type CampaignContinuation,
  type CampaignModel,
  type CampaignReceipt,
  type CampaignSuite,
} from "./core/campaign.js";
import { syntheticCampaignSuite } from "./core/campaign-presets.js";
import {
  analyzeCampaign,
  syntheticCampaignExecution,
} from "./core/campaign-study.js";
import {
  preflightSuite,
  type AssetBindings,
} from "./campaign-io.js";
import {
  compareCampaignScores,
  type CampaignScorecard,
} from "./core/campaign-comparison.js";
import { readSettings } from "./settings.js";
import { changedAppIn, changedSourcesIn, loadManifest, repoRoot, rerunChangedApp, rerunChangedSources, workspaceDir, type WorkspaceManifest } from "./workspace.js";
import { appCheck } from "./app-check.js";
import { tmpdir } from "node:os";
import { decodeText } from "./files.js";

// ---------- commands, usage and help ----------

const usage: Record<string, string> = {
  review: "review <study-folder> [--port 4317]",
  proposal: "proposal <document.pdf|docx|md|txt> <new-directory> [--agent]",
  "proposal-check": "proposal-check <document.pdf|docx|md|txt> <reading.json>",
  "agents-draft": "agents-draft <study.json> <new-agents.json>",
  "study-check": "study-check <study.json> [--agents agents.json] [--human human.json]",
  "app-check": "app-check <study-folder> [--design <design>]",
  explain: "explain <file>",
  brief: "brief <study.json> <new-brief.json>",
  plan: "plan <study.json> <new-directory> [--agents agents.json] [--repetitions N]",
  "campaign-from-plan": "campaign-from-plan <plan.json> <new-directory> [<provider> <model> <reasoning>]",
  unpack: "unpack <package.json> <new-directory>",
  "campaign-status": "campaign-status <campaign.json> [<receipts.jsonl> ...]",
  "campaign-analyze":
    "campaign-analyze <campaign.json> <human.json> <new-directory> <results> [<earlier-results> ...] [--comparisons comparisons.json]",
  "campaign-compare":
    "campaign-compare <old-campaign.json> <old-scores.json> <new-campaign.json> <new-scores.json> <new-directory>",
  analyze: "analyze <plan.json> <human.json> <results> <new-directory> [--comparisons comparisons.json]",
  "campaign-continue":
    "campaign-continue <previous-campaign.json> <changes.json> <new-directory> [--receipts <receipts.jsonl> ...]",
  "campaign-rerun": "campaign-rerun <previous-campaign.json> <new-directory> <provider> <model> <reasoning>",
  "campaign-verify": "campaign-verify <campaign.json|campaign-folder> [<parent-campaign.json>]",
  "campaign-example": "campaign-example <new-suite.json>",
  "campaign-new": "campaign-new <suite.json> <new-directory> <provider> <model> <reasoning>",
  "campaign-preflight": "campaign-preflight <suite-or-campaign.json> <bindings.local.json>",
  "campaign-mock": "campaign-mock <synthetic-campaign.json> <new-directory>",
  demo: "demo [<new-directory>]",
};
const sections: [string, [string, string][]][] = [
  ["Website", [["review", "open a study folder (under examples/ or private/studies/) in the local website"]]],
  [
    "Understand and draft a study",
    [
      ["proposal", "extract a document's text locally (--agent: also read it with the XR_PLANNER_* model)"],
      ["proposal-check", "check reading.json: every fact needs an exact quote from the document"],
      ["agents-draft", "draft agent configurations with the Settings forecasting model"],
      ["study-check", "check the study, its agent configurations and human data; list what to fix"],
      ["app-check", "open each design of a WebXR app through the runtime without an agent and report problems"],
      ["explain", "summarise a study, agents, human, comparisons, plan, campaign or campaign-suite file"],
      ["brief", "export the planning brief (no model call)"],
    ],
  ],
  [
    "Freeze",
    [
      ["plan", "freeze a plan (uses agents.json next to the study unless --agents is given)"],
      ["campaign-from-plan", "freeze a campaign from a plan"],
      ["unpack", "verify a package container {\"files\": {…}} and write its files"],
    ],
  ],
  [
    "Status, scores and comparisons",
    [
      ["campaign-status", "progress of a campaign from its receipts (none before anything ran)"],
      ["campaign-analyze", "score a campaign against human.json"],
      ["campaign-compare", "compare the scorecards of two campaigns (descriptive)"],
      ["analyze", "score a plan's results against human.json"],
    ],
  ],
  [
    "Continue, rerun and verify",
    [
      ["campaign-continue", "derive a continuation from a change set; unchanged finished runs are reused"],
      ["campaign-rerun", "freeze the same suite again with another model; every job runs again"],
      ["campaign-verify", "check a campaign's digest and every file in its manifest; with a parent, its lineage"],
    ],
  ],
  [
    "External campaign suites and examples",
    [
      ["campaign-example", "write a synthetic campaign suite"],
      ["campaign-new", "freeze a campaign from a suite"],
      ["campaign-preflight", "check a suite's asset files against a bindings file"],
      ["campaign-mock", "run a synthetic campaign with invented forecasts"],
      ["demo", "synthetic example from study to report"],
    ],
  ],
];
const bindingsFormat =
  '{"roots": {"<root>": "<folder>"}, "files": {"<asset-id>": {"root": "<root>", "path": "<path inside the root>"}}, "attestations": {"<asset-id>": {"sha256": "<hash>", "evidence": "<how it was checked>"}}}';
/** The saved comparisons beside a study.json (comparisons.json), or null when there are none or they cannot be read. */
async function comparisonsBeside(studyPath: string) {
  const file = join(dirname(studyPath), "comparisons.json");
  if (!existsSync(file)) return null;
  try {
    return validateComparisons(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return null;
  }
}
function helpText(): string {
  const lines = ["XR Study Sim — command line. Run: node dist/cli.js <command> …", ""];
  for (const [title, commands] of sections) {
    lines.push(`${title}:`);
    for (const [name, what] of commands) lines.push(`  ${usage[name]}`, `      ${what}`);
    lines.push("");
  }
  lines.push(
    "Notes:",
    "  Options may come anywhere after the command. --receipts takes every file after it, up to the next option.",
    "  New directories and files must not exist yet; nothing is ever overwritten.",
    "  <results> for campaign-analyze and analyze: a result-bundle file, a run-result file, or a folder of them such as",
    "    runs/<campaign>/results (the website writes one file per job). Give the results of every campaign in the lineage.",
    `  bindings.local.json for campaign-preflight: ${bindingsFormat}`,
    "  Use npm start for the website. The workflow is in AGENTS.md; contracts in docs/data-contract.md.",
  );
  return lines.join("\n");
}

// ---------- arguments ----------

/** Options per command. Value options take one value; list options take every value up to the next option. */
const optionsOf: Record<string, { values?: string[]; lists?: string[]; switches?: string[] }> = {
  review: { values: ["--port"] },
  proposal: { switches: ["--agent"] },
  "study-check": { values: ["--agents", "--human"] },
  "app-check": { values: ["--design"] },
  plan: { values: ["--agents", "--repetitions"] },
  analyze: { values: ["--comparisons"] },
  "campaign-analyze": { values: ["--comparisons"] },
  "campaign-continue": { lists: ["--receipts"] },
};
const optionValue: Record<string, string> = {
  "--port": "port",
  "--agents": "agents.json",
  "--human": "human.json",
  "--design": "design",
  "--repetitions": "N",
  "--comparisons": "comparisons.json",
  "--receipts": "receipts.jsonl",
};
function parseArgs(command: string, raw: string[]) {
  const spec = optionsOf[command] ?? {};
  const known = [...(spec.values ?? []), ...(spec.lists ?? []), ...(spec.switches ?? [])];
  const positional: string[] = [];
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const switches = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    let arg = raw[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    let inline: string | undefined;
    if (arg.includes("=")) [arg, inline] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
    requireThat(
      known.includes(arg),
      `Unknown option ${arg} for ${command}. ${known.length ? `It accepts ${known.join(", ")}.` : "It takes no options."} Usage: node dist/cli.js ${usage[command]}`,
    );
    if (spec.switches?.includes(arg)) {
      switches.add(arg);
      continue;
    }
    if (spec.lists?.includes(arg)) {
      const items = inline !== undefined ? [inline] : [];
      while (i + 1 < raw.length && !raw[i + 1].startsWith("--")) items.push(raw[++i]);
      requireThat(items.length && items.every(Boolean), `${arg} needs at least one file: ${arg} <${optionValue[arg]}> …`);
      lists.set(arg, [...(lists.get(arg) ?? []), ...items]);
      continue;
    }
    const value = inline ?? raw[i + 1];
    requireThat(value !== undefined && value !== "" && !value.startsWith("--"), `${arg} needs a value: ${arg} <${optionValue[arg]}>.`);
    requireThat(!values.has(arg), `${arg} is given twice.`);
    values.set(arg, value);
    if (inline === undefined) i++;
  }
  return { positional, values, lists, switches };
}

// ---------- files ----------

const pretty = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
const isFolder = (path: string) => existsSync(path) && statSync(path).isDirectory();
async function readText(path: string): Promise<string> {
  requireThat(existsSync(path), `Cannot find ${path}.`);
  requireThat(!isFolder(path), `${path} is a folder; give a file.`);
  // Also files a Windows program saved with a byte-order mark, as UTF-16 or as Windows-1252.
  return decodeText(await readFile(path)).text;
}
async function readJson<T = unknown>(path: string): Promise<T> {
  const text = await readText(path);
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${path} is not valid JSON (${(e as Error).message}).`);
  }
}
type Kind =
  | "campaign"
  | "suite"
  | "scorecard"
  | "approval"
  | "manifest"
  | "package"
  | "plan"
  | "results"
  | "run"
  | "human"
  | "reading"
  | "study"
  | "agents"
  | "comparisons"
  | "unknown";
const kindName: Record<Kind, string> = {
  campaign: "a campaign.json",
  suite: "a campaign suite",
  scorecard: "a scorecard.json",
  approval: "a study approval file",
  manifest: "a manifest.json",
  package: "a package container",
  plan: "a plan.json",
  results: "a result bundle",
  run: "a run result",
  human: "a human.json",
  reading: "a reading.json",
  study: "a study.json",
  agents: "an agents.json",
  comparisons: "a comparisons.json",
  unknown: "none of the workbench's files",
};
/** Which workbench file a parsed JSON value is, from its shape. */
function kindOf(v: unknown): Kind {
  if (Array.isArray(v)) {
    const objects = v.every((x) => x && typeof x === "object" && !Array.isArray(x));
    if (objects && v.every((x) => "candidate" in x || "baseline" in x)) return "comparisons";
    if (objects && v.length && v.every((x) => "id" in x && ("tools" in x || "sourceIds" in x || "model" in x))) return "agents";
    return "unknown";
  }
  if (!v || typeof v !== "object") return "unknown";
  const o = v as Record<string, unknown>;
  switch (o.schemaVersion) {
    case "xr-campaign/1":
      return "campaign";
    case "xr-campaign-suite/1":
      return "suite";
    case "xr-campaign-scores/1":
      return "scorecard";
    case "xr-study-approval/1":
      return "approval";
  }
  if (o.files && typeof o.files === "object") {
    const values = Object.values(o.files as Record<string, unknown>);
    return values.length && values.every((x) => typeof x === "string" && /^[a-f0-9]{64}$/.test(x)) ? "manifest" : "package";
  }
  if (o.digest && o.study && Array.isArray(o.jobs)) return "plan";
  if (Array.isArray(o.runs)) return "results";
  if (typeof o.jobId === "string" && typeof o.planDigest === "string") return "run";
  if ("measurements" in o || (typeof o.studyId === "string" && !("conditions" in o))) return "human";
  if (o.facts && typeof o.facts === "object") return "reading";
  if ("conditions" in o || "outcomes" in o || "participants" in o) return "study";
  return "unknown";
}
const kindHints: Record<string, string> = {
  "plan<study": "run plan first: node dist/cli.js plan <study.json> <new-directory>",
  "campaign<plan": "freeze a campaign from it first: node dist/cli.js campaign-from-plan <plan.json> <new-directory>",
  "campaign<study": "freeze it first: plan, then campaign-from-plan (or Freeze in the website)",
  "campaign<suite": "freeze it first: node dist/cli.js campaign-new <suite.json> <new-directory> <provider> <model> <reasoning>",
  "study<plan": "a plan already contains its study",
};
function expectKind(path: string, value: unknown, want: Kind): void {
  const got = kindOf(value);
  if (got === want) return;
  const wrapped =
    want === "agents" && value && typeof value === "object" && Array.isArray((value as { agents?: unknown }).agents)
      ? '; put the list itself in the file, not {"agents": [...]}'
      : "";
  const hint = kindHints[`${want}<${got}`];
  throw new Error(
    `${path} is not ${kindName[want]}${got !== "unknown" ? ` (it looks like ${kindName[got]})` : ""}${hint ? `; ${hint}` : ""}${wrapped}.`,
  );
}
/** A JSON file of the expected kind. A folder holding `inFolder` (e.g. campaign.json) also works. */
async function loadAs<T>(path: string, want: Kind, inFolder?: string): Promise<{ value: T; path: string }> {
  const file = inFolder && isFolder(path) && existsSync(join(path, inFolder)) ? join(path, inFolder) : path;
  const value = await readJson<T>(file);
  expectKind(file, value, want);
  return { value, path: file };
}
const loadCampaign = async (path: string) => (await loadAs<Campaign>(path, "campaign", "campaign.json")).value;
async function loadReceipts(files: string[]): Promise<CampaignReceipt[]> {
  const receipts: CampaignReceipt[] = [];
  for (const given of files) {
    const file = isFolder(given) && existsSync(join(given, "receipts.jsonl")) ? join(given, "receipts.jsonl") : given;
    const lines = (await readText(file)).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        receipts.push(JSON.parse(line) as CampaignReceipt);
      } catch {
        throw new Error(`${file}, line ${i + 1}, is not valid JSON; receipts files hold one JSON receipt per line.`);
      }
    });
  }
  return receipts;
}
/**
 * Result bundles from files or folders. A folder (for example the website's runs/<campaign>/results,
 * or runs/<campaign> itself) holds one run-result file per job; its files become one bundle.
 */
async function loadResults(paths: string[], studyId: string): Promise<ResultBundle[]> {
  const bundles: ResultBundle[] = [];
  for (const given of paths) {
    requireThat(existsSync(given), `Cannot find ${given}.`);
    if (!isFolder(given)) {
      const value = await readJson<ResultBundle | RunResult>(given);
      const kind = kindOf(value);
      requireThat(kind === "results" || kind === "run", `${given} is not a result bundle or run result${kind !== "unknown" ? ` (it looks like ${kindName[kind]})` : ""}.`);
      bundles.push(kind === "run" ? { schemaVersion: "1.0", studyId, runs: [value as RunResult] } : (value as ResultBundle));
      continue;
    }
    const dir = isFolder(join(given, "results")) ? join(given, "results") : given;
    const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
    requireThat(files.length, `${dir} holds no result files (*.json).`);
    const runs: RunResult[] = [];
    for (const f of files) {
      const value = await readJson<ResultBundle | RunResult>(join(dir, f));
      const kind = kindOf(value);
      if (kind === "run") runs.push(value as RunResult);
      else if (kind === "results") {
        requireThat((value as ResultBundle).studyId === studyId, `${join(dir, f)} holds results of study "${(value as ResultBundle).studyId}", not "${studyId}".`);
        runs.push(...(value as ResultBundle).runs);
      } else throw new Error(`${join(dir, f)} is not a run result or result bundle.`);
    }
    bundles.push({ schemaVersion: "1.0", studyId, runs });
  }
  return bundles;
}
async function loadComparisons(path: string, study: Study, agents: AgentProtocol[]): Promise<Comparison[]> {
  const list = await readJson<Comparison[]>(path);
  requireThat(
    Array.isArray(list),
    `${path} must be a list: [{"candidate": "<configuration ID>", "baseline": "<configuration ID>", "domain": "objective" or "subjective"}].`,
  );
  const { problems } = explainComparisons(list, study, agents);
  requireThat(!problems.length, `${path}: ${problems.join(" ")}`);
  return list;
}
/** A new output folder: refuse an existing one before any work is done, create it when writing. */
function requireNew(path: string): void {
  requireThat(!existsSync(path), `${path} already exists; choose a new ${/\.[a-z]+$/i.test(path) ? "file name" : "folder"}. Nothing is overwritten.`);
}
async function freshDirectory(path: string): Promise<string> {
  requireNew(path);
  const dir = resolve(path);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir);
  return dir;
}
async function writeNewFile(path: string, text: string): Promise<void> {
  requireNew(path);
  await writeFile(path, text, { flag: "wx" });
}
async function writeFiles(
  directory: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, contents] of Object.entries(files)) {
    requireThat(
      !isAbsolute(name) &&
        !name.split(/[\\/]/).includes("..") &&
        !name.includes("\\"),
      "Unsafe handoff path.",
    );
    const target = resolve(directory, name);
    requireThat(target.startsWith(directory + sep), "Unsafe handoff path.");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: "wx" });
  }
}
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
/** Every file listed in a campaign folder's manifest.json, checked against its SHA-256. */
async function verifyManifest(dir: string, c: Campaign) {
  const manifest = await readJson<{ campaignDigest?: string; files?: Record<string, string> }>(join(dir, "manifest.json"));
  requireThat(manifest && manifest.files && typeof manifest.files === "object", `${join(dir, "manifest.json")} lists no files.`);
  const problems: string[] = [];
  if (manifest.campaignDigest !== c.digest)
    problems.push(`manifest.json belongs to campaign digest ${String(manifest.campaignDigest).slice(0, 12)}…, not this campaign's ${c.digest.slice(0, 12)}….`);
  const listed = Object.entries(manifest.files!);
  for (const [name, digest] of listed) {
    if (isAbsolute(name) || name.split(/[\\/]/).includes("..")) {
      problems.push(`${name}: unsafe path in the manifest.`);
      continue;
    }
    const file = join(dir, name);
    if (!existsSync(file)) problems.push(`${name} is missing.`);
    else if (sha256(await readFile(file)) !== digest) problems.push(`${name} differs from the manifest (changed after freezing).`);
  }
  const unlisted: string[] = [];
  const walk = async (rel: string) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (path !== "manifest.json" && !(path in manifest.files!)) unlisted.push(path);
    }
  };
  await walk("");
  return { checked: listed.length, problems, unlisted };
}
/** What `review` and the website need: a study folder under examples/ or private/studies/ that the workbench can open. */
function reviewFolder(studyPath: string): { id: string; problem?: string } {
  const folder = resolve(studyPath).replace(/[\\/]study\.json$/, "");
  const id = relative(repoRoot, folder).split(sep).join("/");
  if (!["examples/", "private/studies/"].some((r) => id.startsWith(r)))
    return {
      id,
      problem: `${studyPath} is outside examples/ and private/studies/. The website opens study folders only there: copy the folder to private/studies/<name>/ (real data, git-ignored) or examples/<name>/ (synthetic studies only), then run review on that folder.`,
    };
  if (!existsSync(join(folder, "study.json"))) return { id, problem: `There is no study.json in ${id}; the website reads the study from that file name.` };
  try {
    workspaceDir(id);
    return { id };
  } catch (e) {
    const nested = id.replace(/^(examples|private\/studies)\//, "").includes("/");
    const badName = !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(basename(folder)) || basename(folder).endsWith(".");
    return {
      id,
      problem: `The website cannot open ${id}: ${(e as Error).message}${
        nested
          ? " The study folder must sit in examples/ or private/studies/, or one level inside a study there (a variant, not in its campaigns/, runs/, deleted/ or starter/)."
          : badName
          ? " Rename the folder: letters, digits, dots, dashes and underscores only, starting with a letter, digit or underscore."
          : ""
      }`,
    };
  }
}
/** Templates with the Settings forecasting model, as the website drafts them. */
async function draftAgents(study: Study): Promise<{ agents: AgentProtocol[]; model: CampaignModel }> {
  const { forecasting } = await readSettings();
  const model = { provider: forecasting.provider, model: forecasting.model, reasoning: forecasting.reasoning };
  return { agents: (await proposeAgents(study)).map((a) => ({ ...a, model: { ...model } })), model };
}
const modelText = (m: CampaignModel) => `${m.provider} / ${m.model} (effort ${m.reasoning})`;
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const percent = (x: number | null | undefined) => (x === null || x === undefined ? null : Number((x * 100).toFixed(4)));

// ---------- commands ----------

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  if (command === undefined || ["help", "--help", "-h"].includes(command)) {
    const topic = rawArgs[0];
    console.log(topic && usage[topic] ? `Usage: node dist/cli.js ${usage[topic]}` : helpText());
    return;
  }
  if (!(command in usage)) {
    console.error(`Unknown command "${command}".\n\n${helpText()}`);
    process.exitCode = 1;
    return;
  }
  const { positional: args, values, lists, switches } = parseArgs(command, rawArgs);
  const need = (condition: unknown) => requireThat(condition, `Usage: node dist/cli.js ${usage[command]}`);

  if (command === "proposal-check") {
    need(args.length === 2);
    const document = await extractProposal(args[0], Buffer.from(await readFile(resolveExisting(args[0]))));
    const raw = await readJson<{ facts?: Record<string, { value?: unknown; quote?: unknown }> }>(args[1]);
    // Report every unusable fact at once, not only the first.
    const problems: string[] = [];
    for (const key of proposalFields) {
      const fact = raw?.facts?.[key];
      if (!fact || typeof fact.value !== "string" || typeof fact.quote !== "string")
        problems.push(`${key}: missing; give {"value": "…", "quote": "…"} (both empty if the document does not say).`);
      else if (fact.value && !(fact.quote.trim() && document.text.includes(fact.quote)))
        problems.push(`${key}: the quote is not copied exactly from the document${fact.quote.trim() ? `: "${fact.quote.length > 100 ? fact.quote.slice(0, 100) + "…" : fact.quote}"` : " (it is empty)"}.`);
    }
    const extra = Object.keys(raw?.facts ?? {}).filter((k) => !(proposalFields as readonly string[]).includes(k));
    requireThat(
      !problems.length,
      `${args[1]} has ${problems.length} problem(s):\n${problems.map((p) => `- ${p}`).join("\n")}\nThe reading's facts are: ${proposalFields.join(", ")}.`,
    );
    const reading = checkedReading(document, raw, {
      mode: "agent",
      provider: "coding-agent",
      model: "recorded-by-agent",
      usage: null,
    });
    console.log(
      `All ${Object.values(reading.facts).filter((f) => f.value).length} extracted facts have exact quotes in ${args[0]}.` +
        (reading.missing.length ? ` Not found in the document: ${reading.missing.join(", ")}.` : "") +
        (extra.length ? ` Ignored (not reading fields): ${extra.join(", ")}.` : ""),
    );
    return;
  }
  if (command === "agents-draft") {
    need(args.length === 2);
    const study = validateStudy((await loadAs(args[0], "study")).value);
    requireNew(args[1]);
    const { agents, model } = await draftAgents(study);
    await writeNewFile(args[1], pretty(agents));
    console.log(
      `Drafted ${agents.length} agent configurations (${agents.map((a) => a.id).join(", ")}) in ${args[1]}, each with the Settings forecasting model ${modelText(model)}. Review level, runs, runtime, sources, targets and inputs; change a configuration's model if the researcher wants another.`,
    );
    return;
  }
  if (command === "study-check") {
    need(args.length === 1);
    const study = validateStudy((await loadAs(args[0], "study")).value);
    const agentsFile = values.get("--agents"),
      humanFile = values.get("--human");
    const agents = agentsFile
      ? validateAgents(study, (await loadAs<AgentProtocol[]>(agentsFile, "agents")).value)
      : undefined;
    console.log(explainStudy(study, agents));
    const problems: string[] = [];
    if (humanFile) {
      const human = (await loadAs<HumanData>(humanFile, "human")).value;
      const checked = explainHuman(study, human);
      console.log(checked.text);
      problems.push(...checked.problems);
      if (!checked.problems.length)
        try {
          validateHumanData(study, human);
        } catch (e) {
          problems.push((e as Error).message);
        }
    }
    if (agents && !study.synthetic)
      agents
        .filter((a) =>
          [a.model.provider, a.model.model, a.model.reasoning].some((v) =>
            ["configure-on-worker", "record-effective-setting"].includes(v),
          ),
        )
        .forEach((a) => problems.push(`Agent ${a.id} still has a placeholder model.`));
    if (agents)
      try {
        checkNewConfigurations(study, agents);
      } catch (e) {
        problems.push((e as Error).message);
      }
    // WebXR tasks whose required actions the runtime would never record with this app (workspace.json → app).
    const workspaceFile = join(dirname(resolve(args[0])), "workspace.json");
    const workspace = existsSync(workspaceFile) ? await readFile(workspaceFile, "utf8").then((t) => JSON.parse(t), () => ({})).catch(() => ({})) : {};
    // What agents get must be fair (fairness.ts): the research question, stand-ins, models of compared configurations.
    // Also: required capabilities the runtime does not declare (Start would refuse those configurations),
    // token budgets below what the fewest tool calls need, and a motor-noise model the runtime cannot apply.
    const pointerProblem = webxrPointerProblem(workspace);
    const warnings = [
      ...(agents
        ? [
            ...webxrActionWarnings(study, agents, workspace),
            ...[webxrDeviceWarning(study, agents)].filter((w): w is string => !!w),
            ...capabilityWarnings(study, agents, workspace, await readSettings().catch(() => undefined)),
            ...agents.map((a) => tokenBudgetWarning(study, a)).filter((w): w is string => !!w),
          ]
        : []),
      ...(pointerProblem ? [pointerProblem] : []),
      ...fairnessWarnings(study, agents, await comparisonsBeside(args[0])),
    ];
    if (warnings.length) console.log("## Warnings\n\n" + warnings.map((w) => `- ${w}`).join("\n") + "\n");
    // comparisons.json beside the study: a comparison across levels (population vs individual) is
    // refused here as on save, so the analysis never meets one it has to skip. The configurations
    // are those checked above, else agents.json beside the study. (A comparison may also name a
    // model arm that only a campaign has; saving checks those.)
    const comparisonsFile = join(dirname(resolve(args[0])), "comparisons.json");
    if (existsSync(comparisonsFile)) {
      const list = await readJson<Comparison[]>(comparisonsFile);
      let known = agents;
      const besideAgents = join(dirname(resolve(args[0])), "agents.json");
      if (!known && existsSync(besideAgents))
        try {
          known = validateAgents(study, await readJson<AgentProtocol[]>(besideAgents));
        } catch {
          // reported when study-check runs with --agents
        }
      if (!Array.isArray(list)) problems.push("comparisons.json must be a list of comparisons.");
      else if (known)
        for (const c of list) {
          const mixed = c && typeof c === "object" ? mixedLevels(study, known, c) : null;
          if (mixed) problems.push(`comparisons.json: ${mixed}`);
        }
    }
    const approval = await approvalState(args[0], study, agents);
    const folder = reviewFolder(args[0]);
    const folderPath = dirname(resolve(args[0]));
    const notes = [
      basename(args[0]) !== "study.json" ? `The website reads the study from ${folder.id}/study.json.` : "",
      agentsFile && resolve(agentsFile) !== join(folderPath, "agents.json")
        ? `It reads the configurations from ${folder.id}/agents.json, not ${agentsFile}.`
        : "",
    ].filter(Boolean);
    console.log(
      `## Review\n\n${
        approval.current
          ? `Approved by the researcher on ${approval.approval!.approvedAt}.`
          : (approval.approved
              ? "Changed since the researcher approved it. "
              : "Not yet approved. ") +
            (folder.problem
              ? folder.problem
              : `Run \`node dist/cli.js review ${folder.id}\` and ask the researcher to check and approve it.`) +
            (notes.length ? " " + notes.join(" ") : "")
      }\n`,
    );
    if (problems.length) {
      console.log("## Problems\n\n" + problems.map((p) => `- ${p}`).join("\n"));
      process.exitCode = 2;
    } else console.log(warnings.length ? "Study is valid, with the warnings above." : "Study is valid.");
    return;
  }
  if (command === "app-check") {
    need(args.length === 1);
    const dir = resolve(args[0]);
    const study = validateStudy((await loadAs(join(dir, "study.json"), "study")).value);
    const manifest = await loadManifest(dir);
    const out = await mkdtemp(join(tmpdir(), "xr-app-check-"));
    const settings = await readSettings();
    console.log(`Opening each design of ${args[0]} through the WebXR runtime (no agent). Job folders, screenshots and traces: ${out}\n`);
    const checks = await appCheck(dir, study, manifest, { chromePath: settings.chromePath, out, design: values.get("--design") });
    for (const c of checks) {
      console.log(`## ${c.design}\n`);
      for (const n of c.notes) console.log(`- ${n}`);
      for (const p of c.problems) console.log(`- PROBLEM: ${p}`);
      if (c.screenshots.length) console.log(`- Screenshot: ${c.screenshots[0]}`);
      console.log("");
    }
    const n = checks.reduce((s, c) => s + c.problems.length, 0);
    if (n) {
      console.log(`${n} problem${n === 1 ? "" : "s"}: fix the app, workspace.json → app or study.json → runtime before the first real session.`);
      process.exitCode = 2;
    } else console.log("Every design opened, and the runtime could read the app. Look at the screenshots; then run one real session (Run this session only).");
    return;
  }
  if (command === "explain") {
    need(args.length === 1);
    const path = args[0];
    const value = await readJson(path);
    const sibling = (name: string) => join(dirname(path), name);
    const siblingStudy = async (what: string) => {
      requireThat(
        existsSync(sibling("study.json")),
        `To explain ${what}, explain needs the study: put study.json in the same folder as ${path}${what === "agents.json" ? `, or run study-check <study.json> --agents ${path}` : what === "human.json" ? `, or run study-check <study.json> --human ${path}` : ""}.`,
      );
      return validateStudy((await loadAs(sibling("study.json"), "study")).value);
    };
    const kind = kindOf(value);
    if (kind === "campaign") {
      try {
        verifyCampaign(value as Campaign);
      } catch (e) {
        throw new Error(`${path} failed its integrity check: ${(e as Error).message} A frozen campaign must not be edited; derive a continuation instead.`);
      }
      console.log(explainCampaign(value as Campaign));
    } else if (kind === "plan") {
      try {
        verifyPlan(value as Plan);
      } catch (e) {
        throw new Error(`${path} failed its integrity check: ${(e as Error).message}`);
      }
      console.log(explainPlan(value as Plan));
    } else if (kind === "study") console.log(explainStudy(validateStudy(value)));
    else if (kind === "agents") {
      const study = await siblingStudy("agents.json");
      console.log(`# Agent configurations of ${study.title}\n\n${explainAgents(study, validateAgents(study, value as AgentProtocol[]))}\n`);
    } else if (kind === "human") {
      const study = await siblingStudy("human.json");
      const checked = explainHuman(study, value as HumanData);
      console.log(`# Human reference of ${study.title}\n\n${checked.text}`);
      if (checked.problems.length) {
        console.log("## Problems\n\n" + checked.problems.map((p) => `- ${p}`).join("\n"));
        process.exitCode = 2;
      }
    } else if (kind === "comparisons") {
      const study = existsSync(sibling("study.json")) ? validateStudy((await loadAs(sibling("study.json"), "study")).value) : undefined;
      const agents =
        study && existsSync(sibling("agents.json"))
          ? validateAgents(study, (await loadAs<AgentProtocol[]>(sibling("agents.json"), "agents")).value)
          : undefined;
      const checked = explainComparisons(value as Comparison[], study, agents);
      console.log(checked.text + (agents ? "" : "\n(No study.json and agents.json beside it, so configuration IDs were not checked.)\n"));
      if (checked.problems.length) {
        console.log("## Problems\n\n" + checked.problems.map((p) => `- ${p}`).join("\n"));
        process.exitCode = 2;
      }
    } else if (kind === "suite") {
      const suite = validateSuite(value);
      console.log(
        `# ${suite.title}${suite.synthetic ? " (synthetic)" : ""}\n\nCampaign suite \`${suite.id}\`: ${suite.conditions.length} conditions, ${suite.assets.length} assets.\n\n` +
          "| Condition | Label | Stage | Kind | Jobs |\n| --- | --- | --- | --- | --- |\n" +
          suite.conditions.map((c) => `| ${c.id} | ${c.label} | ${c.stage} | ${c.kind} | ${c.jobs.length} |`).join("\n") +
          "\n",
      );
    } else
      throw new Error(
        `explain accepts study, agents, human, comparisons, plan, campaign and campaign-suite files; ${path} looks like ${kindName[kind]}.`,
      );
    return;
  }
  if (command === "review") {
    need(args.length === 1);
    const folder = reviewFolder(args[0]);
    requireThat(!folder.problem, folder.problem!);
    if (values.get("--port")) process.env.XR_STUDY_PORT = values.get("--port");
    await import("./server.js");
    console.log(`Review it at http://127.0.0.1:${process.env.XR_STUDY_PORT ?? 4317}/?study=${encodeURIComponent(folder.id)}`);
    return;
  }
  if (command === "campaign-compare") {
    need(args.length === 5);
    requireNew(args[4]);
    const report = compareCampaignScores(
      await loadCampaign(args[0]),
      (await loadAs<CampaignScorecard>(args[1], "scorecard")).value,
      await loadCampaign(args[2]),
      (await loadAs<CampaignScorecard>(args[3], "scorecard")).value,
    );
    const out = await freshDirectory(args[4]);
    await writeFiles(out, {
      "comparison.json": pretty(report),
      // Agreement and its change in one unit: percent and percentage points.
      "comparison.csv":
        "condition,domain,before_agreement_pct,after_agreement_pct,change_pp,n_humans,before_runs,after_runs,status,before_model,after_model,model_changed,before_run_kind,after_run_kind,note\n" +
        report.rows
          .map((r) =>
            [
              r.conditionId,
              r.domain,
              percent(r.before),
              percent(r.after),
              r.changePercentagePoints === null ? null : Number(r.changePercentagePoints.toFixed(4)),
              r.nHumans,
              r.beforeRuns,
              r.afterRuns,
              r.status,
              r.beforeModel,
              r.afterModel,
              r.modelChanged,
              r.beforeRunKind,
              r.afterRunKind,
              r.note,
            ]
              .map(csvCell)
              .join(","),
          )
          .join("\n") +
        "\n",
    });
    console.log(
      `Comparable model scores saved in ${out}; descriptive changes only (agreement in percent, changes in percentage points).`,
    );
    return;
  }
  if (command === "campaign-example") {
    need(args.length === 1);
    await writeNewFile(args[0], pretty(syntheticCampaignSuite()));
    console.log(
      "Synthetic complete-condition suite saved; no original participant inputs included.",
    );
    return;
  }
  if (command === "campaign-new" || command === "campaign-rerun") {
    need(args.length === 5);
    requireNew(args[1]);
    const model: CampaignModel = {
      provider: args[2],
      model: args[3],
      reasoning: args[4],
    };
    const campaign =
      command === "campaign-new"
        ? freezeCampaign((await loadAs<CampaignSuite>(args[0], "suite")).value, model)
        : rerunCampaign(await loadCampaign(args[0]), model);
    const out = await freshDirectory(args[1]);
    await writeFiles(out, campaignFiles(campaign));
    console.log(
      JSON.stringify(
        {
          directory: out,
          digest: campaign.digest,
          ...campaignSummary(campaign),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "campaign-from-plan") {
    need(args.length === 2 || args.length === 5);
    const plan = (await loadAs<Plan>(args[0], "plan", "plan.json")).value;
    requireNew(args[1]);
    const campaign = campaignFromPlan(
      plan,
      args.length === 5
        ? { provider: args[2], model: args[3], reasoning: args[4] }
        : undefined,
    );
    const out = await freshDirectory(args[1]);
    await writeFiles(out, campaignFiles(campaign));
    console.log(
      pretty({ directory: out, digest: campaign.digest, ...campaignSummary(campaign) }),
    );
    return;
  }
  if (command === "campaign-continue") {
    need(args.length === 3);
    const { value: previous, path: previousPath } = await loadAs<Campaign>(args[0], "campaign", "campaign.json");
    const given = await readJson<CampaignContinuation>(args[1]);
    requireThat(
      given && typeof given === "object" && !Array.isArray(given),
      `${args[1]} must be a JSON object of changes, for example {"rerunConditions": ["<configuration>"]}.`,
    );
    requireNew(args[2]);
    // A campaign the website froze (<study>/campaigns/<id>/campaign.json with sources.json beside it):
    // configurations that read a source changed since then run again, as in the website.
    const studyDir = resolve(dirname(previousPath), "..", "..");
    const fingerprints = join(dirname(previousPath), "sources.json");
    const manifest = existsSync(join(studyDir, "workspace.json")) ? await readJson<WorkspaceManifest>(join(studyDir, "workspace.json")) : {};
    const frozen = existsSync(fingerprints) && existsSync(join(studyDir, "study.json"));
    const bySources = frozen ? rerunChangedSources(previous, await changedSourcesIn(studyDir, previous, manifest, fingerprints), given) : { changes: given, notes: [] as string[] };
    // Likewise the configurations that play the WebXR app, when the app changed.
    const byApp = frozen ? rerunChangedApp(previous, await changedAppIn(studyDir, manifest, fingerprints), bySources.changes) : { changes: bySources.changes, notes: [] as string[] };
    const changes = byApp.changes,
      notes = [...bySources.notes, ...byApp.notes];
    // The configurations it adds or changes are checked as when they are saved (continueCampaign).
    const receiptFiles = lists.get("--receipts");
    const campaign = receiptFiles
      ? continueFromStatus(previous, await loadReceipts(receiptFiles), changes)
      : continueCampaign(previous, changes);
    const out = await freshDirectory(args[2]);
    await writeFiles(out, campaignFiles(campaign));
    console.log(
      pretty({ directory: out, digest: campaign.digest, ...campaignSummary(campaign), ...(notes.length ? { sourceChanges: notes } : {}) }),
    );
    return;
  }
  if (command === "campaign-verify") {
    need(args.length === 1 || args.length === 2);
    const { value: c, path } = await loadAs<Campaign>(args[0], "campaign", "campaign.json");
    try {
      verifyCampaign(c);
    } catch (e) {
      throw new Error(`${path} failed its integrity check: ${(e as Error).message}`);
    }
    const lines = ["Campaign integrity verified: campaign.json matches its digest."];
    const dir = dirname(path);
    if (existsSync(join(dir, "manifest.json"))) {
      const m = await verifyManifest(dir, c);
      requireThat(
        !m.problems.length,
        `campaign.json is intact, but the campaign folder ${dir} does not match its manifest.json:\n${m.problems.map((p) => `- ${p}`).join("\n")}`,
      );
      lines.push(
        `All ${m.checked} files listed in manifest.json match their SHA-256.` +
          (m.unlisted.length ? ` Not listed in the manifest, so not checked: ${m.unlisted.join(", ")}.` : ""),
      );
    } else lines.push(`There is no manifest.json beside it (a website campaign folder holds only campaign.json), so only campaign.json was checked.`);
    if (args[1]) {
      const parent = await loadCampaign(args[1]);
      verifyCampaign(parent);
      requireThat(
        c.parentDigest === parent.digest,
        `${args[1]} is not this campaign's parent: the campaign records parent ${c.parentDigest ? c.parentDigest.slice(0, 12) + "…" : "none"}, the given file is ${parent.digest.slice(0, 12)}….`,
      );
      if (c.continuation) {
        verifyContinuation(parent, c);
        lines.push("The continuation follows from its parent and its recorded change set.");
      } else {
        // campaign-rerun output: the parent's suite frozen again with another model, nothing reused.
        const again = freezeCampaign(parent.suite, c.model, parent.digest, c.id, c.createdAt, c.conditionModels);
        requireThat(
          again.digest === c.digest,
          "This campaign names the parent but is neither a recorded continuation (campaign-continue) nor a rerun of its suite (campaign-rerun).",
        );
        lines.push(`It is a rerun of its parent (campaign-rerun): the same suite with ${modelText(c.model)}; every job runs again and nothing is reused.`);
      }
    }
    console.log(lines.join("\n"));
    return;
  }
  if (command === "campaign-mock") {
    need(args.length === 2);
    const campaign = await loadCampaign(args[0]);
    requireNew(args[1]);
    const { receipts, results } = syntheticCampaignExecution(campaign);
    const out = await freshDirectory(args[1]);
    await writeFiles(out, {
      "receipts.jsonl": receipts.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "results.synthetic.json": pretty(results),
    });
    console.log(
      `Synthetic worker executed ${results.runs.length} new job(s) into ${out}; reused jobs were not re-run.`,
    );
    return;
  }
  if (command === "campaign-analyze") {
    need(args.length >= 4);
    const campaign = await loadCampaign(args[0]);
    const human = (await loadAs<HumanData>(args[1], "human")).value;
    requireNew(args[2]);
    const plan = campaignPlan(campaign);
    const bundles = await loadResults(args.slice(3), plan.study.id);
    const comparisonsFile = values.get("--comparisons");
    const comparisons = comparisonsFile ? await loadComparisons(comparisonsFile, plan.study, plan.agents) : undefined;
    // The executor's receipts beside each results folder (runs/<campaign>/receipts.jsonl) name why sessions failed.
    const runFolders = args.slice(3).filter(isFolder).map((p) => (isFolder(join(p, "results")) ? p : dirname(resolve(p))));
    const receipts = await loadReceipts(runFolders.filter((d) => existsSync(join(d, "receipts.jsonl"))));
    const analysis = analyzeCampaign(campaign, human, bundles, comparisons, receipts);
    const out = await freshDirectory(args[2]);
    await writeFiles(out, {
      "report.json": pretty(analysis.report),
      "report.html": reportHTML(analysis.report),
      "scores.csv": reportCSV(analysis.report),
      "scorecard.json": pretty(analysis.scorecard),
      "provenance.json": pretty({
        campaignDigest: analysis.campaignDigest,
        models: analysis.models,
        reused: analysis.reused,
        ignoredRuns: analysis.ignoredRuns,
      }),
    });
    console.log(
      `Campaign report saved in ${out} (${analysis.reused.length} reused run(s), ${analysis.ignoredRuns} superseded run(s) ignored).`,
    );
    // Reused runs live in the results of the campaign that executed them; say which ones were not given.
    const given = new Set(bundles.flatMap((b) => b.runs.map((r) => r?.planDigest)));
    const origins = new Map<string, { id: string; jobs: number }>();
    campaign.jobs
      .filter((j) => j.kind === "llm" && j.inheritedFrom && !given.has(j.inheritedFrom.campaignDigest))
      .forEach((j) => {
        const o = j.inheritedFrom!;
        origins.set(o.campaignDigest, { id: o.campaignId, jobs: (origins.get(o.campaignDigest)?.jobs ?? 0) + 1 });
      });
    if (origins.size)
      console.warn(
        `Warning: this campaign reuses runs of earlier campaigns, but their results were not given, so these runs are missing from the report: ${[
          ...origins,
        ]
          .map(([digest, o]) => `${o.id} (digest ${digest.slice(0, 12)}…, ${o.jobs} run(s))`)
          .join("; ")}. Add their results too, for example runs/<campaign-id>/results.`,
      );
    return;
  }
  if (command === "campaign-preflight") {
    need(args.length === 2);
    const value = await readJson<CampaignSuite | Campaign>(args[0]);
    const kind = kindOf(value);
    requireThat(
      kind === "suite" || kind === "campaign",
      `${args[0]} is not a campaign suite or campaign.json${kind !== "unknown" ? ` (it looks like ${kindName[kind]})` : ""}.`,
    );
    const suite = kind === "campaign" ? (value as Campaign).suite : (value as CampaignSuite);
    const raw = await readJson<Partial<AssetBindings>>(args[1]);
    const section = (x: unknown) => x === undefined || (!!x && typeof x === "object" && !Array.isArray(x));
    requireThat(
      raw && typeof raw === "object" && !Array.isArray(raw) && section(raw.roots) && section(raw.files) && section(raw.attestations),
      `${args[1]} is not a bindings file. Expected ${bindingsFormat} (sections you do not need may be left out).`,
    );
    const result = await preflightSuite(suite, {
      roots: raw.roots ?? {},
      files: raw.files ?? {},
      attestations: raw.attestations ?? {},
    });
    console.log(pretty(result));
    if (!result.ready) process.exitCode = 2;
    return;
  }
  if (command === "campaign-status") {
    need(args.length >= 1);
    const campaign = await loadCampaign(args[0]);
    const receipts = await loadReceipts(args.slice(1));
    console.log(pretty(campaignStatus(campaign, receipts)));
    return;
  }
  if (command === "proposal") {
    need(args.length === 2);
    const document = await extractProposal(args[0], Buffer.from(await readFile(resolveExisting(args[0]))));
    const config = switches.has("--agent") ? readerConfig() : undefined;
    requireThat(
      !switches.has("--agent") || config,
      "Set XR_PLANNER_PROVIDER, XR_PLANNER_MODEL (and XR_PLANNER_API_KEY for a remote endpoint) before using --agent; see docs/proposal-workflow.md.",
    );
    requireNew(args[1]);
    const reading = config
      ? await agentReading(document, config)
      : localReading(document);
    const out = await freshDirectory(args[1]);
    await writeFiles(out, {
      "extracted-proposal.txt": document.text,
      "reading.json": pretty(reading),
    });
    console.log(
      `Proposal reading saved to ${out}: extracted-proposal.txt and reading.json. Complete reading.json with exact quotes, then run proposal-check; no study was created or frozen.`,
    );
    return;
  }
  if (command === "demo") {
    need(args.length <= 1);
    const target = args[0] ?? "artifacts/demo-" + new Date().toISOString().replace(/[:.]/g, "-");
    requireNew(target);
    const study = exampleStudy(),
      agents = await proposeAgents(study),
      plan = freezePlan(study, withDefaultRuns(study, agents, 1), 1);
    const human = syntheticHumanData(study),
      results = syntheticResults(plan),
      report = analyze(plan, human, results);
    const out = await freshDirectory(target);
    await writeFiles(out, {
      "study.json": pretty(study),
      "agents.json": pretty(agents),
      "plan.json": pretty(plan),
      "human.synthetic.json": pretty(human),
      "results.synthetic.json": pretty(results),
      "report.json": pretty(report),
      "report.html": reportHTML(report),
      "scores.csv": reportCSV(report),
    });
    await mkdir(join(out, "handoff"));
    await writeFiles(join(out, "handoff"), handoffFiles(plan));
    console.log(
      `Synthetic example exported to ${out}\n${plan.jobs.length} mock jobs; no real users, model calls or XR runtime.`,
    );
    return;
  }
  if (command === "plan") {
    need(args.length === 2);
    const study = validateStudy((await loadAs(args[0], "study")).value);
    requireNew(args[1]);
    // An agents.json beside the study is the study's own configuration set; use it unless --agents names another.
    let agentsFile = values.get("--agents");
    const beside = join(dirname(args[0]), "agents.json");
    if (!agentsFile && existsSync(beside)) {
      agentsFile = beside;
      console.log(`Using ${beside}, the agent configurations next to the study (give --agents to choose another file).`);
    }
    let agents: AgentProtocol[];
    if (agentsFile) agents = validateAgents(study, (await loadAs<AgentProtocol[]>(agentsFile, "agents")).value);
    else {
      const draft = await draftAgents(study);
      agents = draft.agents;
      console.log(
        `No agents.json next to the study and no --agents: freezing the ${agents.length} template configurations (${agents.map((a) => a.id).join(", ")}) with the Settings forecasting model ${modelText(draft.model)}. To choose them, run agents-draft and review the file first.`,
      );
    }
    const approval = await approvalState(args[0], study, agentsFile ? agents : undefined);
    if (!approval.current)
      console.warn(
        approval.approved
          ? "Warning: the study or agents changed after the researcher approved them. Run `review` again."
          : "Warning: this study has not been approved in `review`. Freezing anyway; the plan records the exact files used.",
      );
    // Budgets that likely cannot finish the tasks (a warning: the plan is frozen anyway).
    for (const w of agents.map((a) => tokenBudgetWarning(study, a)).filter(Boolean)) console.warn(`Warning: ${w}`);
    // --repetitions N = runs per participant (default 1); population configurations without their own count get participants × N.
    const perParticipant = values.has("--repetitions") ? Number(values.get("--repetitions")) : 1;
    const plan = freezePlan(study, withDefaultRuns(study, agents, perParticipant), perParticipant);
    for (const w of fairnessWarnings(study, agents, await comparisonsBeside(args[0]))) console.warn(`Warning: ${w}`);
    const out = await freshDirectory(args[1]);
    await writeFiles(out, handoffFiles(plan));
    console.log(`Frozen ${plan.jobs.length} jobs in ${out}\n${plan.digest}`);
    return;
  }
  if (command === "brief") {
    need(args.length === 2);
    const study = validateStudy((await loadAs(args[0], "study")).value);
    await writeNewFile(args[1], pretty(planningBrief(study)));
    console.log("Planning brief exported; no LLM was called.");
    return;
  }
  if (command === "analyze") {
    need(args.length === 4);
    const plan = (await loadAs<Plan>(args[0], "plan", "plan.json")).value;
    const human = (await loadAs<HumanData>(args[1], "human")).value;
    requireNew(args[3]);
    const bundles = await loadResults([args[2]], plan.study?.id);
    const comparisonsFile = values.get("--comparisons");
    const comparisons = comparisonsFile ? await loadComparisons(comparisonsFile, plan.study, plan.agents) : undefined;
    const r = analyze(
      plan,
      human,
      { schemaVersion: "1.0", studyId: bundles[0].studyId, runs: bundles.flatMap((b) => b.runs) },
      comparisons,
    );
    const out = await freshDirectory(args[3]);
    await writeFiles(out, {
      "report.json": pretty(r),
      "report.html": reportHTML(r),
      "scores.csv": reportCSV(r),
    });
    console.log(`Report saved in ${out}`);
    return;
  }
  if (command === "unpack") {
    need(args.length === 2);
    const pack = await readJson<{ files?: Record<string, string> }>(args[0]);
    const kind = kindOf(pack);
    requireThat(
      kind === "package" && Object.values(pack.files!).every((x) => typeof x === "string") && typeof pack.files!["manifest.json"] === "string",
      `${args[0]} is not a package container${kind !== "unknown" && kind !== "package" ? ` (it looks like ${kindName[kind]})` : ""}. unpack expects one JSON file {"files": {"manifest.json": "…", "plan.json" or "campaign.json": "…", …}} (a package made by an earlier version or another tool); plan and the campaign-… commands already write their files into a folder.`,
    );
    const files = pack.files!;
    let manifest: { files?: Record<string, string>; campaignDigest?: string };
    try {
      manifest = JSON.parse(files["manifest.json"]);
    } catch {
      throw new Error("The package's manifest.json is not valid JSON.");
    }
    requireThat(manifest?.files && typeof manifest.files === "object", "The package's manifest.json lists no files.");
    requireThat(
      Object.keys(files).length === Object.keys(manifest.files!).length + 1,
      "Handoff inventory mismatch.",
    );
    for (const [name, digest] of Object.entries(manifest.files!))
      requireThat(
        typeof files[name] === "string" && sha256(files[name]) === digest,
        `Checksum mismatch: ${name}.`,
      );
    if (files["campaign.json"]) {
      const campaign = JSON.parse(files["campaign.json"]) as Campaign;
      verifyCampaign(campaign);
      requireThat(
        manifest.campaignDigest === campaign.digest,
        "Campaign manifest digest mismatch.",
      );
    } else {
      requireThat(
        files["plan.json"],
        "Package contains neither a frozen plan nor a campaign.",
      );
      handoffFiles(JSON.parse(files["plan.json"]) as Plan);
    }
    const out = await freshDirectory(args[1]);
    await writeFiles(out, files);
    console.log(`Verified handoff unpacked into ${out}`);
    return;
  }
}
/** A path that exists and is a file, with a plain message otherwise. */
function resolveExisting(path: string): string {
  requireThat(existsSync(path), `Cannot find ${path}.`);
  requireThat(!isFolder(path), `${path} is a folder; give a file.`);
  return path;
}
main().catch((error) => {
  const e = error as NodeJS.ErrnoException;
  console.error(
    e.code === "ENOENT" && e.path
      ? `Cannot find ${e.path}.`
      : e.code === "EEXIST" && e.path
      ? `${e.path} already exists; choose a new name. Nothing is overwritten.`
      : e.code === "EISDIR"
      ? `${e.path ?? "The path"} is a folder; give a file.`
      : e.message,
  );
  process.exitCode = 1;
});
