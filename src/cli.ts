import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve, isAbsolute, relative, sep } from "node:path";
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
  proposeAgents,
} from "./core/planner.js";
import {
  requireThat,
  validateAgents,
  validateHumanData,
  validateStudy,
} from "./core/validation.js";
import { reportCSV, reportHTML } from "./core/report.js";
import {
  explainCampaign,
  explainPlan,
  explainStudy,
  humanCoverage,
} from "./core/explain.js";
import { approvalState } from "./review.js";
import {
  extractProposal,
  checkedReading,
  localReading,
  agentReading,
  readerConfig,
} from "./core/proposal.js";
import type {
  AgentProtocol,
  Comparison,
  HumanData,
  Plan,
  ResultBundle,
} from "./core/types.js";
import {
  campaignFiles,
  campaignStatus,
  campaignSummary,
  campaignFromPlan,
  continueCampaign,
  continueFromStatus,
  freezeCampaign,
  rerunCampaign,
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

const load = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, "utf8")) as T;
const pretty = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
async function loadReceipts(files: string[]): Promise<CampaignReceipt[]> {
  const receipts: CampaignReceipt[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (text.trim())
      receipts.push(
        ...text
          .trim()
          .split(/\n/)
          .map((l) => JSON.parse(l) as CampaignReceipt),
      );
  }
  return receipts;
}
async function freshDirectory(path: string): Promise<string> {
  const dir = resolve(path);
  await mkdir(dirname(dir), { recursive: true });
  await mkdir(dir);
  return dir;
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
async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  // --comparisons <file> may follow analyze / campaign-analyze; take it out of the positional list.
  const ci = rawArgs.indexOf("--comparisons");
  const comparisonsFile = ci < 0 ? undefined : rawArgs[ci + 1];
  const args = ci < 0 ? rawArgs : rawArgs.filter((_, i) => i !== ci && i !== ci + 1);
  const comparisons = comparisonsFile ? await load<Comparison[]>(comparisonsFile) : undefined;
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  if (command === "proposal-check") {
    requireThat(
      args.length === 2,
      "Usage: proposal-check <document.pdf|docx|md|txt> <reading.json>",
    );
    const document = await extractProposal(args[0], await readFile(args[0]));
    const reading = checkedReading(document, await load(args[1]), {
      mode: "agent",
      provider: "coding-agent",
      model: "recorded-by-agent",
      usage: null,
    });
    console.log(
      `All ${Object.values(reading.facts).filter((f) => f.value).length} extracted facts have exact quotes in ${args[0]}.` +
        (reading.missing.length ? ` Not found in the document: ${reading.missing.join(", ")}.` : ""),
    );
    return;
  }
  if (command === "agents-draft") {
    requireThat(
      args.length === 2,
      "Usage: agents-draft <study.json> <new-agents.json>",
    );
    const agents = await proposeAgents(validateStudy(await load(args[0])));
    await writeFile(args[1], pretty(agents), { flag: "wx" });
    console.log(
      `Drafted ${agents.length} agent methods (${agents.map((a) => a.id).join(", ")}) in ${args[1]}. Set the real provider/model/reasoning for each before freezing a real study.`,
    );
    return;
  }
  if (command === "study-check") {
    requireThat(
      args[0],
      "Usage: study-check <study.json> [--agents agents.json] [--human human.json]",
    );
    const study = validateStudy(await load(args[0]));
    const agentsFile = flag("--agents"),
      humanFile = flag("--human");
    const agents = agentsFile
      ? validateAgents(study, await load<AgentProtocol[]>(agentsFile))
      : undefined;
    console.log(explainStudy(study, agents));
    const problems: string[] = [];
    if (agents && !study.synthetic)
      agents
        .filter((a) =>
          [a.model.provider, a.model.model, a.model.reasoning].some((v) =>
            ["configure-on-worker", "record-effective-setting"].includes(v),
          ),
        )
        .forEach((a) => problems.push(`Agent ${a.id} still has a placeholder model.`));
    if (humanFile) {
      const human = await load<HumanData>(humanFile);
      const cov = humanCoverage(study, human);
      console.log(
        `## Human reference\n\n${cov.records} of ${cov.expected} expected records.` +
          (cov.missing.length ? ` Missing ${cov.missing.length}, e.g. ${cov.missing.slice(0, 5).join(", ")}.` : "") +
          "\n",
      );
      if (cov.unknownPeople.length) problems.push(`Participant IDs not in the study: ${cov.unknownPeople.join(", ")}.`);
      if (cov.unknownOutcomes.length) problems.push(`Outcome IDs not in the study: ${cov.unknownOutcomes.join(", ")}.`);
      if (cov.unknownConditions.length) problems.push(`Design IDs not in the study: ${cov.unknownConditions.join(", ")}.`);
      if (!problems.length)
        try {
          validateHumanData(study, human);
        } catch (e) {
          problems.push((e as Error).message);
        }
    }
    const approval = await approvalState(args[0], study, agents);
    console.log(
      `## Review\n\n${
        approval.current
          ? `Approved by the researcher on ${approval.approval!.approvedAt}.`
          : approval.approved
          ? "Changed since the researcher approved it. Run `review` again before freezing."
          : "Not yet approved. Run `node dist/cli.js review " + args[0] + (agentsFile ? ` --agents ${agentsFile}` : "") + "` and ask the researcher to check and approve it."
      }\n`,
    );
    if (problems.length) {
      console.log("## Problems\n\n" + problems.map((p) => `- ${p}`).join("\n"));
      process.exitCode = 2;
    } else console.log("Study is valid.");
    return;
  }
  if (command === "explain") {
    requireThat(args.length === 1, "Usage: explain <study.json|plan.json|campaign.json>");
    const value = await load<{ schemaVersion: string; study?: unknown; suite?: unknown }>(args[0]);
    if (value.schemaVersion === "xr-campaign/1") {
      verifyCampaign(value as unknown as Campaign);
      console.log(explainCampaign(value as unknown as Campaign));
    } else if ((value as Plan).digest && value.study) console.log(explainPlan(value as unknown as Plan));
    else console.log(explainStudy(validateStudy(value)));
    return;
  }
  if (command === "review") {
    requireThat(args[0], "Usage: review <study-folder> [--port 4317]   (the folder must be under examples/ or private/studies/)");
    const { repoRoot, workspaceDir } = await import("./workspace.js");
    const folder = resolve(args[0]).replace(/[\\/]study\.json$/, "");
    const id = relative(repoRoot, folder).split(sep).join("/");
    try {
      workspaceDir(id);
    } catch {
      throw new Error("Put the study folder under private/studies/<name>/ (git-ignored) or examples/<name>/ so the workbench can open it.");
    }
    if (flag("--port")) process.env.XR_STUDY_PORT = flag("--port");
    await import("./server.js");
    console.log(`Review it at http://127.0.0.1:${process.env.XR_STUDY_PORT ?? 4317}/?study=${encodeURIComponent(id)}`);
    return;
  }
  if (command === "campaign-compare") {
    requireThat(
      args.length === 5,
      "Usage: campaign-compare <old-campaign.json> <old-scores.json> <new-campaign.json> <new-scores.json> <new-directory>",
    );
    const report = compareCampaignScores(
      await load<Campaign>(args[0]),
      await load<CampaignScorecard>(args[1]),
      await load<Campaign>(args[2]),
      await load<CampaignScorecard>(args[3]),
    );
    const out = await freshDirectory(args[4]);
    await writeFiles(out, {
      "comparison.json": pretty(report),
      "comparison.csv":
        "condition,domain,before,after,change_pp,n_humans,before_runs,after_runs\n" +
        report.rows
          .map((r) =>
            [
              r.conditionId,
              r.domain,
              r.before ?? "",
              r.after ?? "",
              r.changePercentagePoints ?? "",
              r.nHumans,
              r.beforeRuns,
              r.afterRuns,
            ].join(","),
          )
          .join("\n") +
        "\n",
    });
    console.log(
      `Comparable model scores saved in ${out}; descriptive changes only.`,
    );
    return;
  }
  if (command === "campaign-example") {
    requireThat(args.length === 1, "Usage: campaign-example <new-suite.json>");
    await writeFile(args[0], pretty(syntheticCampaignSuite()), { flag: "wx" });
    console.log(
      "Synthetic complete-condition suite saved; no original participant inputs included.",
    );
    return;
  }
  if (command === "campaign-new" || command === "campaign-rerun") {
    requireThat(
      args.length === 5,
      `Usage: ${command} <${
        command === "campaign-new" ? "suite" : "previous-campaign"
      }.json> <new-directory> <provider-or-transport> <exact-model-id> <reasoning-setting>`,
    );
    const model: CampaignModel = {
      provider: args[2],
      model: args[3],
      reasoning: args[4],
    };
    const campaign =
      command === "campaign-new"
        ? freezeCampaign(await load<CampaignSuite>(args[0]), model)
        : rerunCampaign(await load<Campaign>(args[0]), model);
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
    requireThat(
      args.length === 2 || args.length === 5,
      "Usage: campaign-from-plan <plan.json> <new-directory> [<provider> <model> <reasoning>]",
    );
    const campaign = campaignFromPlan(
      await load<Plan>(args[0]),
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
    const rp = args.indexOf("--receipts");
    requireThat(
      (rp < 0 && args.length === 3) || (rp === 3 && args.length > 4),
      "Usage: campaign-continue <previous-campaign.json> <changes.json> <new-directory> [--receipts <receipts.jsonl> ...]",
    );
    const previous = await load<Campaign>(args[0]);
    const changes = await load<CampaignContinuation>(args[1]);
    const campaign =
      rp < 0
        ? continueCampaign(previous, changes)
        : continueFromStatus(
            previous,
            await loadReceipts(args.slice(rp + 1)),
            changes,
          );
    const out = await freshDirectory(args[2]);
    await writeFiles(out, campaignFiles(campaign));
    console.log(
      pretty({ directory: out, digest: campaign.digest, ...campaignSummary(campaign) }),
    );
    return;
  }
  if (command === "campaign-verify") {
    requireThat(
      args.length === 1 || args.length === 2,
      "Usage: campaign-verify <campaign.json> [<parent-campaign.json>]",
    );
    const c = await load<Campaign>(args[0]);
    if (args[1]) verifyContinuation(await load<Campaign>(args[1]), c);
    else verifyCampaign(c);
    console.log(
      args[1]
        ? "Campaign integrity verified and the continuation follows from its parent."
        : "Campaign integrity verified.",
    );
    return;
  }
  if (command === "campaign-mock") {
    requireThat(
      args.length === 2,
      "Usage: campaign-mock <synthetic-campaign.json> <new-directory>",
    );
    const { receipts, results } = syntheticCampaignExecution(
      await load<Campaign>(args[0]),
    );
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
    requireThat(
      args.length >= 4,
      "Usage: campaign-analyze <campaign.json> <human.json> <new-directory> <results.json> [<earlier-results.json> ...] [--comparisons comparisons.json]",
    );
    const bundles = await Promise.all(
      args.slice(3).map((f) => load<ResultBundle>(f)),
    );
    const analysis = analyzeCampaign(
      await load<Campaign>(args[0]),
      await load<HumanData>(args[1]),
      bundles,
      comparisons,
    );
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
    return;
  }
  if (command === "campaign-preflight") {
    requireThat(
      args.length === 2,
      "Usage: campaign-preflight <suite-or-campaign.json> <bindings.local.json>",
    );
    const value = await load<CampaignSuite | Campaign>(args[0]);
    const suite = value.schemaVersion === "xr-campaign/1" ? value.suite : value;
    const result = await preflightSuite(
      suite,
      await load<AssetBindings>(args[1]),
    );
    console.log(pretty(result));
    if (!result.ready) process.exitCode = 2;
    return;
  }
  if (command === "campaign-status") {
    requireThat(
      args.length >= 2,
      "Usage: campaign-status <campaign.json> <receipts.jsonl> [<earlier-receipts.jsonl> ...]",
    );
    const receipts = await loadReceipts(args.slice(1));
    console.log(
      pretty(campaignStatus(await load<Campaign>(args[0]), receipts)),
    );
    return;
  }
  if (command === "proposal") {
    requireThat(
      args[0] && args[1],
      "Use proposal <document.pdf|docx|md|txt> <new-directory> [--agent].",
    );
    const document = await extractProposal(args[0], await readFile(args[0]));
    const config = args.includes("--agent") ? readerConfig() : undefined;
    requireThat(
      !args.includes("--agent") || config,
      "Configure XR_PLANNER_* before using --agent.",
    );
    const reading = config
      ? await agentReading(document, config)
      : localReading(document);
    const out = await freshDirectory(args[1]);
    await writeFiles(out, {
      "extracted-proposal.txt": document.text,
      "reading.json": pretty(reading),
    });
    console.log(
      `Proposal reading saved to ${out}. Review it in the document-first workbench; no study was automatically frozen.`,
    );
    return;
  }
  if (command === "demo") {
    const study = exampleStudy(),
      agents = await proposeAgents(study),
      plan = freezePlan(study, withDefaultRuns(study, agents, 1), 1);
    const human = syntheticHumanData(study),
      results = syntheticResults(plan),
      report = analyze(plan, human, results);
    const out = await freshDirectory(
      args[0] ??
        "artifacts/demo-" + new Date().toISOString().replace(/[:.]/g, "-"),
    );
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
    requireThat(
      args[0] && args[1],
      "Usage: plan <study.json> <new-output-directory> [--agents protocols.json] [--repetitions N]",
    );
    const study = validateStudy(await load(args[0]));
    const ap = args.indexOf("--agents"),
      rp = args.indexOf("--repetitions");
    const agents =
      ap < 0
        ? await proposeAgents(study)
        : await load<AgentProtocol[]>(args[ap + 1]);
    const approval = await approvalState(args[0], study, ap < 0 ? undefined : agents);
    if (!approval.current)
      console.warn(
        approval.approved
          ? "Warning: the study or agents changed after the researcher approved them. Run `review` again."
          : "Warning: this study has not been approved in `review`. Freezing anyway; the plan records the exact files used.",
      );
    // --repetitions N = runs per participant (default 1); population configurations without their own count get participants × N.
    const perParticipant = rp < 0 ? 1 : Number(args[rp + 1]);
    const plan = freezePlan(study, withDefaultRuns(study, agents, perParticipant), perParticipant);
    const out = await freshDirectory(args[1]);
    await writeFiles(out, handoffFiles(plan));
    console.log(`Frozen ${plan.jobs.length} jobs in ${out}\n${plan.digest}`);
    return;
  }
  if (command === "brief") {
    requireThat(
      args[0] && args[1],
      "Usage: brief <study.json> <new-brief.json>",
    );
    await writeFile(
      args[1],
      pretty(planningBrief(validateStudy(await load(args[0])))),
      { flag: "wx" },
    );
    console.log("Planning brief exported; no LLM was called.");
    return;
  }
  if (command === "analyze") {
    requireThat(
      args.length === 4,
      "Usage: analyze <plan.json> <human.json> <results.json> <new-output-directory> [--comparisons comparisons.json]",
    );
    const r = analyze(
      await load<Plan>(args[0]),
      await load<HumanData>(args[1]),
      await load<ResultBundle>(args[2]),
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
    requireThat(
      args.length === 2,
      "Usage: unpack <handoff.json> <new-output-directory>",
    );
    const pack = await load<{ files: Record<string, string> }>(args[0]);
    requireThat(
      pack.files &&
        Object.values(pack.files).every((x) => typeof x === "string"),
      "Invalid handoff container.",
    );
    const manifest = JSON.parse(pack.files["manifest.json"]) as {
      files: Record<string, string>;
    };
    requireThat(
      Object.keys(pack.files).length === Object.keys(manifest.files).length + 1,
      "Handoff inventory mismatch.",
    );
    for (const [name, digest] of Object.entries(manifest.files))
      requireThat(
        typeof pack.files[name] === "string" &&
          createHash("sha256").update(pack.files[name]).digest("hex") ===
            digest,
        `Checksum mismatch: ${name}.`,
      );
    if (pack.files["campaign.json"]) {
      const campaign = JSON.parse(pack.files["campaign.json"]) as Campaign;
      verifyCampaign(campaign);
      requireThat(
        (manifest as { campaignDigest?: string }).campaignDigest ===
          campaign.digest,
        "Campaign manifest digest mismatch.",
      );
    } else {
      requireThat(
        pack.files["plan.json"],
        "Package contains neither a frozen plan nor a campaign.",
      );
      handoffFiles(JSON.parse(pack.files["plan.json"]) as Plan);
    }
    const out = await freshDirectory(args[1]);
    await writeFiles(out, pack.files);
    console.log(`Verified handoff unpacked into ${out}`);
    return;
  }
  console.log(
    "XR Study Sim — local HCI planning and analysis\n\nCommands:\n  demo [new-directory]\n  proposal <document.pdf|docx|md|txt> <new-directory> [--agent]\n  plan <study.json> <new-directory> [--agents protocols.json] [--repetitions N]\n  brief <study.json> <new-brief.json>\n  analyze <plan.json> <human.json> <results.json> <new-directory> [--comparisons comparisons.json]\n  unpack <handoff.json> <new-directory>\n  campaign-example <new-suite.json>\n  campaign-new <suite.json> <new-directory> <provider> <model> <reasoning>\n  campaign-rerun <previous-campaign.json> <new-directory> <provider> <model> <reasoning>\n  campaign-preflight <suite-or-campaign.json> <bindings.local.json>\n  campaign-status <campaign.json> <receipts.jsonl> [earlier-receipts.jsonl ...]\n  campaign-from-plan <plan.json> <new-directory> [provider model reasoning]\n  campaign-continue <previous-campaign.json> <changes.json> <new-directory> [--receipts receipts.jsonl ...]\n  campaign-verify <campaign.json> [parent-campaign.json]\n  campaign-mock <synthetic-campaign.json> <new-directory>\n  campaign-analyze <campaign.json> <human.json> <new-directory> <results.json> [earlier-results.json ...] [--comparisons comparisons.json]\n  campaign-compare <old-campaign.json> <old-scores.json> <new-campaign.json> <new-scores.json> <new-directory>\n\nUse npm start for the local workbench. External XR execution is an adapter contract.",
  );
}
main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
