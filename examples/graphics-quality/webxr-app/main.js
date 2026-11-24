// Toy WebXR study app: one small room rendered at three graphics-quality levels
// (low: flat colour; medium: colour textures + simple shading; high: full PBR
// texture sets with normal/roughness/metalness/AO/height maps and displacement).
// Targets and distractors share shape and colour and differ only in material
// (glossy ceramic vs matte, brushed metal vs plastic, glass vs plastic), so the
// visual quality level changes how easy the material cues are to see.
//
// URL parameters:
//   quality = low | medium | high      (default high)
//   study   = 1                        hides the quality switcher and condition label
//   participant = p01                  written into the event log
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PATTERNS, colorOnly, pbrSet } from "./pbr.js";

const params = new URLSearchParams(location.search);
const LEVELS = ["low", "medium", "high"];
const quality = LEVELS.includes(params.get("quality")) ? params.get("quality") : "high";
const studyMode = params.get("study") === "1";
const participant = params.get("participant") ?? "anonymous";

const QUALITY = {
  low: { antialias: false, pixelRatio: 0.6, shadows: false, env: false, toneMapping: false },
  medium: { antialias: false, pixelRatio: 1, shadows: false, env: false, toneMapping: false },
  high: { antialias: true, pixelRatio: Math.min(window.devicePixelRatio, 2), shadows: true, env: true, toneMapping: true },
}[quality];

// ---------- renderer, scene, camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: QUALITY.antialias, preserveDrawingBuffer: true });
renderer.setPixelRatio(QUALITY.pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = QUALITY.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
if (QUALITY.toneMapping) {
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
}
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(quality === "low" ? 0x8a8f94 : 0x9fa7ad);
if (QUALITY.env) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
}

const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 50);
camera.position.set(0, 1.3, 1.25);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, 0);
controls.enablePan = false;
controls.minDistance = 0.5;
controls.maxDistance = 4;
controls.update();

// ---------- lights ----------
if (quality !== "low") {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b5a48, quality === "high" ? 0.6 : 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, quality === "high" ? 1.8 : 1.4);
  sun.position.set(2.5, 4, 2);
  sun.castShadow = QUALITY.shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -3;
  sun.shadow.camera.right = 3;
  sun.shadow.camera.top = 3;
  sun.shadow.camera.bottom = -3;
  sun.shadow.radius = 4;
  scene.add(sun);
}

// ---------- materials per quality ----------
// The same procedural patterns (pbr.js) are used at every level, so the scene
// content is identical; only rendering quality changes.
//   low    flat unlit colour
//   medium colour texture (256 px) with simple Lambert/Phong shading
//   high   full PBR set (1024/512 px): albedo, normal, roughness, metalness,
//          ambient occlusion and height (displacement on the floor and brick wall)
const MEDIUM_SHINE = { "ceramic-glossy": [90, 0x444444], "metal-brushed": [60, 0x999999], tablewood: [12, 0x222222] };
const HIGH_EXTRAS = {
  "ceramic-glossy": { clearcoat: 1, clearcoatRoughness: 0.03 },
  tablewood: { clearcoat: 0.35, clearcoatRoughness: 0.2 },
  fabric: { sheen: 1, sheenColor: new THREE.Color(0xd99aa8), sheenRoughness: 0.6 },
  "metal-brushed": { anisotropy: 0.8 },
};
const DISPLACEMENT = { planks: [0.008, -0.004], brick: [0.035, -0.02] };
function repeated(texture, repeat) {
  if (repeat === 1) return texture;
  const t = texture.clone();
  t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}
function material(pattern, repeat = 1) {
  if (pattern === "glass") {
    if (quality === "low") return new THREE.MeshBasicMaterial({ color: 0xa9d6e5 });
    if (quality === "medium") return new THREE.MeshPhongMaterial({ color: 0xa9d6e5, transparent: true, opacity: 0.55, shininess: 100 });
    return new THREE.MeshPhysicalMaterial({ color: 0xa9d6e5, roughness: 0.04, transmission: 1, thickness: 0.05, ior: 1.5, specularIntensity: 1 });
  }
  if (quality === "low") return new THREE.MeshBasicMaterial({ color: PATTERNS[pattern].flat });
  if (quality === "medium") {
    const map = repeated(colorOnly(pattern, 256), repeat);
    const shine = MEDIUM_SHINE[pattern];
    return shine
      ? new THREE.MeshPhongMaterial({ map, shininess: shine[0], specular: shine[1] })
      : new THREE.MeshLambertMaterial({ map });
  }
  const large = ["planks", "brick", "plaster", "tablewood"].includes(pattern);
  const set = pbrSet(pattern, large ? 1024 : 512);
  const orm = repeated(set.orm, repeat);
  const disp = DISPLACEMENT[pattern];
  return new THREE.MeshPhysicalMaterial({
    map: repeated(set.map, repeat),
    normalMap: repeated(set.normalMap, repeat),
    roughnessMap: orm,
    metalnessMap: orm,
    aoMap: orm,
    roughness: 1,
    metalness: 1,
    ...(disp ? { displacementMap: repeated(set.heightMap, repeat), displacementScale: disp[0], displacementBias: disp[1] } : {}),
    ...(HIGH_EXTRAS[pattern] ?? {}),
  });
}
function shadowed(mesh) {
  mesh.castShadow = mesh.receiveShadow = QUALITY.shadows;
  return mesh;
}
const segments = quality === "low" ? 10 : quality === "medium" ? 24 : 64;
// Displacement needs real vertices: dense grids only at high quality.
const grid = (w, h, perMetre) => (quality === "high" ? [Math.round(w * perMetre), Math.round(h * perMetre)] : [1, 1]);

// ---------- room ----------
const floor = shadowed(new THREE.Mesh(new THREE.PlaneGeometry(8, 8, ...grid(8, 8, 40)), material("planks", 3)));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
for (const [x, z, ry, pattern] of [
  [0, -3, 0, "brick"],
  [-3, 0, Math.PI / 2, "plaster"],
  [3, 0, -Math.PI / 2, "plaster"],
]) {
  const wall = shadowed(new THREE.Mesh(new THREE.PlaneGeometry(6, 3, ...grid(6, 3, pattern === "brick" ? 80 : 1)), material(pattern, pattern === "brick" ? 2 : 1)));
  wall.position.set(x, 1.5, z);
  wall.rotation.y = ry;
  scene.add(wall);
}
const table = new THREE.Group();
const top = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.9), material("tablewood")));
top.position.y = 0.75;
table.add(top);
for (const [x, z] of [
  [-0.8, -0.38],
  [0.8, -0.38],
  [-0.8, 0.38],
  [0.8, 0.38],
]) {
  const leg = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.75, 0.05), material("tablewood")));
  leg.position.set(x, 0.375, z);
  table.add(leg);
}
scene.add(table);

// ---------- objects (neutral IDs; names are not shown to participants or agents) ----------
function mug(kind) {
  const g = new THREE.Group();
  g.add(shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.1, segments), material(kind))));
  const handle = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 8, segments), material(kind)));
  handle.position.x = 0.05;
  g.add(handle);
  return g;
}
function bowl(kind) {
  const geo = new THREE.SphereGeometry(0.08, segments, segments / 2, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const m = shadowed(new THREE.Mesh(geo, material(kind)));
  m.material.side = THREE.DoubleSide;
  m.position.y = 0.08; // lower hemisphere: rim at the top, base on the table
  const g = new THREE.Group();
  g.add(m);
  return g;
}
function vase(kind) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push(new THREE.Vector2(0.035 + 0.035 * Math.sin(Math.PI * t * 1.2), t * 0.24));
  }
  const g = new THREE.Group();
  g.add(shadowed(new THREE.Mesh(new THREE.LatheGeometry(pts, segments), material(kind))));
  return g;
}
function box() {
  const g = new THREE.Group();
  const m = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.1), material("boxwood")));
  m.position.y = 0.05;
  g.add(m);
  return g;
}
function cushion() {
  const g = new THREE.Group();
  const m = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.1, segments, segments / 2), material("fabric")));
  m.scale.set(1.3, 0.45, 1.3);
  m.position.y = 0.045;
  g.add(m);
  return g;
}
function plant() {
  const g = new THREE.Group();
  const pot = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.045, 0.1, segments), material("terracotta")));
  pot.position.y = 0.05;
  g.add(pot);
  for (let i = 0; i < 6; i++) {
    const leaf = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.04, segments / 2, segments / 4), material("leaf")));
    leaf.position.set(Math.cos(i) * 0.04, 0.14 + (i % 3) * 0.03, Math.sin(i) * 0.04);
    leaf.scale.set(1, 0.5, 1.6);
    g.add(leaf);
  }
  return g;
}

// id -> [builder, position, hidden truth used only for scoring the log]
const OBJECTS = {
  "obj-1": [() => mug("ceramic-glossy"), [-0.6, 0.775, -0.15], "ceramic-mug"],
  "obj-2": [() => mug("ceramic-matte"), [-0.3, 0.775, 0.2], "matte-mug"],
  "obj-3": [() => bowl("metal-brushed"), [0.35, 0.775, -0.2], "metal-bowl"],
  "obj-4": [() => bowl("plastic"), [0.05, 0.775, 0.15], "plastic-bowl"],
  "obj-5": [() => vase("glass"), [0.65, 0.775, 0.15], "glass-vase"],
  "obj-6": [() => vase("plastic-blue"), [-0.05, 0.775, -0.25], "plastic-vase"],
  "obj-7": [box, [0.7, 0.775, -0.25], "wooden-box"],
  "obj-8": [cushion, [-0.7, 0.775, 0.25], "cushion"],
  "obj-9": [plant, [0.3, 0.775, 0.28], "plant"],
};
const selectable = [];
for (const [id, [build, pos, truth]] of Object.entries(OBJECTS)) {
  const g = build();
  g.position.set(...pos);
  g.userData = { id, truth };
  g.traverse((o) => (o.userData.objectId = id));
  scene.add(g);
  selectable.push(g);
}

// ---------- task ----------
// One practice trial, then four scored trials with the same three targets (as in the brief and in
// study.json: search time is the geometric mean over four scored trials). Before each scored trial
// the six look-alike objects swap places, seeded by participant and quality level, so every trial
// needs a new search and the layout is the same for everyone with the same participant and level.
const MAIN = { phase: "main", text: "Select the glossy ceramic mug, the brushed-metal bowl and the glass vase.", targets: ["ceramic-mug", "metal-bowl", "glass-vase"] };
const TRIALS = [
  { phase: "practice", title: "Practice", text: "Select the wooden box.", targets: ["wooden-box"] },
  ...[1, 2, 3, 4].map((n) => ({ ...MAIN, title: `Main task · trial ${n} of 4` })),
];
const LOOKALIKES = ["obj-1", "obj-2", "obj-3", "obj-4", "obj-5", "obj-6"];
const SLOTS = LOOKALIKES.map((id) => OBJECTS[id][1]);
function seeded(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function arrange(trial) {
  const order = [...SLOTS.keys()];
  if (trial > 0) {
    const rand = seeded(`${participant}|${quality}|${trial}`);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  LOOKALIKES.forEach((id, i) => selectable.find((o) => o.userData.id === id).position.set(...SLOTS[order[i]]));
}
const state = { trial: -1, phase: "idle", remaining: [], errors: 0, startedAt: 0, done: false };
const log = [];
function record(type, data = {}) {
  log.push({ t: Math.round(performance.now()), type, quality, participant, ...data });
}
const $ = (id) => document.getElementById(id);
function showTask() {
  const tr = TRIALS[state.trial];
  $("task-title").textContent = state.done
    ? "Done — please answer the questionnaire"
    : tr
    ? tr.title + (studyMode ? "" : ` · ${quality} quality`)
    : "Graphics Quality Room" + (studyMode ? "" : ` · ${quality} quality`);
  $("task-text").textContent = state.done ? "" : tr ? tr.text : "Look around, then start the practice trial.";
  $("task-status").textContent = tr && !state.done ? `${tr.targets.length - state.remaining.length}/${tr.targets.length} found · ${state.errors} wrong selection(s)` : "";
  $("start").hidden = state.trial >= 0;
  $("download").hidden = !state.done;
  updatePanel();
}
function startTrial(i) {
  state.trial = i;
  state.phase = TRIALS[i].phase;
  arrange(i);
  state.remaining = [...TRIALS[i].targets];
  state.errors = 0;
  state.startedAt = performance.now();
  record("phase", { phaseId: state.phase });
  record("trial-start", { trial: i, phase: state.phase, layout: LOOKALIKES.map((id) => selectable.find((o) => o.userData.id === id).position.toArray()) });
  showTask();
}
function select(id) {
  if (state.trial < 0 || state.done) return { accepted: false, reason: "No active trial." };
  const obj = selectable.find((o) => o.userData.id === id);
  if (!obj) return { accepted: false, reason: "Unknown object." };
  const correct = state.remaining.includes(obj.userData.truth);
  record("select", { trial: state.trial, objectId: id, correct });
  if (correct) {
    state.remaining = state.remaining.filter((t) => t !== obj.userData.truth);
    flash(obj, 0x2ecc71);
  } else {
    state.errors++;
    flash(obj, 0xe74c3c);
  }
  if (!state.remaining.length) {
    const seconds = (performance.now() - state.startedAt) / 1000;
    record("trial-end", { trial: state.trial, phase: state.phase, seconds, errors: state.errors });
    if (state.trial + 1 < TRIALS.length) startTrial(state.trial + 1);
    else {
      state.done = true;
      record("phase", { phaseId: "questionnaire" });
    }
  }
  showTask();
  return { accepted: true, correct };
}
function flash(obj, color) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.12, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(obj.position).setY(0.78);
  scene.add(ring);
  setTimeout(() => scene.remove(ring), 600);
}

// In-headset instruction panel above the table.
const panelCanvas = document.createElement("canvas");
panelCanvas.width = 1024;
panelCanvas.height = 256;
const panelTexture = new THREE.CanvasTexture(panelCanvas);
panelTexture.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.4), new THREE.MeshBasicMaterial({ map: panelTexture, transparent: true }));
panel.position.set(0, 1.55, -1.4);
scene.add(panel);
function updatePanel() {
  const g = panelCanvas.getContext("2d");
  g.clearRect(0, 0, 1024, 256);
  g.fillStyle = "rgba(0,0,0,0.65)";
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = "#fff";
  g.font = "bold 44px system-ui";
  g.fillText($("task-title").textContent, 30, 70);
  g.font = "34px system-ui";
  const words = $("task-text").textContent.split(" ");
  let line = "",
    y = 130;
  for (const w of words) {
    if (g.measureText(line + w).width > 960) {
      g.fillText(line, 30, y);
      line = "";
      y += 44;
    }
    line += w + " ";
  }
  g.fillText(line, 30, y);
  g.font = "28px system-ui";
  g.fillStyle = "#ccc";
  g.fillText($("task-status").textContent, 30, 236);
  panelTexture.needsUpdate = true;
}

// ---------- input: mouse and XR controllers ----------
const raycaster = new THREE.Raycaster();
function pick(origin, direction) {
  raycaster.set(origin, direction);
  const hit = raycaster.intersectObjects(selectable, true)[0];
  return hit?.object.userData.objectId;
}
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; // was a drag
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(selectable, true)[0];
  if (hit) select(hit.object.userData.objectId);
});
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  controller.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]), new THREE.LineBasicMaterial({ color: 0xffffff })));
  controller.addEventListener("selectstart", () => {
    if (state.trial < 0) return startTrial(0);
    const m = new THREE.Matrix4().extractRotation(controller.matrixWorld);
    const id = pick(new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld), new THREE.Vector3(0, 0, -1).applyMatrix4(m));
    if (id) select(id);
  });
  scene.add(controller);
}
$("start").addEventListener("click", () => startTrial(0));
$("download").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `log-${participant}-${quality}.json`;
  a.click();
});

// Quality switcher (hidden in study mode, where the experimenter sets ?quality=).
if (!studyMode)
  for (const level of LEVELS) {
    const b = document.createElement("button");
    b.textContent = level;
    b.setAttribute("aria-pressed", String(level === quality));
    b.addEventListener("click", () => {
      params.set("quality", level);
      location.search = params.toString();
    });
    $("quality").appendChild(b);
  }

// ---------- automation API for an agent worker (e.g. Playwright) ----------
// Exposes only what a participant could perceive or do: screen positions of
// neutral object IDs, camera control, selection, screenshots and the event log.
window.xrStudy = {
  quality,
  getState: () => ({
    phase: state.done ? "questionnaire" : state.phase,
    trial: state.trial,
    instruction: $("task-text").textContent,
    found: state.trial >= 0 ? TRIALS[state.trial].targets.length - state.remaining.length : 0,
    errors: state.errors,
    done: state.done,
  }),
  start: () => startTrial(0),
  listObjects: () =>
    selectable.map((o) => {
      const p = o.getWorldPosition(new THREE.Vector3()).project(camera);
      return { id: o.userData.id, x: (p.x + 1) / 2, y: (1 - p.y) / 2, onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1 };
    }),
  select,
  look: (azimuthDeg, polarDeg, distance = 1.35) => {
    const s = new THREE.Spherical(distance, THREE.MathUtils.degToRad(polarDeg), THREE.MathUtils.degToRad(azimuthDeg));
    camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(controls.target));
    controls.update();
    renderer.render(scene, camera);
  },
  capture: () => {
    panel.visible = false;
    renderer.render(scene, camera);
    return renderer.domElement.toDataURL("image/png");
  },
  log: () => structuredClone(log),
};

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
record("session-start", { userAgent: navigator.userAgent });
showTask();
renderer.setAnimationLoop(() => {
  panel.visible = renderer.xr.isPresenting; // the HTML overlay serves desktop users
  controls.update();
  renderer.render(scene, camera);
});
