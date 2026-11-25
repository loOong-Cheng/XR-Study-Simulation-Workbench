#!/usr/bin/env node
// One-step machine setup, meant to be run by a coding agent (see AGENTS.md → "New machine").
// Installs dependencies, builds, finds Claude Code, Chrome and Python, writes them into
// private/settings.json, installs the example suites' starter campaigns, and reports what is ready.
// Plain Node, no dependencies.
//
//   node scripts/setup.mjs            install (if needed), build, detect, write settings, report
//   node scripts/setup.mjs --test     also run the test suite
//   node scripts/setup.mjs --check    detect and report only; change nothing
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
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

// 5 · Python, for study bridges written in Python (Suite 2: examples/selection/runtime/bridge.py).
// A real interpreter only: on Windows `python` may be the Microsoft Store stub, which starts, prints
// "Python was not found" and exits, so each candidate must run a line of Python.
const pythonCandidates = win ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
let python = null;
for (const [cmd, pre] of pythonCandidates) {
  const r = run(cmd, [...pre, "-c", "import sys; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])"], { shell: false, timeout: 30_000 });
  const [exe, version] = `${r.stdout ?? ""}`.trim().split(/\r?\n/).map((s) => s.trim());
  if (r.status === 0 && exe && existsSync(exe) && Number(version?.split(".")[0]) >= 3) {
    python = { exe, version };
    break;
  }
}
say(`Python: ${python ? `${python.exe} (${python.version})` : "not found"}`);

// 6 · Settings
const { readSettings, writeSettings, settingsFile } = await import(pathToFileURL(join(root, "dist", "settings.js")).href);
const settings = await readSettings();
const changes = [];
if (claudePath && settings.claudePath !== claudePath) (settings.claudePath = claudePath), changes.push(`claudePath = ${claudePath}`);
if (chromePath && settings.chromePath !== chromePath) (settings.chromePath = chromePath), changes.push(`chromePath = ${chromePath}`);
// A bridge started with a bare `python`/`python3`/`py` gets this machine's interpreter by its full path.
for (const [id, r] of Object.entries(settings.runtimes ?? {})) {
  if (!r.command || !/^(python3?|py)(\.exe)?$/i.test(r.command)) continue;
  if (!python) {
    problems.push(`The ${id} runtime starts \`${r.command}\`, but no Python 3 was found. Install Python 3 (Windows: winget install Python.Python.3.12; macOS: brew install python) and run setup again.`);
    continue;
  }
  const args = /^py(\.exe)?$/i.test(r.command) && /^-\d/.test(r.args?.[0] ?? "") ? r.args.slice(1) : r.args;
  settings.runtimes[id] = { ...r, command: python.exe, args };
  changes.push(`runtimes.${id}.command = ${python.exe}`);
}
if (!python) notes.push("Python 3 was not found. Study bridges written in Python (Suite 2's examples/selection/runtime/bridge.py) need it; install Python 3 if you use one.");
const shownSettings = relative(root, settingsFile()).startsWith("..") ? settingsFile() : relative(root, settingsFile()).split("\\").join("/");
if (changes.length && !check) {
  await writeSettings(settings);
  say(`Settings written to ${shownSettings}: ${changes.join("; ")}`);
}

// 7 · Engine runtimes and the local MCP servers Claude Code already knows
say("\nEngine runtimes (Settings → Runtimes):");
for (const id of ["unreal", "unity", "visionos"]) {
  const r = settings.runtimes[id] ?? {};
  say(`  ${id}: ${r.command ? `${r.command} ${(r.args ?? []).join(" ")}` : "not configured"}${r.capabilities?.length ? ` [${r.capabilities.join(", ")}]` : ""}`);
}
if (python && !settings.runtimes.unity?.command)
  say(`  (Suite 2's Unity bridge: command ${python.exe}, arguments examples/selection/runtime/bridge.py {jobFile})`);
if (claudePath) {
  // `claude mcp list` prints "name: command args - status" per server. Only local stdio servers can
  // drive an engine on this machine: claude.ai connectors and remote (HTTP/SSE) servers are left out.
  const m = run(claudePath, ["mcp", "list"], { shell: false, timeout: 60_000 });
  const local = `${m.stdout ?? ""}`
    .split(/\r?\n/)
    .map((l) => l.match(/^(.+?): (.*) - (.+)$/))
    .filter((x) => x && !/^claude\.ai\b/i.test(x[1]) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(x[2].trim()) && !/\((HTTP|SSE|WS|WebSocket)\)\s*$/i.test(x[2]))
    .map(([, name, command]) => `  ${name}: ${command.trim()}`);
  say("\nLocal MCP servers in Claude Code (an engine's own MCP server a study bridge can drive):");
  say(local.length ? local.join("\n") : "  (none)");
}

// 8 · Long paths (Windows): run folders nest a study, a campaign, a job and its attempt, and Unity
// screenshots reach about 240 characters from a short checkout; Windows stops at 260 unless long
// paths are enabled (Python bridges, Unity logs and claude.exe's working folder are affected).
if (win) {
  const lp = run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem", "/v", "LongPathsEnabled"], { shell: false, timeout: 30_000 });
  const enabled = lp.status === 0 && /LongPathsEnabled\s+REG_DWORD\s+0x0*1\b/i.test(lp.stdout ?? "");
  const shorter = "a short folder such as C:\\xr-study-sim (not under OneDrive) avoids that";
  if (!enabled)
    notes.push(
      `Windows long paths are not enabled. Engine runs write files up to about ${180 + root.length} characters deep (Unity screenshots), and Windows refuses paths over 260 characters without them. Enable them once in an administrator PowerShell: New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force (then sign out and in).${root.length > 60 ? ` This folder's path is also long (${root.length} characters); ${shorter}.` : ""}`,
    );
  else if (root.length > 60)
    notes.push(`This folder's path is ${root.length} characters long. Long paths are enabled, but some engine tools still stop at 260 characters; ${shorter}.`);
}

// 9 · Starter campaigns: every example suite that has no campaign yet gets its ready-made starter
// (examples/<suite>/starter/, frozen at 1 run per participant), so Simulate and Start work at once.
// Once per study: a starter that was deleted is not installed again (campaigns/.starters.json).
if (!check) {
  const { installStarters } = await import(pathToFileURL(join(root, "dist", "starters.js")).href);
  const results = await installStarters();
  const installed = results.filter((r) => r.state === "installed");
  say("\nStarter campaigns (examples/<suite>/starter/):");
  for (const r of results)
    say(
      `  ${r.id}: ${
        r.state === "installed"
          ? `installed (${r.sessions} sessions)`
          : r.state === "installed-before"
            ? "installed earlier"
            : r.state === "has-campaigns"
              ? "not installed (the study has campaigns)"
              : r.message
      }`,
    );
  for (const r of results.filter((x) => x.state === "out-of-date")) notes.push(`${r.id}: ${r.message}`);
  if (installed.length) notes.push(`Installed ${installed.length} starter campaign(s): open a suite under Open study, then Run agents → Simulate (free) or one real session (Run this session only). See docs/testing-with-example-suites.md.`);
}

// 10 · Studies
const { listWorkspaces } = await import(pathToFileURL(join(root, "dist", "workspace.js")).href);
say("\nStudies:");
for (const w of await listWorkspaces())
  say(`  ${w.id}  ·  ${w.title}  ·  engine ${w.engine}${w.synthetic ? " · synthetic" : ""}${w.hasHuman ? " · human data" : ""} · ${w.campaigns} campaign(s)`);

// 11 · Tests
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
  // The port the website will use: XR_STUDY_PORT when set (also for `npm start`), else 4317.
  const port = Number(process.env.XR_STUDY_PORT) || 4317;
  say(`Setup complete. Start the website with \`npm start\` → http://127.0.0.1:${port}${process.env.XR_STUDY_PORT ? " (XR_STUDY_PORT)" : " (set XR_STUDY_PORT for another port)"}`);
  process.exit(0);
}
