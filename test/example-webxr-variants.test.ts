// Suites 5-w, 6-w and 7-w (examples/<suite>/webxr): suites 5–7 with a runnable WebXR app, each a study
// inside its suite's folder. Checks that their files stay valid, that everything but the app, the device
// and the app configurations is still the parent suite's, and plays every design to the end through the
// built-in WebXR runtime with a fixed script (no model; skipped without Chrome). Run from the repository
// root (npm test).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { minToolCalls, tokenBudgetWarning } from "../src/core/planner.js";
import { checkNewConfigurations, mixedLevels, validateAgents, validateComparisons, validateHumanData, validateStudy } from "../src/core/validation.js";
import { fairnessWarnings } from "../src/core/fairness.js";
import { appActions, webxrActionWarnings, webxrCapabilities, webxrIdleFps, webxrPointer, webxrSettleMs } from "../src/executor/runtimes.js";
import { defaultSettings } from "../src/settings.js";
import type { AgentProtocol, Comparison, HumanData, Study } from "../src/core/types.js";
import type { WorkspaceManifest } from "../src/workspace.js";

/** The device the built-in WebXR runtime reports; any other study device makes every app session a deviation. */
const WEBXR_DEVICE = "webxr-desktop-browser-1280x720";
const VARIANTS = [
  { parent: "examples/haptic-buttons", added: ["uses-app", "uses-app-knows-participant"] },
  { parent: "examples/haptic-buttons-between", added: ["uses-app"] },
  { parent: "examples/text-entry", added: ["uses-app", "uses-app-knows-participant"] },
];
const COPY_AGAIN = "The WebXR variants share these files with their suite: copy the suite's file into <suite>/webxr/ (human.json with the variant's studyId), then run npm run starters.";
const chrome = process.env.CHROME_PATH || defaultSettings().chromePath;
const server = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/runtimes/webxr-mcp.js");
const raw = async <T>(dir: string, p: string) => JSON.parse(await readFile(join(dir, p), "utf8")) as T;

test("suites 5-w, 6-w, 7-w: valid files; the suite's study, people, data and configurations; the WebXR device; the app declares what the cases need", async () => {
  for (const { parent, added } of VARIANTS) {
    const p = resolve(parent);
    const v = join(p, "webxr");
    const study = validateStudy(await raw<Study>(v, "study.json"));
    const agents = validateAgents(study, await raw<AgentProtocol[]>(v, "agents.json"));
    const human = await raw<HumanData>(v, "human.json");
    validateHumanData(study, human);
    checkNewConfigurations(study, agents);
    const comparisons = validateComparisons(await raw<Comparison[]>(v, "comparisons.json"), study, agents);
    const manifest = await raw<WorkspaceManifest>(v, "workspace.json");

    // The suite's study: only the ID, the title, the runtime and the action a case requires differ.
    const [ps, vs] = [await raw<Study>(p, "study.json"), await raw<Study>(v, "study.json")];
    assert.equal(vs.id, `${ps.id}-webxr`);
    assert.equal(vs.synthetic, true);
    const rest = ({ id: _id, title: _title, runtime: _runtime, cases, ...s }: Study) => ({ ...s, cases: cases.map(({ requiredActions: _r, ...c }) => c) });
    assert.deepEqual(rest(vs), rest(ps), `${parent}/webxr: study.json`);
    assert.deepEqual({ ...vs.runtime, deviceProfile: null, requiredCapabilities: null }, { ...ps.runtime, deviceProfile: null, requiredCapabilities: null });
    assert.equal(vs.runtime.deviceProfile, WEBXR_DEVICE, `${parent}/webxr: the study's device must be the WebXR runtime's`);
    const caps = webxrCapabilities(manifest);
    for (const c of vs.runtime.requiredCapabilities) assert.ok(caps.includes(c), `${parent}/webxr: ${c}`);
    assert.deepEqual(webxrActionWarnings(study, agents, manifest), [], `${parent}/webxr: every required action is one the runtime records`);

    // The suite's invented data and sources, byte for byte (human.json with this study's ID).
    const [ph, vh] = [await raw<HumanData>(p, "human.json"), human];
    assert.equal(vh.studyId, vs.id);
    assert.deepEqual({ ...vh, studyId: null }, { ...ph, studyId: null }, `${parent}/webxr: human.json. ${COPY_AGAIN}`);
    const pm = await raw<WorkspaceManifest>(p, "workspace.json");
    assert.deepEqual(manifest.sources, pm.sources);
    for (const path of Object.values<string>(manifest.sources ?? {}))
      assert.ok((await readFile(join(v, path))).equals(await readFile(join(p, path))), `${parent}/webxr/${path} differs from ${parent}/${path}. ${COPY_AGAIN}`);

    // The suite's configurations unchanged, plus app configurations with enough budget.
    const pa = await raw<AgentProtocol[]>(p, "agents.json");
    const va = await raw<AgentProtocol[]>(v, "agents.json");
    assert.deepEqual(va.slice(0, pa.length), pa, `${parent}/webxr: the suite's configurations come first, unchanged`);
    assert.deepEqual(va.slice(pa.length).map((a) => a.id), added);
    for (const id of added) {
      const a = agents.find((x) => x.id === id)!;
      assert.equal(a.runtime, "webxr", id);
      assert.ok(a.tools.includes("xr-interact"), id);
      assert.ok(a.sourceIds.includes("brief"), id);
      assert.equal(tokenBudgetWarning(study, a), null, `${parent}/webxr ${id}`);
      assert.ok(minToolCalls(study, a).min <= (a.maxToolCalls ?? Infinity), `${parent}/webxr ${id}: tool-call budget`);
    }
    // Comparisons: the suite's, plus Uses the app against Text only.
    const pc = await raw<Comparison[]>(p, "comparisons.json");
    assert.deepEqual(comparisons.slice(0, pc.length), pc);
    assert.deepEqual(comparisons.slice(pc.length).map((c) => [c.candidate, c.baseline]), [["uses-app", "text-only"]]);
    for (const c of comparisons) assert.equal(mixedLevels(study, agents, c), null);
    assert.deepEqual(fairnessWarnings(study, agents, comparisons), [], `${parent}/webxr`);

    // The app: served from the study folder, with its vendored three.js.
    assert.ok(manifest.app?.serve && existsSync(join(v, manifest.app.serve, "index.html")), `${parent}/webxr: app`);
    assert.match(manifest.app!.query ?? "", /\{condition\}/);
    for (const f of ["build/three.module.js", "LICENSE"]) assert.ok(existsSync(join(v, manifest.app!.serve, "vendor/three", f)), f);
    // LF line endings, as in the suites.
    for (const f of ["study.json", "agents.json", "workspace.json", "comparisons.json", "README.md", `${manifest.app!.serve}/main.js`, `${manifest.app!.serve}/index.html`])
      assert.ok(!(await readFile(join(v, f))).includes(13), `${parent}/webxr/${f} has CR line endings`);
  }
});

test("suite 7-w: the app's phrase pool is the generator's, every phrase word is in the swipe lexicon, practice phrases are outside the pool", async () => {
  const generator = await readFile(resolve("examples/text-entry/data/generate_synthetic.py"), "utf8");
  const block = /^PHRASES = \[\n([\s\S]*?)^\]/m.exec(generator);
  assert.ok(block, "PHRASES in data/generate_synthetic.py");
  const pool = [...block[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  assert.equal(pool.length, 40);
  const app = await import(pathToFileURL(resolve("examples/text-entry/webxr/webxr-app/phrases.js")).href);
  assert.deepEqual(app.PHRASES, pool, `webxr-app/phrases.js is out of date with the generator. ${COPY_AGAIN}`);
  const lexicon = new Set<string>(app.LEXICON);
  for (const w of new Set(pool.join(" ").split(" "))) assert.ok(lexicon.has(w), w);
  assert.deepEqual([...app.LEXICON].sort(), app.LEXICON, "sorted, as the generator writes it");
  for (const p of app.PRACTICE) assert.ok(!pool.includes(p), p);
});

// ---------- scripted sessions through the WebXR runtime ----------

const children = new Set<ChildProcess>();
after(() => children.forEach((c) => c.kill()));
type Reply = { error: boolean; text: string; json: any };

/** A WebXR runtime with one job of every design of a variant, as the executor starts it. */
async function session(id: string, participant: string | null) {
  const dir = resolve(id);
  const study = await raw<Study>(dir, "study.json");
  const manifest = await raw<WorkspaceManifest>(dir, "workspace.json");
  const root = await mkdtemp(join(tmpdir(), "xr-webxr-test-variant-"));
  const caseOf = (design: string, kind: string) => {
    const phase = study.phases.find((p) => p.kind === kind);
    const c = phase && study.cases.find((x) => x.conditionId === design && x.phaseId === phase.id);
    return c ? { caseId: c.id, phaseId: phase.id } : null;
  };
  // The runtime names Chrome's profile after the job: xr-webxr-test-…, which webxr-runtime.test.ts (running at the
  // same time) leaves alone as another test's.
  const jobId = `test-${study.id}`;
  await writeFile(
    join(root, "job.json"),
    JSON.stringify({
      webxr: {
        jobId,
        budget: 1000,
        tokenBudget: null,
        chromePath: chrome,
        app: { dir: join(dir, manifest.app!.serve), query: manifest.app!.query },
        capabilities: webxrCapabilities(manifest),
        actions: appActions(manifest),
        participant,
        designs: study.conditions.map((d) => ({ id: d.id, label: d.label, practice: caseOf(d.id, "practice"), main: caseOf(d.id, "main") })),
        settleMs: webxrSettleMs(manifest),
        idleFps: webxrIdleFps(manifest),
        pointer: webxrPointer(manifest, jobId),
      },
    }),
  );
  const child = spawn(process.execPath, [server, root], { stdio: ["pipe", "pipe", "ignore"] });
  children.add(child);
  const waiting = new Map<number, (m: any) => void>();
  createInterface({ input: child.stdout! }).on("line", (l) => {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
    waiting.delete(m.id);
  });
  let seq = 0;
  const rpc = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((ok) => {
      const n = ++seq;
      waiting.set(n, ok);
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  await rpc("initialize", { protocolVersion: "2025-06-18" });
  const tools = ((await rpc("tools/list")).result.tools as { name: string }[]).map((t) => t.name);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<Reply> => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text: string = r.result?.content?.find((c: { type: string }) => c.type === "text")?.text ?? r.error?.message ?? "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { error: r.result?.isError === true || !!r.error, text, json };
  };
  const must = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await call(name, args);
    assert.ok(!r.error, `${name} ${JSON.stringify(args)}: ${r.text}`);
    return r;
  };
  const state = async () => (await must("app_state")).json;
  const close = () => new Promise<void>((ok) => (child.exitCode !== null || child.signalCode !== null ? ok() : (child.on("exit", () => ok()), child.stdin!.end())));
  const kill = () => void (child.exitCode === null && child.signalCode === null && child.kill());
  const trace = async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l)).map((e) => e.event ?? e);
  const remove = () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  return { study, tools, call, must, state, close, kill, trace, remove };
}

/** Every case started once and ended submitted, with its required actions and at least minActions scored ones; the runtime reports the study's device. */
async function checkTrace(s: Awaited<ReturnType<typeof session>>) {
  const events = await s.trace();
  for (const c of s.study.cases) {
    const evs = events.filter((e) => e.caseId === c.id);
    const ends = evs.filter((e) => e.type === "case-end");
    const counted = evs.filter((e) => e.type === "action" && e.scored && e.completed);
    assert.equal(evs.filter((e) => e.type === "case-start").length, 1, `${c.id}: started once`);
    assert.deepEqual(ends.map((e) => e.submitted), [true], `${c.id}: submitted`);
    assert.ok(counted.length >= (c.minActions ?? 1), `${c.id}: ${counted.length} scored actions, at least ${c.minActions} needed`);
    for (const a of c.requiredActions ?? []) assert.ok(counted.some((e) => e.action === a), `${c.id}: ${a}`);
  }
  const runtime = events.find((e) => e.type === "runtime");
  assert.equal(runtime.deviceProfile, s.study.runtime.deviceProfile, "the runtime reports the study's device (no protocol deviation)");
  return events;
}

/** Runs a scripted session and checks that the runtime's Chrome profile is gone afterwards. */
async function scripted(id: string, participant: string | null, play: (s: Awaited<ReturnType<typeof session>>) => Promise<void>) {
  const profiles = () => readdirSync(tmpdir()).filter((n) => n.startsWith("xr-webxr-test-synthetic-"));
  const before = new Set(profiles());
  const s = await session(id, participant);
  try {
    // Nothing is open before open_design.
    assert.ok((await s.call("screenshot")).error);
    await play(s);
    await s.close();
    const events = await checkTrace(s);
    assert.deepEqual(profiles().filter((n) => !before.has(n)), [], "Chrome's profile is removed when the runtime ends");
    return events;
  } finally {
    s.kill();
    await s.remove();
  }
}

// Where suite 5-w's keys are on the 1280×720 screenshot at the start view (point_at confirms each one).
const KEYPAD: Record<string, [number, number]> = {
  "1": [0.4586, 0.496], "2": [0.5, 0.496], "3": [0.5406, 0.496],
  "4": [0.4586, 0.565], "5": [0.5, 0.565], "6": [0.5406, 0.565],
  "7": [0.4586, 0.632], "8": [0.5, 0.632], "9": [0.5406, 0.632],
  delete: [0.4609, 0.694], "0": [0.5, 0.694], blank: [0.5406, 0.694],
};

test("suite 5-w: a scripted session clicks every sequence of every design through the WebXR runtime; gap presses are refused, a wrong digit is deleted", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const events = await scripted("examples/haptic-buttons/webxr", null, async (s) => {
    assert.ok(s.tools.includes("click") && s.tools.includes("point_at"), s.tools.join(", "));
    for (const d of s.study.conditions) {
      assert.match((await s.must("open_design", { design: d.id })).text, /^Opened/);
      if (d === s.study.conditions[0])
        for (const [k, [x, y]] of Object.entries(KEYPAD)) assert.ok(JSON.stringify((await s.must("point_at", { x, y })).json).includes(`over key ${k}`), `key ${k} at ${x},${y}`);
      // A press in the gap between 1 and 2 is refused and not counted.
      const gap = await s.call("click", { x: 0.4793, y: 0.53 });
      assert.equal(gap.json?.result?.accepted, false, gap.text);
      let st = await s.state();
      let first = true;
      while (!st.done) {
        const target: string = st.public.panelShows;
        const typed: string = st.public.typedSoFar ?? "";
        // Once per design: a wrong digit, corrected with Delete.
        const key = first ? (target[0] === "9" ? "8" : "9") : target.startsWith(typed) ? target[typed.length] : "delete";
        first = false;
        await s.must("click", { x: KEYPAD[key][0], y: KEYPAD[key][1] });
        st = await s.state();
      }
    }
  });
  assert.ok(events.some((e) => e.type === "action" && e.action === "select-target" && e.completed === false), "the gap presses are in the trace, refused");
});

test("suite 6-w: a scripted session types and confirms every code of every design with the declared actions", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  await scripted("examples/haptic-buttons-between/webxr", null, async (s) => {
    assert.ok(s.tools.includes("act"), s.tools.join(", "));
    for (const d of s.study.conditions) {
      await s.must("open_design", { design: d.id });
      if (d === s.study.conditions[0]) assert.ok((await s.call("act", { name: "fly" })).error, "an unknown action is refused");
      let st = await s.state();
      let first = true;
      while (!st.done) {
        const target: string = st.public.panelShows;
        if (first) {
          await s.must("act", { name: "press-key", args: { key: target[0] === "9" ? "8" : "9" } });
          await s.must("act", { name: "press-key", args: { key: "delete" } });
          first = false;
        }
        await s.must("act", { name: "press-key", args: { keys: target } });
        await s.must("act", { name: "confirm-code" });
        st = await s.state();
      }
    }
  });
});

test("suite 7-w: a scripted session types every phrase on all four keyboards as one participant; only the swipe keyboard offers swipe actions", { skip: !existsSync(chrome) && `Chrome not found at ${chrome}` }, async () => {
  const study = await raw<Study>(resolve("examples/text-entry/webxr"), "study.json");
  await scripted("examples/text-entry/webxr", study.participants[4].id, async (s) => {
    const seen = new Set<string>();
    for (const d of s.study.conditions) {
      await s.must("open_design", { design: d.id });
      // The swipe actions come from the app's actions() while that keyboard is open.
      assert.equal(/\bswipe\b/.test((await s.call("act", { name: "fly" })).text), d.id === "swipe", d.id);
      let st = await s.state();
      let first = true;
      while (!st.done) {
        const target: string = st.public.panelShows;
        if (d.id === "swipe") {
          if (first) {
            // A misspelled stroke gives the closest word and suggestions; choose-word and delete-word work.
            const r = await s.must("act", { name: "swipe", args: { words: target.split(" ")[0] + "x" } });
            const suggestions: string[] = r.json?.result?.public?.suggestions ?? [];
            assert.ok(suggestions.length > 0, r.text);
            await s.must("act", { name: "choose-word", args: { word: suggestions[0] } });
            await s.must("act", { name: "delete-word" });
          }
          await s.must("act", { name: "swipe", args: { words: target } });
        } else if (first) {
          await s.must("act", { name: "type", args: { text: target.slice(0, 3) + "q" } });
          await s.must("act", { name: "backspace", args: { count: 1 } });
          await s.must("act", { name: "type", args: { text: target.slice(3) } });
        } else await s.must("act", { name: "type", args: { text: target } });
        first = false;
        assert.ok(!seen.has(target), `phrase repeated in one session: ${target}`);
        seen.add(target);
        await s.must("act", { name: "enter-phrase" });
        st = await s.state();
      }
    }
  });
});
