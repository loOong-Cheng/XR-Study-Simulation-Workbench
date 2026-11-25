// The website's page logic that needs no browser: focus that survives a redraw, the assistant's
// Markdown as safe HTML, colour contrast of the stylesheet, money, clipped intervals; and the
// server bits the page shows (which configuration names what the study lacks, the model note).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { clippedToScale, contrastRatio, focusKey, focusMark, focusTarget, markdownToHtml, money, plural, type Keyed } from "../src/web/ui.js";
import { campaignFromPlan, continueCampaign } from "../src/core/campaign.js";
import { analyzeCampaign, syntheticCampaignExecution } from "../src/core/campaign-study.js";
import { exampleStudy, syntheticHumanData } from "../src/core/example.js";
import { freezePlan, proposeAgents } from "../src/core/planner.js";

/** A stand-in element: a tag and attributes. */
const el = (tagName: string, attrs: Record<string, string> = {}): Keyed => ({ tagName, getAttribute: (n) => attrs[n] ?? null });

test("focus keys: a control is found again after a redraw by its naming attributes, not its label", () => {
  // Before: the Save button of the Study page, two Remove buttons, a configuration field, a radio, a link.
  const save = el("BUTTON", { "data-action": "save" });
  const removeA = el("BUTTON", { "data-action": "remove-outcome:a" });
  const label = el("INPUT", { "data-cfg": "text-only", "data-field": "label" });
  const radio = el("INPUT", { type: "radio", name: "exec-mode", value: "simulate" });
  const row = el("TR", { "data-job": "job-3" });
  const plain = el("DIV");
  assert.equal(focusKey(plain), null);
  assert.notEqual(focusKey(radio), focusKey(el("INPUT", { type: "radio", name: "exec-mode", value: "agent" })));
  assert.notEqual(focusKey(label), focusKey(el("INPUT", { "data-cfg": "text-only", "data-field": "model" })));
  assert.equal(focusKey(el("A", { href: "/x" })), "A|href=/x");
  // After the redraw the elements are new objects: the same keys find them.
  const after = [el("BUTTON", { "data-action": "remove-outcome:a" }), el("BUTTON", { "data-action": "save" })];
  assert.equal(focusTarget(focusMark(save, [removeA, save])!, after), after[1]);
  assert.equal(focusTarget(focusMark(row, [row])!, [el("TR", { "data-job": "job-2" }), el("TR", { "data-job": "job-3" })])?.getAttribute("data-job"), "job-3");
  // Several controls with one key (Load runs zip twice): the same position, else the first.
  const z1 = el("BUTTON", { "data-action": "exec-import" });
  const z2 = el("BUTTON", { "data-action": "exec-import" });
  const mark = focusMark(z2, [z1, z2])!;
  assert.deepEqual(mark, { key: "BUTTON|data-action=exec-import", index: 1 });
  const n1 = el("BUTTON", { "data-action": "exec-import" });
  const n2 = el("BUTTON", { "data-action": "exec-import" });
  assert.equal(focusTarget(mark, [n1, n2]), n2);
  assert.equal(focusTarget(mark, [n1]), n1);
  // Gone after the redraw: nothing to focus (the page then focuses its title).
  assert.equal(focusTarget(mark, [el("BUTTON", { "data-action": "save" })]), null);
  assert.equal(focusMark(plain, [plain]), null);
});

test("the assistant's Markdown becomes a small, escaped subset of HTML", () => {
  const html = markdownToHtml("## Summary\n\nThe **text-only** configuration *agrees* best.\nSecond line with `a*b*c`.\n\n- first <b>x</b>\n- second & third\n\n1. one\n2) two\n\n<script>alert(1)</script> [link](javascript:alert(1)) <img src=x onerror=alert(1)>");
  assert.equal(
    html,
    "<p><strong>Summary</strong></p>" +
      "<p>The <strong>text-only</strong> configuration <em>agrees</em> best.<br>Second line with <code>a*b*c</code>.</p>" +
      "<ul><li>first &lt;b&gt;x&lt;/b&gt;</li><li>second &amp; third</li></ul>" +
      "<ol><li>one</li><li>two</li></ol>" +
      "<p>&lt;script&gt;alert(1)&lt;/script&gt; [link](javascript:alert(1)) &lt;img src=x onerror=alert(1)&gt;</p>",
  );
  // Only the tags made here appear; every attribute-like text stays escaped.
  const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
  assert.deepEqual([...tags].sort(), ["br", "code", "em", "li", "ol", "p", "strong", "ul"]);
  assert.equal(markdownToHtml(""), "");
  assert.equal(markdownToHtml('a "quoted" \'word\' under_score snake_case_name'), "<p>a &quot;quoted&quot; &#39;word&#39; under_score snake_case_name</p>");
  // An indented line continues a list item; a list ends at a paragraph.
  assert.equal(markdownToHtml("- one\n  more\nafter"), "<ul><li>one more</li></ul><p>after</p>");
});

/** Rules of the stylesheet: selector → declarations (later rules win), custom properties resolved from :root. */
async function stylesheet() {
  const css = (await readFile(resolve("public/app.css"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = new Map<string, Record<string, string>>();
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = Object.fromEntries(
      m[2]
        .split(";")
        .map((d) => d.split(":"))
        .filter((d) => d.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join(":").trim().replace(/\s*!important$/, "")]),
    );
    for (const sel of m[1].split(",").map((x) => x.trim().replace(/\s+/g, " ")))
      rules.set(sel, { ...(rules.get(sel) ?? {}), ...decls });
  }
  const root = rules.get(":root")!;
  const value = (v: string | undefined): string | undefined => {
    const ref = v && /^var\((--[\w-]+)\)$/.exec(v);
    return ref ? value(root[ref[1]]) : v;
  };
  const prop = (sel: string, p: string) => {
    const r = rules.get(sel);
    assert.ok(r, `no rule ${sel}`);
    return value(r[p] ?? (p === "background" ? r["background-color"] : undefined));
  };
  return { root, prop, value };
}
test("contrast: text, controls and the focus ring of the stylesheet meet WCAG AA", async () => {
  const { root, prop, value } = await stylesheet();
  const page = "#f4f6f2",
    card = "#ffffff",
    sidebar = prop(".sidebar", "background")!,
    tableHead = prop("th", "background")!;
  const fails: string[] = [];
  const check = (name: string, fg: string | undefined, bg: string | undefined, min: number) => {
    assert.ok(fg && bg, `${name}: colour missing`);
    const r = contrastRatio(fg!, bg!);
    if (r < min) fails.push(`${name}: ${fg} on ${bg} is ${r.toFixed(2)}, needs ${min}`);
  };
  // Tokens: secondary text on every background it is used on; the focus ring and control borders.
  for (const bg of [page, card, sidebar, tableHead]) check(`--muted on ${bg}`, value(root["--muted"]), bg, 4.5);
  for (const bg of [page, card, sidebar, "#fbfcfa"]) check(`--focus on ${bg}`, value(root["--focus"]), bg, 3);
  for (const bg of [card, "#fbfcfa"]) check(`--control-border on ${bg}`, value(root["--control-border"]), bg, 3);
  check("focus ring", value(prop(":focus-visible", "outline")!.split(" ").pop()), page, 3);
  check("field focus", value(prop(".field input:focus", "outline")!.split(" ").pop()), card, 3);
  // Small text on its own background (4.5:1).
  check("table head", prop("th", "color"), tableHead, 4.5);
  for (const s of ["done", "running", "failed", "stopped", "reused", "not-started", "queued"]) check(`.status.${s}`, prop(`.status.${s}`, "color"), prop(`.status.${s}`, "background"), 4.5);
  check(".status", prop(".status", "color"), prop(".status", "background"), 4.5);
  check(".pill", prop(".pill", "color"), prop(".pill", "background"), 4.5);
  check(".pill.real", prop(".pill.real", "color"), prop(".pill.real", "background"), 4.5);
  check(".tag", prop(".tag", "color"), prop(".tag", "background"), 4.5);
  check(".notice", prop(".notice", "color"), prop(".notice", "background"), 4.5);
  check(".notice.neutral", prop(".notice.neutral", "color"), prop(".notice.neutral", "background"), 4.5);
  check(".domain-label", prop(".domain-label", "color"), prop(".domain-label", "background"), 4.5);
  check(".domain-label.subjective", prop(".domain-label.subjective", "color"), prop(".domain-label.subjective", "background"), 4.5);
  for (const s of [".mini-title", ".eyebrow", ".check", ".fact", "td.quote", ".heat-self", "label.check.disabled", ".field", "details summary"]) check(s, prop(s, "color"), card, 4.5);
  check(".eyebrow on the page", prop(".eyebrow", "color"), page, 4.5);
  check("footer", prop("footer", "color"), page, 4.5);
  for (const s of [".sidebar-label", ".sidebar-bottom p", ".sidebar-bottom small", ".nav"]) check(s, prop(s, "color"), sidebar, 4.5);
  check(".nav:hover", prop(".nav", "color"), prop(".nav:hover", "background"), 4.5);
  check(".nav.active", prop(".nav.active", "color"), prop(".nav.active", "background"), 4.5);
  check(".button.primary", prop(".button.primary", "color"), prop(".button.primary", "background"), 4.5);
  check(".tab.active", prop(".tab.active", "color"), prop(".tab.active", "background"), 4.5);
  check("#toast", prop("#toast", "color"), prop("#toast", "background"), 4.5);
  check(".server-banner", prop(".server-banner", "color"), prop(".server-banner", "background"), 4.5);
  check("placeholder", prop(".runs-input::placeholder", "color"), card, 4.5);
  assert.deepEqual(fails, []);
  // Tiny text is gone: the pill and the mini titles are at least 10 px.
  for (const s of [".pill", ".mini-title", ".domain-label", "th"]) assert.ok(parseFloat(prop(s, "font-size")!) >= 10, `${s} is under 10px`);
  assert.equal(contrastRatio("#000", "#fff").toFixed(0), "21");
});

test("money, plurals and clipped intervals in words", () => {
  assert.equal(money(null), "—");
  assert.equal(money(0), "$0.00");
  assert.equal(money(0.0042), "$0.0042");
  assert.equal(money(0.00001), "<$0.0001");
  assert.equal(money(0.01), "$0.01");
  assert.equal(money(12.345), "$12.35");
  assert.equal(plural(1, "new session"), "1 new session");
  assert.equal(plural(2, "new session"), "2 new sessions");
  assert.equal(plural(0, "design pair"), "0 design pairs");
  // Proportions are clipped to 0–1 and mean ranks to 1–k; a single value (all the same) is not "clipped".
  assert.equal(clippedToScale("proportion", 3, 0, 0.4), true);
  assert.equal(clippedToScale("proportion", 3, 0.2, 1), true);
  assert.equal(clippedToScale("proportion", 3, 0.2, 0.8), false);
  assert.equal(clippedToScale("proportion", 3, 1, 1, true), false);
  assert.equal(clippedToScale("rank", 4, 1, 2.5), true);
  assert.equal(clippedToScale("rank", 4, 1.5, 4), true);
  assert.equal(clippedToScale("continuous", 4, 0, 10), false);
  // A declared range clips too (as scaleBounds does), and counts start at 0.
  assert.equal(clippedToScale("ordinal", 4, 1, 5.2, false, [1, 7]), true);
  assert.equal(clippedToScale("ordinal", 4, 2.1, 5.2, false, [1, 7]), false);
  assert.equal(clippedToScale("count", 4, 0, 3), true);
  assert.equal(clippedToScale("proportion", 4, 0.1, 0.5, false, [0.1, 0.9]), true);
});

test("files that disagree: the page is told which configuration names which unknown source", async () => {
  const { configProblems } = await import("../src/workspace.js");
  const study = exampleStudy();
  const agents = await proposeAgents(study);
  const broken = agents.map((a, i) => (i === 0 ? { ...a, sourceIds: [...a.sourceIds, "old-notes"], requiredSourceIds: [...a.requiredSourceIds, "old-notes"], targets: ["gone-measure"] } : a));
  const problems = configProblems(study, broken);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].configId, agents[0].id);
  assert.deepEqual(problems[0].unknownSources, ["old-notes"]);
  assert.deepEqual(problems[0].unknownOutcomes, ["gone-measure"]);
  assert.match(problems[0].message ?? "", /Unknown/);
  assert.deepEqual(configProblems(study, agents), []);
});

test("the website names the configuration and source in the problem, and lists them per configuration", async () => {
  const { handleGet } = await import("../src/routes.js");
  // A copy of the WebXR example's files under private/studies (as the other website tests do).
  const from = resolve("examples/graphics-quality");
  const name = `__test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const dir = resolve("private/studies", name);
  const id = `private/studies/${name}`;
  await mkdir(dir, { recursive: true });
  try {
    for (const f of ["study.json", "agents.json", "human.json", "comparisons.json", "workspace.json", "agent-brief.md"]) if (existsSync(join(from, f))) await cp(join(from, f), join(dir, f));
    const agents = JSON.parse(await readFile(join(dir, "agents.json"), "utf8"));
    agents[0].sourceIds.push("old-notes");
    await writeFile(join(dir, "agents.json"), JSON.stringify(agents, null, 2));
    let view: Record<string, any> = {};
    await handleGet("/api/workspace", new URL(`http://x/api/workspace?id=${encodeURIComponent(id)}`), null as never, (v) => (view = v as Record<string, any>));
    assert.match(view.problem, new RegExp(`${agents[0].label} \\(${agents[0].id}\\) names source "old-notes", which the study does not have`));
    assert.equal(view.problems.length, 1);
    assert.deepEqual(view.problems[0].unknownSources, ["old-notes"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("analysis note: configurations that differ only in effort are not said to use different models", async () => {
  const study = exampleStudy();
  const plan = freezePlan(study, await proposeAgents(study), 2, "2026-11-23T10:00:00.000Z");
  const human = syntheticHumanData(plan.study);
  const base = { provider: "mock", model: "model-a", reasoning: "default" };
  const c1 = campaignFromPlan(plan, base, "c1", "2026-11-23T10:00:00.000Z");
  const r1 = syntheticCampaignExecution(c1);
  const effortOnly = continueCampaign(c1, { conditionModels: { "uses-app": { ...base, reasoning: "effort=max" } } }, "c2", "2026-11-24T10:00:00.000Z");
  const notes = analyzeCampaign(effortOnly, human, [r1.results, syntheticCampaignExecution(effortOnly).results]).report.notes;
  assert.ok(notes.some((n) => /same model with different effort/.test(n)), notes.join("\n"));
  assert.ok(!notes.some((n) => /different forecasting models/.test(n)));
  const otherModel = continueCampaign(c1, { conditionModels: { "uses-app": { ...base, model: "model-b" } } }, "c3", "2026-11-24T10:00:00.000Z");
  const notes2 = analyzeCampaign(otherModel, human, [r1.results, syntheticCampaignExecution(otherModel).results]).report.notes;
  assert.ok(notes2.some((n) => /^Conditions use different forecasting models\./.test(n)), notes2.join("\n"));
});
