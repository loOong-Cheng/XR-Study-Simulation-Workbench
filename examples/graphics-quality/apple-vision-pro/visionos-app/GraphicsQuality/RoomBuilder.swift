// Builds the room of main.js in RealityKit, at one of three quality levels:
//   low    UnlitMaterial flat colours; no lights, shadows or textures
//   medium PhysicallyBasedMaterial with 256 px colour textures, one directional light
//          without shadows, roughness/metallic/specular for basic highlights, transparent glass
//   high   full procedural PBR sets (1024/512 px: colour, normal, roughness, metallic, AO),
//          clear coat, anisotropy, sheen, transparent glass, a shadowing directional light,
//          grounding shadows and image-based light from a procedural environment
import Foundation
import RealityKit
import simd
import UIKit

func uiColor(_ hex: UInt32) -> UIColor {
    UIColor(red: CGFloat((hex >> 16) & 255) / 255, green: CGFloat((hex >> 8) & 255) / 255,
            blue: CGFloat(hex & 255) / 255, alpha: 1)
}

/// One mesh of an object, in the object's (group's) coordinates.
struct ObjectPart {
    let mesh: MeshData
    let pattern: String
    var translation: SIMD3<Float> = .zero
    var scale: SIMD3<Float> = .one

    var matrix: simd_float4x4 {
        var m = matrix_identity_float4x4
        m.columns.0.x = scale.x
        m.columns.1.y = scale.y
        m.columns.2.z = scale.z
        m.columns.3 = SIMD4<Float>(translation, 1)
        return m
    }
}

enum ObjectGeometry {
    static func segments(_ quality: Quality) -> Int {
        switch quality { case .low: 10; case .medium: 24; case .high: 64 }
    }

    /// The meshes of main.js mug(), bowl(), vase(), box(), cushion() and plant().
    static func parts(_ kind: ObjectKind, segments: Int) -> [ObjectPart] {
        switch kind {
        case .mug(let pattern):
            return [
                ObjectPart(mesh: Geometry.cylinder(radiusTop: 0.045, radiusBottom: 0.04, height: 0.1, radialSegments: segments), pattern: pattern),
                ObjectPart(mesh: Geometry.torus(radius: 0.025, tube: 0.007, radialSegments: 8, tubularSegments: segments),
                           pattern: pattern, translation: [0.05, 0, 0]),
            ]
        case .bowl(let pattern):
            // Lower hemisphere, double-sided: rim at the top, base on the table.
            let mesh = Geometry.sphere(radius: 0.08, widthSegments: segments, heightSegments: segments / 2,
                                       thetaStart: .pi / 2, thetaLength: .pi / 2).doubleSided()
            return [ObjectPart(mesh: mesh, pattern: pattern, translation: [0, 0.08, 0])]
        case .vase(let pattern):
            let points = (0...12).map { i -> SIMD2<Float> in
                let t = Double(i) / 12
                return SIMD2<Float>(Float(0.035 + 0.035 * sin(Double.pi * t * 1.2)), Float(t * 0.24))
            }
            return [ObjectPart(mesh: Geometry.lathe(points, segments: segments), pattern: pattern)]
        case .box:
            return [ObjectPart(mesh: Geometry.box(width: 0.14, height: 0.1, depth: 0.1), pattern: "boxwood", translation: [0, 0.05, 0])]
        case .cushion:
            return [ObjectPart(mesh: Geometry.sphere(radius: 0.1, widthSegments: segments, heightSegments: segments / 2),
                               pattern: "fabric", translation: [0, 0.045, 0], scale: [1.3, 0.45, 1.3])]
        case .plant:
            var parts = [ObjectPart(mesh: Geometry.cylinder(radiusTop: 0.06, radiusBottom: 0.045, height: 0.1, radialSegments: segments),
                                    pattern: "terracotta", translation: [0, 0.05, 0])]
            let leaf = Geometry.sphere(radius: 0.04, widthSegments: segments / 2, heightSegments: segments / 4)
            for i in 0..<6 {
                let x = Float(cos(Double(i)) * 0.04), z = Float(sin(Double(i)) * 0.04)
                parts.append(ObjectPart(mesh: leaf, pattern: "leaf", translation: [x, 0.14 + Float(i % 3) * 0.03, z], scale: [1, 0.5, 1.6]))
            }
            return parts
        }
    }

    /// Axis-aligned bounds of an object's meshes in its own coordinates.
    static func bounds(_ parts: [ObjectPart]) -> (min: SIMD3<Float>, max: SIMD3<Float>) {
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        for part in parts {
            let b = part.mesh.bounds(part.matrix)
            lo = simd_min(lo, b.min)
            hi = simd_max(hi, b.max)
        }
        return (lo, hi)
    }
}

@MainActor
final class RoomBuilder {
    let quality: Quality
    let textures: [String: PatternTextures]
    let environment: EnvironmentResource?
    let root = Entity()
    private var meshCache: [String: MeshResource] = [:]

    init(quality: Quality, textures: [String: PatternTextures], environment: EnvironmentResource?) {
        self.quality = quality
        self.textures = textures
        self.environment = environment
        root.name = "room-root"
    }

    // ---------- materials ----------
    func material(_ pattern: String) -> any RealityKit.Material {
        if quality == .low {
            let hex: UInt32 = pattern == "glass" ? 0xA9D6E5 : (PATTERNS[pattern]?.flat ?? 0x808080)
            return UnlitMaterial(color: uiColor(hex), applyPostProcessToneMap: false)
        }
        var m = PhysicallyBasedMaterial()
        if pattern == "glass" {
            m.baseColor = .init(tint: uiColor(0xA9D6E5))
            m.metallic = 0.0
            if quality == .medium {
                // three.js MeshPhongMaterial: opacity 0.55, shininess 100
                m.roughness = 0.14
                m.specular = 0.5
                m.blending = .transparent(opacity: .init(floatLiteral: 0.55))
            } else {
                // three.js MeshPhysicalMaterial: roughness 0.04, transmission 1, ior 1.5.
                // RealityKit has no transmission/refraction: a clear, glossy, mostly transparent surface.
                m.roughness = 0.04
                m.specular = 1.0
                m.clearcoat = .init(floatLiteral: 1)
                m.clearcoatRoughness = .init(floatLiteral: 0.02)
                m.blending = .transparent(opacity: .init(floatLiteral: 0.3))
            }
            return m
        }
        let maxAniso = quality == .high ? 8 : 1
        func param(_ texture: TextureResource) -> MaterialParameters.Texture {
            var t = MaterialParameters.Texture(texture)
            t.sampler = TextureFactory.sampler(anisotropy: maxAniso)
            return t
        }
        guard let set = textures[pattern] else {
            m.baseColor = .init(tint: uiColor(PATTERNS[pattern]?.flat ?? 0x808080))
            return m
        }
        m.baseColor = .init(tint: .white, texture: param(set.color))
        if quality == .medium {
            // three.js MeshLambertMaterial (no highlight) or MeshPhongMaterial (shininess, specular):
            // roughness ≈ sqrt(2 / (shininess + 2)).
            switch pattern {
            case "ceramic-glossy": m.roughness = 0.15; m.metallic = 0.0; m.specular = 0.5
            case "metal-brushed": m.roughness = 0.18; m.metallic = 0.6; m.specular = 1.0
            case "tablewood": m.roughness = 0.38; m.metallic = 0.0; m.specular = 0.25
            default: m.roughness = 1.0; m.metallic = 0.0; m.specular = 0.0
            }
            return m
        }
        // high: full PBR set (three.js roughness = metalness = 1 multiply the maps)
        if let n = set.normal { m.normal = .init(texture: param(n)) }
        if let r = set.roughness { m.roughness = .init(scale: 1, texture: param(r)) }
        if let mt = set.metallic { m.metallic = .init(scale: 1, texture: param(mt)) }
        if let ao = set.ambientOcclusion { m.ambientOcclusion = .init(texture: param(ao)) }
        switch pattern {
        case "ceramic-glossy":
            m.clearcoat = .init(floatLiteral: 1)
            m.clearcoatRoughness = .init(floatLiteral: 0.03)
        case "tablewood":
            m.clearcoat = .init(floatLiteral: 0.35)
            m.clearcoatRoughness = .init(floatLiteral: 0.2)
        case "fabric":
            m.sheen = .init(tint: uiColor(0xD99AA8))  // RealityKit has no sheen roughness
        case "metal-brushed":
            m.anisotropyLevel = .init(floatLiteral: 0.8)
        default:
            break
        }
        return m
    }

    // ---------- entities ----------
    private func meshResource(_ mesh: MeshData, key: String) -> MeshResource? {
        if let cached = meshCache[key] { return cached }
        do {
            let r = try mesh.resource()
            meshCache[key] = r
            return r
        } catch {
            Log.info("mesh generation failed for \(key): \(error)")
            return nil
        }
    }

    /// A lit (or unlit) mesh with the per-quality extras.
    private func model(_ mesh: MeshData, key: String, pattern: String, castsShadow: Bool) -> ModelEntity {
        guard let resource = meshResource(mesh, key: key) else { return ModelEntity() }
        let e = ModelEntity(mesh: resource, materials: [material(pattern)])
        if quality == .high {
            if environment != nil { e.components.set(ImageBasedLightReceiverComponent(imageBasedLight: root)) }
            e.components.set(GroundingShadowComponent(castsShadow: castsShadow, receivesShadow: true))
        }
        return e
    }

    /// Builds the room under `root`; returns the selectable object groups by ID.
    func build(positions: [String: [Double]]) -> [String: Entity] {
        // Background colour (three.js scene.background).
        var bgMaterial = UnlitMaterial(color: uiColor(quality == .low ? 0x8A8F94 : 0x9FA7AD), applyPostProcessToneMap: false)
        bgMaterial.faceCulling = .front
        let background = ModelEntity(mesh: .generateSphere(radius: 25), materials: [bgMaterial])
        background.name = "background"
        background.components.set(DynamicLightShadowComponent(castsShadow: false))
        root.addChild(background)

        // Floor and walls.
        let floor = model(Geometry.plane(width: 8, height: 8, uvRepeat: 3), key: "floor", pattern: "planks", castsShadow: false)
        floor.orientation = simd_quatf(angle: -.pi / 2, axis: [1, 0, 0])
        root.addChild(floor)
        let walls: [(Float, Float, Float, String)] = [(0, -3, 0, "brick"), (-3, 0, .pi / 2, "plaster"), (3, 0, -.pi / 2, "plaster")]
        for (x, z, ry, pattern) in walls {
            let repeatCount: Float = pattern == "brick" ? 2 : 1
            let wall = model(Geometry.plane(width: 6, height: 3, uvRepeat: repeatCount), key: "wall-\(pattern)", pattern: pattern, castsShadow: false)
            wall.position = [x, 1.5, z]
            wall.orientation = simd_quatf(angle: ry, axis: [0, 1, 0])
            root.addChild(wall)
        }

        // Table.
        let table = Entity()
        table.name = "table"
        let top = model(Geometry.box(width: 1.8, height: 0.05, depth: 0.9), key: "tabletop", pattern: "tablewood", castsShadow: true)
        top.position = [0, 0.75, 0]
        table.addChild(top)
        for (x, z) in [(-0.8, -0.38), (0.8, -0.38), (-0.8, 0.38), (0.8, 0.38)] as [(Float, Float)] {
            let leg = model(Geometry.box(width: 0.05, height: 0.75, depth: 0.05), key: "leg", pattern: "tablewood", castsShadow: true)
            leg.position = [x, 0.375, z]
            table.addChild(leg)
        }
        root.addChild(table)

        // Objects.
        let segments = ObjectGeometry.segments(quality)
        var objects: [String: Entity] = [:]
        for spec in OBJECT_SPECS {
            let group = Entity()
            group.name = spec.id
            let parts = ObjectGeometry.parts(spec.kind, segments: segments)
            for (i, part) in parts.enumerated() {
                let e = model(part.mesh, key: "\(spec.id)-\(i)", pattern: part.pattern, castsShadow: true)
                e.position = part.translation
                e.scale = part.scale
                group.addChild(e)
            }
            let b = ObjectGeometry.bounds(parts)
            let shape = ShapeResource.generateBox(size: b.max - b.min).offsetBy(translation: (b.max + b.min) / 2)
            group.components.set(CollisionComponent(shapes: [shape]))
            group.components.set(InputTargetComponent())
            let p = positions[spec.id] ?? spec.position
            group.position = SIMD3<Float>(Float(p[0]), Float(p[1]), Float(p[2]))
            root.addChild(group)
            objects[spec.id] = group
        }

        // Lights stay fixed to the room: children of root.
        if quality != .low {
            let sun = Entity()
            sun.name = "sun"
            sun.components.set(DirectionalLightComponent(color: .white, intensity: quality == .high ? 2400 : 2600))
            if quality == .high {
                sun.components.set(DirectionalLightComponent.Shadow(shadowProjection: .automatic(maximumDistance: 6), depthBias: 1))
            }
            let from = SIMD3<Float>(2.5, 4, 2)
            sun.position = from
            sun.orientation = simd_quatf(from: [0, 0, -1], to: simd_normalize(-from))
            root.addChild(sun)
        }
        if quality == .high, let environment {
            root.components.set(ImageBasedLightComponent(source: .single(environment), intensityExponent: 0))
        }
        return objects
    }

    /// The selection feedback ring (three.js RingGeometry(0.1, 0.12, 32)).
    func ring(color: UInt32) -> ModelEntity {
        var m = UnlitMaterial(color: uiColor(color), applyPostProcessToneMap: false)
        m.faceCulling = .none
        let mesh = meshResource(Geometry.flatRing(inner: 0.1, outer: 0.12, segments: 32), key: "ring")
        let e = mesh.map { ModelEntity(mesh: $0, materials: [m]) } ?? ModelEntity()
        e.components.set(DynamicLightShadowComponent(castsShadow: false))
        return e
    }
}
