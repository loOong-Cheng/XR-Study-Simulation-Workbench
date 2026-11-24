// Study MCP server given to every forecasting session (stdio).
//   node dist/runtimes/study-mcp.js <job-dir>
// Tools: list_files/read_file (only the permitted project folder), submit_forecast.
// Every call is appended to <job-dir>/trace.jsonl and counted against the budget.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { serveMcp, text, ToolError, type Tool } from "./mcp.js";

export interface JobSpec {
  jobId: string;
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

/** Tokens the session has used so far (the executor keeps <job>/usage.json current). */
async function tokensUsed(): Promise<number> {
  try {
    return Number(JSON.parse(await readFile(join(jobDir, "usage.json"), "utf8")).tokens) || 0;
  } catch {
    return 0;
  }
}
async function countCall(tool: string): Promise<void> {
  // The last 10% of the token budget is kept for submitting the forecast.
  if (tool !== "submit_forecast" && spec.tokenBudget && (await tokensUsed()) >= spec.tokenBudget * 0.9)
    throw new ToolError(`Token budget of ${spec.tokenBudget} tokens is nearly used up. Submit your forecast now with submit_forecast.`);
  await appendFile(join(jobDir, "calls.log"), tool + "\n");
  const used = (await readFile(join(jobDir, "calls.log"), "utf8")).trim().split("\n").length;
  if (tool !== "submit_forecast" && used > spec.budget)
    throw new ToolError(`Tool budget of ${spec.budget} calls is used up. Submit your forecast now with submit_forecast.`);
}
function inside(path: string): string {
  if (!spec.projectDir) throw new ToolError("This configuration has no access to project files.");
  const target = resolve(spec.projectDir, path || ".");
  if (target !== spec.projectDir && !target.startsWith(spec.projectDir + sep))
    throw new ToolError("Only the approved project folder can be read.");
  return target;
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
        const dir = inside(String(args.path ?? "."));
        const entries = await readdir(dir, { withFileTypes: true });
        await log({ tool: "list_files", path: relative(spec.projectDir!, dir) || "." });
        return text(
          entries
            .filter((e) => !e.name.startsWith("."))
            .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
            .join("\n") || "(empty)",
        );
      },
    },
    {
      name: "read_file",
      description: "Read one text file from the approved project folder (up to 100,000 characters).",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async handler(args) {
        await countCall("read_file");
        const file = inside(String(args.path ?? ""));
        if (!existsSync(file) || !(await stat(file)).isFile()) throw new ToolError("No such file.");
        const data = await readFile(file);
        await log({
          tool: "read_file",
          path: relative(spec.projectDir!, file),
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
        { measurements, uncertainty: args.uncertainty ?? null, reasoning: args.reasoning ?? null, submittedAt: new Date().toISOString() },
        null,
        2,
      ),
    );
    await log({ tool: "submit_forecast", ok: true, event: { type: "forecast" } });
    return text("Forecast accepted. You are done; end the session.");
  },
});
serveMcp("study", "0.4.0", tools);
