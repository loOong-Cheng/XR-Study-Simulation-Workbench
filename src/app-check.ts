// app-check: a smoke test of a study's WebXR app without an agent (docs/runtime-adapters.md →
// "Before the first real session"). Each design is opened through the built-in runtime exactly as a
// session would open it; the check takes a screenshot, reads the state, lists objects, looks and
// points where the app declares it, runs the actions marked safe, and reads the audit trace the
// runtime wrote. Nothing is scored and no model runs.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Study } from "./core/types.js";
import { appActions, webxrCapabilities, webxrPointer, webxrPointerProblem, webxrSettleMs } from "./executor/runtimes.js";
import type { WorkspaceManifest } from "./workspace.js";

const runtime = resolve(dirname(fileURLToPath(import.meta.url)), "runtimes/webxr-mcp.js");

export interface DesignCheck {
  design: string;
  /** What will break sessions: a missing contract function, a state the runtime cannot read, a refused open. */
  problems: string[];
  /** What the check saw (the state, objects, replies) and what it could not check. */
  notes: string[];
  /** Screenshots the runtime took, in the check's folder. */
  screenshots: string[];
}

/** A stdio client for one runtime process. */
function client(jobDir: string) {
  const child = spawn(process.execPath, [runtime, jobDir], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    try {
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    } catch {
      // not a protocol line
    }
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok) => {
      const id = ++seq;
      waiting.set(id, ok);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { error: r.result?.isError === true || !!r.error, text: (r.result?.content?.find((c: any) => c.type === "text")?.text as string | undefined) ?? r.error?.message ?? "" };
  };
  const close = () => new Promise<void>((ok) => (child.on("exit", () => ok()), child.stdin!.end()));
  return { rpc, call, close };
}
const parse = (t: string): any => {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

/**
 * Open every design (or the one named) of a study's WebXR app through the runtime and report
 * problems per design. `out` is a new folder for the check's job folders (screenshots, trace).
 */
export async function appCheck(studyDir: string, study: Study, manifest: WorkspaceManifest, opts: { chromePath: string; out: string; design?: string }): Promise<DesignCheck[]> {
  const app = manifest.app;
  if (!app || typeof app.serve !== "string" || typeof app.query !== "string") throw new Error("workspace.json declares no WebXR app (app.serve and app.query).");
  if (!existsSync(opts.chromePath)) throw new Error(`Chrome not found at ${opts.chromePath}. Set the Chrome path in Settings (private/settings.json → chromePath).`);
  const designs = study.conditions.filter((c) => !opts.design || c.id === opts.design);
  if (!designs.length) throw new Error(`No design ${opts.design}. Designs: ${study.conditions.map((c) => c.id).join(", ")}.`);
  const caps = webxrCapabilities(manifest);
  const declared = (Array.isArray(app.actions) ? app.actions : []) as { name?: unknown; safe?: unknown; example?: unknown }[];
  const caseOf = (design: string, kind: string) => {
    const phase = study.phases.find((p) => p.kind === kind);
    const c = phase && study.cases.find((x) => x.conditionId === design && x.phaseId === phase.id);
    return c ? { caseId: c.id, phaseId: phase!.id } : null;
  };
  const results: DesignCheck[] = [];
  await mkdir(opts.out, { recursive: true });
  for (const d of designs) {
    const check: DesignCheck = { design: d.id, problems: [], notes: [], screenshots: [] };
    results.push(check);
    const jobDir = join(opts.out, d.id.replace(/[^A-Za-z0-9_-]/g, "_"));
    await mkdir(jobDir, { recursive: true });
    const entry = { id: d.id, label: d.label, practice: caseOf(d.id, "practice"), main: caseOf(d.id, "main") };
    await writeFile(
      join(jobDir, "job.json"),
      JSON.stringify({
        webxr: {
          jobId: `app-check-${d.id}`,
          budget: 1000,
          tokenBudget: null,
          chromePath: opts.chromePath,
          app: { dir: resolve(studyDir, app.serve), query: app.query },
          capabilities: caps,
          actions: appActions(manifest),
          participant: study.participants[0]?.id ?? null,
          designs: [entry],
          settleMs: webxrSettleMs(manifest),
          pointer: webxrPointer(manifest, `app-check-${d.id}`),
        },
      }),
    );
    const mcp = client(jobDir);
    try {
      await mcp.rpc("initialize", { protocolVersion: "2025-06-18" });
      const opened = await mcp.call("open_design", { design: d.id });
      if (opened.error) {
        check.problems.push(`open_design failed: ${opened.text}`);
        continue;
      }
      check.notes.push(opened.text.split("\n")[0].slice(0, 400));
      // The state as the agent sees it (phase, trial, done, instruction, public).
      const state = parse((await mcp.call("app_state")).text) ?? {};
      if (caps.includes("phase-events")) {
        if (typeof state.phase !== "string") check.problems.push('getState() reports no phase (a string), which phase-events needs: the runtime cannot tell practice from the main task.');
        if (typeof state.done !== "boolean") check.problems.push("getState() reports no done (true or false): the main task would never end.");
        if (state.trial === undefined) check.notes.push("getState() reports no trial number (optional; without phase \"practice\" the practice task ends when trial increases).");
      } else if (typeof state.done !== "boolean") check.problems.push("getState() reports no done (true or false): the main task would never end.");
      if (typeof state.instruction !== "string") check.notes.push("getState() reports no instruction (optional): the agent sees only what screenshots show.");
      if (entry.practice && state.phase !== "practice" && typeof state.trial !== "number")
        check.problems.push('The study has a practice task here, but after start() the app reports neither phase "practice" nor a trial number: the practice task could only end when done becomes true.');
      if (!entry.practice && state.phase === "practice")
        check.problems.push('The app starts in phase "practice", but the study has no practice task for this design: its practice answers would be recorded as the main task.');
      if (state.done === true) check.problems.push("The app reports done right after start(): the task is over before the agent acts.");
      const shot = await mcp.call("screenshot");
      if (shot.error) check.problems.push(`screenshot failed: ${shot.text}`);
      if (caps.includes("pointer-select")) {
        const objects = parse((await mcp.call("list_objects")).text);
        if (!Array.isArray(objects)) check.problems.push("list_objects failed.");
        else if (!objects.length) check.problems.push("listObjects() returned no objects: the agent has nothing to select.");
        else check.notes.push(`${objects.length} objects listed (${objects.filter((o: any) => o.visible !== false).length} visible).`);
      }
      if (caps.includes("look")) {
        const looked = await mcp.call("look", { azimuth: 0, polar: 90 });
        if (looked.error) check.problems.push(`look failed: ${looked.text}`);
      }
      if (caps.includes("pointer-xy")) {
        const pointed = parse((await mcp.call("point_at", { x: 0.5, y: 0.5 })).text);
        if (!pointed) check.problems.push("point_at failed.");
        else if (pointed.result?.over === "an object")
          check.notes.push('point_at: the app reports an object under the pointer, but has no listObjects(), so the agent is told only "an object" (no neutral ID).');
      }
      // Only actions the researcher marked safe (they change the task, so the rest are not run).
      const skipped = declared.filter((a) => typeof a?.name === "string" && a.safe !== true).map((a) => a.name as string);
      if (skipped.length) check.notes.push(`Not run: ${skipped.join(", ")} (an action marked "safe": true in workspace.json → app.actions, with "example" arguments, is run once).`);
      for (const a of declared) {
        if (typeof a?.name !== "string" || a.safe !== true) continue;
        const r = await mcp.call("act", { name: a.name, args: a.example && typeof a.example === "object" ? a.example : {} });
        if (r.error) check.problems.push(`act ${a.name} failed: ${r.text}`);
        else check.notes.push(`act ${a.name}: ${r.text.slice(0, 300)}`);
      }
      const after = parse((await mcp.call("app_state")).text) ?? {};
      check.notes.push(`State at the end: ${JSON.stringify(after).slice(0, 400)}`);
    } finally {
      await mcp.close();
    }
    // The audit trace the runtime wrote, as a session's would be.
    const events = existsSync(join(jobDir, "trace.jsonl"))
      ? (await readFile(join(jobDir, "trace.jsonl"), "utf8")).split("\n").map(parse).filter((l) => l?.event).map((l) => l.event)
      : [];
    for (const type of ["runtime", "phase", "case-start", "observation"])
      if (!events.some((e: any) => e.type === type)) check.problems.push(`The trace has no ${type} event.`);
    const shots = existsSync(join(jobDir, "screenshots")) ? readdirSync(join(jobDir, "screenshots")) : [];
    check.screenshots = shots.map((f) => join(jobDir, "screenshots", f));
  }
  const pointerProblem = webxrPointerProblem(manifest);
  if (pointerProblem && results[0]) results[0].problems.push(pointerProblem);
  return results;
}
