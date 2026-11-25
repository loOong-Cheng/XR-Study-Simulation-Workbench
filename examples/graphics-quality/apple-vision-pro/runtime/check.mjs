#!/usr/bin/env node
// Checks the visionOS app and bridge without an agent, as app-check does for WebXR apps: opens each
// design through the bridge in the simulator, takes a screenshot, reads the state, lists the
// objects, turns the view and takes another screenshot. Prints where the screenshots are; exits
// with 2 when something fails. No Claude usage.
//   node examples/graphics-quality/apple-vision-pro/runtime/check.mjs [--design high] [--app <GraphicsQuality.app>] [--device <name or UDID>]
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const study = JSON.parse(await readFile(join(here, "..", "study.json"), "utf8"));
const only = opt("--design");
const designs = study.conditions.filter((c) => !only || c.id === only);
if (!designs.length) {
  console.error(`Unknown design ${only}. Designs: ${study.conditions.map((c) => c.id).join(", ")}`);
  process.exit(2);
}
const caseOf = (id, phase) => {
  const c = study.cases.find((x) => x.conditionId === id && x.phaseId === phase);
  return c ? { caseId: c.id, phaseId: c.phaseId } : null;
};
const jobDir = await mkdtemp(join(tmpdir(), "xr-visionos-check-"));
await writeFile(
  join(jobDir, "job.json"),
  JSON.stringify({
    jobId: "visionos-check",
    budget: 1000,
    tokenBudget: null,
    participantId: study.participants[0]?.id ?? null,
    app: {
      runtime: "visionos",
      observation: "mono",
      trace: join(jobDir, "trace.jsonl"),
      screenshots: join(jobDir, "screenshots"),
      designs: designs.map((d) => ({ id: d.id, label: d.label, practice: caseOf(d.id, "practice"), main: caseOf(d.id, "main") })),
      cases: study.cases.filter((c) => designs.some((d) => d.id === c.conditionId)).map((c) => ({ caseId: c.id, conditionId: c.conditionId, phaseId: c.phaseId, requiredActions: c.requiredActions })),
    },
  }),
);
const passOn = ["--app", "--device"].flatMap((n) => (opt(n) ? [n, opt(n)] : []));
const bridge = spawn(process.execPath, [join(here, "bridge.mjs"), join(jobDir, "job.json"), ...passOn], { stdio: ["pipe", "pipe", "pipe"] });
const log = [];
bridge.stderr.on("data", (d) => log.push(String(d)));
const waiting = new Map();
let seq = 0;
createInterface({ input: bridge.stdout }).on("line", (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
  waiting.delete(m.id);
});
const rpc = (method, params = {}) =>
  new Promise((ok) => {
    const id = ++seq;
    waiting.set(id, ok);
    bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const problems = [];
const call = async (name, a = {}) => {
  const r = await rpc("tools/call", { name, arguments: a });
  const text = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");
  if (r.result?.isError) problems.push(`${name}: ${text}`);
  return { ...r.result, text };
};
await rpc("initialize", { protocolVersion: "2025-06-18" });
await rpc("tools/list");
for (const d of designs) {
  console.log(`\n## ${d.id}\n`);
  const opened = await call("open_design", { design: d.id });
  console.log(`- ${opened.text}`);
  if (opened.isError) continue;
  await call("screenshot");
  const objects = JSON.parse((await call("list_objects")).text || "[]");
  const placed = objects.filter((o) => o.onScreen);
  console.log(`- ${objects.length} objects listed (${placed.length} on screen).`);
  if (objects.length && !placed.length) problems.push(`${d.id}: no object is on screen (calibration or view).`);
  const looked = await call("look", { azimuth: 30, polar: 60 });
  console.log(`- look: ${looked.text}`);
  await call("screenshot");
  console.log(`- State: ${(await call("app_state")).text}`);
}
bridge.stdin.end();
await new Promise((r) => bridge.on("exit", r));
const trace = (await readFile(join(jobDir, "trace.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).event).filter(Boolean);
const kinds = new Set(trace.map((e) => e.type));
for (const k of ["runtime", "phase", "case-start", "observation", "action"]) if (!kinds.has(k)) problems.push(`The trace has no "${k}" event.`);
const shots = await readdir(join(jobDir, "screenshots")).catch(() => []);
console.log(`\nScreenshots: ${join(jobDir, "screenshots")} (${shots.length})`);
const calibration = log.join("").split("\n").filter((l) => /calibrated/.test(l));
if (calibration.length) console.log(`Calibration: ${calibration.at(-1).replace(/^\[visionos-bridge\] /, "")}`);
if (problems.length) {
  console.log(`\nProblems:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  console.log(`\nBridge log (last lines):\n${log.join("").split("\n").slice(-15).join("\n")}`);
  process.exit(2);
}
console.log("\nEvery design opened in the simulator, and the bridge could read the app. Look at the screenshots; then run one real session (Run this session only).");
