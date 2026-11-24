#!/usr/bin/env node
// One-step machine setup, meant to be run by a coding agent (see AGENTS.md → "New machine").
// Installs dependencies, builds, finds Claude Code and Chrome, writes them into
// private/settings.json, and reports what is ready. Plain Node, no dependencies.
//
//   node scripts/setup.mjs            install (if needed), build, detect, write settings, report
//   node scripts/setup.mjs --test     also run the test suite
//   node scripts/setup.mjs --check    detect and report only; change nothing
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const win = process.platform === "win32";
const flags = new Set(process.argv.slice(2));
const check = flags.has("--check");
const problems = [];
const notes = [];
const say = (s = "") => console.log(s);
const run = (cmd, args, opts = {}) => {
  // On Windows, npm is npm.cmd and needs a shell. Pass one command line then: shell + an args
  // array is deprecated (DEP0190). Full paths (claude.exe) and shell:false run without a shell.
  const shell = opts.shell ?? (win && !cmd.includes("\\"));
  const base = { cwd: root, encoding: "utf8", timeout: 600_000, ...opts, shell };
  return shell ? spawnSync([cmd, ...args].join(" "), base) : spawnSync(cmd, args, base);
};

// 1 · Node
const [major, minor] = process.versions.node.split(".").map(Number);
say(`Node ${process.versions.node}`);
if (major < 22 || (major === 22 && minor < 13)) {
  problems.push("Node.js 22.13 or newer is needed. Install the current LTS (Windows: winget install OpenJS.NodeJS.LTS; macOS: brew install node), open a new terminal, and run setup again.");
  report();
}

// 2 · Dependencies and build
if (!check) {
  // A copied folder may carry node_modules from another machine (some packages ship platform binaries).
  const marker = join(root, "node_modules", ".xr-study-sim-platform");
  const platform = `${process.platform}-${process.arch}`;
  const installedFor = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  if (!existsSync(join(root, "node_modules")) || installedFor !== platform || flags.has("--install")) {
    say(installedFor && installedFor !== platform ? `Dependencies were installed on ${installedFor}; reinstalling for ${platform} (npm ci) …` : "Installing dependencies (npm ci) …");
    const r = run("npm", ["ci", "--no-audit", "--no-fund"], { stdio: "inherit" });
    if (r.status !== 0) problems.push("npm ci failed; see the output above.");
    else writeFileSync(marker, platform + "\n");
  }
  say("Building …");
  const b = run("npm", ["run", "build"], { stdio: "inherit" });
  if (b.status !== 0) problems.push("The build failed; see the output above.");
}
if (!existsSync(join(root, "dist", "settings.js"))) {
  problems.push("The framework is not built (dist/ is missing). Run setup without --check.");
  report();
}

// 3 · Claude Code
const which = (name) => {
  const r = win ? run("where", [name], { shell: false }) : run("sh", ["-c", `command -v ${name}`], { shell: false });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
};
const claudeCandidates = [
  ...which("claude"),
  join(homedir(), ".local", "bin", win ? "claude.exe" : "claude"),
  ...(win ? [join(process.env.LOCALAPPDATA ?? "", "Programs", "claude", "claude.exe")] : []),
].filter((p, i, a) => p && existsSync(p) && a.indexOf(p) === i);
// The executor starts Claude Code directly (no shell), so on Windows it needs claude.exe, not npm's claude.cmd.
const claudePath = claudeCandidates.find((p) => !win || p.toLowerCase().endsWith(".exe"));
let claudeVersion = "";
if (claudePath) {
  const v = run(claudePath, ["--version"], { shell: false, timeout: 30_000 });
  claudeVersion = (v.stdout || "").trim();
  if (v.status !== 0) problems.push(`Claude Code at ${claudePath} does not start: ${(v.stderr || "").trim().slice(0, 200)}`);
} else if (claudeCandidates.length) {
  problems.push(`Only ${claudeCandidates[0]} was found. Agent sessions need the native Claude Code (claude.exe): install it with the native installer.`);
} else {
  problems.push("Claude Code was not found. Install it with the native installer, run `claude` once and log in with your subscription.");
}
say(`Claude Code: ${claudePath ? `${claudePath} (${claudeVersion})` : "not found"}`);

// 4 · Chrome (WebXR runtime)
const chromeCandidates = win
  ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d, "Google", "Chrome", "Application", "chrome.exe"))
  : process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", join(homedir(), "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome")]
  : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].flatMap(which);
const chromePath = chromeCandidates.find((p) => existsSync(p));
say(`Chrome: ${chromePath ?? "not found"}`);
if (!chromePath) notes.push("Chrome was not found, so the WebXR suite can only be simulated. Install Google Chrome to run it for real.");

// 5 · Settings
const { readSettings, writeSettings } = await import(pathToFileURL(join(root, "dist", "settings.js")).href);
const settings = await readSettings();
const changes = [];
if (claudePath && settings.claudePath !== claudePath) (settings.claudePath = claudePath), changes.push(`claudePath = ${claudePath}`);
if (chromePath && settings.chromePath !== chromePath) (settings.chromePath = chromePath), changes.push(`chromePath = ${chromePath}`);
if (changes.length && !check) {
  await writeSettings(settings);
  say(`Settings written to private/settings.json: ${changes.join("; ")}`);
}

// 6 · Engine runtimes and the MCP servers Claude Code already knows
say("\nEngine runtimes (Settings → Runtimes):");
for (const id of ["unreal", "unity", "visionos"]) {
  const r = settings.runtimes[id] ?? {};
  say(`  ${id}: ${r.command ? `${r.command} ${(r.args ?? []).join(" ")}` : "not configured"}${r.capabilities?.length ? ` [${r.capabilities.join(", ")}]` : ""}`);
}
if (claudePath) {
  const m = run(claudePath, ["mcp", "list"], { shell: false, timeout: 60_000 });
  const text = `${m.stdout ?? ""}`.trim();
  say("\nMCP servers configured in Claude Code on this machine (candidates for an engine runtime):");
  say(text ? text.split(/\r?\n/).map((l) => `  ${l}`).join("\n") : "  (none listed)");
}

// 7 · Studies
const { listWorkspaces } = await import(pathToFileURL(join(root, "dist", "workspace.js")).href);
say("\nStudies:");
for (const w of await listWorkspaces())
  say(`  ${w.id}  ·  ${w.title}  ·  engine ${w.engine}${w.synthetic ? " · synthetic" : ""}${w.hasHuman ? " · human data" : ""} · ${w.campaigns} campaign(s)`);

// 8 · Tests
if (flags.has("--test") && !check) {
  say("\nRunning tests …");
  const t = run("npm", ["test"], { stdio: "inherit" });
  if (t.status !== 0) problems.push("Some tests failed; see the output above.");
}
report();

function report() {
  say("");
  for (const n of notes) say(`Note: ${n}`);
  if (problems.length) {
    for (const p of problems) say(`PROBLEM: ${p}`);
    say("\nSetup is not complete.");
    process.exit(1);
  }
  say("Setup complete. Start the website with `npm start` → http://127.0.0.1:4317");
  process.exit(0);
}
