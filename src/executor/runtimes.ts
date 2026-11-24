// MCP runtimes a forecasting session can use to experience the XR app.
import { existsSync } from "node:fs";
import type { AgentProtocol, Study } from "../core/types.js";
import type { Settings } from "../settings.js";
import type { WorkspaceManifest } from "../workspace.js";

export interface RuntimeStatus {
  id: string;
  label: string;
  available: boolean;
  builtIn: boolean;
  observations: ("mono" | "stereo-pair")[];
  capabilities: string[];
  message: string;
}
const labels: Record<string, string> = {
  none: "No app (text and files only)",
  webxr: "WebXR in headless Chrome (built in)",
  unreal: "Unreal Engine (your Unreal MCP with a study bridge)",
  unity: "Unity (Unity MCP)",
  visionos: "Apple Vision Pro (visionOS simulator)",
};
const missing: Record<string, string> = {
  unreal: "Unreal MCP runtime is not configured. Set its command in Settings on the machine that runs Unreal, or simulate the runs.",
  unity: "Unity MCP runtime is not configured. Set its command in Settings, or simulate the runs.",
  visionos: "Apple Vision Pro needs a visionOS simulator runtime, which is not configured. Simulate the runs or configure one in Settings.",
};

// ---------- the built-in WebXR runtime: what the app declares (workspace.json → app) ----------
/** Capability names of the WebXR runtime and its app (docs/runtime-adapters.md → "The window.xrStudy contract"). */
export const WEBXR_CAPABILITIES: Record<string, string> = {
  screenshot: "mono screenshots; always provided (Chrome takes them)",
  look: "window.xrStudy.look(azimuth, polar) turns the viewpoint (tool look)",
  "pointer-select": "listObjects() and select(id): pick an object by its neutral ID (tools list_objects, select)",
  "pointer-xy": "point and click at screen positions (tools point_at, click) through window.xrStudy.pointer(x, y, kind), or real mouse events without it",
  actions: "the app's own task actions (tool act → window.xrStudy.act(name, args)), listed in workspace.json → app.actions or by window.xrStudy.actions()",
  "phase-events": "getState() reports phase, trial and done, so the practice and main tasks are told apart",
  "quality-lock": "the design is fixed by the URL; the participant cannot switch it",
};
/** An app without app.capabilities in workspace.json: the basic contract (start, getState, look, listObjects, select). */
export const WEBXR_BASIC_CAPABILITIES = ["look", "pointer-select", "phase-events"];
/** One of the app's own actions: its name (also the trace's action name), what it does, its parameters, and whether it is a task answer (default true). */
export type AppAction = { name: string; description?: string; params?: Record<string, unknown>; scored?: boolean };
/** The app's own actions declared in workspace.json → app.actions (malformed entries left out). */
export function appActions(manifest: WorkspaceManifest): AppAction[] {
  const list = manifest.app?.actions;
  return Array.isArray(list) ? list.map(normalAction).filter((a): a is AppAction => !!a) : [];
}
/** An action declaration in the documented shape, or null (also used by the runtime for window.xrStudy.actions()). */
export function normalAction(a: unknown): AppAction | null {
  const x = a as Record<string, unknown> | null;
  if (!x || typeof x !== "object" || typeof x.name !== "string" || !/^[A-Za-z0-9_.-]{1,60}$/.test(x.name)) return null;
  return {
    name: x.name,
    ...(typeof x.description === "string" ? { description: x.description.slice(0, 500) } : {}),
    ...(x.params && typeof x.params === "object" && !Array.isArray(x.params) ? { params: x.params as Record<string, unknown> } : {}),
    ...(typeof x.scored === "boolean" ? { scored: x.scored } : {}),
  };
}
/** What the WebXR runtime provides with this app: its own screenshots plus what workspace.json → app declares. */
export function webxrCapabilities(manifest: WorkspaceManifest): string[] {
  const declared = manifest.app?.capabilities;
  const list = Array.isArray(declared) ? declared.filter((c): c is string => typeof c === "string") : WEBXR_BASIC_CAPABILITIES;
  return [...new Set(["screenshot", ...list, ...(appActions(manifest).length ? ["actions"] : [])])];
}
/** Action names the WebXR runtime records in the trace with this app's capabilities and actions. */
export function webxrActionNames(manifest: WorkspaceManifest): string[] {
  const caps = webxrCapabilities(manifest);
  return [
    "complete-task",
    ...(caps.includes("look") ? ["look-around"] : []),
    ...(caps.includes("pointer-xy") ? ["point"] : []),
    ...(caps.includes("pointer-select") || caps.includes("pointer-xy") ? ["select-target"] : []),
    ...appActions(manifest).map((a) => a.name),
  ];
}
/**
 * Required actions of WebXR tasks that the runtime would never record with this app: every session
 * would be a protocol deviation. Apps that list their actions only at run time (window.xrStudy.actions())
 * cannot be checked here.
 */
export function webxrActionWarnings(study: Study, agents: AgentProtocol[], manifest: WorkspaceManifest): string[] {
  const users = agents.filter((a) => a.tools.includes("xr-interact") && runtimeFor(study, a) === "webxr");
  if (!users.length) return [];
  if (!manifest.app) return [`${users.map((a) => a.id).join(", ")} use${users.length === 1 ? "s" : ""} the WebXR app, but workspace.json declares no app (app.serve, app.query).`];
  const known = webxrActionNames(manifest);
  const runtimeOnly = webxrCapabilities(manifest).includes("actions") && !appActions(manifest).length;
  const missing = new Map<string, string[]>();
  for (const id of new Set(users.flatMap((a) => a.requiredCaseIds)))
    for (const action of study.cases.find((c) => c.id === id)?.requiredActions ?? [])
      if (!known.includes(action)) missing.set(action, [...(missing.get(action) ?? []), id]);
  return [...missing].map(
    ([action, cases]) =>
      `Required action "${action}" (${cases.slice(0, 3).join(", ")}${cases.length > 3 ? ", …" : ""}) is not one the WebXR runtime records for this app (${known.join(", ")})${
        runtimeOnly ? "; the app lists its actions only at run time (window.xrStudy.actions()), so this cannot be checked here" : ""
      }. Declare it in workspace.json → app.actions, or change the task's required actions; otherwise every session is recorded as a protocol deviation.`,
  );
}

/** Which runtime a config needs: its own setting, else none for configs that never use the app, else the study's engine. */
export function runtimeFor(study: Study, a: AgentProtocol): string {
  if (a.runtime) return a.runtime;
  if (!a.tools.includes("xr-interact")) return "none";
  return study.runtime.engine === "unreal" ? "unreal" : study.runtime.engine === "unity" ? "unity" : "webxr";
}
export function runtimeStatus(id: string, settings: Settings, manifest: WorkspaceManifest): RuntimeStatus {
  if (id === "none")
    return { id, label: labels.none, available: true, builtIn: true, observations: [], capabilities: [], message: "Always available." };
  if (id === "webxr") {
    const chrome = existsSync(settings.chromePath);
    const app = !!manifest.app;
    return {
      id,
      label: labels.webxr,
      available: chrome && app,
      builtIn: true,
      observations: ["mono"],
      capabilities: webxrCapabilities(manifest),
      message: !app
        ? "This study has no WebXR app declared in workspace.json."
        : !chrome
        ? `Chrome not found at ${settings.chromePath}. Set the Chrome path in Settings.`
        : "Ready. Mono screenshots only: WebXR on a desktop page provides no stereo pair.",
    };
  }
  const r = settings.runtimes[id];
  const ok = !!r?.command?.trim();
  return {
    id,
    label: labels[id] ?? id,
    available: ok,
    builtIn: false,
    // Stereo only when the runtime declares it can capture a stereo pair.
    observations: r?.capabilities?.includes("stereo-capture") ? ["mono", "stereo-pair"] : ["mono"],
    capabilities: r?.capabilities ?? [],
    message: ok ? `Configured: ${r!.command} ${(r!.args ?? []).join(" ")}` : missing[id] ?? `${id} runtime is not configured.`,
  };
}
