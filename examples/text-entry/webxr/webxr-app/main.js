// Mid-air text entry WebXR app (suite 7 played in WebXR; synthetic study).
// A plain grey room; the participant sits on a chair without armrests, holding two controllers.
// Four keyboards (the room, the phrases and the instruction stay the same):
//   raycast  flat QWERTY about 1 m wide, 1.5 m away at chest height; point a ray at a key, pull the
//            trigger. Space, Backspace and Enter are keys on the panel.
//   drum     QWERTY drum pads on a curved surface 45 cm in front of the chest, 25 cm below shoulder
//            height, tilted 30° towards the participant; a 20 cm drumstick on each controller strikes
//            a pad downwards; the controller vibrates on each hit.
//   swipe    the raycast panel; a word is one stroke through its letters (trigger held), turned into
//            the closest lexicon word plus a space; three next-best words appear above the keyboard;
//            Delete word removes the last word; single letters can be tapped as on the raycast keyboard.
//   split    two small half-keyboards just above the controllers (q–t, a–g, z–b | y–p, h–l, n–m); a
//            thumbstick tilt moves the highlight one key, the lower face button types it, the
//            highlight returns to the middle; grips type a space, upper face buttons are Backspace,
//            a trigger is Enter.
// Actions (act): type, backspace, enter-phrase for every keyboard; swipe, choose-word and delete-word
// on the swipe keyboard (listed at run time by actions()). Each reply says what typing took on this
// keyboard (trigger pulls, strikes, tilts and presses) and what the participant saw and felt.
// The app adds no motor noise and no human timing: keys land where they were aimed, and a swipe stroke
// runs exactly through the key centres of the letters given. Uncorrected errors are logged, never shown.
//
// Phrases: the study's pool of 40 (phrases.js), in an order drawn from the participant ID, ten per
// keyboard by its place in [raycast, drum, swipe, split], so no phrase repeats within a session; two
// practice phrases per keyboard from outside the pool.
//
// URL parameters:
//   keyboard    = raycast | drum | swipe | split   (default raycast)
//   study       = 1                                hides the desktop help and the keyboard switcher
//   participant = P01                              picks the phrase order; written into the event log
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";
import { PHRASES, PRACTICE, LEXICON } from "./phrases.js";

const params = new URLSearchParams(location.search);
const KEYBOARDS = ["raycast", "drum", "swipe", "split"];
const keyboard = KEYBOARDS.includes(params.get("keyboard")) ? params.get("keyboard") : "raycast";
const studyMode = params.get("study") === "1";
const participant = params.get("participant") ?? "anonymous";
const sessionSeed = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
const INSTRUCTION = "Type the phrase as quickly and accurately as you can. You may correct mistakes you notice. Press Enter when you are done.";

// ---------- phrases ----------
function seeded(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
function shuffled(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pool = shuffled(PHRASES, seeded(`pool|${participant}`));
const slot = KEYBOARDS.indexOf(keyboard);
const practice = shuffled(PRACTICE, seeded(`practice|${participant}`)).slice(slot * 2, slot * 2 + 2);
const ITEMS = [
  ...practice.map((text, i) => ({ phase: "practice", n: i + 1, of: practice.length, text })),
  ...pool.slice(slot * 10, slot * 10 + 10).map((text, i) => ({ phase: "main", n: i + 1, of: 10, text })),
];

// ---------- renderer, scene, camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xbfc2c6);
scene.add(new THREE.HemisphereLight(0xffffff, 0x8d9095, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 0.7);
sun.position.set(0.6, 3, 1.2);
scene.add(sun);
const roomMat = new THREE.MeshLambertMaterial({ color: 0xcfd1d4 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshLambertMaterial({ color: 0x9a9da2 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
for (const [x, z, ry] of [[0, -3.2, 0], [-3, 0, Math.PI / 2], [3, 0, -Math.PI / 2]]) {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), roomMat);
  wall.position.set(x, 1.5, z);
  wall.rotation.y = ry;
  scene.add(wall);
}
const EYE = new THREE.Vector3(0, 1.2, 0); // seated
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.02, 30);
camera.position.copy(EYE);

function labelTexture(text, { bg = "#e9ecef", fg = "#111", px = 96, w = 128, h = 128, turn = false } = {}) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = fg;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `bold ${px}px system-ui`;
  // A cylinder's top cap maps the texture turned by 90°; `turn` draws the label turned back.
  if (turn) {
    g.translate(w / 2, h / 2);
    g.rotate(-Math.PI / 2);
    g.fillText(text, 0, 4);
  } else g.fillText(text, w / 2, h / 2 + 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const KEY = 0xe9ecef,
  LIT = 0x8fd3ff,
  HIGHLIGHT = 0xffd400;
const keyMeshes = new Map(); // key name -> mesh (letters, "space", "backspace", "enter", "delete-word")
const NAMES = { space: "space", backspace: "⌫", enter: "Enter", "delete-word": "Delete word" };

// Controllers (simple bodies) and, per keyboard, a ray or a drumstick.
const controllerMat = new THREE.MeshLambertMaterial({ color: 0x2b2e33 });
function controllerBody(x, y, z) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.12, 16), controllerMat);
  body.rotation.x = Math.PI / 2.6;
  g.add(body);
  const ringM = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 8, 24), controllerMat);
  ringM.position.set(0, 0.03, -0.035);
  ringM.rotation.x = 0.6;
  g.add(ringM);
  g.position.set(x, y, z);
  scene.add(g);
  return g;
}

// ---------- keyboards ----------
const ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const OFFSET = [0, 0.5, 1.5];
let panelAnchor, defaultPolar;
const board = new THREE.Group();
scene.add(board);

function flatBoard(withDeleteWord) {
  // 1 m wide (ten keys of 0.1 m), 1.5 m away, at chest height
  board.position.set(0, 0.95, -1.5);
  board.rotation.x = -0.12;
  const u = 0.1,
    s = 0.088;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1.06, 0.46), new THREE.MeshLambertMaterial({ color: 0x3b3f45 }));
  back.position.set(0, -0.03, -0.012);
  board.add(back);
  ROWS.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s, s, 0.012), keyMaterials(ch));
      m.position.set((c + OFFSET[r] - 4.5) * u, (1 - r) * u + 0.02, 0);
      board.add(m);
      keyMeshes.set(ch, m);
    }),
  );
  const bottom = withDeleteWord ? [["delete-word", 2], ["space", 4], ["backspace", 2], ["enter", 2]] : [["backspace", 2], ["space", 5], ["enter", 2]];
  let x = withDeleteWord ? -5 : -4.5;
  for (const [name, w] of bottom) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w * u - 0.012, s, 0.012), keyMaterials(NAMES[name], w));
    m.position.set((x + w / 2) * u, -2 * u + 0.02, 0);
    x += w;
    board.add(m);
    keyMeshes.set(name, m);
  }
  panelAnchor = { pos: new THREE.Vector3(0, 1.38, -1.52), w: 1.0, h: 0.3 };
  defaultPolar = 93;
  for (const sx of [-1, 1]) {
    const c = controllerBody(sx * 0.2, 0.88, -0.32);
    const ray = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(-sx * 0.15, 0.04, -1.15)]), new THREE.LineBasicMaterial({ color: 0xffffff }));
    c.add(ray);
  }
}
function keyMaterials(text, w = 1) {
  const side = new THREE.MeshLambertMaterial({ color: KEY });
  const face = new THREE.MeshLambertMaterial({ color: KEY, map: labelTexture(text, { px: text.length > 1 ? 40 : 84, w: 128 * Math.min(w, 4), h: 128 }) });
  return [side, side, side, side, face, side];
}
function drumBoard() {
  // pads on a curved surface 45 cm in front of the chest, 25 cm below shoulder height, tilted 30°
  board.position.set(0, 0.8, -0.45);
  board.rotation.x = THREE.MathUtils.degToRad(30);
  const u = 0.062,
    R = 0.45;
  const place = (m, x, rowZ) => {
    m.position.set(x, 0, rowZ + (x * x) / (2 * R));
    m.rotation.y = -Math.asin(Math.max(-1, Math.min(1, x / R))) * 0.6;
  };
  ROWS.forEach((row, r) =>
    [...row].forEach((ch, c) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.012, 24), padMaterials(ch));
      place(m, (c + OFFSET[r] - 4.5) * u, (r - 1) * u);
      board.add(m);
      keyMeshes.set(ch, m);
    }),
  );
  for (const [name, x, w] of [["backspace", -3.2, 1.6], ["space", 0, 3.6], ["enter", 3.2, 1.6]]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w * u, 0.012, u * 0.85), padMaterials(NAMES[name], w));
    place(m, x * u, 2 * u);
    board.add(m);
    keyMeshes.set(name, m);
  }
  panelAnchor = { pos: new THREE.Vector3(0, 1.06, -0.8), w: 0.56, h: 0.17 };
  defaultPolar = 121;
  for (const sx of [-1, 1]) {
    const c = controllerBody(sx * 0.27, 0.96, -0.2);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.006, 0.2, 10), new THREE.MeshLambertMaterial({ color: 0xc8a06a }));
    stick.rotation.x = -1.0;
    stick.position.set(-sx * 0.02, -0.04, -0.09);
    c.add(stick);
  }
}
function padMaterials(text, w = 1) {
  const side = new THREE.MeshLambertMaterial({ color: 0x6c7178 });
  const round = !(text.length > 1 || w > 1);
  const top = new THREE.MeshLambertMaterial({ color: KEY, map: labelTexture(text, { px: text.length > 1 ? 38 : 80, w: 128 * Math.min(Math.ceil(w), 4), h: 128, turn: round }) });
  // cylinder groups: side, top, bottom; box faces: +x, -x, +y (top), -y, +z, -z
  return text.length > 1 || w > 1 ? [side, side, top, side, side, side] : [side, top, side];
}
const HALVES = { left: ["qwert", "asdfg", "zxcvb"], right: ["yuiop", "hjkl", "nm"] };
const MIDDLE = { left: [1, 2], right: [1, 2] }; // row, column of the key the highlight starts on: d, k
const halfOf = (ch) => (HALVES.left.some((r) => r.includes(ch)) ? "left" : "right");
const halves = {};
function splitBoard() {
  const u = 0.024;
  for (const side of ["left", "right"]) {
    const sx = side === "left" ? -1 : 1;
    const c = controllerBody(sx * 0.17, 0.64, -0.3);
    const g = new THREE.Group();
    g.position.set(sx * 0.17, 0.74, -0.32);
    g.lookAt(EYE);
    scene.add(g);
    halves[side] = g;
    HALVES[side].forEach((row, r) =>
      [...row].forEach((ch, col) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(u * 0.9, u * 0.9, 0.004), keyMaterials(ch));
        m.position.set((col - 2) * u, (1 - r) * u, 0);
        g.add(m);
        keyMeshes.set(ch, m);
      }),
    );
    void c;
  }
  panelAnchor = { pos: new THREE.Vector3(0, 1.0, -0.72), w: 0.5, h: 0.15 };
  defaultPolar = 124;
  showHighlight();
}
function showHighlight() {
  for (const side of ["left", "right"]) {
    const [r, c] = MIDDLE[side];
    const ch = HALVES[side][r][c];
    for (const k of HALVES[side].join("")) tint(keyMeshes.get(k), KEY);
    tint(keyMeshes.get(ch), HIGHLIGHT);
  }
}
function tint(mesh, color) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) m.color.setHex(color);
}
if (keyboard === "drum") drumBoard();
else if (keyboard === "split") splitBoard();
else flatBoard(keyboard === "swipe");

// ---------- the phrase panel ----------
const panelCanvas = document.createElement("canvas");
panelCanvas.width = 1024;
panelCanvas.height = 300;
const panelTex = new THREE.CanvasTexture(panelCanvas);
panelTex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(panelAnchor.w, panelAnchor.h), new THREE.MeshBasicMaterial({ map: panelTex }));
panel.position.copy(panelAnchor.pos);
panel.lookAt(EYE);
scene.add(panel);

// ---------- task state and event log ----------
const state = { index: -1, typed: "", done: false, shownAt: 0, suggestions: [], lastWord: null };
const log = [];
function record(type, data = {}) {
  log.push({ t: Math.round(performance.now()), type, keyboard, participant, ...data });
}
const current = () => (state.index >= 0 && !state.done ? ITEMS[state.index] : null);

function drawPanel() {
  const g = panelCanvas.getContext("2d");
  const W = panelCanvas.width,
    H = panelCanvas.height;
  g.fillStyle = "#16181b";
  g.fillRect(0, 0, W, H);
  const item = current();
  g.textBaseline = "middle";
  if (!item) {
    g.fillStyle = "#fff";
    g.font = "bold 52px system-ui";
    g.textAlign = "center";
    g.fillText(state.done ? "Done: please take off the headset" : "Get ready", W / 2, H / 2);
  } else {
    g.textAlign = "left";
    g.fillStyle = "#9aa3ad";
    g.font = "30px system-ui";
    g.fillText(item.phase === "practice" ? `Practice phrase ${item.n} of ${item.of}` : `Phrase ${item.n} of ${item.of}`, 30, 34);
    g.fillStyle = "#fff";
    g.font = "bold 54px system-ui";
    g.fillText(item.text, 30, 104);
    g.fillStyle = "#8fd3ff";
    g.font = "54px ui-monospace, monospace";
    g.fillText(state.typed + "|", 30, 184);
    if (keyboard === "swipe" && state.suggestions.length) {
      g.fillStyle = "#ffd27a";
      g.font = "36px system-ui";
      g.fillText(`Suggestions:  ${state.suggestions.join("   ·   ")}`, 30, 262);
    }
  }
  panelTex.needsUpdate = true;
}
function show(i) {
  const prev = current();
  state.index = i;
  state.typed = "";
  state.suggestions = [];
  state.lastWord = null;
  state.shownAt = performance.now();
  const item = ITEMS[i];
  if (!prev || prev.phase !== item.phase) record("phase", { phaseId: item.phase });
  record("phrase-start", { phase: item.phase, n: item.n, presented: item.text });
  drawPanel();
}

// Minimum string distance (Levenshtein), for the uncorrected error rate in the log.
function msd(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// ---------- what typing takes on each keyboard ----------
function splitCost(ch) {
  if (ch === " ") return { tilts: 0, presses: 1, how: "grip" };
  const side = halfOf(ch);
  const rows = HALVES[side];
  const r = rows.findIndex((row) => row.includes(ch));
  const c = rows[r].indexOf(ch);
  // vertical tilts first (the column is clamped to a shorter row), then horizontal ones
  let [cr, cc] = MIDDLE[side];
  let tilts = 0;
  while (cr !== r) {
    cr += Math.sign(r - cr);
    cc = Math.min(cc, rows[cr].length - 1);
    tilts++;
  }
  tilts += Math.abs(c - cc);
  return { tilts, presses: 1, how: side };
}
let flash = null;
function light(name) {
  const m = keyMeshes.get(name);
  if (!m) return;
  clearTimeout(flash);
  if (keyboard === "split") showHighlight();
  else for (const k of keyMeshes.values()) tint(k, KEY);
  tint(m, LIT);
  flash = setTimeout(() => (keyboard === "split" ? showHighlight() : tint(m, KEY)), 250);
}
const described = new Set();
function once(key, full, short) {
  if (described.has(key)) return short;
  described.add(key);
  return full;
}
const times = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function effort(chars, extra = "") {
  const n = chars.length;
  if (keyboard === "split") {
    const costs = [...chars].map(splitCost);
    const tilts = costs.reduce((s, c) => s + c.tilts, 0);
    const presses = costs.filter((c) => c.how !== "grip").length;
    const grips = costs.filter((c) => c.how === "grip").length;
    return {
      took: `${times(tilts, "thumbstick tilt", "thumbstick tilts")} and ${times(presses, "press", "presses")} of the lower face buttons${grips ? `, ${times(grips, "grip press", "grip presses")} for spaces` : ""}${extra}`,
      seen: once("split", "The highlight moved one key per tilt and went back to the middle of its half (d on the left, k on the right) after each key; each typed letter appeared below the phrase. Nothing vibrated.", "As before: the highlight moved one key per tilt and went back to the middle."),
    };
  }
  if (keyboard === "drum")
    return {
      took: `${times(n, "strike", "strikes")} of a drumstick tip on the pads${extra}`,
      seen: once("drum", "Each pad was struck downwards with the tip of one of the two drumsticks; the controller vibrated on each hit, and the letter appeared below the phrase.", "As before: a strike per key, and the controller vibrated on each hit."),
    };
  return {
    took: `${times(n, "trigger pull", "trigger pulls")}, moving the ray from key to key on the keyboard 1.5 m away${extra}`,
    seen: once("ray", "Each key lit up and clicked as the trigger was pulled with the ray on it; the letter appeared below the phrase.", "As before: each key lit up and clicked."),
  };
}
function needItem() {
  return current() ? null : { accepted: false, reason: state.done ? "All phrases are done." : "No phrase is shown yet." };
}
function typeText(text) {
  const refused = needItem();
  if (refused) return refused;
  const chars = String(text ?? "");
  if (!chars) return { accepted: false, reason: "Give text: the letters and spaces to type." };
  if (!/^[a-z ]+$/.test(chars)) return { accepted: false, reason: "This keyboard types only the lowercase letters a–z and Space." };
  if (chars.length > 80) return { accepted: false, reason: "Type at most 80 characters in one action." };
  state.typed += chars;
  state.suggestions = [];
  state.lastWord = null;
  const e = effort(chars);
  record("type", { text: chars, panel: state.typed, took: e.took });
  light(chars.at(-1) === " " ? "space" : chars.at(-1));
  drawPanel();
  return { accepted: true, public: { typed: chars, took: e.took, seen: e.seen, panel: state.typed } };
}
function backspace(count) {
  const refused = needItem();
  if (refused) return refused;
  const n = Math.max(1, Math.min(40, Math.round(Number(count ?? 1)) || 1));
  const removed = state.typed.slice(Math.max(0, state.typed.length - n));
  state.typed = state.typed.slice(0, state.typed.length - removed.length);
  state.suggestions = [];
  state.lastWord = null;
  const how = keyboard === "split" ? `${times(n, "press", "presses")} of the upper face button (B or Y)` : keyboard === "drum" ? `${times(n, "strike", "strikes")} on the Backspace pad` : `${times(n, "trigger pull", "trigger pulls")} on the Backspace key`;
  record("backspace", { count: n, removed, panel: state.typed });
  light("backspace");
  drawPanel();
  return { accepted: true, public: { removed: removed || "nothing (the text was empty)", took: how, panel: state.typed } };
}
function enterPhrase() {
  const refused = needItem();
  if (refused) return refused;
  if (!state.typed.trim()) return { accepted: false, reason: "Nothing is typed yet; Enter submits the typed phrase." };
  const item = current();
  const transcribed = state.typed.replace(/\s+$/, "");
  const errors = msd(item.text, transcribed);
  record("phrase-end", { phase: item.phase, n: item.n, presented: item.text, transcribed, msd: errors, uncorrectedErrorRate: errors / Math.max(item.text.length, transcribed.length), seconds: (performance.now() - state.shownAt) / 1000 });
  light("enter");
  const how = keyboard === "split" ? "a trigger press (Enter)" : keyboard === "drum" ? "a strike on the Enter pad" : "a trigger pull on the Enter key";
  if (state.index + 1 < ITEMS.length) show(state.index + 1);
  else {
    state.index = ITEMS.length;
    state.done = true;
    record("phase", { phaseId: "questionnaire" });
    drawPanel();
  }
  return { accepted: true, public: { submitted: transcribed, took: how, next: state.done ? "All phrases are done." : current().text } };
}

// ---------- the swipe recogniser ----------
const CENTRE = {};
ROWS.forEach((row, r) => [...row].forEach((ch, c) => (CENTRE[ch] = [c + OFFSET[r], r])));
function strokeOf(letters) {
  const pts = [];
  for (const ch of letters) {
    const p = CENTRE[ch];
    const last = pts.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) pts.push(p);
  }
  return resample(pts, 32);
}
function resample(pts, n) {
  if (pts.length === 1) return Array(n).fill(pts[0]);
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = seg.reduce((a, b) => a + b, 0);
  const out = [];
  for (let k = 0; k < n; k++) {
    let d = (total * k) / (n - 1);
    let i = 0;
    while (i < seg.length - 1 && d > seg[i]) d -= seg[i++];
    const f = seg[i] ? Math.min(1, d / seg[i]) : 0;
    out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]);
  }
  return out;
}
const TEMPLATES = LEXICON.map((w) => [w, strokeOf(w)]);
function recognise(letters) {
  const s = strokeOf(letters);
  const scored = TEMPLATES.map(([w, t]) => [w, t.reduce((sum, p, i) => sum + Math.hypot(p[0] - s[i][0], p[1] - s[i][1]), 0) / t.length]);
  scored.sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
  return scored.slice(0, 4).map(([w]) => w);
}
function swipe(words) {
  const refused = needItem();
  if (refused) return refused;
  const list = String(words ?? "").trim().split(/\s+/).filter(Boolean);
  if (!list.length || !list.every((w) => /^[a-z]+$/.test(w))) return { accepted: false, reason: "Give words: one or more words of the letters a–z; each word is one stroke." };
  if (list.length > 8) return { accepted: false, reason: "Swipe at most eight words in one action." };
  const recognised = [];
  for (const w of list) {
    const [best, ...rest] = recognise(w);
    state.lastWord = { start: state.typed.length, word: best };
    state.typed += best + " ";
    state.suggestions = rest;
    recognised.push(best);
    record("swipe", { stroke: w, recognised: best, suggestions: rest, panel: state.typed });
  }
  light("space");
  drawPanel();
  return {
    accepted: true,
    public: {
      recognised,
      suggestions: state.suggestions,
      took: `${times(list.length, "stroke", "strokes")}, ${list.length > 1 ? "each " : ""}with the trigger held while the ray ran through the word's letters`,
      seen: once("swipe", "After each stroke the recogniser's word appeared below the phrase with a space, and the three next-best words for the last stroke appeared above the keyboard.", "As before: each stroke became a word and a space."),
      panel: state.typed,
    },
  };
}
function chooseWord(word) {
  const refused = needItem();
  if (refused) return refused;
  if (!state.lastWord || !state.suggestions.includes(word)) return { accepted: false, reason: state.suggestions.length ? `Choose one of the suggestions: ${state.suggestions.join(", ")}.` : "No suggestions are shown." };
  const { start, word: old } = state.lastWord;
  state.typed = state.typed.slice(0, start) + word + " ";
  state.suggestions = state.suggestions.filter((w) => w !== word).concat(old);
  state.lastWord = { start, word };
  record("choose-word", { replaced: old, chosen: word, panel: state.typed });
  drawPanel();
  return { accepted: true, public: { replaced: old, with: word, took: "pointing the ray at the suggestion and pulling the trigger", panel: state.typed } };
}
function deleteWord() {
  const refused = needItem();
  if (refused) return refused;
  const before = state.typed;
  state.typed = state.typed.replace(/\S+\s*$/, "");
  state.suggestions = [];
  state.lastWord = null;
  record("delete-word", { removed: before.slice(state.typed.length), panel: state.typed });
  light("delete-word");
  drawPanel();
  return { accepted: true, public: { removed: before.slice(state.typed.length) || "nothing (the text was empty)", took: "a trigger pull on the Delete word key", panel: state.typed } };
}
const SWIPE_ACTIONS = [
  { name: "swipe", description: "Draw one stroke per word through its letters with the trigger held; the recogniser types the closest word and a space", params: { words: "one or more words, e.g. the kettle" }, scored: false },
  { name: "choose-word", description: "Choose one of the three suggestions for the last stroke; it replaces the last word", params: { word: "a suggestion shown above the keyboard" }, scored: false },
  { name: "delete-word", description: "Press Delete word: removes the last word", params: {}, scored: false },
];

// ---------- head direction ----------
const view = { azimuth: 0, polar: defaultPolar };
function applyView() {
  const th = THREE.MathUtils.degToRad(view.azimuth),
    ph = THREE.MathUtils.degToRad(view.polar);
  camera.position.copy(EYE);
  camera.lookAt(EYE.clone().add(new THREE.Vector3(Math.sin(ph) * Math.sin(th), Math.cos(ph), -Math.sin(ph) * Math.cos(th))));
  camera.updateMatrixWorld();
}
applyView();

// Desktop help and keyboard switcher (hidden in study mode).
if (!studyMode) {
  const hud = document.getElementById("hud");
  hud.hidden = false;
  for (const k of KEYBOARDS) {
    const b = document.createElement("button");
    b.textContent = k;
    b.setAttribute("aria-pressed", String(k === keyboard));
    b.addEventListener("click", () => {
      params.set("keyboard", k);
      location.search = params.toString();
    });
    document.getElementById("keyboards").appendChild(b);
  }
  document.getElementById("type-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("type-input");
    if (input.value) (keyboard === "swipe" ? swipe : typeText)(input.value.toLowerCase());
    else enterPhrase();
    input.value = "";
  });
}

// ---------- window.xrStudy: the contract the workbench's WebXR runtime plays the app through ----------
// Only what a participant could perceive or do: the phrase panel, head direction and the keyboard's
// own inputs. Only the documented getState fields and `public` reach the agent.
window.xrStudy = {
  getState: () => {
    const item = current();
    return {
      phase: state.done ? "questionnaire" : item?.phase ?? "idle",
      trial: state.index,
      instruction: state.done ? "Done." : INSTRUCTION,
      done: state.done,
      public: item
        ? {
            block: item.phase === "practice" ? "practice" : "scored",
            phrase: `${item.n} of ${item.of}`,
            panelShows: item.text,
            typedSoFar: state.typed,
            ...(keyboard === "swipe" && state.suggestions.length ? { suggestions: state.suggestions } : {}),
          }
        : {},
    };
  },
  start: () => {
    if (state.index < 0) show(0);
  },
  look: (azimuth, polar) => {
    view.azimuth = Math.max(-90, Math.min(90, Number(azimuth) || 0));
    view.polar = Math.max(60, Math.min(160, Number(polar) || 90));
    applyView();
    return { azimuth: view.azimuth, polar: view.polar };
  },
  actions: () => (keyboard === "swipe" ? SWIPE_ACTIONS : []),
  act: (name, args = {}) => {
    if (name === "type") return typeText(args.text);
    if (name === "backspace") return backspace(args.count);
    if (name === "enter-phrase") return enterPhrase();
    if (keyboard === "swipe") {
      if (name === "swipe") return swipe(args.words);
      if (name === "choose-word") return chooseWord(String(args.word ?? "").trim().toLowerCase());
      if (name === "delete-word") return deleteWord();
    }
    return { accepted: false, reason: `This keyboard has no action ${name}.` };
  },
  log: () => structuredClone(log),
};

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
record("session-start", { sessionSeed, userAgent: navigator.userAgent, phrases: ITEMS.map((i) => i.text) });
drawPanel();
renderer.setAnimationLoop(() => renderer.render(scene, camera));
