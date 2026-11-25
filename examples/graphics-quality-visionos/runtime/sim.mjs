// The visionOS simulator and the study app inside it, for the study bridge (bridge.mjs).
// macOS only (Xcode with a visionOS simulator runtime). Standard library only:
//   - xcrun simctl boots a dedicated Apple Vision Pro simulator, installs and launches the app per
//     design (--quality, --participant, --port) and takes screenshots;
//   - the app answers on http://127.0.0.1:<port>/rpc (the simulator shares the Mac's network);
//   - sips (built into macOS) turns a screenshot into the 1280-pixel JPEG the agent gets.
// Where objects appear on the screen: the app places calibration markers at known positions in
// head coordinates, the bridge finds them in a screenshot and fits the projection (DLT), then maps
// each object's head-coordinate centre to the screen.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, "../../..");
export const BUNDLE_ID = "org.xrstudysim.graphicsquality";
export const DEFAULT_APP = join(repoRoot, ".build/visionos-graphics-quality/Build/Products/Debug-xrsimulator/GraphicsQuality.app");
export const DEVICE_NAME = "XR Study Sim (Apple Vision Pro)";
export const BUILD_HINT = "node examples/graphics-quality-visionos/runtime/build.mjs";

export class SimError extends Error {}

/** Run a program; resolves with stdout (a Buffer when binary), rejects with its stderr. */
export function run(cmd, args, { timeoutMs = 120_000, binary = false } = {}) {
  return new Promise((ok, fail) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, encoding: binary ? "buffer" : "utf8" }, (err, stdout, stderr) => {
      if (err) return fail(new SimError(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${String(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`));
      ok(stdout);
    });
  });
}
const simctl = (args, opts) => run("xcrun", ["simctl", ...args], opts);

/** The newest installed visionOS simulator runtime, or null. */
export async function visionRuntime() {
  if (process.platform !== "darwin") return null;
  let list;
  try {
    list = JSON.parse(await simctl(["list", "runtimes", "-j"], { timeoutMs: 30_000 }));
  } catch {
    return null;
  }
  const rts = (list.runtimes ?? []).filter((r) => r.isAvailable !== false && /visionOS|xrOS/i.test(`${r.name} ${r.identifier}`));
  rts.sort((a, b) => String(b.version).localeCompare(String(a.version), "en", { numeric: true }));
  return rts[0] ?? null;
}

/** A free TCP port on the loopback address. */
export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

// ---------- images ----------
/** Pixels of an uncompressed 24- or 32-bit BMP: { width, height, at(x, y) -> [r, g, b] }. */
export function readBmp(buf) {
  if (buf.toString("latin1", 0, 2) !== "BM") throw new SimError("Not a BMP image.");
  const offset = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);
  if (bpp !== 24 && bpp !== 32) throw new SimError(`Unsupported BMP: ${bpp} bits per pixel.`);
  if (compression !== 0 && compression !== 3) throw new SimError(`Unsupported BMP compression ${compression}.`);
  const height = Math.abs(rawHeight);
  const bottomUp = rawHeight > 0;
  const bytes = bpp / 8;
  const stride = Math.ceil((width * bytes) / 4) * 4;
  return {
    width,
    height,
    at(x, y) {
      const row = bottomUp ? height - 1 - y : y;
      const i = offset + row * stride + x * bytes;
      return [buf[i + 2], buf[i + 1], buf[i]];
    },
  };
}

// ---------- the projection: head coordinates (metres, -Z forward) -> screen fractions ----------
/** Eigen-decomposition of a symmetric matrix (cyclic Jacobi): { values, vectors (columns) }. */
function eigenSymmetric(S) {
  const n = S.length;
  const A = S.map((r) => [...r]);
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-300) continue;
        const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1),
          s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k][p],
            akq = A[k][q];
          A[k][p] = c * akp - s * akq;
          A[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p][k],
            aqk = A[q][k];
          A[p][k] = c * apk - s * aqk;
          A[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p],
            vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  return { values: A.map((r, i) => r[i]), vectors: V };
}
/**
 * The 3×4 projection matrix that maps head points to screen fractions, from at least six marker
 * correspondences: the direct linear transform, solved as the least-squares null vector of the
 * homogeneous system (no entry is assumed nonzero: with the eye at the head's origin the constant
 * term of the depth row is zero).
 */
export function fitProjection(pairs) {
  if (pairs.length < 6) throw new SimError(`Only ${pairs.length} calibration markers were found (6 needed).`);
  const rows = [];
  for (const { head: [X, Y, Z], screen: [u, v] } of pairs) {
    rows.push([X, Y, Z, 1, 0, 0, 0, 0, -u * X, -u * Y, -u * Z, -u]);
    rows.push([0, 0, 0, 0, X, Y, Z, 1, -v * X, -v * Y, -v * Z, -v]);
  }
  const AtA = Array.from({ length: 12 }, (_, i) => Array.from({ length: 12 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)));
  const { values, vectors } = eigenSymmetric(AtA);
  const k = values.indexOf(Math.min(...values));
  let p = vectors.map((r) => r[k]);
  // Points in front of the viewer have a positive depth (w).
  const [X, Y, Z] = pairs[0].head;
  if (p[8] * X + p[9] * Y + p[10] * Z + p[11] < 0) p = p.map((x) => -x);
  const P = [p.slice(0, 4), p.slice(4, 8), p.slice(8, 12)];
  const error = Math.max(...pairs.map(({ head, screen }) => {
    const q = project(P, head);
    return q ? Math.hypot(q.x - screen[0], q.y - screen[1]) : Infinity;
  }));
  return { P, error };
}
/** A head point on the screen: { x, y } as fractions from the top-left corner, or null behind the viewer. */
export function project(P, [X, Y, Z]) {
  const w = P[2][0] * X + P[2][1] * Y + P[2][2] * Z + P[2][3];
  if (!(w > 1e-9)) return null;
  return { x: (P[0][0] * X + P[0][1] * Y + P[0][2] * Z + P[0][3]) / w, y: (P[1][0] * X + P[1][1] * Y + P[1][2] * Z + P[1][3]) / w };
}

/**
 * Seven markers, two depths, not on one plane and no two on one ray from the eye. Each has a colour
 * whose channels are all fully on or off, so a pixel's colour class is its three channels thresholded.
 */
export const MARKERS = [
  { head: [-0.25, 0.15, -1.0], color: [255, 0, 0] },
  { head: [0.25, 0.15, -1.0], color: [0, 255, 0] },
  { head: [-0.25, -0.15, -1.0], color: [0, 0, 255] },
  { head: [0.25, -0.15, -1.0], color: [255, 255, 0] },
  { head: [0.0, 0.3, -1.6], color: [255, 0, 255] },
  { head: [0.0, -0.3, -1.6], color: [0, 255, 255] },
  { head: [0.45, 0.02, -1.6], color: [255, 255, 255] },
];
// Simulator screenshots are encoded in Display P3: a marker drawn as sRGB red comes out about
// (234, 51, 35). Each marker is matched against its colour in both encodings.
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const encode = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
/** An sRGB colour (0–255) as Display P3 (0–255). */
export function srgbToP3([r, g, b]) {
  const [R, G, B] = [r, g, b].map((x) => linear(x / 255));
  return [0.8225 * R + 0.1774 * G, 0.0332 * R + 0.9669 * G, 0.0171 * R + 0.0724 * G + 0.9108 * B].map((x) => Math.round(255 * encode(Math.min(1, Math.max(0, x)))));
}
const REFERENCES = MARKERS.flatMap((m, i) => [
  { i, c: m.color },
  { i, c: srgbToP3(m.color) },
]);
/** The marker a pixel belongs to (its index in MARKERS), or -1 for the background and blended edges. */
function markerOf([r, g, b]) {
  if (Math.max(r, g, b) < 120) return -1;
  let best = -1,
    dist = 70 * 70;
  for (const { i, c } of REFERENCES) {
    const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (d < dist) (dist = d), (best = i);
  }
  return best;
}
/** Marker centres in an image, as fractions: { [marker index]: [u, v] } for markers with enough pixels. */
export function findMarkers(img) {
  const sums = new Map();
  const step = img.width > 2000 ? 2 : 1;
  for (let y = 0; y < img.height; y += step)
    for (let x = 0; x < img.width; x += step) {
      const k = markerOf(img.at(x, y));
      if (k < 0) continue;
      const s = sums.get(k) ?? [0, 0, 0];
      s[0] += x;
      s[1] += y;
      s[2]++;
      sums.set(k, s);
    }
  const out = {};
  for (const [k, [sx, sy, n]] of sums) if (n >= 6) out[k] = [(sx / n + 0.5) / img.width, (sy / n + 0.5) / img.height];
  return out;
}

// ---------- the simulator and the app ----------
export class VisionSim {
  constructor({ app = DEFAULT_APP, device = DEVICE_NAME, log = () => {} } = {}) {
    this.appPath = resolve(app);
    this.deviceName = device;
    this.log = log;
    this.udid = null;
    this.port = null;
    this.projection = null;
    this.runtime = null;
  }
  /** Find (or create) and boot the simulator, install the app; the runtime's identity for the trace. */
  async connect() {
    if (process.platform !== "darwin") throw new SimError("The visionOS runtime needs a Mac with Xcode.");
    this.runtime = await visionRuntime();
    if (!this.runtime) throw new SimError("No visionOS simulator runtime is installed. Install it in Xcode → Settings → Components → visionOS (or xcodebuild -downloadPlatform visionOS).");
    if (!existsSync(join(this.appPath, "Info.plist"))) throw new SimError(`The visionOS app is not built (${this.appPath}). Build it first: ${BUILD_HINT}`);
    this.udid = await this.device();
    const state = await this.deviceState();
    if (state !== "Booted") {
      this.log(`booting ${this.udid}`);
      await simctl(["boot", this.udid], { timeoutMs: 180_000 }).catch((e) => {
        if (!/current state: Booted/i.test(e.message)) throw e;
      });
    }
    await simctl(["bootstatus", this.udid, "-b"], { timeoutMs: 300_000 });
    await simctl(["install", this.udid, this.appPath], { timeoutMs: 180_000 });
    return {
      engine: "realitykit",
      engineVersion: `visionOS ${this.runtime.version} (${this.runtime.buildversion ?? "simulator"})`,
      backend: "visionos-simulator",
      deviceProfile: "apple-vision-pro-simulator",
      capabilities: ["screenshot", "look", "pointer-select", "phase-events", "quality-lock"],
      device: this.udid,
      appBuilt: new Date(statSync(join(this.appPath, "Info.plist")).mtimeMs).toISOString(),
    };
  }
  async device() {
    const list = JSON.parse(await simctl(["list", "devices", "-j"], { timeoutMs: 30_000 }));
    const all = Object.entries(list.devices ?? {}).flatMap(([rt, ds]) => ds.map((d) => ({ ...d, rt })));
    const byId = all.find((d) => d.udid === this.deviceName);
    if (byId) return byId.udid;
    const named = all.filter((d) => d.name === this.deviceName && d.isAvailable !== false && d.rt === this.runtime.identifier);
    if (named.length) return named[0].udid;
    // A device type this runtime supports (older Xcode types such as "at 2732x2048" may not be).
    const types = this.runtime.supportedDeviceTypes ?? [];
    const type = types.find((t) => /Apple-Vision-Pro/i.test(t.identifier)) ?? types.find((t) => /vision/i.test(t.name ?? ""));
    if (!type) throw new SimError("Xcode has no Apple Vision Pro simulator device type.");
    this.log(`creating simulator "${this.deviceName}"`);
    return String(await simctl(["create", this.deviceName, type.identifier, this.runtime.identifier], { timeoutMs: 60_000 })).trim();
  }
  async deviceState() {
    const list = JSON.parse(await simctl(["list", "devices", "-j"], { timeoutMs: 30_000 }));
    for (const ds of Object.values(list.devices ?? {})) for (const d of ds) if (d.udid === this.udid) return d.state;
    return "Unknown";
  }
  /** Start the app on one design in a fresh state (any earlier run of it is ended), wait until its scene is ready. */
  async launch({ quality, participant }) {
    this.port = await freePort();
    this.projection = null;
    await simctl(["launch", "--terminate-running-process", this.udid, BUNDLE_ID, "--quality", quality, "--participant", participant, "--port", String(this.port)], { timeoutMs: 60_000 });
    const until = Date.now() + 90_000;
    let last = "";
    while (Date.now() < until) {
      try {
        const h = await this.rpc("hello", {}, 3000);
        if (h?.ready) return h;
        last = "the scene is not ready yet";
      } catch (e) {
        last = e.message;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new SimError(`The app did not become ready within 90 s (${last}).`);
  }
  async rpc(method, params = {}, timeoutMs = 30_000) {
    if (!this.port) throw new SimError("The app is not running.");
    const res = await fetch(`http://127.0.0.1:${this.port}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) throw new SimError(`The app refused ${method}: ${body.error}`);
    return body.result;
  }
  /** A screenshot of what the simulated headset shows, as a file of the given type. */
  async screenshotFile(type, dir) {
    const file = join(dir, `shot.${type}`);
    await simctl(["io", this.udid, "screenshot", `--type=${type}`, file], { timeoutMs: 60_000 });
    return file;
  }
  /** The view as the agent gets it: JPEG, longest side 1280 px. */
  async screenshot() {
    const dir = await mkdtemp(join(tmpdir(), "xr-visionos-shot-"));
    try {
      const png = await this.screenshotFile("png", dir);
      const jpg = join(dir, "shot.jpg");
      await run("sips", ["-Z", "1280", "-s", "format", "jpeg", "-s", "formatOptions", "82", png, "--out", jpg], { timeoutMs: 60_000 });
      return await readFile(jpg);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  /** Learn where head points appear on the screen: markers on, one screenshot, markers off. */
  async calibrate() {
    await this.rpc("calibrate", { markers: MARKERS });
    const dir = await mkdtemp(join(tmpdir(), "xr-visionos-cal-"));
    let found;
    try {
      // The markers are drawn on the next frames; try a few screenshots until all are seen.
      // (A first launch may still be compiling shaders: up to about 6 s.)
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise((r) => setTimeout(r, attempt ? 500 : 250));
        found = findMarkers(readBmp(await readFile(await this.screenshotFile("bmp", dir))));
        if (MARKERS.every((_, i) => found[i])) break;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await this.rpc("calibrate", { markers: [] });
    }
    const pairs = MARKERS.flatMap((m, i) => (found[i] ? [{ head: m.head, screen: found[i] }] : []));
    const fit = fitProjection(pairs);
    if (fit.error > 0.02) throw new SimError(`Calibration does not fit (largest error ${(fit.error * 100).toFixed(1)}% of the screen).`);
    this.projection = fit.P;
    this.log(`calibrated with ${pairs.length} markers, largest error ${(fit.error * 100).toFixed(2)}%`);
    return fit;
  }
  /** The app's objects with screen positions (x, y from 0 to 1 from the top-left corner) and whether they are on screen. */
  async objects() {
    const list = await this.rpc("objects");
    return (Array.isArray(list) ? list : []).map((o) => {
      const q = this.projection && Array.isArray(o.head) ? project(this.projection, o.head) : null;
      const onScreen = !!q && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1;
      return { id: String(o.id), onScreen, visible: onScreen, ...(onScreen ? { x: q.x, y: q.y } : {}) };
    });
  }
  async terminate() {
    if (this.udid) await simctl(["terminate", this.udid, BUNDLE_ID], { timeoutMs: 30_000 }).catch(() => undefined);
    this.port = null;
  }
}
