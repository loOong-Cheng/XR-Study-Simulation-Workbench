// Mid-air keypad WebXR app for the haptic-buttons studies (synthetic; suites 5 and 6 played in WebXR).
// One plain, evenly lit room with a phone-style keypad floating at chest height, about 40 cm in front
// of a standing participant, tilted slightly towards them; a panel above it shows what to type.
// The three feedback designs change only what happens at a press:
//   visual  the key's visual feedback only; the fingertip actuator stays silent
//   buzz    the same visual feedback plus one short vibration burst at activation
//   pulse   the same visual feedback plus a vibration pattern that follows the press
// An agent cannot feel a vibration, so every press replies with what the participant sees and what
// the actuator does, in words (`public.seen`, `public.felt`), taken from the study brief.
//
// Two tasks, chosen by the URL (`task`):
//   sequences  (suite 5)  keys 1–9, then delete, 0 and an unused blank key; 3 cm keys, 1 cm gaps;
//              a key activates 1 cm behind its face. Three practice and ten scored 4-digit
//              sequences; a sequence is complete when its four digits are right (no Enter).
//   codes      (suite 6)  keys 1–9, then Delete, 0 and Enter; 4 cm keys, 1 cm gaps; a key moves in
//              with the finger and registers at 1.5 cm depth. Two practice and twelve scored 4-digit
//              codes; Enter submits the code as typed and the next one appears.
// Presses: a click on a key (window.xrStudy.pointer) or act press-key / confirm-code. The app adds no
// motor noise and no human timing: a press lands on the key that was aimed at. The digits are drawn at
// random for every page load (written to the event log), so the code holds no task answers.
//
// URL parameters:
//   feedback    = visual | buzz | pulse      (default visual)
//   task        = sequences | codes          (default sequences)
//   study       = 1                          hides the desktop help and the design switcher
//   participant = P01                        written into the event log
import * as THREE from "three";
import { VRButton } from "three/addons/webxr/VRButton.js";

const params = new URLSearchParams(location.search);
const DESIGNS = ["visual", "buzz", "pulse"];
const feedback = DESIGNS.includes(params.get("feedback")) ? params.get("feedback") : "visual";
const taskName = params.get("task") === "codes" ? "codes" : "sequences";
const studyMode = params.get("study") === "1";
const participant = params.get("participant") ?? "anonymous";
const sessionSeed = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

const TASKS = {
  sequences: {
    key: 0.03,
    gap: 0.01,
    rows: [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["delete", "0", "blank"]],
    practice: 3,
    main: 10,
    enter: false,
    word: "sequence",
    instruction:
      "Type the sequence shown on the panel with your right index finger. Correct a wrong digit with the delete key and type it again; the next sequence appears when all four digits are right.",
  },
  codes: {
    key: 0.04,
    gap: 0.01,
    rows: [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"], ["delete", "0", "enter"]],
    practice: 2,
    main: 12,
    enter: true,
    word: "code",
    instruction: "Type the code shown on the panel and press Enter. Remove a wrong digit with Delete and type it again.",
  },
};
const TASK = TASKS[taskName];
const LABEL = { delete: taskName === "codes" ? "Delete" : "delete", enter: "Enter", blank: "" };
const label = (id) => LABEL[id] ?? id;

// What the participant perceives at a press, per task and design (from the study briefs).
const SEEN = {
  sequences: (k) => `Key ${k} turned light blue for 200 ms and moved 3 mm back as it activated. Nothing physical stopped the fingertip; it went on past the key face until it was pulled back.`,
  codes: (k) => `Key ${k} lit light blue when the fingertip touched it, moved in with the finger, stopped at 1.5 cm depth and turned dark blue as it registered, then sprang back to grey as the finger left it.`,
};
const FELT = {
  sequences: {
    visual: "Nothing vibrated: the fingertip actuator stays silent with visual feedback only.",
    buzz: "One short vibration burst (20 ms, full strength) at the fingertip at the moment the key activated.",
    pulse:
      "Light ticks at the fingertip began when it touched the key face and came faster as it pushed towards the activation plane; at activation the ticks stopped and a distinct, stronger double pulse played. Nothing vibrated as the finger moved back out.",
  },
  codes: {
    visual: "Nothing vibrated: the ring stays off with visual feedback only.",
    buzz: "One short vibration of the ring (20 ms, full strength) as the key registered.",
    pulse: "A faint tick of the ring when the fingertip touched the key, a stronger double pulse when it registered, and a faint tick when the finger left the key.",
  },
};

// ---------- seeded random digits ----------
function seeded(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}
const rand = seeded(`${sessionSeed}|${taskName}|${feedback}`);
const used = new Set();
function digits() {
  for (;;) {
    const d = Array.from({ length: 4 }, () => String(Math.floor(rand() * 10))).join("");
    if (!used.has(d)) return used.add(d), d;
  }
}
const ITEMS = [
  ...Array.from({ length: TASK.practice }, (_, i) => ({ phase: "practice", n: i + 1, of: TASK.practice, digits: digits() })),
  ...Array.from({ length: TASK.main }, (_, i) => ({ phase: "main", n: i + 1, of: TASK.main, digits: digits() })),
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
scene.background = new THREE.Color(0xc9ccd0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9ea3, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(0.5, 3, 1.5);
scene.add(sun);

// The plain room: floor and walls in light grey, evenly lit.
const wallMat = new THREE.MeshLambertMaterial({ color: 0xd9dbde });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshLambertMaterial({ color: 0xa7abb0 }));
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
for (const [x, z, ry] of [[0, -3, 0], [-3, 0, Math.PI / 2], [3, 0, -Math.PI / 2]]) {
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 3), wallMat);
  wall.position.set(x, 1.5, z);
  wall.rotation.y = ry;
  scene.add(wall);
}

const EYE = new THREE.Vector3(0, 1.65, 0);
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.02, 30);
camera.position.copy(EYE);

// ---------- the keypad ----------
const pitch = TASK.key + TASK.gap;
const cols = 3,
  rowsN = TASK.rows.length;
const padW = cols * TASK.key + (cols - 1) * TASK.gap + 0.02;
const padH = rowsN * TASK.key + (rowsN - 1) * TASK.gap + 0.02;
const keypad = new THREE.Group();
keypad.position.set(0, 1.28, -0.4);
keypad.rotation.x = -0.35; // tilted slightly towards the participant
scene.add(keypad);
// A thin, dark backing frame behind the keys (it shows the gaps; pressing it does nothing).
const backing = new THREE.Mesh(new THREE.BoxGeometry(padW, padH, 0.004), new THREE.MeshLambertMaterial({ color: 0x3b3f45 }));
backing.position.z = -0.008;
keypad.add(backing);

const GREY = 0x8d939a,
  LIGHT_BLUE = 0x8fd3ff,
  DARK_BLUE = 0x1f5fa8;
function keyFace(text) {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = "#111";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = text.length > 1 ? "bold 30px system-ui" : "bold 72px system-ui";
  g.fillText(text, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const keys = new Map(); // id -> mesh
TASK.rows.forEach((row, r) =>
  row.forEach((id, c) => {
    const side = new THREE.MeshLambertMaterial({ color: GREY });
    const face = new THREE.MeshLambertMaterial({ color: GREY, map: id === "blank" ? null : keyFace(label(id)) });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(TASK.key, TASK.key, 0.01), [side, side, side, side, face, side]);
    mesh.position.set((c - 1) * pitch, ((rowsN - 1) / 2 - r) * pitch, 0);
    mesh.userData = { id, rest: mesh.position.z, face, side };
    keypad.add(mesh);
    keys.set(id, mesh);
  }),
);
function tint(mesh, color) {
  mesh.userData.face.color.setHex(color);
  mesh.userData.side.color.setHex(color);
}

// The panel above the keypad: what to type and what has been typed.
const panelCanvas = document.createElement("canvas");
panelCanvas.width = 768;
panelCanvas.height = 300;
const panelTex = new THREE.CanvasTexture(panelCanvas);
panelTex.colorSpace = THREE.SRGBColorSpace;
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.256, 0.1), new THREE.MeshBasicMaterial({ map: panelTex }));
panel.position.set(0, padH / 2 + 0.075, 0.01);
keypad.add(panel);

// The participant's right index finger: a fingertip and a short finger, resting below the keypad.
const finger = new THREE.Group();
const skin = new THREE.MeshLambertMaterial({ color: 0xe0b29a });
const fingerMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.008, 0.06, 4, 12), skin);
fingerMesh.rotation.x = Math.PI / 2; // along the pressing direction
fingerMesh.position.z = 0.038;
finger.add(fingerMesh);
keypad.add(finger);
const REST = new THREE.Vector3(0.05, -padH / 2 - 0.03, 0.05);
finger.position.copy(REST);
function fingerOver(mesh, depth = 0.02) {
  finger.position.set(mesh.position.x, mesh.position.y - 0.004, 0.005 + depth);
}

// ---------- task state and event log ----------
const state = { index: -1, typed: "", done: false, shownAt: 0, presses: 0, wrong: 0 };
const log = [];
function record(type, data = {}) {
  log.push({ t: Math.round(performance.now()), type, feedback, task: taskName, participant, ...data });
}
const current = () => (state.index >= 0 && !state.done ? ITEMS[state.index] : null);
const phase = () => (state.done ? "questionnaire" : current()?.phase ?? "idle");

function drawPanel() {
  const g = panelCanvas.getContext("2d");
  const W = panelCanvas.width,
    H = panelCanvas.height;
  g.fillStyle = "#16181b";
  g.fillRect(0, 0, W, H);
  g.textAlign = "center";
  g.textBaseline = "middle";
  const item = current();
  if (!item) {
    g.fillStyle = "#fff";
    g.font = "bold 46px system-ui";
    g.fillText(state.done ? "Done: please take off the headset" : "Get ready", W / 2, H / 2);
  } else {
    g.fillStyle = "#9aa3ad";
    g.font = "30px system-ui";
    const what = TASK.word[0].toUpperCase() + TASK.word.slice(1);
    g.fillText(item.phase === "practice" ? `Practice ${item.n} of ${item.of}` : `${what} ${item.n} of ${item.of}`, W / 2, 38);
    g.fillStyle = "#fff";
    g.font = "bold 92px ui-monospace, monospace";
    g.fillText(item.digits.split("").join(" "), W / 2, 125);
    g.font = "bold 72px ui-monospace, monospace";
    const typed = state.typed.padEnd(4, "_").split("").join(" ");
    g.fillStyle = "#8fd3ff";
    g.fillText(typed, W / 2, TASK.enter ? 212 : 222);
    if (TASK.enter) {
      g.fillStyle = "#9aa3ad";
      g.font = "24px system-ui";
      g.fillText("Press Enter when the code is typed", W / 2, 284);
    }
  }
  panelTex.needsUpdate = true;
  const felt = document.getElementById("felt");
  if (felt) felt.textContent = item ? `${item.phase === "practice" ? "Practice" : "Scored"} ${item.n}/${item.of}` : "";
}

function show(i) {
  const prev = current();
  state.index = i;
  state.typed = "";
  state.shownAt = performance.now();
  const item = ITEMS[i];
  if (!prev || prev.phase !== item.phase) record("phase", { phaseId: item.phase });
  record("item-start", { phase: item.phase, n: item.n, digits: item.digits });
  drawPanel();
}
function finishItem(submitted) {
  const item = current();
  record("item-end", { phase: item.phase, n: item.n, digits: item.digits, typed: submitted, correct: submitted === item.digits, seconds: (performance.now() - state.shownAt) / 1000 });
  if (state.index + 1 < ITEMS.length) show(state.index + 1);
  else {
    state.index = ITEMS.length;
    state.done = true;
    record("phase", { phaseId: "questionnaire" });
    drawPanel();
  }
}

// ---------- one press of a key (touch, push in, activate, pull back) ----------
let flashTimer = null;
function animatePress(mesh) {
  for (const m of keys.values()) {
    tint(m, GREY);
    m.position.z = m.userData.rest;
  }
  clearTimeout(flashTimer);
  if (taskName === "codes") {
    // light blue on touch, in with the finger, dark blue at 1.5 cm, then back to grey as the finger leaves
    tint(mesh, DARK_BLUE);
    mesh.position.z = mesh.userData.rest - 0.015;
    fingerOver(mesh, -0.01);
    flashTimer = setTimeout(() => {
      tint(mesh, GREY);
      mesh.position.z = mesh.userData.rest;
      fingerOver(mesh);
    }, 180);
  } else {
    // light blue for 200 ms and 3 mm back at activation
    tint(mesh, LIGHT_BLUE);
    mesh.position.z = mesh.userData.rest - 0.003;
    fingerOver(mesh, -0.006);
    flashTimer = setTimeout(() => {
      tint(mesh, GREY);
      mesh.position.z = mesh.userData.rest;
      fingerOver(mesh);
    }, 200);
  }
}
function press(id, how) {
  const item = current();
  if (!item) return { accepted: false, reason: state.done ? `All ${TASK.word}s are done.` : "Nothing to type yet." };
  const mesh = keys.get(id);
  if (!mesh) return { accepted: false, reason: `There is no key ${id}.` };
  animatePress(mesh);
  const expected = item.digits[state.typed.length];
  let effect;
  let wrong = false;
  if (id === "delete") {
    effect = state.typed ? `The last digit (${state.typed.at(-1)}) was removed.` : "There was no digit to remove.";
    state.typed = state.typed.slice(0, -1);
  } else if (id === "blank") effect = "The blank key does nothing.";
  else if (id === "enter") {
    if (!state.typed) effect = "Nothing was typed, so Enter did nothing.";
    else {
      const submitted = state.typed;
      record("press", { key: id, how, phase: item.phase, n: item.n, panel: submitted });
      finishItem(submitted);
      return reply(id, `The code ${submitted} was submitted.`);
    }
  } else if (state.typed.length >= 4) effect = `The panel already shows four digits; ${id} was not added.`;
  else {
    wrong = id !== expected;
    state.typed += id;
    effect = `${id} appeared on the panel.`;
  }
  state.presses++;
  if (wrong) state.wrong++;
  record("press", { key: id, how, phase: item.phase, n: item.n, expected: expected ?? null, wrong, panel: state.typed });
  // Suite 5: a sequence is complete as soon as its four digits are right.
  if (!TASK.enter && state.typed === item.digits) {
    finishItem(state.typed);
    return reply(id, `${effect} All four digits were right, so the panel shows the next ${TASK.word}.`);
  }
  drawPanel();
  return reply(id, effect);
}
// The first press of a design describes its feedback in full; later presses say it was the same, so a
// long session does not repeat the description at every key.
let described = false;
function reply(id, effect) {
  const k = label(id) || "blank";
  const full = !described;
  described = true;
  return {
    accepted: true,
    public: {
      key: k,
      seen: full ? SEEN[taskName](k) : `The same visual feedback as before, on key ${k}.`,
      felt: full ? FELT[taskName][feedback] : `The same as before: ${SHORT[taskName][feedback]}.`,
      result: effect,
      panel: state.typed,
    },
  };
}
const SHORT = {
  sequences: { visual: "no vibration", buzz: "one 20 ms buzz at activation", pulse: "ticks speeding up on the way in, then a double pulse at activation" },
  codes: { visual: "no vibration", buzz: "one 20 ms buzz of the ring at registration", pulse: "a faint tick on touch, a double pulse at registration, a faint tick on release" },
};

// ---------- pointing (screen point -> key) ----------
const raycaster = new THREE.Raycaster();
function hitAt(x, y) {
  scene.updateMatrixWorld(); // keys may have moved (a press) since the last frame
  raycaster.setFromCamera(new THREE.Vector2(x * 2 - 1, -(y * 2 - 1)), camera);
  const hit = raycaster.intersectObjects([...keys.values(), backing], false)[0];
  if (!hit) return { kind: "none" };
  if (hit.object === backing) return { kind: "gap" };
  return { kind: "key", mesh: hit.object, id: hit.object.userData.id };
}
let hovering = null;
function pointer(x, y, kind) {
  const h = hitAt(Number(x), Number(y));
  if (kind === "move") {
    hovering = h;
    if (h.kind === "key") fingerOver(h.mesh);
    return { public: { fingertip: h.kind === "key" ? `over key ${label(h.id) || "blank"}` : h.kind === "gap" ? "over the gap between keys" : "not over the keypad" } };
  }
  if (kind === "down") return undefined;
  // "up": the press is complete, on whatever is under the fingertip now
  const target = h;
  hovering = null;
  if (target.kind === "gap") return { accepted: false, reason: "The fingertip went between two keys; nothing activated." };
  if (target.kind !== "key") return { accepted: false, reason: "The fingertip was not over the keypad; nothing activated." };
  return press(target.id, "pointer");
}

// Desktop mouse and XR controllers, for people trying the app.
renderer.domElement.addEventListener("click", (e) => {
  const r = pointer(e.clientX / innerWidth, e.clientY / innerHeight, "up");
  const felt = document.getElementById("felt");
  if (felt && r?.public) felt.textContent = r.public.felt;
});
for (let i = 0; i < 2; i++) {
  const controller = renderer.xr.getController(i);
  controller.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xffffff })));
  controller.addEventListener("selectstart", () => {
    const m = new THREE.Matrix4().extractRotation(controller.matrixWorld);
    raycaster.set(new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld), new THREE.Vector3(0, 0, -1).applyMatrix4(m));
    const hit = raycaster.intersectObjects([...keys.values()], false)[0];
    if (hit) press(hit.object.userData.id, "controller");
  });
  scene.add(controller);
}

// Design switcher (hidden in study mode, where the experimenter sets ?feedback=).
if (!studyMode) {
  document.getElementById("hud").hidden = false;
  for (const d of DESIGNS) {
    const b = document.createElement("button");
    b.textContent = d;
    b.setAttribute("aria-pressed", String(d === feedback));
    b.addEventListener("click", () => {
      params.set("feedback", d);
      location.search = params.toString();
    });
    document.getElementById("designs").appendChild(b);
  }
}

// ---------- head direction ----------
// azimuth: degrees around the vertical axis, 0 = facing the keypad, positive = to the right;
// polar: degrees down from straight up (90 = level). The head turns; the body stays in place.
const view = { azimuth: 0, polar: 127 };
function applyView() {
  const th = THREE.MathUtils.degToRad(view.azimuth),
    ph = THREE.MathUtils.degToRad(view.polar);
  const dir = new THREE.Vector3(Math.sin(ph) * Math.sin(th), Math.cos(ph), -Math.sin(ph) * Math.cos(th));
  camera.position.copy(EYE);
  camera.lookAt(EYE.clone().add(dir));
  camera.updateMatrixWorld(); // pointing right after a look uses the new view, before the next frame
}
applyView();

// ---------- window.xrStudy: the contract the workbench's WebXR runtime plays the app through ----------
// Only what a participant could perceive or do: the panel, the keys, head direction and presses.
// Only the documented getState fields and `public` reach the agent (docs/runtime-adapters.md).
const ACT_KEYS = new Set([...keys.keys()].filter((k) => k !== "blank" && k !== "enter"));
window.xrStudy = {
  getState: () => {
    const item = current();
    return {
      phase: phase(),
      trial: state.index,
      instruction: state.done ? "Done." : TASK.instruction,
      done: state.done,
      public: item ? { block: item.phase === "practice" ? "practice" : "scored", [TASK.word]: `${item.n} of ${item.of}`, panelShows: item.digits, typedSoFar: state.typed } : {},
    };
  },
  start: () => {
    if (state.index < 0) show(0);
  },
  look: (azimuth, polar) => {
    view.azimuth = Math.max(-90, Math.min(90, Number(azimuth) || 0));
    view.polar = Math.max(60, Math.min(150, Number(polar) || 90));
    applyView();
    return { azimuth: view.azimuth, polar: view.polar };
  },
  pointer,
  act: (name, args = {}) => {
    if (name === "confirm-code") {
      if (!TASK.enter) return { accepted: false, reason: "This keypad has no Enter key." };
      return press("enter", "act");
    }
    if (name !== "press-key") return { accepted: false, reason: `Unknown action ${name}.` };
    const many = typeof args.keys === "string" ? args.keys : null;
    const list = many !== null ? many.replace(/\s+/g, "").split("") : [String(args.key ?? "").trim().toLowerCase()];
    if (!list.length || !list.every((k) => ACT_KEYS.has(k)))
      return { accepted: false, reason: "Give key (one of 0–9 or delete) or keys (digits to press one after another, for example 7391)." };
    if (list.length > 8) return { accepted: false, reason: "Press at most eight keys in one action." };
    const results = list.map((k) => press(k, "act"));
    const done = results.filter((r) => r.accepted);
    if (!done.length) return results[0];
    const first = done[0].public;
    return { accepted: true, public: { pressed: done.map((r) => r.public.key), seen: `Each key: ${first.seen}`, felt: `Each key: ${first.felt}`, result: done.map((r) => r.public.result).join(" "), panel: state.typed } };
  },
  log: () => structuredClone(log),
};

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
record("session-start", { sessionSeed, userAgent: navigator.userAgent });
drawPanel();
renderer.setAnimationLoop(() => renderer.render(scene, camera));
