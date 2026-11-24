// Files on Windows and on case-insensitive volumes: deleting a campaign while a file is open, names
// that open protected files under another spelling (letter case, long s, trailing dots, short
// names, streams, hard links, nested studies), JSON and CSV saved by Windows programs, names
// Windows keeps for devices, and pasted quoted paths. Windows-only behaviour is checked with
// path.win32 strings; parts that need a case-insensitive disk are skipped on other disks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { freezePlan } from "../src/core/planner.js";
import { campaignFromPlan } from "../src/core/campaign.js";

const removeDir = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
async function tempWorkspace(from: string) {
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  await mkdir(dir, { recursive: true });
  for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"])
    if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
  const manifest = JSON.parse(await readFile(join(from, "workspace.json"), "utf8"));
  for (const rel of Object.values<string>(manifest.sources ?? {}))
    if (existsSync(join(from, rel)) && !existsSync(join(dir, rel))) await cp(join(from, rel), join(dir, rel), { recursive: true });
  return { id: `private/studies/${name}`, dir };
}
async function setManifestSources(dir: string, sources: Record<string, string>) {
  const m = JSON.parse(await readFile(join(dir, "workspace.json"), "utf8"));
  m.sources = { ...m.sources, ...sources };
  await writeFile(join(dir, "workspace.json"), JSON.stringify(m, null, 2));
}
const errno = (code: string) => Object.assign(new Error(`${code}: resource busy or locked, rename`), { code });

// ---------- D1. Deleting a campaign while a file is open ----------

test("campaign delete: runs move first, a locked folder is retried, and a failed move is rolled back", async () => {
  const { readWorkspace, saveCampaign, listCampaigns, runDir } = await import("../src/workspace.js");
  const { deleteCampaign, deleteMoves } = await import("../src/history.js");
  const original = { ...deleteMoves };
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const ws = await readWorkspace(a.id);
    const c = campaignFromPlan(freezePlan(ws.study, ws.agents!, 1), undefined, "locked-delete", new Date(Date.now() - 1000).toISOString());
    await saveCampaign(a.id, c);
    await mkdir(runDir(a.id, c.id), { recursive: true });
    await writeFile(join(runDir(a.id, c.id), "receipts.jsonl"), "");
    const untouched = async () => {
      assert.equal((await listCampaigns(a.id)).length, 1);
      assert.ok(existsSync(join(runDir(a.id, c.id), "receipts.jsonl")));
      assert.deepEqual(existsSync(join(a.dir, "deleted")) ? await readdir(join(a.dir, "deleted")) : [], []);
    };
    deleteMoves.retryMs = 300;
    deleteMoves.stepMs = 20;

    // The campaign file is open (Windows: EBUSY): retried, then the runs, already moved, move back.
    let tries = 0;
    deleteMoves.rename = async (from, to) => {
      if (String(from).includes(`${sep}campaigns${sep}`)) {
        tries++;
        throw errno("EBUSY");
      }
      return rename(from, to);
    };
    await assert.rejects(deleteCampaign(a.id, c.id), /A file in the campaign folder is open \(EBUSY.*Close it and try again\. Nothing was deleted\./);
    assert.ok(tries > 1, "a locked folder is tried again");
    await untouched();

    // A file in the runs folder is open (EPERM): nothing moves.
    deleteMoves.rename = async (from, to) => {
      if (String(from).includes(`${sep}runs${sep}`)) throw errno("EPERM");
      return rename(from, to);
    };
    await assert.rejects(deleteCampaign(a.id, c.id), /A file in the runs folder is open \(EPERM.*Nothing was deleted\./);
    await untouched();

    // The campaign cannot move and the runs cannot move back: the message says where they are.
    deleteMoves.rename = async (from, to) => {
      if (String(from).includes(`${sep}campaigns${sep}`) || String(from).includes(`${sep}deleted${sep}`)) throw errno("EBUSY");
      return rename(from, to);
    };
    const stuckError = await deleteCampaign(a.id, c.id).then(() => "", (e: Error) => e.message);
    assert.match(stuckError, /could not be moved back; move that folder back to runs\/locked-delete/);
    assert.doesNotMatch(stuckError, /Nothing was deleted/);
    const [stuck] = await readdir(join(a.dir, "deleted"));
    await rename(join(a.dir, "deleted", stuck, "runs"), runDir(a.id, c.id));
    await rm(join(a.dir, "deleted"), { recursive: true });
    await untouched();

    // What the old order left behind (campaign moved, runs still here): a retry finishes the delete.
    deleteMoves.rename = rename;
    const legacy = join(a.dir, "deleted", `20250101-000000-${c.id}`);
    await mkdir(legacy, { recursive: true });
    await rename(join(a.dir, "campaigns", c.id), join(legacy, "campaign"));
    assert.equal((await deleteCampaign(a.id, c.id)).movedTo, `deleted/20250101-000000-${c.id}`);
    assert.ok(existsSync(join(legacy, "runs", "receipts.jsonl")) && !existsSync(runDir(a.id, c.id)));
    await assert.rejects(deleteCampaign(a.id, c.id), /This campaign was already deleted/);
    await rename(join(legacy, "campaign"), join(a.dir, "campaigns", c.id));
    await rename(join(legacy, "runs"), runDir(a.id, c.id));
    await rm(join(a.dir, "deleted"), { recursive: true });
    await untouched();

    // A lock that is released while retrying: the campaign and its runs are deleted together.
    let busy = 2;
    deleteMoves.retryMs = 5000;
    deleteMoves.rename = async (from, to) => {
      if (busy-- > 0) throw errno("EACCES");
      return rename(from, to);
    };
    const r = await deleteCampaign(a.id, c.id);
    assert.equal((await listCampaigns(a.id)).length, 0);
    assert.ok(existsSync(join(a.dir, ...r.movedTo.split("/"), "runs", "receipts.jsonl")));
    assert.ok(existsSync(join(a.dir, ...r.movedTo.split("/"), "campaign", "campaign.json")));
    assert.ok(!existsSync(runDir(a.id, c.id)));
  } finally {
    Object.assign(deleteMoves, original);
    await removeDir(a.dir);
  }
});

// ---------- D2. Windows spellings, checked as pure strings ----------

test("guard: Windows aliases (trailing dot or space, streams, short names) and case-insensitive containment", async () => {
  const { windowsAliasProblem, looksLikeShortName, agentRefusal, within, inside, pathKey } = await import("../src/runtimes/guard.js");
  for (const p of ["human.json.", "human.json ", "human.json::$DATA", "C:\\study\\human.json:secret", "C:\\study\\runs.\\c\\r.jsonl", "sub\\file.md ", "evidence/x.md."])
    assert.ok(windowsAliasProblem(p, "win32"), p);
  for (const p of ["C:\\study\\human.json", "..\\x\\y.md", "evidence/notes.v2.md", ".\\a", "C:"]) assert.equal(windowsAliasProblem(p, "win32"), null, p);
  // Other systems keep such names as they are.
  assert.equal(windowsAliasProblem("human.json.", "darwin"), null);
  assert.ok(looksLikeShortName("HUMAN~1.JSO") && looksLikeShortName("CAMPAI~1") && looksLikeShortName("RUNS~12"));
  assert.ok(!looksLikeShortName("human.json") && !looksLikeShortName("my~notes.txt") && !looksLikeShortName("a~b~1"));
  // Unresolved short names, letter case and long s, as Windows paths.
  assert.equal(agentRefusal("C:\\lab\\study\\HUMAN~1.JSO", "win32"), "alias");
  assert.equal(agentRefusal("C:\\lab\\study\\CAMPAI~1\\c1\\campaign.json", "win32"), "alias");
  assert.equal(agentRefusal("C:\\lab\\study\\Human.JSON", "win32"), "human");
  assert.equal(agentRefusal("C:\\lab\\study\\human.j\u017Fon", "win32"), "human");
  assert.equal(agentRefusal("/lab/study/human.j\u017Fon", "darwin"), "human");
  assert.equal(agentRefusal("/lab/study/HUMAN.JSON", "linux"), "human");
  // Containment ignores letter case on Windows and macOS, never on Linux.
  assert.ok(within("C:\\Users\\R\\xr-study-sim", "c:\\users\\r\\XR-STUDY-SIM\\private\\studies", "win32"));
  assert.ok(within("C:\\", "C:\\x", "win32"));
  assert.ok(!within("C:\\Study", "C:\\Study2\\x", "win32"));
  assert.ok(within("/Users/r/xr-study-sim", "/Users/r/XR-STUDY-SIM/private", "darwin"));
  assert.ok(within("/r/runs", "/r/run\u017F/x", "darwin"));
  assert.ok(!within("/Users/r/xr-study-sim", "/Users/r/XR-STUDY-SIM/private", "linux"));
  // Unicode: a name typed in decomposed form (NFD) is the same name.
  assert.equal(pathKey("/a/cafe\u0301", "linux"), pathKey("/a/caf\u00e9", "linux"));
  // Being inside grants access only for the real folder, not a sibling that differs in case on a case-sensitive volume.
  assert.ok(inside("C:\\Study", "c:\\study\\evidence\\x.md", "win32"));
  assert.ok(!inside("/a/study", "/a/STUDY/x", "darwin"));
  assert.ok(inside("/a/study", "/a/study/x", "darwin"));
});

// ---------- D7–D11. Look-alike names, hard links and nested studies on the real disk ----------

async function studyServer(jobDir: string) {
  const child = spawn(process.execPath, [resolve("dist/runtimes/study-mcp.js"), jobDir], { stdio: ["pipe", "pipe", "ignore"] });
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

test("protected files: look-alike names, hard links and nested studies are refused for sources, writes, the MCP server and file lists", async () => {
  const { missingSources, readWorkspace, sourceLocation, studyWriteTarget, repoRoot } = await import("../src/workspace.js");
  const { sourceText, saveKnowledge } = await import("../src/sources.js");
  const { agentFileList, realPath } = await import("../src/runtimes/guard.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const tmp = await mkdtemp(join(tmpdir(), "xr-lookalike-"));
  try {
    const human = await readFile(join(a.dir, "human.json"), "utf8");
    await mkdir(join(a.dir, "runs", "x"), { recursive: true });
    await writeFile(join(a.dir, "runs", "x", "receipts.jsonl"), "RUNS-SECRET\n");
    await mkdir(join(a.dir, "campaigns", "c"), { recursive: true });
    await writeFile(join(a.dir, "campaigns", "c", "note.md"), "CAMPAIGN-SECRET\n");
    await mkdir(join(a.dir, "deleted"), { recursive: true });
    await writeFile(join(a.dir, "deleted", "old.md"), "DELETED-SECRET\n");
    // A study kept inside the study folder, and one inside the project folder.
    for (const inner of [join(a.dir, "nested", "inner"), join(a.dir, "proj", "inner")]) {
      await mkdir(join(inner, "runs"), { recursive: true });
      await writeFile(join(inner, "study.json"), "{}");
      await writeFile(join(inner, "human.json"), "NESTED-HUMAN\n");
      await writeFile(join(inner, "runs", "r.md"), "NESTED-RUNS\n");
    }
    await writeFile(join(a.dir, "proj", "readme.md"), "hello");
    const hard = await link(join(a.dir, "human.json"), join(a.dir, "evidence", "hard.md")).then(
      () => true,
      () => false,
    );
    const foldsCase = existsSync(join(a.dir, "HUMAN.JSON"));
    const foldsLongS = existsSync(join(a.dir, "human.j\u017Fon"));

    // Sources: every spelling is refused; where the disk opens human.json or run records under it, as such.
    const lookalikes = ["HUMAN.JSON", "Human.Json", "./human.json", "human.j\u017Fon", "RUNS/x/receipts.jsonl", "run\u017F/x/receipts.jsonl", "campaign\u017F/c/note.md", "Deleted/old.md", "nested/inner/runs/r.md", "nested/inner/RUNS/r.md", "nested/inner/human.j\u017Fon", "nested/inner/human.json", ...(hard ? ["evidence/hard.md"] : [])];
    for (const p of lookalikes) {
      const problem = sourceLocation(a.dir, "evidence", p).problem;
      assert.ok(problem, p);
      if (existsSync(join(a.dir, p))) assert.match(problem!, /human results or run records|hard link/, p);
    }
    // Ordinary files still work, also when typed in another letter case or Unicode form.
    assert.ok(sourceLocation(a.dir, "evidence", "evidence/toy-evidence.md").path);
    await writeFile(join(a.dir, "evidence", "caf\u00e9.md"), "notes");
    if (existsSync(join(a.dir, "evidence", "cafe\u0301.md"))) assert.ok(sourceLocation(a.dir, "evidence", "evidence/cafe\u0301.md").path);
    if (foldsCase) assert.equal(basename(sourceLocation(a.dir, "evidence", "EVIDENCE/TOY-EVIDENCE.MD").path!), "toy-evidence.md");

    // The website and the prompt check (missingSources) use the same rule.
    await setManifestSources(a.dir, { evidence: "human.j\u017Fon" });
    await assert.rejects(sourceText(a.id, "evidence"));
    let ws = await readWorkspace(a.id);
    assert.equal(missingSources(ws.dir, ws.study, ws.manifest, ["evidence"]).length, 1);

    // Writes: never to human.json or run records under another name, never through a hard link.
    for (const p of ["human.j\u017Fon", "HUMAN.JSON", "run\u017F/x/new.md", "RUNS/x/new.md", "campaign\u017F/c/new.md", "nested/inner/runs/new.md", "nested/inner/run\u017F/new.md", "nested/inner/human.json", ...(hard ? ["evidence/hard.md"] : [])])
      assert.throws(() => studyWriteTarget(a.dir, p), /never written to human\.json|hard link/, p);
    const study = structuredClone(ws.study);
    for (const mapped of ["human.j\u017Fon", ...(hard ? ["evidence/hard.md"] : [])]) {
      await setManifestSources(a.dir, { evidence: mapped });
      ws = await readWorkspace(a.id);
      await assert.rejects(saveKnowledge(a.id, { study, agents: ws.agents, write: [{ sourceId: "evidence", path: mapped, text: "OVERWRITTEN" }] }), /never written to human\.json|hard link/);
      assert.equal(await readFile(join(a.dir, "human.json"), "utf8"), human, mapped);
    }

    // The study MCP server, given the whole study folder: nothing protected under any spelling.
    await mkdir(join(tmp, "job"), { recursive: true });
    await writeFile(join(tmp, "job", "job.json"), JSON.stringify({ jobId: "t", budget: 100, projectDir: a.dir, participantId: null, designs: [], targets: [] }));
    const s = await studyServer(join(tmp, "job"));
    try {
      for (const p of lookalikes) {
        const r = await s.tool("read_file", { path: p });
        assert.ok(r.isError, p);
        assert.match(r.content[0].text, /not available to agents|No such file/, p);
      }
      assert.equal((await s.tool("read_file", { path: "proj/readme.md" })).content[0].text, "hello");
      const evidence = (await s.tool("list_files", { path: "evidence" })).content[0].text;
      assert.match(evidence, /toy-evidence\.md/);
      assert.doesNotMatch(evidence, /hard\.md/);
      assert.equal((await s.tool("list_files", { path: "nested/inner" })).content[0].text, "study.json");
    } finally {
      await s.close();
    }

    // D11: a project folder's file list (website and prompt) names only what read_file gives.
    assert.deepEqual((await agentFileList(join(a.dir, "proj"))).sort(), ["inner/study.json", "readme.md"]);
    await setManifestSources(a.dir, { evidence: "evidence/toy-evidence.md", project: "proj" });
    const listed = await sourceText(a.id, "project");
    assert.match(listed, /readme\.md/);
    assert.doesNotMatch(listed, /human\.json|runs\//);

    // D8: the workbench folder written in another letter case (or with a long s) is still the workbench.
    const repo = realPath(repoRoot);
    const upper = join(dirname(repo), basename(repo).toUpperCase());
    if (foldsCase && existsSync(upper)) assert.match(sourceLocation(a.dir, "project", join(upper, "examples")).problem ?? "", /into the workbench folder/);
    if (foldsLongS) assert.match(sourceLocation(a.dir, "project", join(repo, "example\u017F")).problem ?? "", /into the workbench folder/);
    assert.equal(await readFile(join(a.dir, "human.json"), "utf8"), human);
  } finally {
    await removeDir(a.dir);
    await removeDir(tmp);
  }
});

// ---------- D3, D4. JSON and CSV saved by Windows programs ----------

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
/** Windows-1252 bytes for text of Latin-1 letters and the euro sign. */
const cp1252 = (text: string) => Buffer.from([...text].map((c) => (c === "€" ? 0x80 : c.charCodeAt(0))));

test("text files: BOM, UTF-16 and Windows-1252 are read; JSON from PowerShell 5.1 loads", async () => {
  const { decodeText, readJsonFile } = await import("../src/files.js");
  assert.deepEqual(decodeText(cp1252("€ Jérôme")), { text: "€ Jérôme", encoding: "windows-1252" });
  assert.deepEqual(decodeText(Buffer.concat([BOM, Buffer.from("é")])), { text: "é", encoding: "utf-8" });
  assert.deepEqual(decodeText(utf16le("id,é")), { text: "id,é", encoding: "utf-16le" });
  assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from("id", "utf16le").swap16()])), { text: "id", encoding: "utf-16be" });
  assert.deepEqual(decodeText(Buffer.from("id,x", "utf16le")), { text: "id,x", encoding: "utf-16le" });
  assert.deepEqual(decodeText(Buffer.from("plain, é")), { text: "plain, é", encoding: "utf-8" });

  const { readStudyFolder, listWorkspaces } = await import("../src/workspace.js");
  const { readSettings } = await import("../src/settings.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  const before = process.env.XR_STUDY_SETTINGS;
  try {
    // study.json with a BOM (Set-Content -Encoding UTF8), workspace.json as UTF-16 (Out-File).
    await writeFile(join(a.dir, "study.json"), Buffer.concat([BOM, await readFile(join(a.dir, "study.json"))]));
    await writeFile(join(a.dir, "workspace.json"), utf16le(await readFile(join(a.dir, "workspace.json"), "utf8")));
    const ws = await readStudyFolder(a.id);
    assert.equal(ws.manifest.sources?.evidence, "evidence/toy-evidence.md");
    assert.ok((await listWorkspaces()).some((w) => w.id === a.id));
    assert.deepEqual(await readJsonFile(join(a.dir, "workspace.json")), ws.manifest);
    // settings.json with a BOM.
    await writeFile(join(cfg, "settings.json"), Buffer.concat([BOM, Buffer.from(JSON.stringify({ concurrency: 3 }))]));
    process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
    assert.equal((await readSettings()).concurrency, 3);
  } finally {
    if (before === undefined) delete process.env.XR_STUDY_SETTINGS;
    else process.env.XR_STUDY_SETTINGS = before;
    await removeDir(a.dir);
    await removeDir(cfg);
  }
});

test("participant tables from Excel on Windows: Windows-1252 and UTF-16 are read with a note, agents get the same letters", async () => {
  const { participantKnowledgeOverview, knowledgeDraft } = await import("../src/sources.js");
  const { participantProblems } = await import("../src/participant-knowledge.js");
  const { readWorkspace } = await import("../src/workspace.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  try {
    const path = join(a.dir, "data", "raw", "demographics.csv");
    const csv = (await readFile(path, "utf8")).replace("P01,18-24,none,4,right", "P01,18-24,none,4,droitière");
    assert.match(csv, /droitière/);
    await writeFile(path, cp1252(csv));
    const ws = await readWorkspace(a.id);
    const src = ws.study.sources.find((s) => s.kind === "demographics")!;
    assert.deepEqual(participantProblems(ws.study, "demographics", path, src.fields ?? []), []);
    let [o] = await participantKnowledgeOverview(a.id, []);
    assert.match(o.notes, /Read as Windows-1252.*demographics\.csv/);
    assert.match(o.individual!.text, /handedness: droitière/);
    assert.doesNotMatch(JSON.stringify(o), /\uFFFD/);
    // UTF-16 ("Unicode text", tab-separated).
    await writeFile(path, utf16le(csv.replace(/,/g, "\t")));
    [o] = await participantKnowledgeOverview(a.id, []);
    assert.deepEqual(o.problems, []);
    assert.match(o.notes, /Read as UTF-16LE/);
    assert.match(o.individual!.text, /handedness: droitière/);
    // Plain UTF-8: no note.
    await writeFile(path, csv);
    [o] = await participantKnowledgeOverview(a.id, []);
    assert.equal(o.notes, "");
    // An uploaded table is drafted with the right letters and the note.
    const draft = await knowledgeDraft(a.id, "background.csv", cp1252(csv));
    assert.equal(draft.kind, "participant");
    assert.match(draft.text, /droitière/);
    assert.match(String(draft.notes), /Read as Windows-1252.*background\.csv/);
  } finally {
    await removeDir(a.dir);
  }
});

// ---------- D5, D6. Names Windows keeps for devices; pasted quoted paths ----------

test("names: Windows device names are refused for studies and avoided for generated files; quoted paths are unquoted", async () => {
  const { windowsUnusableName, unquotePath } = await import("../src/files.js");
  for (const n of ["con", "CON", "aux.md", "nul.csv", "prn", "com1", "COM9.txt", "lpt1", "com\u00b9", "notes.", "notes ", "con."]) assert.ok(windowsUnusableName(n), n);
  for (const n of ["console", "con-source", "com10", "lpt", "notes.md", "aux-data.csv"]) assert.ok(!windowsUnusableName(n), n);
  const { createStudy, readStudyFolder, missingSources, readWorkspace } = await import("../src/workspace.js");
  for (const n of ["CON", "aux", "nul", "Com1", "lpt9-"]) await assert.rejects(createStudy(n), /Windows keeps for devices/, n);
  assert.ok(!existsSync(resolve("private/studies/con")));

  assert.equal(unquotePath('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"'), "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
  assert.equal(unquotePath("  'D:\\Unreal\\Lab'  "), "D:\\Unreal\\Lab");
  assert.equal(unquotePath("\u201cC:\\x\\claude.exe\u201d"), "C:\\x\\claude.exe");
  assert.equal(unquotePath('"C:\\half'), '"C:\\half');
  assert.equal(unquotePath("plain/path"), "plain/path");

  const { knowledgeDraft, saveKnowledge } = await import("../src/sources.js");
  const { writeSettings, readSettings, defaultSettings } = await import("../src/settings.js");
  const a = await tempWorkspace(resolve("examples/selection"));
  const cfg = await mkdtemp(join(tmpdir(), "xr-settings-"));
  const before = process.env.XR_STUDY_SETTINGS;
  try {
    // Generated source IDs and file names.
    const csv = await readFile(join(a.dir, "data", "raw", "demographics.csv"));
    const draft = await knowledgeDraft(a.id, "CON.csv", csv);
    assert.equal(draft.sourceId, "con-source");
    assert.equal(draft.path, "data/con-source.csv");
    const ws = await readWorkspace(a.id);
    const study = structuredClone(ws.study);
    study.sources.push({ id: "notes", label: "Notes", kind: "evidence", description: "x" });
    const saved = await saveKnowledge(a.id, { study, agents: ws.agents, write: [{ sourceId: "notes", path: "evidence/aux.md", text: "notes" }] });
    assert.deepEqual(saved.written, ["evidence/aux-2.md"]);

    // workspace.json: a project or evidence path pasted with quotes.
    await setManifestSources(a.dir, { evidence: '"evidence/toy-evidence.md"', project: "'project-snapshot'" });
    const folder = await readStudyFolder(a.id);
    assert.equal(folder.manifest.sources?.evidence, "evidence/toy-evidence.md");
    assert.deepEqual(missingSources(folder.dir, folder.study, folder.manifest, ["evidence", "project"]), []);

    // Settings: Chrome, Claude Code and runtime commands pasted with quotes.
    process.env.XR_STUDY_SETTINGS = join(cfg, "settings.json");
    await writeSettings({ ...defaultSettings(), chromePath: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"', claudePath: '"C:\\Users\\r\\.local\\bin\\claude.exe"', runtimes: { unity: { command: '"C:\\Python312\\python.exe"' } } });
    const s = await readSettings();
    assert.equal(s.chromePath, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    assert.equal(s.claudePath, "C:\\Users\\r\\.local\\bin\\claude.exe");
    assert.equal(s.runtimes.unity.command, "C:\\Python312\\python.exe");
    // A hand-edited file is read the same way.
    await writeFile(join(cfg, "settings.json"), JSON.stringify({ chromePath: '"/Applications/Chrome"' }));
    assert.equal((await readSettings()).chromePath, "/Applications/Chrome");
  } finally {
    if (before === undefined) delete process.env.XR_STUDY_SETTINGS;
    else process.env.XR_STUDY_SETTINGS = before;
    await removeDir(a.dir);
    await removeDir(cfg);
  }
});
