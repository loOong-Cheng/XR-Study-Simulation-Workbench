// Procedural PBR texture sets, generated in the browser (no downloads, no licences).
// Every pattern returns, per texel: height h (0-1), base colour [r,g,b] (0-1),
// roughness, metalness. From that we build:
//   map            sRGB base colour (albedo)
//   normalMap      tangent-space normals derived from the height field
//   orm            ambient occlusion (R), roughness (G), metalness (B)  - glTF packing
//   heightMap      height for displacementMap / bump
// Medium quality uses only the colour map at a lower resolution; high quality
// uses the full set.
import * as THREE from "three";

// ---------- tileable value noise ----------
function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function smooth(t) {
  return t * t * (3 - 2 * t);
}
// Periodic value noise. px/py: lattice cells across the tile in u and v, so
// stretched (anisotropic) patterns like wood grain still tile seamlessly.
export function noise(u, v, px, seed = 1, py = px) {
  const x = u * px,
    y = v * py;
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const xf = smooth(x - xi),
    yf = smooth(y - yi);
  const wx = (n) => ((n % px) + px) % px,
    wy = (n) => ((n % py) + py) % py;
  const a = hash(wx(xi), wy(yi), seed),
    b = hash(wx(xi + 1), wy(yi), seed),
    c = hash(wx(xi), wy(yi + 1), seed),
    d = hash(wx(xi + 1), wy(yi + 1), seed);
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
}
export function fbm(u, v, px, octaves = 4, seed = 1, py = px) {
  let sum = 0,
    amp = 0.5,
    norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise(u, v, px << i, seed + i * 17, py << i);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

// ---------- patterns ----------
export const PATTERNS = {
  // Oak floor planks: grain, per-plank tint, grooves between planks.
  planks: { flat: 0x8b5a33, normal: 2.5, fn(u, v) {
    const rows = 10, row = Math.floor(v * rows), lv = v * rows - row;
    const offset = hash(row, 0, 5) * 0.5, lu = (u + offset) % 1;
    const board = Math.floor(lu * 2), bu = lu * 2 - board;
    const tint = 0.82 + 0.3 * hash(row, board, 9);
    const warp = fbm(u, v, 4, 2, 11);
    const fibres = fbm(u, v, 2, 4, 3 + row, 160); // long streaks along u
    const rings = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * rows * 3 + warp * 2));
    const grain = 0.6 * fibres + 0.4 * rings;
    // Distance to the nearest plank edge in tile units (rows are 1/rows tall, boards 1/2 long).
    const edge = Math.min(Math.min(lv, 1 - lv) / rows, Math.min(bu, 1 - bu) / 2);
    const groove = clamp01(edge / 0.004);
    const c = rgb(0x9a6a3e).map((x) => x * tint * (0.62 + 0.5 * grain));
    return { h: groove * (0.8 + 0.15 * grain), color: c.map((x) => x * mix(0.4, 1, groove)), rough: mix(0.85, 0.38 + 0.2 * grain, groove), metal: 0 };
  } },
  // Lacquered table top: finer grain, low roughness.
  tablewood: { flat: 0x7b4a2a, normal: 1.2, fn(u, v) {
    const fibres = fbm(u, v, 2, 5, 21, 96);
    const warp = fbm(u, v, 3, 3, 23);
    const rings = 0.5 + 0.5 * Math.sin(2 * Math.PI * (v * 14 + warp * 1.5));
    const t = 0.55 * fibres + 0.45 * rings;
    return { h: 0.5 + 0.3 * t, color: rgb(0x8a5530).map((x) => x * (0.62 + 0.5 * t)), rough: 0.28 + 0.15 * fibres, metal: 0 };
  } },
  // Brick wall with mortar joints: the strongest height/displacement example.
  brick: { flat: 0x9a4f3c, normal: 3, fn(u, v) {
    const rows = 12, row = Math.floor(v * rows), lv = v * rows - row;
    const per = 4, su = (u * per + (row % 2) * 0.5) % per, col = Math.floor(su), lu = su - col;
    const mortar = Math.min(lv / 0.12, (1 - lv) / 0.12, lu / 0.05, (1 - lu) / 0.05);
    const inBrick = clamp01(mortar);
    const n = fbm(u, v, 16, 4, 31);
    const tone = 0.75 + 0.35 * hash(row, col, 33);
    const brickC = rgb(0xa0503a).map((x) => x * tone * (0.8 + 0.35 * n));
    const mortarC = rgb(0xb8b2a6).map((x) => x * (0.85 + 0.2 * n));
    return { h: inBrick * (0.75 + 0.25 * n) + (1 - inBrick) * 0.15 * n, color: brickC.map((x, i) => mix(mortarC[i], x, inBrick)), rough: mix(0.95, 0.82, inBrick), metal: 0 };
  } },
  plaster: { flat: 0xd9d4cb, normal: 1.5, fn(u, v) {
    const n = fbm(u, v, 8, 5, 41);
    return { h: n, color: rgb(0xdcd6cc).map((x) => x * (0.92 + 0.1 * n)), rough: 0.88 + 0.1 * n, metal: 0 };
  } },
  // Woven fabric: over/under threads.
  fabric: { flat: 0x7a3b4a, normal: 3, fn(u, v) {
    const f = 48, x = u * f, y = v * f, cx = Math.floor(x), cy = Math.floor(y);
    const over = (cx + cy) % 2 === 0;
    const tu = Math.sin(Math.PI * (x - cx)), tv = Math.sin(Math.PI * (y - cy));
    const thread = over ? tu * 0.6 + 0.4 * tv : tv * 0.6 + 0.4 * tu;
    const n = fbm(u, v, 32, 3, 51);
    return { h: 0.3 + 0.6 * thread, color: rgb(0x7a3b4a).map((c) => c * (0.7 + 0.35 * thread + 0.1 * n)), rough: 0.9, metal: 0 };
  } },
  terracotta: { flat: 0xb5651d, normal: 2, fn(u, v) {
    const n = fbm(u, v, 16, 5, 61), pores = noise(u, v, 128, 63) > 0.82 ? 0.3 : 0;
    return { h: n - pores, color: rgb(0xb5651d).map((c) => c * (0.8 + 0.3 * n)), rough: 0.9, metal: 0 };
  } },
  leaf: { flat: 0x3f7d3a, normal: 2, fn(u, v) {
    const vein = Math.exp(-Math.pow((u - 0.5) * 40, 2)) + 0.6 * Math.exp(-Math.pow(((u + v * 0.6) % 0.2 - 0.1) * 60, 2));
    const n = fbm(u, v, 8, 3, 71);
    return { h: 0.5 + 0.4 * vein, color: rgb(0x3f7d3a).map((c) => c * (0.8 + 0.3 * n + 0.25 * vein)), rough: 0.55, metal: 0 };
  } },
  // Ceramics share colour; they differ in roughness and micro-surface.
  "ceramic-glossy": { flat: 0xf2efe8, normal: 0.1, fn(u, v) {
    const speck = noise(u, v, 256, 81) > 0.92 ? 0.85 : 1;
    return { h: fbm(u, v, 16, 3, 83), color: rgb(0xf2efe8).map((c) => c * speck), rough: 0.06, metal: 0 };
  } },
  "ceramic-matte": { flat: 0xf2efe8, normal: 0.6, fn(u, v) {
    const n = fbm(u, v, 64, 4, 91);
    return { h: n, color: rgb(0xf2efe8).map((c) => c * (0.93 + 0.07 * n)), rough: 0.78, metal: 0 };
  } },
  // Brushed metal: streaks along one direction in roughness and height.
  "metal-brushed": { flat: 0xb8bcc2, normal: 1.2, fn(u, v) {
    const streak = fbm(u, v, 1, 3, 101, 256); // streaks run along u
    return { h: streak, color: rgb(0xc4c8ce).map((c) => c * (0.9 + 0.1 * streak)), rough: 0.18 + 0.25 * streak, metal: 1 };
  } },
  plastic: { flat: 0xb8bcc2, normal: 0.15, fn(u, v) {
    const n = fbm(u, v, 32, 3, 111);
    return { h: n, color: rgb(0xb8bcc2), rough: 0.42 + 0.08 * n, metal: 0 };
  } },
  "plastic-blue": { flat: 0xa9d6e5, normal: 0.15, fn(u, v) {
    const n = fbm(u, v, 32, 3, 121);
    return { h: n, color: rgb(0xa9d6e5), rough: 0.45 + 0.08 * n, metal: 0 };
  } },
  boxwood: { flat: 0x9a6a3e, normal: 1.8, fn(u, v) {
    const g = 0.6 * fbm(u, v, 2, 4, 131, 48) + 0.4 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (v * 6 + fbm(u, v, 3, 2, 133))));
    return { h: 0.5 + 0.4 * g, color: rgb(0xa47546).map((c) => c * (0.7 + 0.45 * g)), rough: 0.6, metal: 0 };
  } },
};

// ---------- texture generation ----------
const cache = new Map();
function texture(data, size, srgb, anisotropy) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}
// Full PBR set for high quality.
export function pbrSet(name, size, anisotropy = 8) {
  const key = `${name}@${size}`;
  if (cache.has(key)) return cache.get(key);
  const p = PATTERNS[name];
  const n = size * size;
  const height = new Float32Array(n);
  const color = new Uint8Array(n * 4), orm = new Uint8Array(n * 4), heightTex = new Uint8Array(n * 4), normal = new Uint8Array(n * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x, s = p.fn(x / size, y / size);
      height[i] = clamp01(s.h);
      color.set([...s.color.map((c) => Math.round(clamp01(c) * 255)), 255], i * 4);
      orm.set([255, Math.round(clamp01(s.rough) * 255), Math.round(clamp01(s.metal) * 255), 255], i * 4);
    }
  // Normals from height (central differences, wrapping), plus a cavity-style AO.
  const at = (x, y) => height[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const dx = (at(x + 1, y) - at(x - 1, y)) * p.normal * (size / 256);
      const dy = (at(x, y + 1) - at(x, y - 1)) * p.normal * (size / 256);
      const len = Math.hypot(dx, dy, 1);
      normal.set([((-dx / len) * 0.5 + 0.5) * 255, ((-dy / len) * 0.5 + 0.5) * 255, ((1 / len) * 0.5 + 0.5) * 255, 255], i * 4);
      const around = (at(x - 3, y) + at(x + 3, y) + at(x, y - 3) + at(x, y + 3)) / 4;
      orm[i * 4] = Math.round(clamp01(1 - Math.max(0, around - height[i]) * 4) * 255);
      const h = Math.round(height[i] * 255);
      heightTex.set([h, h, h, 255], i * 4);
    }
  const set = {
    map: texture(color, size, true, anisotropy),
    normalMap: texture(normal, size, false, anisotropy),
    orm: texture(orm, size, false, anisotropy),
    heightMap: texture(heightTex, size, false, anisotropy),
  };
  cache.set(key, set);
  return set;
}
// Colour-only texture for medium quality (same pattern, lower resolution, no other maps).
export function colorOnly(name, size) {
  const key = `${name}@color${size}`;
  if (cache.has(key)) return cache.get(key);
  const p = PATTERNS[name], data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const s = p.fn(x / size, y / size);
      data.set([...s.color.map((c) => Math.round(clamp01(c) * 255)), 255], (y * size + x) * 4);
    }
  const t = texture(data, size, true, 1);
  cache.set(key, t);
  return t;
}
