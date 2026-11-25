// Material-cues WebXR study app (suite 4, synthetic study): one small room rendered at two
// rendering qualities.
//   low   flat, unlit colours: every material is drawn in its average colour, no lighting,
//         shading, textures, reflections or shadows, at reduced resolution
//   high  physically based materials (full procedural texture sets), reflections, glass
//         transmission, clear-coat glaze, brushed-metal anisotropy, soft shadows
// Six look-alike objects come in pairs that share shape and almost share colour and differ in
// material (glossy vs matte ceramic mug, brushed-metal vs plastic bowl, glass vs plastic vase), so
// the rendering quality changes which material cues can be seen.
//
// Task per design: one practice trial (select the wooden box); then the scored main task: four
// search trials (select the glossy ceramic mug, the brushed-metal bowl and the glass vase) and six
// identification trials (a yellow ring and cone mark one look-alike; name its material).
// The layout of the look-alikes and the order of the marked objects are drawn at random for every
// session (written to the event log), so the code holds no layout.
//
// URL parameters:
//   quality = low | high               (default high)
//   study   = 1                        hides the quality switcher and condition label
//   participant = P01                  written into the event log
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { PATTERNS, pbrSet } from "./pbr.js";

const params = new URLSearchParams(location.search);
const LEVELS = ["low", "high"];
const quality = LEVELS.includes(params.get("quality")) ? params.get("quality") : "high";
const high = quality === "high";
const studyMode = params.get("study") === "1";
const participant = params.get("participant") ?? "anonymous";
// A fresh random seed for every page load: the layouts follow from it and are logged.
const sessionSeed = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

const QUALITY = {
  low: { antialias: false, pixelRatio: 0.7, shadows: false, env: false, toneMapping: false },
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
scene.background = new THREE.Color(high ? 0x9fa7ad : 0x8a8f94);
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

// ---------- lights (high quality only; low quality is unlit) ----------
if (high) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x6b5a48, 0.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  sun.position.set(2.5, 4, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -3;
  sun.shadow.camera.right = 3;
  sun.shadow.camera.top = 3;
  sun.shadow.camera.bottom = -3;
  sun.shadow.radius = 4;
  scene.add(sun);
}

// ---------- materials per quality ----------
// The same procedural patterns (pbr.js) are used at both levels, so the scene content is
// identical; only rendering quality changes.
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
  if (!high) return new THREE.MeshBasicMaterial({ color: PATTERNS[pattern].flat });
  if (pattern === "glass")
    return new THREE.MeshPhysicalMaterial({ color: PATTERNS.glass.flat, roughness: 0.04, transmission: 1, thickness: 0.05, ior: 1.5, specularIntensity: 1 });
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
const segments = high ? 64 : 16;
// Displacement needs real vertices: dense grids only at high quality.
const grid = (w, h, perMetre) => (high ? [Math.round(w * perMetre), Math.round(h * perMetre)] : [1, 1]);

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

// ---------- objects (names are not shown to participants; the runtime gives agents neutral IDs) ----------
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

// The answer options of the identification trials, as shown to participants.
const MATERIALS = ["glossy ceramic", "matte ceramic", "brushed metal", "plastic", "glass"];
// id -> [builder, home position, what it is (scoring and the log only), its material (an option above)]
const OBJECTS = {
  "mug-a": [() => mug("ceramic-glossy"), [-0.6, 0.775, -0.15], "glossy-mug", "glossy ceramic"],
  "mug-b": [() => mug("ceramic-matte"), [-0.3, 0.775, 0.2], "matte-mug", "matte ceramic"],
  "bowl-a": [() => bowl("metal-brushed"), [0.35, 0.775, -0.2], "metal-bowl", "brushed metal"],
  "bowl-b": [() => bowl("plastic"), [0.05, 0.775, 0.15], "plastic-bowl", "plastic"],
  "vase-a": [() => vase("glass"), [0.65, 0.775, 0.15], "glass-vase", "glass"],
  "vase-b": [() => vase("plastic-blue"), [-0.05, 0.775, -0.25], "plastic-vase", "plastic"],
  box: [box, [0.7, 0.775, -0.25], "wooden-box", "wood"],
  cushion: [cushion, [-0.7, 0.775, 0.25], "cushion", "fabric"],
  plant: [plant, [0.3, 0.775, 0.28], "plant", "plant"],
};
const selectable = [];
for (const [id, [build, pos, truth, made]] of Object.entries(OBJECTS)) {
  const g = build();
  g.position.set(...pos);
  g.userData = { id, truth, made };
  g.traverse((o) => (o.userData.objectId = id));
  scene.add(g);
  selectable.push(g);
}
const byId = (id) => selectable.find((o) => o.userData.id === id);

// ---------- task ----------
const SEARCH = "Select the glossy ceramic mug, the brushed-metal bowl and the glass vase.";
const IDENTIFY = `What is the marked object made of? Answer ${MATERIALS.slice(0, -1).join(", ")} or ${MATERIALS.at(-1)}.`;
const LOOKALIKES = ["mug-a", "mug-b", "bowl-a", "bowl-b", "vase-a", "vase-b"];
const SEARCH_TRIALS = 4;
const TRIALS = [
  { kind: "practice", phase: "practice", title: "Practice", text: "Select the wooden box.", targets: ["wooden-box"] },
  ...Array.from({ length: SEARCH_TRIALS }, (_, i) => ({ kind: "search", phase: "main", title: `Search · trial ${i + 1} of ${SEARCH_TRIALS}`, text: SEARCH, targets: ["glossy-mug", "metal-bowl", "glass-vase"] })),
  ...LOOKALIKES.map((_, i) => ({ kind: "identify", phase: "main", title: `Identification · item ${i + 1} of ${LOOKALIKES.length}`, text: IDENTIFY, item: i })),
];
const SLOTS = LOOKALIKES.map((id) => OBJECTS[id][1]);
function seeded(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
// Before every search trial (and once before the identification trials) the look-alikes swap places.
function arrange(key) {
  const order = shuffled([...SLOTS.keys()], seeded(`${sessionSeed}|${quality}|${key}`));
  LOOKALIKES.forEach((id, i) => byId(id).position.set(...SLOTS[order[i]]));
}
// The order in which the look-alikes are marked in the identification trials.
const marked = shuffled(LOOKALIKES, seeded(`${sessionSeed}|${quality}|marked`));

const state = { trial: -1, phase: "idle", remaining: [], errors: 0, startedAt: 0, done: false, answers: 0 };
const log = [];
function record(type, data = {}) {
  log.push({ t: Math.round(performance.now()), type, quality, participant, ...data });
}
const $ = (id) => document.getElementById(id);
const current = () => (state.trial >= 0 && !state.done ? TRIALS[state.trial] : null);
const markedId = () => (current()?.kind === "identify" ? marked[current().item] : null);

// In the identification trials a yellow ring on the table surrounds the marked object and a small
// yellow cone points down at it from just above its top (unambiguous from every viewpoint).
const TOP = { mug: 0.83, bowl: 0.86, vase: 1.02 }; // height of each shape's top above the floor
const yellow = new THREE.MeshBasicMaterial({ color: 0xffd400, side: THREE.DoubleSide });
const marker = new THREE.Group();
const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.125, 48), yellow);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.778;
const cone = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 16), yellow);
cone.rotation.x = Math.PI; // pointing down
marker.add(ring, cone);
marker.visible = false;
scene.add(marker);
function placeMarker() {
  const id = markedId();
  marker.visible = !!id;
  if (!id) return;
  const p = byId(id).position;
  marker.position.set(p.x, 0, p.z);
  cone.position.y = TOP[id.split("-")[0]] + 0.05;
}

function progressText() {
  const tr = current();
  if (!tr) return "";
  if (tr.kind === "identify") return `${state.answers}/${LOOKALIKES.length} answered`;
  return `${tr.targets.length - state.remaining.length}/${tr.targets.length} found · ${state.errors} wrong selection(s)`;
}
function showTask() {
  const tr = current();
  $("task-title").textContent = state.done
    ? "Done — please answer the questionnaire"
    : tr
    ? tr.title + (studyMode ? "" : ` · ${quality} quality`)
    : "Material Cues Room" + (studyMode ? "" : ` · ${quality} quality`);
  $("task-text").textContent = state.done ? "" : tr ? tr.text : "Look around, then start the practice trial.";
  $("task-status").textContent = progressText();
  $("answers").hidden = tr?.kind !== "identify";
  $("start").hidden = state.trial >= 0;
  $("download").hidden = !state.done;
  placeMarker();
  updatePanel();
}
function startTrial(i) {
  state.trial = i;
  const tr = TRIALS[i];
  state.phase = tr.phase;
  if (tr.kind !== "identify") arrange(`trial-${i}`);
  else if (tr.item === 0) arrange("identify");
  state.remaining = tr.kind === "identify" ? [] : [...tr.targets];
  state.errors = 0;
  state.startedAt = performance.now();
  if (i === 0 || TRIALS[i - 1].phase !== tr.phase) record("phase", { phaseId: tr.phase });
  record("trial-start", {
    trial: i,
    kind: tr.kind,
    phase: tr.phase,
    layout: Object.fromEntries(LOOKALIKES.map((id) => [OBJECTS[id][2], byId(id).position.toArray()])),
    ...(tr.kind === "identify" ? { marked: OBJECTS[marked[tr.item]][2] } : {}),
  });
  showTask();
}
function next() {
  if (state.trial + 1 < TRIALS.length) startTrial(state.trial + 1);
  else {
    state.done = true;
    record("phase", { phaseId: "questionnaire" });
    showTask();
  }
}
function select(id) {
  const tr = current();
  if (!tr) return { accepted: false, reason: "No active trial." };
  if (tr.kind === "identify") return { accepted: false, reason: "Name the marked object's material (identify)." };
  const obj = byId(id);
  if (!obj) return { accepted: false, reason: "Unknown object." };
  const correct = state.remaining.includes(obj.userData.truth);
  record("select", { trial: state.trial, object: obj.userData.truth, correct });
  if (correct) {
    state.remaining = state.remaining.filter((t) => t !== obj.userData.truth);
    flash(obj, 0x2ecc71);
  } else {
    state.errors++;
    flash(obj, 0xe74c3c);
  }
  if (!state.remaining.length) {
    const seconds = (performance.now() - state.startedAt) / 1000;
    record("trial-end", { trial: state.trial, kind: tr.kind, phase: tr.phase, seconds, wrongSelections: state.errors });
    next();
  } else showTask();
  return { accepted: true, correct };
}
// Answers are normalised (case, hyphens) and a few short forms are accepted ("metal", "glossy").
const ALIASES = { metal: "brushed metal", glossy: "glossy ceramic", matte: "matte ceramic", "ceramic glossy": "glossy ceramic", "ceramic matte": "matte ceramic", "metal brushed": "brushed metal" };
function identify(answer) {
  const tr = current();
  if (tr?.kind !== "identify") return { accepted: false, reason: "No identification trial is active." };
  const said = String(answer ?? "").toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ").trim();
  const material = MATERIALS.includes(said) ? said : ALIASES[said];
  if (!material) return { accepted: false, reason: `Answer one of: ${MATERIALS.join(", ")}.` };
  const obj = byId(marked[tr.item]);
  // No feedback: participants are not told whether an answer was right.
  record("identify", { trial: state.trial, item: tr.item + 1, object: obj.userData.truth, answer: material, correct: material === obj.userData.made, seconds: (performance.now() - state.startedAt) / 1000 });
  state.answers++;
  next();
  return { accepted: true };
}
function flash(obj, color) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.12, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.copy(obj.position).setY(0.78);
  scene.add(ring);
  setTimeout(() => scene.remove(ring), 600);
}

// ---------- in-headset panel and answer tiles ----------
function canvasPlane(w, h, px, py) {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = py;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  return { canvas, texture, mesh };
}
const panel = canvasPlane(1.6, 0.4, 1024, 256);
panel.mesh.position.set(0, 1.55, -1.4);
scene.add(panel.mesh);
function updatePanel() {
  const g = panel.canvas.getContext("2d");
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
  panel.texture.needsUpdate = true;
}
// In a headset, participants answer by pointing at one of five tiles under the panel.
const tiles = MATERIALS.map((m, i) => {
  const t = canvasPlane(0.3, 0.09, 384, 112);
  const g = t.canvas.getContext("2d");
  g.fillStyle = "#2c684f";
  g.fillRect(0, 0, 384, 112);
  g.fillStyle = "#fff";
  g.font = "bold 40px system-ui";
  g.textAlign = "center";
  g.fillText(m, 192, 70);
  t.texture.needsUpdate = true;
  t.mesh.position.set(-0.68 + i * 0.34, 1.27, -1.4);
  t.mesh.userData.answer = m;
  t.mesh.visible = false;
  scene.add(t.mesh);
  return t.mesh;
});

// ---------- input: mouse, answer buttons and XR controllers ----------
const raycaster = new THREE.Raycaster();
let down = null;
renderer.domElement.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return; // was a drag
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(selectable, true)[0];
  if (hit) select(hit.object.userData.objectId);
});
for (const m of MATERIALS) {
  const b = document.createElement("button");
  b.textContent = m;
  b.addEventListener("click", () => identify(m));
  $("answers").appendChild(b);
}
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  controller.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]), new THREE.LineBasicMaterial({ color: 0xffffff })));
  controller.addEventListener("selectstart", () => {
    if (state.trial < 0) return startTrial(0);
    const m = new THREE.Matrix4().extractRotation(controller.matrixWorld);
    raycaster.set(new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld), new THREE.Vector3(0, 0, -1).applyMatrix4(m));
    if (current()?.kind === "identify") {
      const tile = raycaster.intersectObjects(tiles, false)[0];
      if (tile) identify(tile.object.userData.answer);
      return;
    }
    const hit = raycaster.intersectObjects(selectable, true)[0];
    if (hit) select(hit.object.userData.objectId);
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

// ---------- window.xrStudy: the contract the workbench's WebXR runtime plays the app through ----------
// Exposes only what a participant could perceive or do: screen positions of the objects, the marker,
// camera control, selection, the identification answer and the event log. Only the documented
// getState fields and `public` reach the agent (docs/runtime-adapters.md); `public` holds what the
// participant sees in the task panel. The object IDs here are replaced by neutral ones for agents.
window.xrStudy = {
  getState: () => {
    const tr = current();
    return {
      phase: state.done ? "questionnaire" : state.phase,
      trial: state.trial,
      instruction: $("task-text").textContent,
      done: state.done,
      public: !tr
        ? {}
        : tr.kind === "identify"
        ? { step: "identification", item: tr.item + 1, items: LOOKALIKES.length, answered: state.answers }
        : { step: tr.kind, found: tr.targets.length - state.remaining.length, targets: tr.targets.length, wrongSelections: state.errors },
    };
  },
  start: () => startTrial(0),
  listObjects: () =>
    selectable.map((o) => {
      const p = o.getWorldPosition(new THREE.Vector3()).project(camera);
      const onScreen = Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1;
      return { id: o.userData.id, x: (p.x + 1) / 2, y: (1 - p.y) / 2, onScreen, visible: onScreen, ...(o.userData.id === markedId() ? { public: { marked: true } } : {}) };
    }),
  select,
  act: (name, args) => (name === "identify" ? identify(args?.material) : { accepted: false, reason: `Unknown action ${name}.` }),
  // The camera orbits the table: polar 5–89° (89 is almost level with the table top). Replies with the view applied.
  look: (azimuthDeg, polarDeg, distance = 1.35) => {
    const polar = Math.min(89, Math.max(5, Number(polarDeg)));
    const s = new THREE.Spherical(distance, THREE.MathUtils.degToRad(polar), THREE.MathUtils.degToRad(azimuthDeg));
    camera.position.copy(new THREE.Vector3().setFromSpherical(s).add(controls.target));
    controls.update();
    renderer.render(scene, camera);
    return { azimuth: azimuthDeg, polar };
  },
  log: () => structuredClone(log),
};

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
record("session-start", { sessionSeed, userAgent: navigator.userAgent });
showTask();
renderer.setAnimationLoop(() => {
  const inHeadset = renderer.xr.isPresenting; // the HTML overlay serves desktop users
  panel.mesh.visible = inHeadset;
  for (const t of tiles) t.visible = inHeadset && current()?.kind === "identify";
  controls.update();
  renderer.render(scene, camera);
});
