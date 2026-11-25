// A stand-in for `claude -p` for the bridge tests (test/bridge.test.ts): starts the MCP servers
// from --mcp-config the way Claude Code does, plays the app through the bridge template's tools
// and submits a forecast, printing stream-json like the real CLI. FAKE_PLAN picks the behaviour:
//   play          read one project file, play every design, submit
//   crash         as play, but SIGKILL the bridge in the middle of the first design and start it
//                 again (without tools/list), as Claude Code does with a crashed MCP server
//   hang          ask the runtime for tools/list and wait (the bridge never answers)
//   gate          submit before using the app (refused), then report a nearly used token budget
//                 and submit again (accepted without the required exposure)
//   select        the WebXR-style tools (screenshot, look, list_objects, select, app_state) of the
//                 visionOS bridge: selects the targets FAKE_TARGETS names ({"practice": [app IDs],
//                 "main": [app IDs]}), found through the bridge's object-ids.jsonl, until the task is done
// FAKE_OUT (a file) receives the text of the replies the test wants to look at.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf("--mcp-config") + 1], "utf8"));
const model = args[args.indexOf("--model") + 1];
const plan = process.env.FAKE_PLAN || "play";
const out = (m) => console.log(JSON.stringify(m));
const note = (what, text) => process.env.FAKE_OUT && fs.appendFileSync(process.env.FAKE_OUT, JSON.stringify({ what, text }) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(s) {
  const p = spawn(s.command, s.args, { env: { ...process.env, ...(s.env || {}) }, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "";
  const wait = {};
  let id = 0;
  const exited = new Promise((r) => p.on("exit", r));
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (wait[m.id]) wait[m.id](m);
    }
  });
  const call = (method, params) =>
    new Promise((r) => {
      const n = ++id;
      wait[n] = r;
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  return { p, call, exited };
}
const textOf = (r) => (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(" ");

(async () => {
  out({ type: "system", subtype: "init", session_id: `fake-${process.pid}`, model, claude_code_version: "fake", mcp_servers: Object.keys(cfg.mcpServers).map((name) => ({ name, status: "connected" })) });
  const study = start(cfg.mcpServers.study);
  await study.call("initialize", {});
  const appName = Object.keys(cfg.mcpServers).find((n) => n !== "study");
  let rt = appName ? start(cfg.mcpServers[appName]) : null;
  const tool = async (server, name, a = {}) => {
    out({ type: "assistant", message: { content: [{ type: "tool_use", name: `mcp__${server === study ? "study" : appName}__${name}`, input: a }] } });
    return server.call("tools/call", { name, arguments: a });
  };
  if (rt) {
    await rt.call("initialize", {});
    if (plan === "hang") {
      rt.call("tools/list", {});
      await sleep(60_000);
      process.exit(0);
    }
    await rt.call("tools/list", {});
  }
  const jobDir = cfg.mcpServers.study.args[1];
  const job = JSON.parse(fs.readFileSync(path.join(jobDir, "job.json"), "utf8"));
  // A configuration that reads files opens one first.
  if (job.projectDir) {
    const listed = textOf(await tool(study, "list_files", {}));
    const file = listed.split("\n").find((l) => l && !l.endsWith("/"));
    if (file) await tool(study, "read_file", { path: file });
  }
  const predictions = [];
  for (const d of job.designs)
    for (const t of job.targets) {
      const value = t.scale === "proportion" ? 0.5 : t.scale === "rank" ? 1 + job.designs.indexOf(d) : t.aggregation === "geometric" ? 20 : 3;
      predictions.push(t.components ? { design: d.id, outcome: t.id, items: Object.fromEntries(t.components.map((c) => [c, 4])) } : { design: d.id, outcome: t.id, value });
    }
  const submit = () => tool(study, "submit_forecast", { predictions, uncertainty: "test" });

  if (plan === "gate") {
    note("first-submit", textOf(await submit()));
    // The session's tokens are nearly used up: the executor sets usage.json → submitNow.
    out({ type: "assistant", message: { id: "big", usage: { input_tokens: 19_500, output_tokens: 50 }, content: [{ type: "text", text: "Out of tokens." }] } });
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      try {
        if (JSON.parse(fs.readFileSync(path.join(jobDir, "usage.json"), "utf8")).submitNow) break;
      } catch {
        // not written yet
      }
    }
    const r = await submit();
    note("second-submit", textOf(r));
    out({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 19_500, output_tokens: 50 }, num_turns: 2 });
    study.p.stdin.end();
    rt && rt.p.stdin.end();
    process.exit(0);
  }

  if (plan === "select") {
    const targets = JSON.parse(process.env.FAKE_TARGETS || "{}");
    const shownFor = (design) => {
      const lines = fs.readFileSync(path.join(jobDir, "object-ids.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.design === design);
      const map = lines.at(-1).shownToApp;
      return (appId) => Object.keys(map).find((k) => map[k] === appId);
    };
    for (const d of job.app.designs) {
      note("open", textOf(await tool(rt, "open_design", { design: d.id })));
      const shown = shownFor(d.id);
      for (const kind of ["practice", "main"]) {
        if (!d[kind]) continue;
        note("screenshot", JSON.stringify((await tool(rt, "screenshot")).result?.content?.map((c) => c.type)));
        await tool(rt, "look", { azimuth: 10, polar: 65 });
        note("objects", textOf(await tool(rt, "list_objects")));
        for (let round = 0; round < 8; round++) {
          const state = JSON.parse(textOf(await tool(rt, "app_state")));
          if (kind === "practice" ? state.phase !== "practice" : state.done) break;
          for (const appId of targets[kind] || []) {
            const r = textOf(await tool(rt, "select", { object: shown(appId) }));
            note("select", r);
          }
        }
      }
    }
    const r = await submit();
    note("submit", textOf(r));
    out({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 3 });
    study.p.stdin.end();
    rt && rt.p.stdin.end();
    await sleep(2000);
    process.exit(0);
  }

  let crashed = plan !== "crash";
  for (const d of job.app.designs) {
    await tool(rt, "open_design", { design: d.id });
    for (const kind of ["practice", "main"]) {
      const c = d[kind];
      if (!c) continue;
      const actions = job.app.cases.find((x) => x.caseId === c.caseId).requiredActions;
      note("screenshot", textOf(await tool(rt, "screenshot")));
      if (!crashed) {
        // The bridge dies between two calls; Claude Code starts it again and calls on, without tools/list.
        crashed = true;
        const starts = fs.readFileSync(path.join(jobDir, "bridge.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.type === "start");
        process.kill(starts.at(-1).pid, "SIGKILL");
        await rt.exited;
        rt = start(cfg.mcpServers[appName]);
        await rt.call("initialize", {});
        note("after-restart", textOf(await tool(rt, "screenshot")));
      }
      await tool(rt, "list_objects");
      for (let trial = 0; trial < 50; trial++) {
        let last = "";
        for (const action of actions) last = textOf(await tool(rt, "act", { action, object: "obj-1" }));
        if (/Task finished/.test(last)) break;
      }
    }
  }
  const r = await submit();
  note("submit", textOf(r));
  out({ type: "result", subtype: r.result.isError ? "error" : "success", usage: { input_tokens: 100, output_tokens: 50 }, num_turns: 3 });
  study.p.stdin.end();
  rt && rt.p.stdin.end();
  await sleep(300);
  process.exit(0);
})();
