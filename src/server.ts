import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { analyze } from "./core/analyzer.js";
import {
  exampleStudy,
  syntheticHumanData,
  syntheticResults,
} from "./core/example.js";
import {
  freezePlan,
  handoffFiles,
  planningBrief,
  proposeAgents,
} from "./core/planner.js";
import { validateAgents, validateStudy } from "./core/validation.js";
import { hash } from "./core/planner.js";
import { approvalState, approve, readReviewFiles } from "./review.js";
import { handleGet, handlePost } from "./routes.js";

// Review mode: `cli review <study.json> [--agents agents.json]` sets these. The
// server only ever writes to these two files (and the study's approval record).
const reviewStudy = process.env.XR_REVIEW_STUDY;
let reviewAgents = process.env.XR_REVIEW_AGENTS;
// Paths inside the working directory are shown relative to it; others in full.
const display = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
};
async function reviewState() {
  if (!reviewStudy) return { active: false };
  const { study, agents } = await readReviewFiles(reviewStudy, reviewAgents);
  return {
    active: true,
    studyPath: display(reviewStudy),
    agentsPath: reviewAgents ? display(reviewAgents) : null,
    study,
    agents: agents ?? null,
    ...(await approvalState(reviewStudy, study, agents)),
  };
}
import { reportCSV, reportHTML } from "./core/report.js";
import {
  campaignFiles,
  campaignFromPlan,
  campaignStatus,
  campaignSummary,
  continueCampaign,
  continueFromStatus,
  freezeCampaign,
  rerunCampaign,
  type Campaign,
  type CampaignContinuation,
  type CampaignModel,
  type CampaignReceipt,
} from "./core/campaign.js";
import { syntheticCampaignSuite } from "./core/campaign-presets.js";
import {
  analyzeCampaign,
  syntheticCampaignExecution,
} from "./core/campaign-study.js";
import { compareCampaignScores } from "./core/campaign-comparison.js";
import {
  extractProposal,
  textDocument,
  localReading,
  agentReading,
  readerConfig,
  compileProposal,
  type ProposalReview,
} from "./core/proposal.js";
import type {
  AgentProtocol,
  Comparison,
  AnalysisReport,
  HumanData,
  Plan,
  ResultBundle,
} from "./core/types.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.XR_STUDY_PORT ?? 4317);
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  );
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  try {
    const path = new URL(req.url ?? "/", `http://127.0.0.1:${port}`).pathname;
    if (req.method === "GET") {
      if (path.startsWith("/api/") && (await handleGet(path, new URL(req.url ?? "/", `http://127.0.0.1:${port}`), res, json))) return;
      if (path === "/api/campaign/suite") {
        json(syntheticCampaignSuite());
        return;
      }
      if (path === "/api/review") {
        json(await reviewState());
        return;
      }
      if (path === "/api/example") {
        const reader = readerConfig();
        json({
          study: exampleStudy(),
          version: "0.3.0",
          reader: reader
            ? {
                available: true,
                provider: reader.provider,
                model: reader.model,
                endpoint: new URL(reader.baseURL).origin,
              }
            : { available: false },
          runtimeStatus:
            "Synthetic worker only; Unreal/Unity adapters execute externally.",
        });
        return;
      }
      const routes: Record<string, [string, string]> = {
        "/": [join(root, "public/index.html"), "text/html"],
        "/app.css": [join(root, "public/app.css"), "text/css"],
        "/app.js": [join(root, "dist/web/app.js"), "text/javascript"],
        "/plots.js": [join(root, "dist/web/plots.js"), "text/javascript"],
      };
      const route = routes[path];
      if (!route) {
        json({ error: "Not found" }, 404);
        return;
      }
      res.writeHead(200, { "Content-Type": route[1] + "; charset=utf-8" });
      res.end(await readFile(route[0]));
      return;
    }
    if (req.method !== "POST") {
      json({ error: "Method not allowed" }, 405);
      return;
    }
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]).has(
        origin,
      )
    ) {
      json({ error: "Use the local workbench origin." }, 403);
      return;
    }
    // Runs zips (with screenshots) and documents may be large; everything else is small.
    const limit = path === "/api/runs/import" || path === "/api/assistant/understand" ? 400 * 1024 * 1024 : 12 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        json({ error: `Request exceeds ${Math.round(limit / 1048576)} MB.` }, 413);
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(raw) as Record<string, unknown>;
    if (path.startsWith("/api/") && (await handlePost(path, body, json))) return;
    if (path === "/api/review/save" || path === "/api/review/approve") {
      if (!reviewStudy) throw new Error("Start the workbench with `node dist/cli.js review <study.json>` to save a reviewed study.");
      const study = validateStudy(body.study);
      const agents = Array.isArray(body.agents)
        ? validateAgents(study, body.agents as AgentProtocol[])
        : undefined;
      if (path === "/api/review/save") {
        await writeFile(reviewStudy, JSON.stringify(study, null, 2) + "\n");
        if (agents) {
          reviewAgents ??= reviewStudy.replace(/\.json$/i, "") + ".agents.json";
          await writeFile(reviewAgents, JSON.stringify(agents, null, 2) + "\n");
        }
      } else {
        const onDisk = await readReviewFiles(reviewStudy, reviewAgents);
        if (
          hash(onDisk.study) !== hash(study) ||
          (agents && (!onDisk.agents || hash(onDisk.agents) !== hash(agents)))
        )
          throw new Error("Save your changes to the files before approving.");
        await approve(reviewStudy, study, onDisk.agents, typeof body.note === "string" ? body.note.slice(0, 2000) : "");
      }
      json(await reviewState());
      return;
    }
    if (path === "/api/campaign/new") {
      json(freezeCampaign(body.suite, body.model as CampaignModel));
      return;
    }
    if (path === "/api/campaign/rerun") {
      json(
        rerunCampaign(body.campaign as Campaign, body.model as CampaignModel),
      );
      return;
    }
    if (path === "/api/campaign/from-plan") {
      json(
        campaignFromPlan(
          body.plan as Plan,
          (body.model as CampaignModel | undefined) ?? undefined,
        ),
      );
      return;
    }
    if (path === "/api/campaign/continue") {
      json(
        Array.isArray(body.receipts)
          ? continueFromStatus(
              body.campaign as Campaign,
              body.receipts as CampaignReceipt[],
              body.changes as CampaignContinuation,
            )
          : continueCampaign(
              body.campaign as Campaign,
              body.changes as CampaignContinuation,
            ),
      );
      return;
    }
    if (path === "/api/campaign/summary") {
      json(campaignSummary(body.campaign as Campaign));
      return;
    }
    if (path === "/api/campaign/mock") {
      const c = body.campaign as Campaign;
      const run = syntheticCampaignExecution(c);
      // Mock runs are synthetic only, so the invented human reference is safe to return with them.
      json({ ...run, human: syntheticHumanData(c.suite.study!) });
      return;
    }
    if (path === "/api/campaign/analyze") {
      json(
        analyzeCampaign(
          body.campaign as Campaign,
          body.human as HumanData,
          body.results as ResultBundle[],
          body.comparisons as Comparison[] | undefined,
        ),
      );
      return;
    }
    if (path === "/api/campaign/compare") {
      json(
        compareCampaignScores(
          body.before as Campaign,
          body.beforeScores as Parameters<typeof compareCampaignScores>[1],
          body.after as Campaign,
          body.afterScores as Parameters<typeof compareCampaignScores>[3],
        ),
      );
      return;
    }
    if (path === "/api/campaign/handoff") {
      json({ files: campaignFiles(body.campaign as Campaign) });
      return;
    }
    if (path === "/api/campaign/status") {
      json(
        campaignStatus(
          body.campaign as Campaign,
          body.receipts as CampaignReceipt[],
        ),
      );
      return;
    }
    if (path === "/api/proposal/extract") {
      if (typeof body.name !== "string" || typeof body.base64 !== "string")
        throw new Error("Choose a proposal document.");
      json(
        await extractProposal(body.name, Buffer.from(body.base64, "base64")),
      );
      return;
    }
    if (path === "/api/proposal/read") {
      const source = body.document as { name: string; text: string };
      const document = textDocument(source.name, source.text);
      if (body.mode === "agent") {
        const config = readerConfig();
        if (!config)
          throw new Error(
            "Configure XR_PLANNER_PROVIDER, XR_PLANNER_MODEL and XR_PLANNER_API_KEY on the local server, or use the local helper.",
          );
        json(await agentReading(document, config));
      } else if (body.mode === "local") json(localReading(document));
      else throw new Error("Choose agent or local reader mode.");
      return;
    }
    if (path === "/api/proposal/compile") {
      const study = compileProposal(body.review as ProposalReview);
      json({ study, agents: await proposeAgents(study) });
      return;
    }
    if (path === "/api/propose") {
      json({ agents: await proposeAgents(body.study) });
      return;
    }
    if (path === "/api/brief") {
      json(planningBrief(validateStudy(body.study)));
      return;
    }
    if (path === "/api/freeze") {
      json(
        freezePlan(
          body.study,
          body.agents as AgentProtocol[],
          body.repetitions === undefined ? 3 : Number(body.repetitions),
        ),
      );
      return;
    }
    if (path === "/api/handoff") {
      json({ files: handoffFiles(body.plan as Plan) });
      return;
    }
    if (path === "/api/demo") {
      const plan = body.plan as Plan;
      const human = syntheticHumanData(plan.study),
        results = syntheticResults(plan, body.includeViolation === true);
      json({
        human,
        results,
        report: analyze(plan, human, results, body.comparisons as Comparison[] | undefined),
      });
      return;
    }
    if (path === "/api/analyze") {
      json(
        analyze(
          body.plan as Plan,
          body.human as HumanData,
          body.results as ResultBundle,
          body.comparisons as Comparison[] | undefined,
        ),
      );
      return;
    }
    if (path === "/api/report") {
      const r = body.report as AnalysisReport;
      json({ html: reportHTML(r), csv: reportCSV(r) });
      return;
    }
    json({ error: "Not found" }, 404);
  } catch (error) {
    json({ error: (error as Error).message }, 400);
  }
});
server.on("error", (error) => {
  console.error(
    `Could not open the local workbench on port ${port}: ${error.message}\nChoose another port with XR_STUDY_PORT if it is already in use.`,
  );
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    `XR Study Sim — http://127.0.0.1:${port}\nLocal planning and analysis. Optional proposal-reader calls occur only when requested. XR execution remains external.`,
  ),
);
