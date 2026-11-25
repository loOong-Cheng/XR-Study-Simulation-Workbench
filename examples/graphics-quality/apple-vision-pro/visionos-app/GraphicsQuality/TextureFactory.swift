// Turns the procedural texel buffers (Patterns.swift) into RealityKit textures, and
// paints the equirectangular environment used for image-based lighting at high quality.
import CoreGraphics
import Foundation
import Metal
import RealityKit
import simd

/// The texel data for one quality level, generated off the main actor.
struct TextureData: @unchecked Sendable {
    var colorOnly: [String: (size: Int, rgba: [UInt8])] = [:]
    var sets: [String: PBRSetData] = [:]
    var environment: CGImage?
}

/// Textures ready for materials.
struct PatternTextures {
    var color: TextureResource
    var normal: TextureResource?
    var roughness: TextureResource?
    var metallic: TextureResource?
    var ambientOcclusion: TextureResource?
}

enum TextureFactory {
    /// Patterns used at medium/high quality (glass has no texture).
    static let patternNames = ["planks", "brick", "plaster", "tablewood", "boxwood", "fabric", "terracotta", "leaf",
                               "ceramic-glossy", "ceramic-matte", "metal-brushed", "plastic", "plastic-blue"]
    /// pbr.js: large surfaces get 1024 px sets, small objects 512 px.
    static let largePatterns: Set<String> = ["planks", "brick", "plaster", "tablewood"]

    static func generate(quality: Quality) -> TextureData {
        var data = TextureData()
        switch quality {
        case .low:
            break
        case .medium:
            for name in patternNames { data.colorOnly[name] = (256, colorOnlyData(name, size: 256)) }
        case .high:
            for name in patternNames {
                data.sets[name] = pbrSetData(name, size: largePatterns.contains(name) ? 1024 : 512)
            }
            data.environment = environmentImage(width: 1024, height: 512)
        }
        return data
    }

    // ---------- CGImage helpers ----------
    static func rgbaImage(_ bytes: [UInt8], size: Int, srgb: Bool) -> CGImage? {
        let space = srgb ? CGColorSpace(name: CGColorSpace.sRGB)! : CGColorSpace(name: CGColorSpace.linearSRGB)!
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: size * 4,
                       space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    static func grayImage(_ bytes: [UInt8], size: Int) -> CGImage? {
        guard let provider = CGDataProvider(data: Data(bytes) as CFData) else { return nil }
        return CGImage(width: size, height: size, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: size,
                       space: CGColorSpace(name: CGColorSpace.linearGray)!, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }

    @MainActor
    static func texture(_ image: CGImage?, _ semantic: TextureResource.Semantic) async -> TextureResource? {
        guard let image else { return nil }
        do {
            return try await TextureResource(image: image, options: .init(semantic: semantic))
        } catch {
            Log.info("texture creation failed: \(error)")
            return nil
        }
    }

    @MainActor
    static func makeTextures(_ data: TextureData) async -> [String: PatternTextures] {
        var result: [String: PatternTextures] = [:]
        for (name, entry) in data.colorOnly {
            if let color = await texture(rgbaImage(entry.rgba, size: entry.size, srgb: true), .color) {
                result[name] = PatternTextures(color: color)
            }
        }
        for (name, set) in data.sets {
            guard let color = await texture(rgbaImage(set.color, size: set.size, srgb: true), .color) else { continue }
            result[name] = PatternTextures(
                color: color,
                normal: await texture(rgbaImage(set.normal, size: set.size, srgb: false), .normal),
                roughness: await texture(grayImage(set.rough, size: set.size), .scalar),
                metallic: await texture(grayImage(set.metal, size: set.size), .scalar),
                ambientOcclusion: await texture(grayImage(set.ao, size: set.size), .scalar))
        }
        return result
    }

    /// Repeat-wrapping, trilinear sampler (three.js RepeatWrapping + mipmaps).
    static func sampler(anisotropy: Int) -> MaterialParameters.Texture.Sampler {
        let d = MTLSamplerDescriptor()
        d.sAddressMode = .repeat
        d.tAddressMode = .repeat
        d.minFilter = .linear
        d.magFilter = .linear
        d.mipFilter = .linear
        d.maxAnisotropy = anisotropy
        return MaterialParameters.Texture.Sampler(d)
    }

    // ---------- environment for image-based lighting ----------
    /// A procedural stand-in for three.js RoomEnvironment: a grey room with a warm floor,
    /// a bright ceiling panel and a few area lights, as linear HDR (float) equirectangular.
    static func environmentImage(width: Int, height: Int) -> CGImage? {
        var px = [Float](repeating: 0, count: width * height * 4)
        let sun = simd_normalize(SIMD3<Float>(2.5, 4, 2))
        let lights: [(dir: SIMD3<Float>, cosRadius: Float, intensity: SIMD3<Float>)] = [
            (sun, cos(0.20), [14, 13.4, 12.4]),
            (simd_normalize(SIMD3<Float>(-1, 0.45, 0.3)), cos(0.30), [3.5, 3.5, 3.6]),
            (simd_normalize(SIMD3<Float>(0.6, 0.35, -1)), cos(0.28), [3.0, 3.0, 3.1]),
            (simd_normalize(SIMD3<Float>(-0.4, 0.3, -1)), cos(0.22), [2.4, 2.4, 2.5]),
        ]
        for y in 0..<height {
            let lat = Float.pi / 2 - (Float(y) + 0.5) / Float(height) * .pi
            for x in 0..<width {
                let lon = (Float(x) + 0.5) / Float(width) * 2 * .pi - .pi
                let d = SIMD3<Float>(sin(lon) * cos(lat), sin(lat), -cos(lon) * cos(lat))
                var c: SIMD3<Float>
                if d.y < -0.02 {
                    c = [0.16, 0.13, 0.10]                       // wooden floor
                } else {
                    let k = 0.42 + 0.18 * max(0, d.y)            // walls, lighter towards the ceiling
                    c = [k, k, k * 1.02]
                }
                if d.y > 0.88 { c = [5.5, 5.5, 5.4] }            // ceiling light panel
                for l in lights where simd_dot(d, l.dir) > l.cosRadius { c = l.intensity }
                let o = (y * width + x) * 4
                px[o] = c.x; px[o + 1] = c.y; px[o + 2] = c.z; px[o + 3] = 1
            }
        }
        let info = CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue
                                | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        guard let provider = CGDataProvider(data: px.withUnsafeBufferPointer { Data(buffer: $0) } as CFData) else { return nil }
        return CGImage(width: width, height: height, bitsPerComponent: 32, bitsPerPixel: 128, bytesPerRow: width * 16,
                       space: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!, bitmapInfo: info,
                       provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)
    }
}
