// Study MCP server given to every forecasting session (stdio).
//   node dist/runtimes/study-mcp.js <job-dir>
// Tools: list_files/read_file (only the permitted project folder), submit_forecast.
// Every call is logged in <job-dir>/trace.jsonl; accepted calls are counted in calls.log against the budget.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { agentFolderEntries, agentPath, readChecked, ReadRefused, realPath, windowsAliasProblem, within } from "./guard.js";
import { caseProgress, flushRuntime, traceEvents } from "./exposure.js";
import { acceptedCalls, budgetNearlyUsed, serveMcp, takeToolCall, text, ToolError, type Tool } from "./mcp.js";
import { checkForecast, submitDescription } from "../core/forecast-format.js";

export interface JobSpec {
  jobId: string;
  /** The executor's ID for this attempt, written into forecast.json: a forecast without it never counts. */
  attemptId?: string;
  budget: number;
  tokenBudget?: number | null;
  /** Submissions the session may make once its token budget is used up (the executor stops it after the last one is refused). */
  submitAttempts?: number;
  projectDir: string | null;
  /** The study's source ID of the project folder (older job files: "project"). */
  projectSourceId?: string | null;
  participantId: string | null;
  designs: { id: string; label: string }[];
  /** Configurations that use the app: the cases the protocol requires (bridge contract). */
  app?: {
    runtime?: string;
    designs?: { id: string; label?: string; practice?: { caseId: string } | null; main?: { caseId: string } | null }[];
    cases?: { caseId: string; conditionId: string; phaseId?: string }[];
  };
  /** The WebXR runtime's part of the job (only settleMs is read here: how long a flush may wait). */
  webxr?: { settleMs?: number };
  targets: {
    id: string;
    label: string;
    unit: string;
    scale: string;
    aggregation: string;
    range?: [number, number];
    components?: string[];
    componentRule?: "mean" | "sum";
    componentWeights?: Record<string, number>;
  }[];
}
const jobDir = resolve(process.argv[2] ?? ".");
const spec = JSON.parse(await readFile(join(jobDir, "job.json"), "utf8")) as JobSpec;
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const log = (entry: Record<string, unknown>) =>
  appendFile(join(jobDir, "trace.jsonl"), JSON.stringify({ t: Date.now(), server: "study", ...entry }) + "\n");
let submitted = false;

async function countCall(tool: string): Promise<void> {
  // The end of the token budget is kept for submitting the forecast (see budgetNearlyUsed).
  if (tool !== "submit_forecast" && spec.tokenBudget && (await budgetNearlyUsed(jobDir, spec.tokenBudget)))
    throw new ToolError(`Token budget of ${spec.tokenBudget} tokens is nearly used up. Submit your forecast now with submit_forecast.`);
  // Checked before it is written: a refused call is not counted (calls.log holds accepted calls only).
  if (!(await takeToolCall(jobDir, tool, spec.budget)))
    throw new ToolError(`Tool budget of ${spec.budget} calls is used up. Submit your forecast now with submit_forecast.`);
}
/**
 * The forecast comes after the app: for a configuration that uses it, every required case must
 * have been started and finished (a case-end with submitted: true) in the trace; a case left
 * unfinished does not count. Before judging, the WebXR runtime is asked to record a transition
 * still pending after the agent's last action. Refused with the missing cases named, unless the
 * token budget is nearly used up or less than 10% of the tool budget is left; then the forecast
 * is accepted and the audit records the missing exposure.
 */
async function exposureGate(): Promise<void> {
  const required = (spec.app?.cases ?? []).map((c) => c.caseId);
  if (!required.length) return;
  const progress = async () => caseProgress(required, await traceEvents(join(jobDir, "trace.jsonl")));
  let { missing, started } = await progress();
  // Only a task still open can finish late: ask the runtime when one of the missing tasks was started.
  if (started.length && spec.app?.runtime === "webxr") {
    const settle = typeof spec.webxr?.settleMs === "number" ? spec.webxr.settleMs : 3000;
    await flushRuntime(jobDir, Math.min(30_000, settle) + 8000);
    ({ missing, started } = await progress());
  }
  if (!missing.length) return;
  const left = spec.budget - (await acceptedCalls(jobDir));
  const forced = (!!spec.tokenBudget && (await budgetNearlyUsed(jobDir, spec.tokenBudget))) || left < Math.max(1, Math.ceil(spec.budget * 0.1));
  if (forced) {
    await log({ tool: "submit_forecast", note: "accepted without required exposure (budget nearly used up)", missingCases: missing });
    return;
  }
  await log({ tool: "submit_forecast", ok: false, missingCases: missing });
  throw new ToolError(
    // A task begun and then left (or still open) is named as such: it counts only once finished.
    `Forecast not accepted yet: experience the app first. Not done yet: ${missing.map((id) => (started.includes(id) ? `${taskInWords(id)}, started but not finished` : taskInWords(id))).join("; ")}. Open each design in your order and complete its tasks, then submit your forecast.`,
  );
}
/** A required task in plain words: "the main task of design Large (large-main)". */
function taskInWords(caseId: string): string {
  const c = spec.app?.cases?.find((x) => x.caseId === caseId);
  if (!c) return caseId;
  const d = spec.app?.designs?.find((x) => x.id === c.conditionId);
  // The design's name without a trailing explanation: "Low quality (flat, unlit colours)" → "Low quality".
  const full = d?.label ?? spec.designs.find((x) => x.id === c.conditionId)?.label ?? c.conditionId;
  const name = full.replace(/\s*\(.*\)\s*$/, "") || full;
  const task = d?.practice?.caseId === caseId ? "practice task" : d?.main?.caseId === caseId ? "main task" : c.phaseId ? `${c.phaseId} task` : "task";
  return `the ${task} of design ${name} (${caseId})`;
}
// The permitted folder as it is on disk (symlinks resolved, on-disk names); every path is checked against it after resolving its own.
const projectRoot = (() => {
  try {
    return spec.projectDir ? realPath(spec.projectDir) : null;
  } catch {
    return null;
  }
})();
/**
 * human.json files read_file never returns, compared by device and inode (see readChecked): the
 * one of the study this session belongs to (the first folder with a study.json above the attempt
 * folder) and one at the top of the project folder.
 */
const protectedFiles = (() => {
  const out = projectRoot ? [join(projectRoot, "human.json")] : [];
  for (let d = jobDir, up = dirname(d); up !== d; d = up, up = dirname(d))
    if (existsSync(join(d, "study.json"))) {
      out.push(join(d, "human.json"));
      break;
    }
  return out;
})();
/** Project-relative path for the trace, with "/" on every system. */
const shown = (p: string) => relative(projectRoot!, p).split(sep).join("/") || ".";
function inside(path: string, what: "file" | "folder"): string {
  if (!spec.projectDir) throw new ToolError("This configuration has no access to project files.");
  if (!projectRoot) throw new ToolError("The project folder is not available on this machine.");
  const target = resolve(projectRoot, path || ".");
  if (!within(projectRoot, target)) throw new ToolError("Only the approved project folder can be read.");
  // On Windows "human.json." or "human.json::$DATA" would open human.json.
  if (windowsAliasProblem(path)) throw new ToolError("This path is not available to agents.");
  // Symlinks may not lead out of the folder, and human results or run records are never given out.
  const real = agentPath(projectRoot, target);
  if (!real) throw new ToolError(existsSync(target) && within(projectRoot, target) ? "This path is not available to agents." : `No such ${what}.`);
  return real;
}
const tools: Tool[] = [];
if (spec.projectDir) {
  tools.push(
    {
      name: "list_files",
      description: "List files in the approved project folder (or a subfolder).",
      inputSchema: { type: "object", properties: { path: { type: "string", description: "Subfolder, default the project root" } } },
      async handler(args) {
        await countCall("list_files");
        const dir = inside(String(args.path ?? "."), "folder");
        if (!(await stat(dir)).isDirectory()) throw new ToolError("No such folder.");
        // Only what read_file would give: no dot files or OS clutter, nothing hidden from agents, no links out.
        const entries = await agentFolderEntries(dir, projectRoot!);
        await log({ tool: "list_files", path: shown(dir) });
        return text(entries.join("\n") || "(empty)");
      },
    },
    {
      name: "read_file",
      description: "Read one text file from the approved project folder (up to 100,000 characters).",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async handler(args) {
        await countCall("read_file");
        const file = inside(String(args.path ?? ""), "file");
        // The open file is checked, not the path again: a file swapped in after the check is refused.
        let data: Buffer;
        try {
          data = await readChecked(file, { protect: protectedFiles });
        } catch (e) {
          if (!(e instanceof ReadRefused)) throw e;
          throw new ToolError(e.reason === "missing" || e.reason === "not-file" ? "No such file." : "This path is not available to agents.");
        }
        await log({
          tool: "read_file",
          path: shown(file),
          event: { type: "source", sourceId: spec.projectSourceId || "project", delivery: "read", sha256: sha(data) },
        });
        return text(data.toString("utf8").slice(0, 100_000));
      },
    },
  );
}
/** Submissions refused after the token budget ran out; the executor ends the session after spec.submitAttempts of them. */
let lateRejections = 0;
tools.push({
  name: "submit_forecast",
  // The row shape and, per measure, exactly what it needs (the item IDs of composite measures).
  description: submitDescription(
    spec.designs.map((d) => d.id),
    spec.targets,
  ),
  inputSchema: {
    type: "object",
    properties: {
      predictions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            design: { type: "string" },
            outcome: { type: "string" },
            value: { type: "number" },
            items: { type: "object", additionalProperties: { type: "number" } },
          },
          required: ["design", "outcome"],
        },
      },
      uncertainty: { type: "string", description: "How sure you are and why" },
      reasoning: { type: "string", description: "Brief basis for the forecast" },
    },
    required: ["predictions"],
  },
  async handler(args) {
    await countCall("submit_forecast");
    if (submitted) throw new ToolError("The forecast was already accepted. End the session.");
    await exposureGate();
    const rows = Array.isArray(args.predictions) ? (args.predictions as Record<string, unknown>[]) : [];
    // Everything to fix at once, per measure (see checkForecast).
    const { problems, measurements } = checkForecast(
      rows,
      spec.designs.map((d) => d.id),
      spec.targets,
      spec.participantId,
    );
    if (!rows.length) problems.unshift(`"predictions" is empty: give one row per design × outcome.`);
    if (problems.length) {
      await log({ tool: "submit_forecast", ok: false, problems: problems.slice(0, 20) });
      // Once the token budget is used up, the session has a few attempts left (the executor ends it after the last).
      const late = spec.tokenBudget && spec.submitAttempts && (await budgetNearlyUsed(jobDir, spec.tokenBudget)) ? ++lateRejections : 0;
      const left = late ? Math.max(0, spec.submitAttempts! - late) : null;
      throw new ToolError(
        `Forecast not accepted. Fix everything below and submit all rows again in one call:\n- ${problems.join("\n- ")}` +
          (left === null ? "" : left ? `\nThe token budget is used up: ${left} more attempt${left === 1 ? "" : "s"}.` : "\nThe token budget is used up and this was the last attempt."),
      );
    }
    submitted = true;
    await writeFile(
      join(jobDir, "forecast.json"),
      JSON.stringify(
        // toolCalls: the calls counted up to this moment (calls.log); the audit's tool budget covers these, later calls are reported apart.
        { attemptId: spec.attemptId ?? null, measurements, uncertainty: args.uncertainty ?? null, reasoning: args.reasoning ?? null, submittedAt: new Date().toISOString(), toolCalls: await acceptedCalls(jobDir) },
        null,
        2,
      ),
    );
    await log({ tool: "submit_forecast", ok: true, event: { type: "forecast" } });
    return text("Forecast accepted. You are done; end the session.");
  },
});
serveMcp("study", "0.4.0", tools);
