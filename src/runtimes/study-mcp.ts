// Study MCP server given to every forecasting session (stdio).
//   node dist/runtimes/study-mcp.js <job-dir>
// Tools: list_files/read_file (only the permitted project folder), submit_forecast.
// Every call is appended to <job-dir>/trace.jsonl and counted against the budget.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { agentFolderEntries, agentPath, realPath, windowsAliasProblem, within } from "./guard.js";
import { budgetNearlyUsed, serveMcp, text, ToolError, type Tool } from "./mcp.js";

export interface JobSpec {
  jobId: string;
  /** The executor's ID for this attempt, written into forecast.json: a forecast without it never counts. */
  attemptId?: string;
  budget: number;
  tokenBudget?: number | null;
  projectDir: string | null;
  participantId: string | null;
  designs: { id: string; label: string }[];
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
  await appendFile(join(jobDir, "calls.log"), tool + "\n");
  const used = (await readFile(join(jobDir, "calls.log"), "utf8")).trim().split("\n").length;
  if (tool !== "submit_forecast" && used > spec.budget)
    throw new ToolError(`Tool budget of ${spec.budget} calls is used up. Submit your forecast now with submit_forecast.`);
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
        // Only what read_file would give: no dot files, nothing hidden from agents, no links out.
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
          event: { type: "source", sourceId: "project", delivery: "read", sha256: sha(data) },
        });
        return text(data.toString("utf8").slice(0, 100_000));
      },
    },
  );
}
tools.push({
  name: "submit_forecast",
  description:
    "Submit your final forecast: one value for every design × outcome listed in the task (or the named items for composite outcomes). Call once, at the end.",
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
    const rows = Array.isArray(args.predictions) ? (args.predictions as Record<string, unknown>[]) : [];
    const problems: string[] = [];
    const seen = new Set<string>();
    const measurements: Record<string, unknown>[] = [];
    const designIds = new Set(spec.designs.map((d) => d.id));
    for (const r of rows) {
      const t = spec.targets.find((x) => x.id === r.outcome);
      const key = `${r.design}|${r.outcome}`;
      if (!t || !designIds.has(String(r.design))) {
        problems.push(`Unknown design/outcome ${key}.`);
        continue;
      }
      if (seen.has(key)) problems.push(`Duplicate ${key}.`);
      seen.add(key);
      let value: number | undefined;
      let components: Record<string, number> | undefined;
      if (t.components) {
        const items = (r.items ?? {}) as Record<string, number>;
        const missing = t.components.filter((c) => !Number.isFinite(items[c]));
        if (missing.length) problems.push(`${key} needs items ${missing.join(", ")}.`);
        components = Object.fromEntries(t.components.map((c) => [c, Number(items[c])]));
      } else {
        value = Number(r.value);
        if (!Number.isFinite(value)) problems.push(`${key} needs a numeric value.`);
        else if (t.scale === "proportion" && (value < 0 || value > 1)) problems.push(`${key} must be a proportion 0–1.`);
        else if (t.scale === "rank" && (value < 1 || value > spec.designs.length))
          problems.push(`${key} must be a rank from 1 to ${spec.designs.length}.`);
        else if (t.aggregation === "geometric" && value <= 0) problems.push(`${key} must be positive.`);
      }
      measurements.push({
        conditionId: r.design,
        outcomeId: r.outcome,
        ...(spec.participantId ? { participantId: spec.participantId } : {}),
        ...(components ? { components } : { value }),
      });
    }
    for (const d of spec.designs)
      for (const t of spec.targets) if (!seen.has(`${d.id}|${t.id}`)) problems.push(`Missing ${d.id}|${t.id}.`);
    if (problems.length) {
      await log({ tool: "submit_forecast", ok: false, problems: problems.slice(0, 20) });
      throw new ToolError(`Forecast not accepted. Fix and submit again:\n- ${problems.slice(0, 30).join("\n- ")}`);
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
