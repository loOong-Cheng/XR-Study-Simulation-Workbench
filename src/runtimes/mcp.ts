// Minimal MCP server over stdio (JSON-RPC 2.0, one message per line). Only
// protocol messages may go to stdout; diagnostics go to stderr.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<Content[]>;
}
export class ToolError extends Error {}
/** Upper limit for one tool call, so an agent never waits on a silent server (the CLI's own limit is far longer). */
const TOOL_LIMIT_MS = 180_000;

export function serveMcp(name: string, version: string, tools: Tool[], onExit?: () => Promise<void> | void) {
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = (result: unknown) => msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, result });
    const fail = (code: number, message: string) =>
      msg.id !== undefined && send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name, version },
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        });
      case "tools/call": {
        const tool = tools.find((t) => t.name === msg.params?.name);
        if (!tool) return fail(-32602, `Unknown tool ${String(msg.params?.name)}`);
        try {
          let timer: NodeJS.Timeout | undefined;
          const watchdog = new Promise<never>((_, fail) => {
            timer = setTimeout(() => fail(new ToolError(`${tool.name} took longer than ${TOOL_LIMIT_MS / 1000} s and was abandoned; try again.`)), TOOL_LIMIT_MS);
          });
          const content = await Promise.race([tool.handler((msg.params?.arguments as Record<string, unknown>) ?? {}), watchdog]).finally(() => clearTimeout(timer));
          return reply({ content });
        } catch (e) {
          return reply({ content: [{ type: "text", text: (e as Error).message }], isError: true });
        }
      }
      default:
        if (msg.id !== undefined) fail(-32601, `Method not found: ${msg.method}`);
    }
  });
  rl.on("close", async () => {
    await onExit?.();
    process.exit(0);
  });
}
export const text = (t: string): Content[] => [{ type: "text", text: t }];

/**
 * Whether a session's token budget is nearly used, from <job>/usage.json, which the executor keeps
 * current: it sets submitNow once what is left is smaller than 10% of the budget or 3.5 × the last
 * turn's input (the submission, a possible second one and the closing turn each re-read the
 * context). 90% used always counts, for older executors.
 */
export async function budgetNearlyUsed(jobDir: string, budget: number): Promise<boolean> {
  try {
    const usage = JSON.parse(await readFile(join(jobDir, "usage.json"), "utf8")) as { tokens?: number; submitNow?: boolean };
    return usage.submitNow === true || (Number(usage.tokens) || 0) >= budget * 0.9;
  } catch {
    return false;
  }
}
