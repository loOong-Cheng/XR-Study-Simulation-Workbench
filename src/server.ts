import { createServer } from "node:http";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { proposeAgents } from "./core/planner.js";
import { object } from "./request.js";
import { handleGet, handlePost } from "./routes.js";
import { hostAllowed, originAllowed, publicError } from "./http-guard.js";
import { settingsFile } from "./settings.js";
import { removeStaleProfiles } from "./executor/processes.js";
import { recoverLeftovers, shutdownExecutors } from "./executor/runner.js";

// The website and its API (src/routes.ts; docs/api.md lists the routes). Everything a page does
// goes through the study-folder routes there; this file serves the page and guards every request.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = Number(process.env.XR_STUDY_PORT ?? 4317);
const server = createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  );
  const json = (value: unknown, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  // Every request (pages, API, event stream) must name this machine as its host: a page of
  // another site that resolves its own name to 127.0.0.1 (DNS rebinding) is refused here.
  if (!hostAllowed(req.headers.host)) {
    json({ error: `Open the workbench at http://127.0.0.1:${port}.` }, 403);
    return;
  }
  try {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (req.method === "GET") {
      if (path.startsWith("/api/") && (await handleGet(path, url, res, json))) return;
      const routes: Record<string, [string, string]> = {
        "/": [join(root, "public/index.html"), "text/html"],
        "/app.css": [join(root, "public/app.css"), "text/css"],
        "/app.js": [join(root, "dist/web/app.js"), "text/javascript"],
        "/plots.js": [join(root, "dist/web/plots.js"), "text/javascript"],
      };
      const route = routes[path];
      if (!route) {
        json({ error: "Not found" }, 404);
        return;
      }
      res.writeHead(200, { "Content-Type": route[1] + "; charset=utf-8" });
      res.end(await readFile(route[0]));
      return;
    }
    if (req.method !== "POST") {
      json({ error: "Method not allowed" }, 405);
      return;
    }
    if (!originAllowed(req.headers.origin, port)) {
      json({ error: "Use the local workbench origin." }, 403);
      return;
    }
    // Runs zips (with screenshots) and documents may be large; everything else is small.
    const limit = path === "/api/runs/import" || path === "/api/assistant/understand" ? 400 * 1024 * 1024 : 12 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) {
        json({ error: `Request exceeds ${Math.round(limit / 1048576)} MB.` }, 413);
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw);
    } catch {
      json({ error: "The request is not valid JSON." }, 400);
      return;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      json({ error: "The request must be a JSON object." }, 400);
      return;
    }
    if (path.startsWith("/api/") && (await handlePost(path, body, json))) return;
    if (path === "/api/propose") {
      // Configuration templates for a study (Agent configurations → templates).
      json({ agents: await proposeAgents(object(body, "study")) });
      return;
    }
    json({ error: "Not found" }, 404);
  } catch (error) {
    // Expected problems go back as written; anything else as "Something went wrong: …", never
    // with this machine's absolute paths. The full error stays on the server console.
    const e = publicError(error);
    if (e.unexpected) console.error(`${req.method} ${req.url?.split("?")[0]}:`, error);
    if (!res.headersSent) json({ error: e.message }, e.status);
    else res.end();
  }
});

// How to find this server among other Node processes (AGENTS.md → "Find and stop this workbench's
// processes"): its title, and server.pid beside the settings file with its process ID and port.
process.title = `xr-study-sim :${port} ${root}`;
const pidFile = join(dirname(settingsFile()), "server.pid");
const ownPidFile = () => {
  try {
    return (JSON.parse(readFileSync(pidFile, "utf8")) as { pid?: number }).pid === process.pid;
  } catch {
    return false;
  }
};
process.on("exit", () => {
  if (ownPidFile()) rmSync(pidFile, { force: true });
});
// Ctrl+C or a stop signal: running sessions are stopped (their whole process trees; they lead their
// own process groups, so the terminal's Ctrl+C does not reach them) and recorded as interrupted
// before the workbench exits. A second signal exits at once; "exit" ends any tree still running.
let closing = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (closing) process.exit(1);
    closing = true;
    console.log(`\n${signal}: stopping running sessions (recorded as interrupted)…`);
    server.close();
    void shutdownExecutors().finally(() => process.exit(0));
  });

server.on("error", (error) => {
  console.error(
    `Could not open the local workbench on port ${port}: ${error.message}\nChoose another port with XR_STUDY_PORT if it is already in use.`,
  );
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, root, startedAt: new Date().toISOString() }, null, 2) + "\n");
  } catch {
    // a read-only folder: the title still names the server
  }
  // Sessions a crashed or killed workbench left behind: stop their processes, record how they ended.
  void recoverLeftovers()
    .then((n) => n && console.log(`Closed the sessions a previous run of the workbench left unfinished, in ${n} campaign(s).`))
    .catch((e) => console.error("Could not check for sessions left unfinished:", (e as Error).message));
  // Chrome profiles that sessions ended by force left in the temporary folder (older than a day).
  void removeStaleProfiles().then((n) => n && console.log(`Removed ${n} Chrome profile(s) of earlier WebXR sessions from the temporary folder.`));
  console.log(
    `XR Study Sim — http://127.0.0.1:${port}\nLocal planning, execution and analysis. Stop with Ctrl+C (running sessions end with the server).`,
  );
});
