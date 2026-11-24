// Security of the local workbench: who may call it, what agents may read, which paths sources and
// zips may reach, and that bad requests get plain messages. Throw-away studies live under
// private/studies/__test-… and are removed afterwards.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, linkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan } from "../src/core/campaign.js";
import { validateStudy } from "../src/core/validation.js";
import type { AgentProtocol, Study } from "../src/core/types.js";
import { until } from "./until.js";

const JSZip = createRequire(import.meta.url)("jszip") as typeof import("jszip");
const sha = (x: Buffer | string) => createHash("sha256").update(x).digest("hex");
const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
// Servers started here end with the tests, also when an assertion failed before a test closed them.
const children = new Set<ChildProcess>();
const own = <T extends ChildProcess>(child: T): T => (children.add(child), child.once("exit", () => children.delete(child)), child);
after(() => children.forEach((c) => c.kill()));
async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = existsSync(join(from, "workspace.json")) ? JSON.parse(await readFile(join(from, "workspace.json"), "utf8")) : {};
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}
/** Symlinks need extra rights on Windows; tests that need them are skipped there when refused. */
async function link(target: string, path: string, type: "file" | "dir" = "file") {
  try {
    await symlink(target, path, type === "dir" ? "junction" : "file");
    return true;
  } catch {
    return false;
  }
}
async function setManifestSources(dir: string, sources: Record<string, string>) {
  const m = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
  m.sources = { ...m.sources, ...sources };
  await writeFile(join(dir, "workspace.json"), JSON.stringify(m, null, 2));
}
/** A small plan: only the text-only configuration (planned contrasts between configurations left out). */
function smallPlan(ws: { study: Study; agents: AgentProtocol[] | null }, repetitions: number) {
  const study = { ...ws.study, analysis: { ...ws.study.analysis, contrasts: [] } };
  return freezePlan(study, ws.agents!.filter((x) => x.id === "text-only").map((x) => ({ ...x, repetitions })), 1);
}

// ---------- 2. Host / Origin, 11. typed requests and plain errors (real server on a spare port) ----------

function call(port: number, path: string, opts: { method?: string; host?: string; origin?: string; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((ok, fail) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { Host: opts.host ?? `127.0.0.1:${port}`, ...(opts.origin ? { Origin: opts.origin } : {}), ...(opts.body ? { "Content-Type": "application/json" } : {}) } },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
        // The event stream never ends; the first chunk is enough.
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) res.once("data", () => (res.destroy(), ok({ status: res.statusCode ?? 0, body: "stream" })));
      },
    );
    req.on("error", fail);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
async function startServer(settings: string): Promise<{ port: number; proc: ChildProcess }> {
  for (let tries = 0; tries < 5; tries++) {
    const port = 41000 + Math.floor(Math.random() * 15000);
    const proc = own(spawn(process.execPath, [resolve("dist/server.js")], { env: { ...process.env, XR_STUDY_PORT: String(port), XR_STUDY_SETTINGS: settings }, stdio: ["ignore", "pipe", "pipe"] }));
    const up = await new Promise<boolean>((ok) => {
      createInterface({ input: proc.stdout! }).on("line", (l) => /XR Study Sim/.test(l) && ok(true));
      proc.on("exit", () => ok(false));
      setTimeout(() => ok(false), 60_000).unref(); // a slow CI runner; never keeps the tests waiting
    });
    if (up) return { port, proc };
    proc.kill();
  }
  throw new Error("Could not start the test server.");
}

test("server: every request must name this machine as host; POSTs need the local origin; bad requests get plain messages", async () => {
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  const a = await tempWorkspace(resolve("examples/selection"));
  const { port, proc } = await startServer(join(cfg, "settings.json"));
  try {
    // DNS rebinding: a page of another site that resolves to 127.0.0.1 sends its own name as Host.
    for (const path of ["/", "/app.js", "/api/settings", "/api/workspaces", `/api/executor/events?id=${encodeURIComponent(a.id)}&campaign=x`, `/api/runs/export?id=${encodeURIComponent(a.id)}&campaign=x`]) {
      const r = await call(port, path, { host: `attacker.example:${port}` });
      assert.equal(r.status, 403, path);
      assert.match(r.body, /Open the workbench at http:\/\/127\.0\.0\.1/);
    }
    assert.equal((await call(port, "/api/settings", { host: "127.0.0.1.attacker.example" })).status, 403);
    assert.equal((await call(port, "/api/settings", { method: "POST", host: `attacker.example:${port}`, body: "{}" })).status, 403);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, "localhost"]) assert.equal((await call(port, "/api/workspaces", { host })).status, 200, host);
    // POST from another origin, even with the right host.
    const cross = await call(port, "/api/workspace/campaign-label", { method: "POST", origin: "http://attacker.example", body: JSON.stringify({ id: a.id, campaignId: "x", label: "y" }) });
    assert.equal(cross.status, 403);
    // Wrong types: plain messages, no JavaScript errors, nothing converted.
    const post = (path: string, body: unknown) => call(port, path, { method: "POST", origin: `http://127.0.0.1:${port}`, body: typeof body === "string" ? body : JSON.stringify(body) });
    const cases: [string, unknown, RegExp][] = [
      ["/api/executor/blockers", { id: a.id, campaignId: "x", jobIds: "abc" }, /"campaignId"|Unknown campaign/],
      ["/api/workspace/freeze", { id: a.id, check: "false" }, /"check" must be true or false/],
      ["/api/workspace/freeze", { id: a.id, repetitions: "2" }, /"repetitions" must be a whole number from 1 to 50/],
      ["/api/workspace/campaign-label", { id: a.id, campaignId: "x", label: { a: 1 } }, /"label" must be a text/],
      ["/api/workspace/campaign-label", { id: [a.id], campaignId: "x", label: "y" }, /"id" must be a text/],
      ["/api/workspace/save", { id: a.id, study: { ...JSON.parse(await readFile(join(a.dir, "study.json"), "utf8")), outcomes: [{ id: "o", phaseIds: "main" }] } }, /must be (text|a list)/],
      ["/api/workspace/save", { id: a.id, agents: "x" }, /"agents" must be a list of objects/],
      ["/api/workspace/figure", { id: a.id, campaignId: "x", agentIds: "abc", kind: "agreement" }, /"agentIds" must be a list of texts/],
      ["/api/settings", "not json", /not valid JSON/],
      ["/api/settings", "[1]", /must be a JSON object/],
      ["/api/workspace/human-figure", { id: a.id, campaignId: "campaign-does-not-exist" }, /Unknown campaign/],
      ["/api/propose", {}, /"study" must be an object/],
    ];
    for (const [path, body, expected] of cases) {
      const r = await post(path, body);
      assert.equal(r.status, 400, `${path} ${r.body}`);
      const msg = JSON.parse(r.body).error as string;
      assert.match(msg, expected, path);
      assert.doesNotMatch(msg, /is not a function|Cannot read properties|undefined \(reading/, path);
      assert.ok(!msg.includes(resolve(".")), `no absolute path: ${msg}`);
    }
    // Unknown sessions are named, not a crash (needs a real campaign).
    const { readWorkspace, saveCampaign } = await import("../src/workspace.js");
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(smallPlan(ws, 1), undefined, "sec-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const unknown = await post("/api/executor/blockers", { id: a.id, campaignId: c.id, jobIds: ["nope"] });
    assert.match(JSON.parse(unknown.body).error, /Unknown session: nope/);
    const typed = await post("/api/executor/start", { id: a.id, campaignId: c.id, jobIds: "abc" });
    assert.match(JSON.parse(typed.body).error, /"jobIds" must be a list of texts/);
    // 1. The screenshot route: the campaign ID is checked like everywhere else.
    const probe = await call(port, `/api/workspace/file?id=${encodeURIComponent(a.id)}&campaign=${encodeURIComponent("../../..")}&path=screenshots/probe.png`);
    assert.equal(probe.status, 400);
    assert.match(JSON.parse(probe.body).error, /Invalid campaign ID/);
    // A screenshot that is not there (or may not be served) is 404, nothing more.
    for (const path of ["jobs/x/a1/screenshots/none.png", "../study.json"]) {
      const missing = await call(port, `/api/workspace/file?id=${encodeURIComponent(a.id)}&campaign=${encodeURIComponent(c.id)}&path=${encodeURIComponent(path)}`);
      assert.equal(missing.status, 404, path);
      assert.equal(JSON.parse(missing.body).error, "Not found.");
    }
    // Routes no page uses are gone (they answered {} with "Cannot read properties of undefined").
    for (const path of ["/api/demo", "/api/report", "/api/analyze", "/api/freeze", "/api/brief", "/api/handoff", "/api/proposal/read", "/api/proposal/extract", "/api/proposal/compile", "/api/campaign/continue", "/api/campaign/handoff", "/api/campaign/new", "/api/review/save"])
      assert.equal((await post(path, {})).status, 404, path);
    for (const path of ["/api/example", "/api/review", "/api/campaign/suite"]) assert.equal((await call(port, path)).status, 404, path);
    // The server names itself: server.pid beside its settings file, with its process ID and port.
    const pid = JSON.parse(await readFile(join(cfg, "server.pid"), "utf8")) as { pid: number; port: number; url: string };
    assert.deepEqual([pid.pid, pid.port, pid.url], [proc.pid, port, `http://127.0.0.1:${port}`]);
    // 5. Non-canonical study IDs are refused, so a study never gets a second executor.
    for (const spelling of [a.id.replace("studies/", "studies/./"), a.id.replace("private/", "private//"), a.id + "/"]) {
      const r = await call(port, `/api/executor/state?id=${encodeURIComponent(spelling)}&campaign=${c.id}`);
      assert.equal(r.status, 400, spelling);
      assert.match(JSON.parse(r.body).error, /Invalid study ID/);
    }
    assert.equal((await call(port, `/api/executor/state?id=${encodeURIComponent(a.id)}&campaign=${c.id}`)).status, 200);
    // Ended with a plain kill (SIGTERM), the server removes its server.pid.
    const ended = new Promise((ok) => proc.once("exit", ok));
    proc.kill();
    await ended;
    if (process.platform !== "win32") assert.equal(existsSync(join(cfg, "server.pid")), false);
  } finally {
    proc.kill();
    await removeDir(a.dir);
    await removeDir(cfg);
  }
});

test("errors: unexpected ones become 'Something went wrong' without this machine's paths; hosts and origins", async () => {
  const { publicError, scrubPaths, hostAllowed, originAllowed } = await import("../src/http-guard.js");
  const { repoRoot } = await import("../src/workspace.js");
  const enoent = Object.assign(new Error(`ENOENT: no such file or directory, open '${join(repoRoot, "private", "studies", "x", "campaigns", "c", "campaign.json")}'`), { code: "ENOENT" });
  const e1 = publicError(enoent);
  assert.equal(e1.status, 500);
  assert.match(e1.message, /^Something went wrong: a file or folder it needs was not found/);
  assert.ok(!e1.message.includes(repoRoot));
  const e2 = publicError(new TypeError("(jobIds ?? []).filter is not a function"));
  assert.equal(e2.status, 500);
  assert.match(e2.message, /^Something went wrong: /);
  const e3 = publicError(new Error(`Source points at ${join(repoRoot, "examples", "x.md")} and /Users/someone/secret/file.txt`));
  assert.equal(e3.status, 400);
  assert.ok(!e3.message.includes(repoRoot) && !e3.message.includes("/Users/someone"), e3.message);
  assert.match(e3.message, /examples.x\.md/);
  assert.equal(scrubPaths("Use evidence/ or data/ in the study folder."), "Use evidence/ or data/ in the study folder.");
  assert.equal(scrubPaths(String.raw`open 'C:\Users\someone\study\human.json'`), "open '…/human.json'");
  for (const ok of ["127.0.0.1:4317", "localhost:4317", "[::1]:4317", "localhost"]) assert.ok(hostAllowed(ok), ok);
  for (const bad of [undefined, "", "attacker.example:4317", "127.0.0.1.nip.io:4317", "localhost.attacker.example", "[::2]:4317", "127.0.0.2:4317"]) assert.ok(!hostAllowed(bad), String(bad));
  assert.ok(originAllowed(undefined, 4317) && originAllowed("http://localhost:4317", 4317));
  assert.ok(!originAllowed("http://attacker.example", 4317) && !originAllowed("null", 4317) && !originAllowed("http://127.0.0.1:9999", 4317));
});

test("typed request fields: no silent conversions, bounded texts", async () => {
  const { text, flag, int, texts, object, objects, choice } = await import("../src/request.js");
  assert.equal(text({ id: "x" }, "id"), "x");
  assert.throws(() => text({ id: ["x"] }, "id"), /"id" must be a text/);
  assert.throws(() => text({ label: { a: 1 } }, "label"), /"label" must be a text/);
  assert.throws(() => text({ t: "x".repeat(201) }, "t"), /at most 200 characters/);
  assert.equal(text({}, "t", { optional: true }), "");
  assert.equal(flag({}, "check"), false);
  assert.throws(() => flag({ check: "false" }, "check"), /true or false/);
  assert.throws(() => int({ n: 1.5 }, "n", { min: 1, max: 5, fallback: 1 }), /whole number/);
  assert.throws(() => texts({ jobIds: "abc" }, "jobIds"), /list of texts/);
  assert.equal(texts({}, "jobIds", { optional: true }), undefined);
  assert.throws(() => object({ s: [] }, "s"), /an object/);
  assert.throws(() => objects({ a: [1] }, "a"), /list of objects/);
  assert.throws(() => choice({ mode: "AGENT" }, "mode", ["agent", "simulate"], "simulate"), /one of agent, simulate/);
});

test("study texts are bounded and wrong shapes get plain messages", async () => {
  const study = JSON.parse(await readFile(resolve("examples/selection/study.json"), "utf8"));
  assert.throws(() => validateStudy({ ...study, title: "x".repeat(2_000_000) }), /The study title is too long: keep it to 500 characters/);
  assert.throws(() => validateStudy({ ...study, researchQuestion: "x".repeat(6000) }), /research question is too long/);
  assert.throws(() => validateStudy({ ...study, conditions: study.conditions.map((c: { id: string }) => ({ ...c, label: { a: 1 } })) }), /The label of design .* must be text/);
  assert.throws(() => validateStudy({ ...study, outcomes: study.outcomes.map((o: object) => ({ ...o, phaseIds: "main" })) }), /measurement phases of .* must be a list/);
  assert.throws(() => validateStudy({ ...study, conditions: [null, null] }), /Each entry of conditions must be an object/);
  assert.throws(() => validateStudy({ ...study, analysis: null }), /Declare the analysis/);
  assert.ok(validateStudy(study));
});

// ---------- 5. study IDs ----------

test("study IDs: only the canonical spelling opens a study", async () => {
  const { workspaceDir, readWorkspace } = await import("../src/workspace.js");
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    assert.equal(workspaceDir(a.id), a.dir);
    const name = a.id.split("/").pop()!;
    for (const bad of [`private/studies/./${name}`, `private//studies/${name}`, `${a.id}/`, `./${a.id}`, `private/studies/${name}/.`, `private/studies/${name}/../${name}`, `private/studies/${name}.`, "private/studies", "src", `private/studies/${name}\\`])
      assert.throws(() => workspaceDir(bad), /Invalid study ID/, bad);
    assert.throws(() => workspaceDir(`private/studies/${name.toUpperCase()}`), /No study found/);
    await assert.rejects(Executor.open(`private//studies/${name}`, "x"), /Invalid study ID/);
    assert.throws(() => closeExecutor(`private//studies/${name}`, "x"), /Invalid study ID/);
    assert.ok((await readWorkspace(a.id)).study);
  } finally {
    await removeDir(a.dir);
  }
});

// ---------- 1. screenshots ----------

test("screenshots: only this campaign's screenshots, symlinks resolved", async () => {
  const { screenshotFile } = await import("../src/routes.js");
  const { readWorkspace, saveCampaign, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(smallPlan(ws, 1), undefined, "shot-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const job = c.jobs[0].id;
    const shots = join(runDir(a.id, c.id), "jobs", job, "a1", "screenshots");
    await mkdir(shots, { recursive: true });
    await writeFile(join(shots, "s1.png"), "png");
    assert.equal(await readFile(screenshotFile(a.id, c.id, `jobs/${job}/a1/screenshots/s1.png`), "utf8"), "png");
    for (const bad of [`jobs/${job}/a1/screenshots/../../../../../study.json`, `jobs/${job}/a1/human.json`, "screenshots/probe.png", `jobs/${job}/a1/screenshots/missing.png`, `jobs\\${job}\\a1\\screenshots\\s1.png`])
      assert.throws(() => screenshotFile(a.id, c.id, bad), /Not found/, bad);
    assert.throws(() => screenshotFile(a.id, "../../..", "screenshots/probe.png"), /Invalid campaign ID/);
    if (await link(join(a.dir, "human.json"), join(shots, "leak.png"))) assert.throws(() => screenshotFile(a.id, c.id, `jobs/${job}/a1/screenshots/leak.png`), /Not found/);
  } finally {
    await removeDir(a.dir);
  }
});

// ---------- 3. what agents may read (study MCP) ----------

async function studyServer(jobDir: string) {
  const child = own(spawn(process.execPath, [resolve("dist/runtimes/study-mcp.js"), jobDir], { stdio: ["pipe", "pipe", "ignore"] }));
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok) => {
      const id = ++seq;
      waiting.set(id, ok);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  await rpc("initialize");
  const tool = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result as { content: { text: string }[]; isError?: boolean };
  return {
    tool,
    close: async () => {
      child.stdin!.end();
      await new Promise((ok) => child.on("exit", ok));
    },
  };
}

test("study MCP: agents never read human.json, run records or anything outside the project folder", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "xr-agent-read-"));
  try {
    const study = join(tmp, "study");
    await mkdir(join(study, "runs", "c1"), { recursive: true });
    await mkdir(join(study, "campaigns", "c1"), { recursive: true });
    await mkdir(join(study, "project", "sub"), { recursive: true });
    await mkdir(join(tmp, "job"), { recursive: true });
    await writeFile(join(study, "study.json"), "{}");
    await writeFile(join(study, "human.json"), '{"secret": 42}');
    await writeFile(join(study, "runs", "c1", "receipts.jsonl"), "secret\n");
    await writeFile(join(study, "campaigns", "c1", "campaign.json"), "{}");
    await writeFile(join(study, "project", "readme.txt"), "hello");
    await writeFile(join(study, "project", "HUMAN.JSON"), '{"copy": 42}');
    await writeFile(join(tmp, "outside.txt"), "outside");
    const links = (await link(join(study, "human.json"), join(study, "project", "notes.txt"))) && (await link(join(tmp, "outside.txt"), join(study, "project", "out.txt"))) && (await link(join(study, "runs"), join(study, "project", "sub", "r"), "dir"));
    const job = (projectDir: string) => writeFile(join(tmp, "job", "job.json"), JSON.stringify({ jobId: "t", budget: 100, projectDir, participantId: null, designs: [], targets: [] }));

    // The project folder inside the study.
    await job(join(study, "project"));
    let s = await studyServer(join(tmp, "job"));
    assert.equal((await s.tool("read_file", { path: "readme.txt" })).content[0].text, "hello");
    assert.match((await s.tool("read_file", { path: "../human.json" })).content[0].text, /Only the approved project folder/);
    assert.match((await s.tool("read_file", { path: "HUMAN.JSON" })).content[0].text, /not available to agents/);
    if (links) {
      assert.match((await s.tool("read_file", { path: "notes.txt" })).content[0].text, /not available to agents/);
      assert.match((await s.tool("read_file", { path: "out.txt" })).content[0].text, /not available to agents/);
      assert.match((await s.tool("list_files", { path: "sub/r" })).content[0].text, /not available to agents/);
    }
    assert.doesNotMatch((await s.tool("list_files", {})).content[0].text, /HUMAN\.JSON/);
    assert.match((await s.tool("read_file", { path: "missing.txt" })).content[0].text, /^No such file\.$/);
    await s.close();

    // A study folder given as the project (workspace.json "project": "."): human results and runs stay hidden.
    await job(study);
    s = await studyServer(join(tmp, "job"));
    for (const p of ["human.json", "runs/c1/receipts.jsonl", "campaigns/c1/campaign.json"]) assert.match((await s.tool("read_file", { path: p })).content[0].text, /not available to agents/, p);
    const listed = (await s.tool("list_files", {})).content[0].text;
    assert.doesNotMatch(listed, /human\.json|runs\/|campaigns\//);
    assert.match(listed, /project\//);
    await s.close();
  } finally {
    await removeDir(tmp);
  }
});

// ---------- 3b, 4. sources: one rule for website, executor and knowledge saving ----------

test("sources: inside the study folder; only an absolute project folder may live elsewhere; never human results", async () => {
  const { missingSources, readWorkspace, sourceLocation } = await import("../src/workspace.js");
  const { sourceText, evidenceOverview, saveKnowledge } = await import("../src/sources.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  // An engine project outside the workbench, on the checkout's drive: across Windows drives (CI checks
  // out on D:, the temporary folder is on C:) no relative path exists, which the test below needs.
  const sameDrive = parse(tmpdir()).root.toLowerCase() === parse(resolve(".")).root.toLowerCase();
  const outside = await mkdtemp(join(sameDrive ? tmpdir() : dirname(resolve(".")), "xr-engine-project-"));
  try {
    await writeFile(join(outside, "Level.umap"), "level");
    const problem = async (id: string) => {
      const ws = await readWorkspace(a.id);
      return missingSources(ws.dir, ws.study, ws.manifest, [id]).map((m) => m.message).join(" ");
    };
    // The examples' own sources are fine.
    assert.equal(await problem("brief"), "");
    assert.equal(await problem("project"), "");
    // Outside the study folder (also through ../), the study folder itself, human results.
    await setManifestSources(a.dir, { brief: "../../../package.json", project: ".", evidence: "human.json" });
    assert.match(await problem("brief"), /points outside the study folder \(\.\.\/\.\.\/\.\.\/package\.json\)\. Copy the file into the study folder/);
    assert.match(await problem("project"), /study folder or a folder around it, which holds the human results/);
    assert.match(await problem("evidence"), /human results or run records/);
    await assert.rejects(sourceText(a.id, "brief"), /points outside the study folder/);
    const ev = await evidenceOverview(a.id, []);
    assert.equal(ev[0].exists, false);
    assert.match(ev[0].problem!, /human results/);
    assert.equal(ev[0].preview, "");
    // A folder around the study, and run records.
    await mkdir(join(a.dir, "runs", "c1"), { recursive: true });
    await setManifestSources(a.dir, { project: "..", evidence: "runs/c1" });
    assert.match(await problem("project"), /folder around it/);
    assert.match(await problem("evidence"), /human results or run records/);
    // A project elsewhere on this machine: only as an absolute path, outside the workbench, holding no study.
    await setManifestSources(a.dir, { project: outside });
    assert.equal(await problem("project"), "");
    assert.equal(sourceLocation(a.dir, "project", outside).path !== undefined, true);
    assert.match(sourceLocation(a.dir, "project", relative(a.dir, outside)).problem ?? "", /must be given as an absolute path/);
    assert.match(sourceLocation(a.dir, "evidence", join(outside, "Level.umap")).problem ?? "", /points outside the study folder/);
    assert.match(sourceLocation(a.dir, "project", resolve("examples/selection/project-snapshot")).problem ?? "", /into the workbench folder/);
    await writeFile(join(outside, "study.json"), "{}");
    assert.match(sourceLocation(a.dir, "project", outside).problem ?? "", /study folder or human results/);
    // Symlinks count where they lead.
    if (await link(resolve("package.json"), join(a.dir, "brief-link.md"))) {
      await setManifestSources(a.dir, { brief: "brief-link.md", project: "webxr-app", evidence: "evidence/toy-evidence.md" });
      assert.match(await problem("brief"), /points outside the study folder/);
      await assert.rejects(sourceText(a.id, "brief"), /points outside the study folder/);
    }
    if (await link(join(a.dir, "human.json"), join(a.dir, "evidence", "linked.md"))) {
      await setManifestSources(a.dir, { evidence: "evidence/linked.md" });
      assert.match(await problem("evidence"), /human results/);
    }
    // Knowledge is never written through a symlinked folder that leads out of the study.
    await setManifestSources(a.dir, { brief: "agent-brief.md", evidence: "evidence/toy-evidence.md" });
    const elsewhere = await mkdtemp(join(tmpdir(), "xr-elsewhere-"));
    try {
      await rm(join(a.dir, "data"), { recursive: true, force: true });
      if (await link(elsewhere, join(a.dir, "data"), "dir")) {
        const ws = await readWorkspace(a.id);
        const study = structuredClone(ws.study);
        study.sources.push({ id: "notes", label: "Notes", kind: "evidence", description: "x" });
        await assert.rejects(saveKnowledge(a.id, { study, agents: ws.agents, write: [{ sourceId: "notes", path: "data/notes.md", text: "x" }] }), /links elsewhere/);
        assert.deepEqual(await readdir(elsewhere), []);
      }
    } finally {
      await removeDir(elsewhere);
    }
  } finally {
    await removeDir(a.dir);
    await removeDir(outside);
  }
});

// ---------- 6–10. runs zips ----------

/** Rebuild a runs zip after editing its files; the manifest gets fresh checksums. */
async function rezip(zip: Buffer, edit: (files: Map<string, Buffer>) => void, campaign?: string) {
  const z = await JSZip.loadAsync(zip);
  const manifest = JSON.parse(await z.file("manifest.json")!.async("string"));
  const files = new Map<string, Buffer>();
  for (const name of Object.keys(manifest.files)) files.set(name, await z.file(name)!.async("nodebuffer"));
  edit(files);
  const out = new JSZip();
  for (const [n, b] of files) out.file(n, b);
  out.file("manifest.json", JSON.stringify({ ...manifest, campaign: campaign ?? manifest.campaign, files: Object.fromEntries([...files].map(([n, b]) => [n, sha(b)])) }));
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

test("runs zip: append-only records merge, every campaign is checked, only exporter files, safe names, bounded size", async () => {
  const { Executor, closeExecutor } = await import("../src/executor/runner.js");
  const { exportRuns, importRuns, IMPORT_LIMITS, safeZipName } = await import("../src/executor/archive.js");
  const { readWorkspace, saveCampaign, readReceipts, runDir, listCampaigns } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const b = await tempWorkspace(resolve("examples/selection"));
  const g = await tempWorkspace(resolve("examples/graphics-quality"));
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  await writeFile(join(cfg, "settings.json"), "{}");
  process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
  const into = (zip: Buffer) => importRuns(b.id, zip, (ids) => ids.forEach((c) => closeExecutor(b.id, c)));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(smallPlan(ws, 5), undefined, "merge-test", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const ids = [...ex.jobs.keys()];
    // z1 after two sessions, z2 after all five.
    await ex.start("simulate", ids.slice(0, 2));
    await until(() => (ex.snapshot().counts.done ?? 0) >= 2, "two sessions to finish", { executor: ex });
    const z1 = await exportRuns(a.id, c.id);
    await ex.start("simulate");
    await until(() => (ex.snapshot().counts.done ?? 0) >= 5, "five sessions to finish", { executor: ex });
    assert.equal(ex.snapshot().counts.done, 5);
    const z2 = await exportRuns(a.id, c.id);

    // 7. z1 then z2: the receipts of all five sessions, not only the first two.
    const r1 = await into(z1);
    assert.equal(r1.receipts, 2);
    const seen = await Executor.open(b.id, c.id); // opened now, so it must be reloaded after z2
    assert.equal(seen.snapshot().counts.done, 2);
    // An attempt this study saw unfinished is replaced by the zip's finished one.
    const partial = join(runDir(b.id, c.id), "jobs", ids[2], "a1", "result.json");
    await mkdir(join(partial, ".."), { recursive: true });
    await writeFile(partial, "partial");
    const r2 = await into(z2);
    assert.equal(r2.receipts, 3);
    assert.ok(r2.updated >= 2, JSON.stringify(r2)); // receipts.jsonl and the unfinished attempt
    assert.equal((await readReceipts(b.id, [c.id])).length, 5);
    assert.equal((await readdir(join(runDir(b.id, c.id), "results"))).length, 5);
    assert.notEqual(await readFile(partial, "utf8"), "partial");
    assert.equal((await Executor.open(b.id, c.id)).snapshot().counts.done, 5);
    // The merged event log holds exactly the lines of the newer export (as many copies of each).
    const events = (await readFile(join(runDir(b.id, c.id), "events.jsonl"), "utf8")).trim().split("\n");
    const z2events = (await (await JSZip.loadAsync(z2)).file(`runs/${c.id}/events.jsonl`)!.async("string")).trim().split("\n");
    assert.deepEqual([...events].sort(), [...z2events].sort());
    // Loading the same zips again changes nothing.
    const again = await into(z2);
    assert.deepEqual([again.written, again.updated, again.receipts], [0, 0, 0]);
    await into(z1);
    assert.equal((await readReceipts(b.id, [c.id])).length, 5);
    // A different record for the same session attempt is a conflict, never mixed in.
    const receiptsPath = join(runDir(b.id, c.id), "receipts.jsonl");
    const original = await readFile(receiptsPath, "utf8");
    await writeFile(receiptsPath, original.replace(/"sessionId":"([^"]+)"/, '"sessionId":"other-machine"'));
    await assert.rejects(into(z2), /was run both here and in the zip, with different records/);
    await writeFile(receiptsPath, original);

    // Refused zips write nothing: check against a fresh study.
    const fresh = await tempWorkspace(resolve("examples/selection"));
    try {
      const refuse = async (zip: Buffer, expected: RegExp) => {
        await assert.rejects(importRuns(fresh.id, zip), expected);
        assert.equal(existsSync(join(fresh.dir, "campaigns")) || existsSync(join(fresh.dir, "runs")), false, `nothing written for ${expected}`);
      };
      // 6. Every campaign is checked, not only the last one.
      const gws = await readWorkspace(g.id);
      const foreign = campaignFromPlan(freezePlan(gws.study, gws.agents!, 1), undefined, "foreign", new Date(Date.now() - 1000).toISOString());
      const mixed = await rezip(z2, (f) => {
        const all = [...f];
        f.clear();
        f.set(`campaigns/${foreign.id}/campaign.json`, Buffer.from(JSON.stringify(foreign)));
        for (const [n, x] of all) f.set(n, x);
      });
      await refuse(mixed, /belong to study "toy-graphics-quality"/);
      // 10. Only runs of campaigns in the zip or the study, only exporter files, campaigns in their own folder.
      await refuse(await rezip(z2, (f) => f.set("runs/campaign-nonexistent/results/fake.json", Buffer.from("{}"))), /neither the zip nor this study has that campaign/);
      await refuse(await rezip(z2, (f) => f.set(`runs/${c.id}/human.json`, Buffer.from("{}"))), /Unexpected file in zip/);
      await refuse(await rezip(z2, (f) => f.set(`runs/${c.id}/jobs/${ids[0]}/a1/human.json`, Buffer.from("{}"))), /Unexpected file in zip/);
      await refuse(await rezip(z2, (f) => f.set(`runs/${c.id}/results/${c.id}--not-a-job.json`, Buffer.from("{}"))), /session that campaign .* does not have/);
      await refuse(
        await rezip(z2, (f) => {
          f.set("campaigns/campaign-renamed/campaign.json", f.get(`campaigns/${c.id}/campaign.json`)!);
        }),
        /holds a campaign with another ID/,
      );
      // 9. Names that could leave the folder on any system.
      await refuse(await rezip(z2, (f) => f.set(`runs/${c.id}/..\\..\\..\\t4-bs.txt`, Buffer.from("x"))), /Unsafe path in zip/);
      for (const bad of ["runs/c/..\\..\\x", "C:/x", "/etc/passwd", "runs/c/./x", "runs//c/x", "runs/c/x.", "runs/c/x ", "runs/c/a:b", "runs/c/../x"]) assert.equal(safeZipName(bad), false, bad);
      assert.equal(safeZipName(`runs/${c.id}/jobs/${ids[0]}/a1/screenshots/s 1.png`), true);
      // 8. Sizes: declared sizes are checked before unpacking, and a file larger than it declares is stopped.
      const big = await rezip(z2, (f) => f.set(`runs/${c.id}/jobs/${ids[0]}/a1/big.bin`, Buffer.alloc(200_000)));
      const saved = { ...IMPORT_LIMITS };
      try {
        IMPORT_LIMITS.fileBytes = 100_000;
        await refuse(big, /would unpack to .*files over/);
        IMPORT_LIMITS.fileBytes = saved.fileBytes;
        IMPORT_LIMITS.totalBytes = 150_000;
        await refuse(big, /runs zips over/);
      } finally {
        Object.assign(IMPORT_LIMITS, saved);
      }
      // A false size in the zip's directory: unpacking stops at the declared size.
      const lying = Buffer.from(big);
      const name = Buffer.from(`runs/${c.id}/jobs/${ids[0]}/a1/big.bin`);
      for (let i = lying.indexOf(name); i >= 0; i = lying.indexOf(name, i + 1)) {
        if (lying.readUInt32LE(i - 46) === 0x02014b50) lying.writeUInt32LE(1000, i - 46 + 24);
        if (lying.readUInt32LE(i - 30) === 0x04034b50) lying.writeUInt32LE(1000, i - 30 + 22);
      }
      await refuse(lying, /larger than it declares|damaged/);
      // A study with the same campaign ID but another campaign.
      assert.equal((await listCampaigns(fresh.id)).length, 0);
    } finally {
      await removeDir(fresh.dir);
    }
  } finally {
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(b.dir);
    await removeDir(g.dir);
    await removeDir(cfg);
  }
});

test("campaign delete: two requests at once; the second is told it was already deleted", async () => {
  const { readWorkspace, saveCampaign, listCampaigns } = await import("../src/workspace.js");
  const { deleteCampaign } = await import("../src/history.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "double-delete", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const [first, second] = await Promise.allSettled([deleteCampaign(a.id, c.id), deleteCampaign(a.id, c.id)]);
    assert.equal(first.status, "fulfilled");
    assert.equal(second.status, "rejected");
    assert.match(String((second as PromiseRejectedResult).reason), /This campaign was already deleted/);
    // Shown to the researcher with "/" on every system.
    assert.match((first as PromiseFulfilledResult<{ movedTo: string }>).value.movedTo, /^deleted\/\d{8}-\d{6}-double-delete$/);
    assert.equal((await listCampaigns(a.id)).length, 0);
    assert.equal((await readdir(join(a.dir, "deleted"))).length, 1);
  } finally {
    await removeDir(a.dir);
  }
});

// ---------- checked reads: the open file is checked, not the path a second time ----------

/**
 * V3b's swapper, one step at a time: `target` becomes a second name of `human` (a hard link) or a
 * plain file again, each by an atomic rename, as another process on the machine could do.
 */
const toHuman = (target: string, human: string) => {
  rmSync(target + ".hl", { force: true });
  linkSync(human, target + ".hl");
  renameSync(target + ".hl", target);
};
const toPlain = (target: string, text = "PLAIN-EVIDENCE\n") => {
  writeFileSync(target + ".plain", text);
  renameSync(target + ".plain", target);
};

test("checked reads: a source swapped for a hard link to human.json between the check and the read is never returned", async () => {
  const { readChecked, readCheckedHooks, ReadRefused } = await import("../src/runtimes/guard.js");
  const { sourceText, evidenceOverview } = await import("../src/sources.js");
  const { briefOverview } = await import("../src/brief.js");
  const { screenshotBytes, screenshotFile } = await import("../src/routes.js");
  const { readWorkspace, saveCampaign, runDir, readResults } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const outside = await mkdtemp(join(tmpdir(), "xr-results-elsewhere-"));
  const human = join(a.dir, "human.json");
  const secret = await readFile(human, "utf8");
  const evidence = join(a.dir, "evidence", "toy-evidence.md");
  const brief = join(a.dir, "agent-brief.md");
  /** Swaps around the open of `target` (its real path): `before` just before it is opened, `after` right after. */
  const around = (target: string, before?: (p: string) => void, after?: (p: string) => void) => {
    const real = realpathSync(target);
    readCheckedHooks.beforeOpen = (p) => p === real && before?.(p);
    readCheckedHooks.afterOpen = (p) => p === real && after?.(p);
  };
  const clear = () => {
    delete readCheckedHooks.beforeOpen;
    delete readCheckedHooks.afterOpen;
  };
  const reason = (p: Promise<unknown>) => p.then(() => "read", (e) => (e instanceof ReadRefused ? e.reason : String(e)));
  try {
    toPlain(evidence);
    assert.equal((await readChecked(realpathSync(evidence), { protect: [human] })).toString(), "PLAIN-EVIDENCE\n");
    // Opened while it was a second name of human.json, plain again before the open file is checked:
    // the open file is human.json (by device and inode); without that list, it is no longer the file the path names.
    around(evidence, (p) => toHuman(p, human), (p) => toPlain(p));
    assert.equal(await reason(readChecked(realpathSync(evidence), { protect: [human] })), "protected");
    assert.equal(await reason(readChecked(realpathSync(evidence))), "changed");
    // Still a hard link when checked; replaced after it was opened; a link put in its place.
    around(evidence, (p) => toHuman(p, human));
    assert.equal(await reason(readChecked(realpathSync(evidence))), "hardlink");
    toPlain(evidence);
    around(evidence, undefined, (p) => toHuman(p, human));
    assert.equal(await reason(readChecked(realpathSync(evidence))), "changed");
    toPlain(evidence);
    around(evidence, (p) => (rmSync(p), symlinkSync(human, p)));
    assert.equal(await reason(readChecked(realpathSync(evidence))), "link");
    clear();
    toPlain(evidence);

    // The website's source preview, the evidence tab and the brief: refused with a plain message, never human data.
    around(evidence, (p) => toHuman(p, human), (p) => toPlain(p));
    const text = await sourceText(a.id, "evidence").then(String, (e: Error) => e.message);
    assert.match(text, /^Source 'evidence' is the study's human results/);
    const [ev] = await evidenceOverview(a.id, []);
    assert.equal(ev.exists, false);
    assert.match(ev.problem ?? "", /human results/);
    assert.ok(!JSON.stringify(ev).includes(secret.slice(0, 40)));
    clear();
    around(brief, (p) => toHuman(p, human), (p) => toPlain(p, "BRIEF\n"));
    const b = await briefOverview(a.id, []);
    assert.equal(b?.exists, false);
    assert.match(b?.problem ?? "", /human results/);
    clear();
    toPlain(evidence);
    assert.equal(await sourceText(a.id, "evidence"), "PLAIN-EVIDENCE\n");

    // Brief and evidence are decoded as saved (UTF-16, Windows-1252), with a note, and the leak check reads the decoded text.
    toPlain(evidence, "");
    await writeFile(evidence, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Participant p01 rated 3.42.\n", "utf16le")]));
    const [utf16] = await evidenceOverview(a.id, []);
    assert.equal(utf16.preview, "Participant p01 rated 3.42.\n");
    assert.match(utf16.notes, /Read as UTF-16LE/);
    assert.equal(utf16.check?.participantIds, 1);
    assert.match(await sourceText(a.id, "evidence"), /^\(Read as UTF-16LE[^\n]*\)\n\nParticipant p01 rated 3\.42\.\n$/);
    await writeFile(brief, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in Windows-1252
    const cp1252 = await briefOverview(a.id, []);
    assert.equal(cp1252?.preview, "café\n");
    assert.match(cp1252?.notes ?? "", /Windows-1252/);

    // Screenshots: read from the file that was checked, and never through a link, even to another file of the run folder.
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(smallPlan(ws, 1), undefined, "checked-reads", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const shots = join(runDir(a.id, c.id), "jobs", c.jobs[0].id, "a1", "screenshots");
    await mkdir(shots, { recursive: true });
    await writeFile(join(shots, "s1.png"), "png");
    const rel = (n: string) => `jobs/${c.jobs[0].id}/a1/screenshots/${n}`;
    assert.equal((await screenshotBytes(a.id, c.id, rel("s1.png"))).toString(), "png");
    around(join(shots, "s1.png"), (p) => toHuman(p, human), (p) => toPlain(p, "png"));
    await assert.rejects(screenshotBytes(a.id, c.id, rel("s1.png")), /^Error: Not found\.$/);
    clear();
    await writeFile(join(runDir(a.id, c.id), "receipts.jsonl"), "{}\n");
    if (await link(join(runDir(a.id, c.id), "receipts.jsonl"), join(shots, "s2.png"))) assert.throws(() => screenshotFile(a.id, c.id, rel("s2.png")), /Not found/);

    // Results are read only from the study's own folders: a linked results/ folder is refused.
    await mkdir(join(outside, "results"));
    if (await link(join(outside, "results"), join(runDir(a.id, c.id), "results"), "dir"))
      await assert.rejects(readResults(a.id, ws.study, [c.id]), /results in the study folder is a link/);
  } finally {
    clear();
    await removeDir(a.dir);
    await removeDir(outside);
  }
});

test("checked reads: the executor injects a source only from the file that was checked, and says why it refused", async () => {
  const { Executor } = await import("../src/executor/runner.js");
  const { readCheckedHooks } = await import("../src/runtimes/guard.js");
  const { readWorkspace, saveCampaign, runDir } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/graphics-quality"));
  const bin = await mkdtemp(join(tmpdir(), "fake-claude-"));
  // A stand-in for `claude -p` that ends at once without a forecast (the prompt is written before it starts).
  await writeFile(join(bin, "claude.cjs"), `console.log(JSON.stringify({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1 }));`);
  await writeFile(join(bin, "settings.json"), JSON.stringify({ claudePath: join(bin, "claude.cjs") }));
  process.env.XR_STUDY_SETTINGS = join(bin, "settings.json");
  const human = join(a.dir, "human.json");
  const secret = (await readFile(human, "utf8")).slice(0, 40);
  const evidence = join(a.dir, "evidence", "toy-evidence.md");
  try {
    const ws = await readWorkspace(a.id);
    const study = { ...ws.study, analysis: { ...ws.study.analysis, contrasts: [] } };
    const c = campaignFromPlan(freezePlan(study, ws.agents!.filter((x) => x.id === "reads-evidence").map((x) => ({ ...x, repetitions: 3 })), 1), undefined, "checked-inject", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    const ex = await Executor.open(a.id, c.id);
    const jobs = [...ex.jobs.keys()];
    const run = async (job: string) => {
      await ex.start("agent", [job]);
      await until(() => !["queued", "running"].includes(ex.snapshot().jobs.find((j) => j.jobId === job)!.status), "the session to end", { executor: ex });
      return ex.snapshot().jobs.find((j) => j.jobId === job)!;
    };
    const prompt = (job: string) => join(runDir(a.id, c.id), "jobs", job, "a1", "prompt.md");
    const real = realpathSync(evidence);
    // Swapped for a hard link to human.json just before it is opened, plain again right after.
    readCheckedHooks.beforeOpen = (p) => p === real && toHuman(p, human);
    readCheckedHooks.afterOpen = (p) => p === real && toPlain(p);
    let s = await run(jobs[0]);
    assert.equal(s.status, "failed");
    assert.match(s.error ?? "", /^Source 'evidence' \([^)]*\) is the study's human results/);
    assert.ok(!existsSync(prompt(jobs[0])) || !(await readFile(prompt(jobs[0]), "utf8")).includes(secret));
    // A hard link (to another file) when read: a plain message too (never 'The "path" argument must be of type string').
    await writeFile(join(a.dir, "copy.md"), "copy\n");
    readCheckedHooks.beforeOpen = (p) => p === real && toHuman(p, join(a.dir, "copy.md"));
    readCheckedHooks.afterOpen = undefined;
    s = await run(jobs[1]);
    assert.match(s.error ?? "", /^Source 'evidence' \([^)]*\) has more than one name on disk \(a hard link\)/);
    delete readCheckedHooks.beforeOpen;
    // A plain file saved as UTF-16 is injected as text.
    toPlain(evidence);
    await writeFile(evidence, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("PLAIN-EVIDENCE in UTF-16\n", "utf16le")]));
    s = await run(jobs[2]);
    assert.match(await readFile(prompt(jobs[2]), "utf8"), /PLAIN-EVIDENCE in UTF-16\n/);
  } finally {
    delete readCheckedHooks.beforeOpen;
    delete readCheckedHooks.afterOpen;
    delete process.env.XR_STUDY_SETTINGS;
    await removeDir(a.dir);
    await removeDir(bin);
  }
});
