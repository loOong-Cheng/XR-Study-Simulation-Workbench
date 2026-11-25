// Mesh builders ported from the three.js geometries the WebXR app uses (PlaneGeometry,
// BoxGeometry, CylinderGeometry, SphereGeometry, LatheGeometry, TorusGeometry,
// RingGeometry), with the same vertex layout, UVs and counter-clockwise front faces.
// Tangents are computed from the UVs so normal maps and anisotropy work.
import Foundation
import RealityKit
import simd

struct MeshData {
    var positions: [SIMD3<Float>] = []
    var normals: [SIMD3<Float>] = []
    var uvs: [SIMD2<Float>] = []
    var indices: [UInt32] = []

    mutating func append(_ other: MeshData) {
        let base = UInt32(positions.count)
        positions += other.positions
        normals += other.normals
        uvs += other.uvs
        indices += other.indices.map { $0 + base }
    }

    /// A copy facing the other way (three.js DoubleSide): reversed winding, flipped normals.
    func flipped() -> MeshData {
        var m = self
        m.normals = normals.map { -$0 }
        m.indices = []
        for t in stride(from: 0, to: indices.count, by: 3) {
            m.indices += [indices[t], indices[t + 2], indices[t + 1]]
        }
        return m
    }

    func doubleSided() -> MeshData {
        var m = self
        m.append(flipped())
        return m
    }

    /// Per-vertex tangents and bitangents from UV derivatives, orthogonalised to the normal.
    func tangentFrames() -> (tangents: [SIMD3<Float>], bitangents: [SIMD3<Float>]) {
        var tan = [SIMD3<Float>](repeating: .zero, count: positions.count)
        var bit = [SIMD3<Float>](repeating: .zero, count: positions.count)
        for t in stride(from: 0, to: indices.count, by: 3) {
            let i0 = Int(indices[t]), i1 = Int(indices[t + 1]), i2 = Int(indices[t + 2])
            let e1 = positions[i1] - positions[i0], e2 = positions[i2] - positions[i0]
            let d1 = uvs[i1] - uvs[i0], d2 = uvs[i2] - uvs[i0]
            let det = d1.x * d2.y - d2.x * d1.y
            if abs(det) < 1e-12 { continue }
            let r = 1 / det
            let tu = (e1 * d2.y - e2 * d1.y) * r
            let tv = (e2 * d1.x - e1 * d2.x) * r
            for i in [i0, i1, i2] { tan[i] += tu; bit[i] += tv }
        }
        for i in 0..<positions.count {
            let n = normals[i]
            var t = tan[i] - n * simd_dot(n, tan[i])
            if simd_length(t) < 1e-8 {
                // Degenerate (poles, cap centres): any vector perpendicular to n.
                let a: SIMD3<Float> = abs(n.y) < 0.99 ? [0, 1, 0] : [1, 0, 0]
                t = simd_cross(a, n)
            }
            t = simd_normalize(t)
            var b = simd_cross(n, t)
            if simd_dot(b, bit[i]) < 0 { b = -b }
            tan[i] = t
            bit[i] = b
        }
        return (tan, bit)
    }

    @MainActor
    func resource() throws -> MeshResource {
        var d = MeshDescriptor(name: "mesh")
        d.positions = MeshBuffers.Positions(positions)
        d.normals = MeshBuffers.Normals(normals)
        d.textureCoordinates = MeshBuffers.TextureCoordinates(uvs)
        let frames = tangentFrames()
        d.tangents = MeshBuffers.Tangents(frames.tangents)
        d.bitangents = MeshBuffers.Tangents(frames.bitangents)
        d.primitives = .triangles(indices)
        return try MeshResource.generate(from: [d])
    }

    func bounds(_ transform: simd_float4x4) -> (min: SIMD3<Float>, max: SIMD3<Float>) {
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        for p in positions {
            let q = transform * SIMD4<Float>(p, 1)
            lo = simd_min(lo, SIMD3(q.x, q.y, q.z))
            hi = simd_max(hi, SIMD3(q.x, q.y, q.z))
        }
        return (lo, hi)
    }
}

enum Geometry {
    /// three.js PlaneGeometry(width, height): XY plane facing +Z. `uvRepeat` scales the UVs
    /// (three.js texture.repeat).
    static func plane(width: Float, height: Float, uvRepeat: Float = 1) -> MeshData {
        var m = MeshData()
        let w = width / 2, h = height / 2
        // three.js grid order: iy = 0 is the top row (v = 1).
        for (iy, y) in [h, -h].enumerated() {
            for (ix, x) in [-w, w].enumerated() {
                m.positions.append([x, y, 0])
                m.normals.append([0, 0, 1])
                m.uvs.append([Float(ix) * uvRepeat, Float(1 - iy) * uvRepeat])
            }
        }
        // a = 0, b = 2, c = 3, d = 1  →  (a, b, d), (b, c, d)
        m.indices = [0, 2, 1, 2, 3, 1]
        return m
    }

    /// three.js BoxGeometry(width, height, depth), one segment per side, UV 0–1 per face.
    static func box(width: Float, height: Float, depth: Float) -> MeshData {
        var m = MeshData()
        // (u axis, v axis, w axis, udir, vdir, faceWidth, faceHeight, faceDepth)
        let faces: [(Int, Int, Int, Float, Float, Float, Float, Float)] = [
            (2, 1, 0, -1, -1, depth, height, width),    // px
            (2, 1, 0, 1, -1, depth, height, -width),    // nx
            (0, 2, 1, 1, 1, width, depth, height),      // py
            (0, 2, 1, 1, -1, width, depth, -height),    // ny
            (0, 1, 2, 1, -1, width, height, depth),     // pz
            (0, 1, 2, -1, -1, width, height, -depth),   // nz
        ]
        for (u, v, w, udir, vdir, fw, fh, fd) in faces {
            let base = UInt32(m.positions.count)
            for iy in 0...1 {
                let y = Float(iy) * fh - fh / 2
                for ix in 0...1 {
                    let x = Float(ix) * fw - fw / 2
                    var p = SIMD3<Float>(repeating: 0), n = SIMD3<Float>(repeating: 0)
                    p[u] = x * udir; p[v] = y * vdir; p[w] = fd / 2
                    n[w] = fd > 0 ? 1 : -1
                    m.positions.append(p)
                    m.normals.append(n)
                    m.uvs.append([Float(ix), 1 - Float(iy)])
                }
            }
            let a = base, b = base + 2, c = base + 3, d = base + 1
            m.indices += [a, b, d, b, c, d]
        }
        return m
    }

    /// three.js CylinderGeometry(radiusTop, radiusBottom, height, radialSegments), closed.
    static func cylinder(radiusTop: Float, radiusBottom: Float, height: Float, radialSegments: Int) -> MeshData {
        let segs = max(3, radialSegments)
        var m = MeshData()
        let half = height / 2
        let slope = (radiusBottom - radiusTop) / height
        var grid: [[UInt32]] = []
        for y in 0...1 {
            let v = Float(y)
            let radius = v * (radiusBottom - radiusTop) + radiusTop
            var row: [UInt32] = []
            for x in 0...segs {
                let u = Float(x) / Float(segs)
                let theta = u * 2 * .pi
                let s = sin(theta), c = cos(theta)
                row.append(UInt32(m.positions.count))
                m.positions.append([radius * s, -v * height + half, radius * c])
                m.normals.append(simd_normalize(SIMD3<Float>(s, slope, c)))
                m.uvs.append([u, 1 - v])
            }
            grid.append(row)
        }
        for x in 0..<segs {
            let a = grid[0][x], b = grid[1][x], c = grid[1][x + 1], d = grid[0][x + 1]
            m.indices += [a, b, d, b, c, d]
        }
        for top in [true, false] {
            let radius = top ? radiusTop : radiusBottom
            let sign: Float = top ? 1 : -1
            let centerStart = UInt32(m.positions.count)
            for _ in 1...segs {
                m.positions.append([0, half * sign, 0])
                m.normals.append([0, sign, 0])
                m.uvs.append([0.5, 0.5])
            }
            let ringStart = UInt32(m.positions.count)
            for x in 0...segs {
                let theta = Float(x) / Float(segs) * 2 * .pi
                let c = cos(theta), s = sin(theta)
                m.positions.append([radius * s, half * sign, radius * c])
                m.normals.append([0, sign, 0])
                m.uvs.append([c * 0.5 + 0.5, s * 0.5 * sign + 0.5])
            }
            for x in 0..<UInt32(segs) {
                let c = centerStart + x, i = ringStart + x
                m.indices += top ? [i, i + 1, c] : [i + 1, i, c]
            }
        }
        return m
    }

    /// three.js SphereGeometry(radius, widthSegments, heightSegments, 0, 2π, thetaStart, thetaLength).
    static func sphere(radius: Float, widthSegments: Int, heightSegments: Int,
                       thetaStart: Float = 0, thetaLength: Float = .pi) -> MeshData {
        let ws = max(3, widthSegments), hs = max(2, heightSegments)
        let thetaEnd = min(thetaStart + thetaLength, .pi)
        var m = MeshData()
        var grid: [[UInt32]] = []
        for iy in 0...hs {
            let v = Float(iy) / Float(hs)
            var uOffset: Float = 0
            if iy == 0 && thetaStart == 0 { uOffset = 0.5 / Float(ws) }
            else if iy == hs && thetaEnd == .pi { uOffset = -0.5 / Float(ws) }
            var row: [UInt32] = []
            for ix in 0...ws {
                let u = Float(ix) / Float(ws)
                let phi = u * 2 * .pi, theta = thetaStart + v * thetaLength
                let p = SIMD3<Float>(-radius * cos(phi) * sin(theta), radius * cos(theta), radius * sin(phi) * sin(theta))
                row.append(UInt32(m.positions.count))
                m.positions.append(p)
                m.normals.append(simd_length(p) > 0 ? simd_normalize(p) : [0, 1, 0])
                m.uvs.append([u + uOffset, 1 - v])
            }
            grid.append(row)
        }
        for iy in 0..<hs {
            for ix in 0..<ws {
                let a = grid[iy][ix + 1], b = grid[iy][ix], c = grid[iy + 1][ix], d = grid[iy + 1][ix + 1]
                if iy != 0 || thetaStart > 0 { m.indices += [a, b, d] }
                if iy != hs - 1 || thetaEnd < .pi { m.indices += [b, c, d] }
            }
        }
        return m
    }

    /// three.js LatheGeometry(points, segments): profile (radius, y) swept around +Y.
    static func lathe(_ points: [SIMD2<Float>], segments: Int) -> MeshData {
        let segs = max(1, segments)
        var m = MeshData()
        // Profile normals (outward for a profile that goes up), as three.js computes them.
        var profileNormals: [SIMD2<Float>] = []
        for j in 0..<points.count {
            let prev = points[max(0, j - 1)], next = points[min(points.count - 1, j + 1)]
            let t = next - prev
            let n = SIMD2<Float>(t.y, -t.x)
            profileNormals.append(simd_length(n) > 0 ? simd_normalize(n) : [1, 0])
        }
        for i in 0...segs {
            let phi = Float(i) / Float(segs) * 2 * .pi
            let s = sin(phi), c = cos(phi)
            for j in 0..<points.count {
                let p = points[j], n = profileNormals[j]
                m.positions.append([p.x * s, p.y, p.x * c])
                m.normals.append(simd_normalize(SIMD3<Float>(n.x * s, n.y, n.x * c)))
                m.uvs.append([Float(i) / Float(segs), Float(j) / Float(points.count - 1)])
            }
        }
        let count = UInt32(points.count)
        for i in 0..<UInt32(segs) {
            for j in 0..<(count - 1) {
                let base = j + i * count
                let a = base, b = base + count, c = base + count + 1, d = base + 1
                m.indices += [a, b, d, c, d, b]
            }
        }
        return m
    }

    /// three.js TorusGeometry(radius, tube, radialSegments, tubularSegments): ring in the XY plane.
    static func torus(radius: Float, tube: Float, radialSegments: Int, tubularSegments: Int) -> MeshData {
        let rs = max(3, radialSegments), ts = max(3, tubularSegments)
        var m = MeshData()
        for j in 0...rs {
            for i in 0...ts {
                let u = Float(i) / Float(ts) * 2 * .pi
                let v = Float(j) / Float(rs) * 2 * .pi
                let p = SIMD3<Float>((radius + tube * cos(v)) * cos(u), (radius + tube * cos(v)) * sin(u), tube * sin(v))
                let center = SIMD3<Float>(radius * cos(u), radius * sin(u), 0)
                m.positions.append(p)
                m.normals.append(simd_normalize(p - center))
                m.uvs.append([Float(i) / Float(ts), Float(j) / Float(rs)])
            }
        }
        let stride = UInt32(ts + 1)
        for j in 1...UInt32(rs) {
            for i in 1...UInt32(ts) {
                let a = stride * j + i - 1, b = stride * (j - 1) + i - 1, c = stride * (j - 1) + i, d = stride * j + i
                m.indices += [a, b, d, b, c, d]
            }
        }
        return m
    }

    /// three.js RingGeometry(inner, outer, segments) rotated −90° about X: flat, facing +Y.
    static func flatRing(inner: Float, outer: Float, segments: Int) -> MeshData {
        var m = MeshData()
        for r in [inner, outer] {
            for i in 0...segments {
                let theta = Float(i) / Float(segments) * 2 * .pi
                m.positions.append([r * cos(theta), 0, -r * sin(theta)])
                m.normals.append([0, 1, 0])
                m.uvs.append([(cos(theta) * r / outer + 1) / 2, (sin(theta) * r / outer + 1) / 2])
            }
        }
        let n = UInt32(segments + 1)
        for i in 0..<UInt32(segments) {
            let a = i, b = i + n, c = i + n + 1, d = i + 1
            m.indices += [a, b, d, b, c, d]
        }
        return m
    }
}
