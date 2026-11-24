// Study MCP server given to every forecasting session (stdio).
//   node dist/runtimes/study-mcp.js <job-dir>
// Tools: list_files/read_file (only the permitted project folder), submit_forecast.
// Every call is logged in <job-dir>/trace.jsonl; accepted calls are counted in calls.log against the budget.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { agentFolderEntries, agentPath, realPath, windowsAliasProblem, within } from "./guard.js";
import { traceEvents, unfinishedCases } from "./exposure.js";
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
  app?: { designs?: { id: string }[]; cases?: { caseId: string; conditionId: string }[] };
  targets: {
    id: string;
    label: string;
    unit: string;
    scale: string;
    aggregation: string;
    components?: string[];
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
 * have been started and ended in the trace. Refused with the missing cases named, unless the
 * token budget is nearly used up or less than 10% of the tool budget is left; then the forecast
 * is accepted and the audit records the missing exposure.
 */
async function exposureGate(): Promise<void> {
  const required = (spec.app?.cases ?? []).map((c) => c.caseId);
  if (!required.length) return;
  const missing = unfinishedCases(required, await traceEvents(join(jobDir, "trace.jsonl")));
  if (!missing.length) return;
  const left = spec.budget - (await acceptedCalls(jobDir));
  const forced = (!!spec.tokenBudget && (await budgetNearlyUsed(jobDir, spec.tokenBudget))) || left < Math.max(1, Math.ceil(spec.budget * 0.1));
  if (forced) {
    await log({ tool: "submit_forecast", note: "accepted without required exposure (budget nearly used up)", missingCases: missing });
    return;
  }
  await log({ tool: "submit_forecast", ok: false, missingCases: missing });
  const designs = [...new Set(missing.map((id) => spec.app?.cases?.find((c) => c.caseId === id)?.conditionId).filter(Boolean))];
  throw new ToolError(
    `Forecast not accepted yet: experience the app first. These required tasks have not been started and finished: ${missing.join(", ")}` +
      (designs.length ? ` (designs ${designs.join(", ")})` : "") +
      ". Open each design in your order and complete its tasks, then submit your forecast.",
  );
}
// The permitted folder as it is on disk (symlinks resolved, on-disk names); every path is checked against it after resolving its own.
const projectRoot = (() => {
  try {
    return spec.projectDir ? realPath(spec.projectDir) : null;
  } catch {
    return null;
  }
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
        if (!(await stat(file)).isFile()) throw new ToolError("No such file.");
        const data = await readFile(file);
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
        { attemptId: spec.attemptId ?? null, measurements, uncertainty: args.uncertainty ?? null, reasoning: args.reasoning ?? null, submittedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    await log({ tool: "submit_forecast", ok: true, event: { type: "forecast" } });
    return text("Forecast accepted. You are done; end the session.");
  },
});
serveMcp("study", "0.4.0", tools);
