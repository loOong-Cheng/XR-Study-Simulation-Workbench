// Procedural surface patterns, ported from examples/graphics-quality/webxr-app/pbr.js.
// Every pattern returns, per texel: height h (0-1), base colour (0-1), roughness and
// metalness. From that we build colour, normal, roughness, metallic and ambient-
// occlusion maps (high quality) or only the colour map (medium quality).
// Pure Foundation code (no RealityKit) so it can be checked against the JavaScript.
import Foundation

struct Texel {
    var h: Double
    var color: (Double, Double, Double)
    var rough: Double
    var metal: Double
}

struct Pattern {
    let flat: UInt32
    let normal: Double
    let fn: (Double, Double) -> Texel
}

// ---------- tileable value noise ----------
@inline(__always)
func hash(_ x: Int, _ y: Int, _ seed: Int) -> Double {
    // JS: (x * 374761393 + y * 668265263 + seed * 982451653) | 0 — exact in doubles, then mod 2^32.
    let s = Int64(x) &* 374_761_393 &+ Int64(y) &* 668_265_263 &+ Int64(seed) &* 982_451_653
    var h = UInt32(truncatingIfNeeded: s)
    h = (h ^ (h >> 13)) &* 1_274_126_177
    return Double(h ^ (h >> 16)) / 4_294_967_295
}

@inline(__always)
func smooth(_ t: Double) -> Double { t * t * (3 - 2 * t) }

/// Periodic value noise. px/py: lattice cells across the tile in u and v.
func noise(_ u: Double, _ v: Double, _ px: Int, _ seed: Int = 1, _ py: Int? = nil) -> Double {
    let py = py ?? px
    let x = u * Double(px), y = v * Double(py)
    let fx = x.rounded(.down), fy = y.rounded(.down)
    let xi = Int(fx), yi = Int(fy)
    let xf = smooth(x - fx), yf = smooth(y - fy)
    @inline(__always) func wx(_ n: Int) -> Int { ((n % px) + px) % px }
    @inline(__always) func wy(_ n: Int) -> Int { ((n % py) + py) % py }
    let a = hash(wx(xi), wy(yi), seed)
    let b = hash(wx(xi + 1), wy(yi), seed)
    let c = hash(wx(xi), wy(yi + 1), seed)
    let d = hash(wx(xi + 1), wy(yi + 1), seed)
    return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
}

func fbm(_ u: Double, _ v: Double, _ px: Int, _ octaves: Int = 4, _ seed: Int = 1, _ py: Int? = nil) -> Double {
    let py = py ?? px
    var sum = 0.0, amp = 0.5, norm = 0.0
    for i in 0..<octaves {
        sum += amp * noise(u, v, px << i, seed + i * 17, py << i)
        norm += amp
        amp *= 0.5
    }
    return sum / norm
}

@inline(__always) func mix(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
@inline(__always) func clamp01(_ x: Double) -> Double { max(0, min(1, x)) }
@inline(__always) func rgb(_ hex: UInt32) -> (Double, Double, Double) {
    (Double((hex >> 16) & 255) / 255, Double((hex >> 8) & 255) / 255, Double(hex & 255) / 255)
}
@inline(__always) func scale(_ c: (Double, Double, Double), _ k: Double) -> (Double, Double, Double) {
    (c.0 * k, c.1 * k, c.2 * k)
}
@inline(__always) func jsMod(_ a: Double, _ b: Double) -> Double { a.truncatingRemainder(dividingBy: b) }

// ---------- patterns ----------
let PATTERNS: [String: Pattern] = [
    // Oak floor planks: grain, per-plank tint, grooves between planks.
    "planks": Pattern(flat: 0x8B5A33, normal: 2.5) { u, v in
        let rows = 10.0
        let row = (v * rows).rounded(.down), lv = v * rows - row
        let offset = hash(Int(row), 0, 5) * 0.5, lu = jsMod(u + offset, 1)
        let board = (lu * 2).rounded(.down), bu = lu * 2 - board
        let tint = 0.82 + 0.3 * hash(Int(row), Int(board), 9)
        let warp = fbm(u, v, 4, 2, 11)
        let fibres = fbm(u, v, 2, 4, 3 + Int(row), 160)
        let rings = 0.5 + 0.5 * sin(2 * Double.pi * (v * rows * 3 + warp * 2))
        let grain = 0.6 * fibres + 0.4 * rings
        let edge = min(min(lv, 1 - lv) / rows, min(bu, 1 - bu) / 2)
        let groove = clamp01(edge / 0.004)
        let c = scale(rgb(0x9A6A3E), tint * (0.62 + 0.5 * grain))
        return Texel(h: groove * (0.8 + 0.15 * grain), color: scale(c, mix(0.4, 1, groove)),
                     rough: mix(0.85, 0.38 + 0.2 * grain, groove), metal: 0)
    },
    // Lacquered table top: finer grain, low roughness.
    "tablewood": Pattern(flat: 0x7B4A2A, normal: 1.2) { u, v in
        let fibres = fbm(u, v, 2, 5, 21, 96)
        let warp = fbm(u, v, 3, 3, 23)
        let rings = 0.5 + 0.5 * sin(2 * Double.pi * (v * 14 + warp * 1.5))
        let t = 0.55 * fibres + 0.45 * rings
        return Texel(h: 0.5 + 0.3 * t, color: scale(rgb(0x8A5530), 0.62 + 0.5 * t), rough: 0.28 + 0.15 * fibres, metal: 0)
    },
    // Brick wall with mortar joints.
    "brick": Pattern(flat: 0x9A4F3C, normal: 3) { u, v in
        let rows = 12.0
        let row = (v * rows).rounded(.down), lv = v * rows - row
        let per = 4.0
        let su = jsMod(u * per + jsMod(row, 2) * 0.5, per), col = su.rounded(.down), lu = su - col
        let mortar = min(lv / 0.12, (1 - lv) / 0.12, lu / 0.05, (1 - lu) / 0.05)
        let inBrick = clamp01(mortar)
        let n = fbm(u, v, 16, 4, 31)
        let tone = 0.75 + 0.35 * hash(Int(row), Int(col), 33)
        let brickC = scale(rgb(0xA0503A), tone * (0.8 + 0.35 * n))
        let mortarC = scale(rgb(0xB8B2A6), 0.85 + 0.2 * n)
        return Texel(h: inBrick * (0.75 + 0.25 * n) + (1 - inBrick) * 0.15 * n,
                     color: (mix(mortarC.0, brickC.0, inBrick), mix(mortarC.1, brickC.1, inBrick), mix(mortarC.2, brickC.2, inBrick)),
                     rough: mix(0.95, 0.82, inBrick), metal: 0)
    },
    "plaster": Pattern(flat: 0xD9D4CB, normal: 1.5) { u, v in
        let n = fbm(u, v, 8, 5, 41)
        return Texel(h: n, color: scale(rgb(0xDCD6CC), 0.92 + 0.1 * n), rough: 0.88 + 0.1 * n, metal: 0)
    },
    // Woven fabric: over/under threads.
    "fabric": Pattern(flat: 0x7A3B4A, normal: 3) { u, v in
        let f = 48.0, x = u * f, y = v * f, cx = x.rounded(.down), cy = y.rounded(.down)
        let over = (Int(cx) + Int(cy)) % 2 == 0
        let tu = sin(Double.pi * (x - cx)), tv = sin(Double.pi * (y - cy))
        let thread = over ? tu * 0.6 + 0.4 * tv : tv * 0.6 + 0.4 * tu
        let n = fbm(u, v, 32, 3, 51)
        return Texel(h: 0.3 + 0.6 * thread, color: scale(rgb(0x7A3B4A), 0.7 + 0.35 * thread + 0.1 * n), rough: 0.9, metal: 0)
    },
    "terracotta": Pattern(flat: 0xB5651D, normal: 2) { u, v in
        let n = fbm(u, v, 16, 5, 61), pores = noise(u, v, 128, 63) > 0.82 ? 0.3 : 0
        return Texel(h: n - pores, color: scale(rgb(0xB5651D), 0.8 + 0.3 * n), rough: 0.9, metal: 0)
    },
    "leaf": Pattern(flat: 0x3F7D3A, normal: 2) { u, v in
        let vein = exp(-pow((u - 0.5) * 40, 2)) + 0.6 * exp(-pow((jsMod(u + v * 0.6, 0.2) - 0.1) * 60, 2))
        let n = fbm(u, v, 8, 3, 71)
        return Texel(h: 0.5 + 0.4 * vein, color: scale(rgb(0x3F7D3A), 0.8 + 0.3 * n + 0.25 * vein), rough: 0.55, metal: 0)
    },
    // Ceramics share colour; they differ in roughness and micro-surface.
    "ceramic-glossy": Pattern(flat: 0xF2EFE8, normal: 0.1) { u, v in
        let speck = noise(u, v, 256, 81) > 0.92 ? 0.85 : 1
        return Texel(h: fbm(u, v, 16, 3, 83), color: scale(rgb(0xF2EFE8), speck), rough: 0.06, metal: 0)
    },
    "ceramic-matte": Pattern(flat: 0xF2EFE8, normal: 0.6) { u, v in
        let n = fbm(u, v, 64, 4, 91)
        return Texel(h: n, color: scale(rgb(0xF2EFE8), 0.93 + 0.07 * n), rough: 0.78, metal: 0)
    },
    // Brushed metal: streaks along one direction in roughness and height.
    "metal-brushed": Pattern(flat: 0xB8BCC2, normal: 1.2) { u, v in
        let streak = fbm(u, v, 1, 3, 101, 256)
        return Texel(h: streak, color: scale(rgb(0xC4C8CE), 0.9 + 0.1 * streak), rough: 0.18 + 0.25 * streak, metal: 1)
    },
    "plastic": Pattern(flat: 0xB8BCC2, normal: 0.15) { u, v in
        let n = fbm(u, v, 32, 3, 111)
        return Texel(h: n, color: rgb(0xB8BCC2), rough: 0.42 + 0.08 * n, metal: 0)
    },
    "plastic-blue": Pattern(flat: 0xA9D6E5, normal: 0.15) { u, v in
        let n = fbm(u, v, 32, 3, 121)
        return Texel(h: n, color: rgb(0xA9D6E5), rough: 0.45 + 0.08 * n, metal: 0)
    },
    "boxwood": Pattern(flat: 0x9A6A3E, normal: 1.8) { u, v in
        let g = 0.6 * fbm(u, v, 2, 4, 131, 48) + 0.4 * (0.5 + 0.5 * sin(2 * Double.pi * (v * 6 + fbm(u, v, 3, 2, 133))))
        return Texel(h: 0.5 + 0.4 * g, color: scale(rgb(0xA47546), 0.7 + 0.45 * g), rough: 0.6, metal: 0)
    },
]

// ---------- texel buffers ----------
// Buffers are stored top row first (as a CGImage expects) with the pattern's y axis
// flipped, so pattern row 0 lands at texture v = 0 (bottom), as with three.js DataTexture.

struct PBRSetData {
    let size: Int
    var color: [UInt8]   // RGBA, sRGB
    var normal: [UInt8]  // RGBA, tangent space (OpenGL convention)
    var rough: [UInt8]   // gray
    var metal: [UInt8]   // gray
    var ao: [UInt8]      // gray
}

@inline(__always) private func byte(_ x: Double) -> UInt8 { UInt8((clamp01(x) * 255).rounded()) }

private func forRows(_ size: Int, _ body: (Int) -> Void) {
    DispatchQueue.concurrentPerform(iterations: size, execute: body)
}

/// Full set for high quality (pbr.js `pbrSet`).
func pbrSetData(_ name: String, size: Int) -> PBRSetData {
    let p = PATTERNS[name]!
    let n = size * size
    var height = [Double](repeating: 0, count: n)
    var set = PBRSetData(size: size,
                         color: [UInt8](repeating: 255, count: n * 4),
                         normal: [UInt8](repeating: 255, count: n * 4),
                         rough: [UInt8](repeating: 0, count: n),
                         metal: [UInt8](repeating: 0, count: n),
                         ao: [UInt8](repeating: 255, count: n))
    height.withUnsafeMutableBufferPointer { hp in
        set.color.withUnsafeMutableBufferPointer { cp in
            set.rough.withUnsafeMutableBufferPointer { rp in
                set.metal.withUnsafeMutableBufferPointer { mp in
                    forRows(size) { y in
                        let row = size - 1 - y
                        for x in 0..<size {
                            let s = p.fn(Double(x) / Double(size), Double(y) / Double(size))
                            hp[y * size + x] = clamp01(s.h)
                            let o = row * size + x
                            cp[o * 4] = byte(s.color.0)
                            cp[o * 4 + 1] = byte(s.color.1)
                            cp[o * 4 + 2] = byte(s.color.2)
                            rp[o] = byte(s.rough)
                            mp[o] = byte(s.metal)
                        }
                    }
                }
            }
        }
    }
    // Normals from height (central differences, wrapping), plus a cavity-style AO.
    let strength = p.normal * (Double(size) / 256)
    height.withUnsafeBufferPointer { hp in
        set.normal.withUnsafeMutableBufferPointer { np in
            set.ao.withUnsafeMutableBufferPointer { ap in
                @inline(__always) func at(_ x: Int, _ y: Int) -> Double {
                    hp[((y + size) % size) * size + ((x + size) % size)]
                }
                forRows(size) { y in
                    let row = size - 1 - y
                    for x in 0..<size {
                        let dx = (at(x + 1, y) - at(x - 1, y)) * strength
                        let dy = (at(x, y + 1) - at(x, y - 1)) * strength
                        let len = (dx * dx + dy * dy + 1).squareRoot()
                        let o = row * size + x
                        // Uint8Array assignment truncates.
                        np[o * 4] = UInt8(((-dx / len) * 0.5 + 0.5) * 255)
                        np[o * 4 + 1] = UInt8(((-dy / len) * 0.5 + 0.5) * 255)
                        np[o * 4 + 2] = UInt8(((1 / len) * 0.5 + 0.5) * 255)
                        let around = (at(x - 3, y) + at(x + 3, y) + at(x, y - 3) + at(x, y + 3)) / 4
                        ap[o] = byte(1 - max(0, around - hp[y * size + x]) * 4)
                    }
                }
            }
        }
    }
    return set
}

/// Colour-only texture for medium quality (pbr.js `colorOnly`), RGBA.
func colorOnlyData(_ name: String, size: Int) -> [UInt8] {
    let p = PATTERNS[name]!
    var data = [UInt8](repeating: 255, count: size * size * 4)
    data.withUnsafeMutableBufferPointer { dp in
        forRows(size) { y in
            let row = size - 1 - y
            for x in 0..<size {
                let s = p.fn(Double(x) / Double(size), Double(y) / Double(size))
                let o = (row * size + x) * 4
                dp[o] = byte(s.color.0)
                dp[o + 1] = byte(s.color.1)
                dp[o + 2] = byte(s.color.2)
            }
        }
    }
    return data
}
