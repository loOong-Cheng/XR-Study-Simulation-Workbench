#!/usr/bin/env node
// Builds the visionOS study app for the simulator, where the study bridge (bridge.mjs) installs it:
//   node examples/graphics-quality/apple-vision-pro/runtime/build.mjs
// Output: .build/visionos-graphics-quality/Build/Products/Debug-xrsimulator/GraphicsQuality.app
// (outside the app's source folder, so building never changes what agents read or what a campaign
// fingerprints). Needs Xcode with the visionOS simulator SDK; macOS only.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APP, repoRoot } from "./sim.mjs";

if (process.platform !== "darwin") {
  console.error("The visionOS app builds on a Mac with Xcode only.");
  process.exit(2);
}
const project = join(repoRoot, "examples/graphics-quality/apple-vision-pro/visionos-app/GraphicsQuality.xcodeproj");
const derived = join(repoRoot, ".build/visionos-graphics-quality");
const args = ["-project", project, "-scheme", "GraphicsQuality", "-sdk", "xrsimulator", "-configuration", "Debug", "-derivedDataPath", derived, "build"];
console.log(`xcodebuild ${args.join(" ")}`);
const r = spawnSync("xcodebuild", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
const errors = out.split("\n").filter((l) => /error:/.test(l));
if (r.status !== 0 || !existsSync(join(DEFAULT_APP, "Info.plist"))) {
  console.error(errors.slice(0, 30).join("\n") || out.split("\n").slice(-30).join("\n"));
  console.error("PROBLEM: the visionOS app did not build.");
  process.exit(2);
}
console.log(`Built ${DEFAULT_APP}`);
