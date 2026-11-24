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
      capabilities: ["screenshot", "pointer-select", "phase-events", "quality-lock"],
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
