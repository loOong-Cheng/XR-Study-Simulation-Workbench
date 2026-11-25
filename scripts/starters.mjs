#!/usr/bin/env node
// Rebuild the starter campaign of every example suite (examples/<suite>/starter/) from the suite's
// current files: study.json, agents.json, workspace.json and the sources they name. Run it after
// changing a suite, and commit the files it rewrites; `npm test` fails while a starter is out of date.
// Plain Node on the built framework (npm run starters builds first). See src/starters.ts.
//
//   node scripts/starters.mjs           rebuild every starter that changed
//   node scripts/starters.mjs --check   change nothing; list out-of-date starters and exit 2 if any
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const flags = process.argv.slice(2);
const unknown = flags.filter((f) => f !== "--check");
if (unknown.length) {
  console.error(`Unknown option ${unknown[0]}. Usage: node scripts/starters.mjs [--check]`);
  process.exit(1);
}
const check = flags.includes("--check");
if (!existsSync(join(root, "dist", "starters.js"))) {
  console.error("The framework is not built (dist/ is missing). Run npm run starters, which builds first.");
  process.exit(1);
}
const { exampleSuites, starterProblems, writeStarter } = await import(pathToFileURL(join(root, "dist", "starters.js")).href);
let stale = 0;
for (const id of await exampleSuites()) {
  if (check) {
    const problems = await starterProblems(id);
    if (problems.length) stale++;
    console.log(`${id}: ${problems.length ? `OUT OF DATE (${problems.join("; ")})` : "current"}`);
    continue;
  }
  const r = await writeStarter(id);
  console.log(`${id}: ${r.changed ? "rebuilt" : "unchanged"} · ${r.campaignId} · ${r.sessions} sessions`);
}
if (check && stale) {
  console.log(`\n${stale} starter(s) out of date. Rebuild them with: npm run starters`);
  process.exit(2);
}
