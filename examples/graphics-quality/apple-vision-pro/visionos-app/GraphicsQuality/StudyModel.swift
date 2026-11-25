// App state: the task flow and event log of main.js, the virtual orbit camera, the
// RealityKit scene and the RPC methods the study bridge calls.
import Foundation
import Observation
import RealityKit
import simd
import SwiftUI
import UIKit

struct RPCError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

@MainActor
@Observable
final class StudyModel {
    static let shared = StudyModel()

    // ---------- launch options ----------
    @ObservationIgnored let options: LaunchOptions
    var quality: Quality { options.quality }
    var participant: String { options.participant }

    // ---------- task state (observed by the panel) ----------
    private(set) var trial = -1
    private(set) var phase = "idle"
    private(set) var remaining: [String] = []
    private(set) var errors = 0
    private(set) var done = false
    private(set) var calibrating = false
    private(set) var ready = false

    @ObservationIgnored private let clockOrigin = DispatchTime.now().uptimeNanoseconds
    @ObservationIgnored private var startedAt: UInt64 = 0
    @ObservationIgnored private var readyAt: UInt64 = 0
    @ObservationIgnored private var log: [JSONValue] = []
    @ObservationIgnored private var positions: [String: [Double]] = [:]
    @ObservationIgnored private var objectCenters: [String: SIMD3<Double>] = [:]

    // ---------- virtual orbit camera (three.js OrbitControls / xrStudy.look) ----------
    static let target = SIMD3<Double>(0, 0.8, 0)
    static let lookDistance = 1.35
    @ObservationIgnored private(set) var azimuth = 0.0
    @ObservationIgnored private(set) var polar = 0.0
    @ObservationIgnored private var distance = lookDistance

    // ---------- scene ----------
    @ObservationIgnored private var head: AnchorEntity?
    @ObservationIgnored private var builder: RoomBuilder?
    @ObservationIgnored private var objectEntities: [String: Entity] = [:]
    @ObservationIgnored private var panel: Entity?
    @ObservationIgnored private let calibrationRoot = Entity()
    @ObservationIgnored private var markers: [(position: SIMD3<Float>, color: UIColor)] = []
    @ObservationIgnored private var updateSubscription: EventSubscription?
    @ObservationIgnored private var building = false
    @ObservationIgnored private var frameCount = 0
    @ObservationIgnored private var smoothFrames = 0
    @ObservationIgnored private var sceneAddedAt: UInt64 = 0
    @ObservationIgnored private var frameWaiters: [UUID: (target: Int, continuation: CheckedContinuation<Void, Never>)] = [:]
    @ObservationIgnored private var server: ControlServer?

    private init() {
        options = LaunchOptions.parse(CommandLine.arguments)
        // Initial view = the WebXR initial camera at (0, 1.3, 1.25) looking at the target.
        let offset = SIMD3<Double>(0, 1.3, 1.25) - Self.target
        distance = simd_length(offset)
        polar = acos(offset.y / distance) * 180 / .pi
        azimuth = 0
        positions = layoutPositions(trial: 0, participant: options.participant, quality: options.quality.rawValue)
        let segments = ObjectGeometry.segments(options.quality)
        for spec in OBJECT_SPECS {
            let b = ObjectGeometry.bounds(ObjectGeometry.parts(spec.kind, segments: segments))
            let c = (b.min + b.max) / 2
            objectCenters[spec.id] = SIMD3<Double>(Double(c.x), Double(c.y), Double(c.z))
        }
        calibrationRoot.name = "calibration"
        record("session-start", [("userAgent", .string(userAgent))])
        Log.info("quality=\(options.quality.rawValue) participant=\(options.participant) port=\(options.port)")
        let server = ControlServer(port: options.port) { body in
            await StudyModel.shared.handleRPC(body)
        }
        server.start()
        self.server = server
    }

    // ---------- clock ----------
    private var now: UInt64 { DispatchTime.now().uptimeNanoseconds }
    private func msSince(_ t: UInt64) -> Int { Int((Double(now &- t) / 1e6).rounded()) }

    // ---------- environment info ----------
    var osString: String { "visionOS \(UIDevice.current.systemVersion)" }
    var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }
    var deviceName: String {
        let env = ProcessInfo.processInfo.environment
        var model = "Apple Vision Pro"
        if let identifier = env["SIMULATOR_MODEL_IDENTIFIER"] ?? machineIdentifier(), !identifier.isEmpty {
            model += " (\(identifier))"
        }
        return isSimulator ? model + " Simulator" : model
    }
    private func machineIdentifier() -> String? {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
    }
    private var userAgent: String {
        "GraphicsQuality-visionOS/1 (\(osString); \(deviceName))"
    }

    // ---------- panel text (as the WebXR overlay in study mode) ----------
    var panelTitle: String {
        if done { return "Done — please answer the questionnaire" }
        return trial >= 0 ? TRIALS[trial].title : "Graphics Quality Room"
    }
    var instruction: String {
        if done { return "" }
        return trial >= 0 ? TRIALS[trial].text : "Look around, then start the practice trial."
    }
    var found: Int { trial >= 0 ? TRIALS[trial].targets.count - remaining.count : 0 }
    var targetCount: Int { trial >= 0 ? TRIALS[trial].targets.count : 0 }
    var statusLine: String {
        trial >= 0 && !done ? "\(found)/\(targetCount) found · \(errors) wrong selection(s)" : ""
    }

    // ---------- task flow (main.js startTrial / select / flash) ----------
    private func record(_ type: String, _ data: [(String, JSONValue)] = []) {
        log.append(.object([("t", .int(msSince(clockOrigin))), ("type", .string(type)),
                            ("quality", .string(quality.rawValue)), ("participant", .string(participant))] + data))
    }

    private func arrange(_ trial: Int) {
        positions = layoutPositions(trial: trial, participant: participant, quality: quality.rawValue)
        applyPositions()
    }

    private func applyPositions() {
        for (id, entity) in objectEntities {
            guard let p = positions[id] else { continue }
            entity.position = SIMD3<Float>(Float(p[0]), Float(p[1]), Float(p[2]))
        }
    }

    private func startTrial(_ i: Int) {
        trial = i
        phase = TRIALS[i].phase
        arrange(i)
        remaining = TRIALS[i].targets
        errors = 0
        startedAt = now
        record("phase", [("phaseId", .string(phase))])
        record("trial-start", [("trial", .int(i)), ("phase", .string(phase)),
                               ("layout", .array(LOOKALIKES.map { JSONValue.vector(positions[$0] ?? []) }))])
    }

    /// `start`: practice (default) or, with phase "main", scored trial 1 of 4.
    func start(phase requested: String? = nil) throws {
        let index: Int
        switch requested {
        case nil, "practice": index = 0
        case "main": index = 1
        default: throw RPCError("Unknown phase \"\(requested!)\"; use \"practice\" or \"main\".")
        }
        done = false
        startTrial(index)
    }

    func select(_ id: String?) -> JSONValue {
        if trial < 0 || done { return .object([("accepted", .bool(false)), ("reason", .string("No active trial."))]) }
        guard let id, let spec = OBJECT_SPECS.first(where: { $0.id == id }) else {
            return .object([("accepted", .bool(false)), ("reason", .string("Unknown object."))])
        }
        let correct = remaining.contains(spec.truth)
        record("select", [("trial", .int(trial)), ("objectId", .string(id)), ("correct", .bool(correct))])
        if correct {
            remaining.removeAll { $0 == spec.truth }
            flash(id, color: 0x2ECC71)
        } else {
            errors += 1
            flash(id, color: 0xE74C3C)
        }
        if remaining.isEmpty {
            let seconds = Double(now &- startedAt) / 1e9
            record("trial-end", [("trial", .int(trial)), ("phase", .string(phase)), ("seconds", .double(seconds)), ("errors", .int(errors))])
            if trial + 1 < TRIALS.count {
                startTrial(trial + 1)
            } else {
                done = true
                record("phase", [("phaseId", .string("questionnaire"))])
            }
        }
        return .object([("accepted", .bool(true)), ("correct", .bool(correct))])
    }

    /// A green or red ring on the table around the object for 600 ms.
    private func flash(_ id: String, color: UInt32) {
        guard let builder, let p = positions[id] else { return }
        let ring = builder.ring(color: color)
        ring.position = SIMD3<Float>(Float(p[0]), 0.78, Float(p[2]))
        builder.root.addChild(ring)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 600_000_000)
            ring.removeFromParent()
        }
    }

    /// Pinch/click on an object in the simulator or headset.
    func tapped(_ entity: Entity) {
        var current: Entity? = entity
        while let e = current, !OBJECT_SPECS.contains(where: { $0.id == e.name }) { current = e.parent }
        guard let id = current?.name else { return }
        if trial < 0 { // as the WebXR controller: the first select starts the practice trial
            startTrial(0)
            return
        }
        Log.info("tap \(id) -> \(select(id).serialized())")
    }

    func startFromPanel() {
        if trial < 0 { startTrial(0) }
    }

    // ---------- view ----------
    /// Camera pose in room coordinates: three.js Spherical(distance, polar, azimuth) around
    /// the target, then lookAt(target) with +Y up (camera looks down its −Z).
    private func cameraPose() -> simd_double4x4 {
        let phi = polar * .pi / 180, theta = azimuth * .pi / 180
        let eye = Self.target + distance * SIMD3<Double>(sin(phi) * sin(theta), cos(phi), sin(phi) * cos(theta))
        let z = simd_normalize(eye - Self.target)
        let x = simd_normalize(simd_cross(SIMD3<Double>(0, 1, 0), z))
        let y = simd_cross(z, x)
        return simd_double4x4(columns: (SIMD4(x, 0), SIMD4(y, 0), SIMD4(z, 0), SIMD4(eye, 1)))
    }

    /// Room → head coordinates.
    private var viewMatrix: simd_double4x4 { cameraPose().inverse }

    private func applyView() {
        guard let root = builder?.root else { return }
        let m = viewMatrix
        func col(_ c: SIMD4<Double>) -> SIMD4<Float> { SIMD4<Float>(Float(c.x), Float(c.y), Float(c.z), Float(c.w)) }
        root.transform = Transform(matrix: simd_float4x4(columns: (col(m.columns.0), col(m.columns.1), col(m.columns.2), col(m.columns.3))))
    }

    func look(azimuth az: Double?, polar pol: Double?) -> (azimuth: Double, polar: Double) {
        if let az { azimuth = az }
        if let pol { polar = min(89, max(5, pol)) }
        distance = Self.lookDistance
        applyView()
        return (azimuth, polar)
    }

    /// Centres of the objects' visual bounds in head coordinates.
    func objectsInHead() -> [(id: String, head: SIMD3<Double>)] {
        let m = viewMatrix
        return OBJECT_SPECS.map { spec in
            let p = positions[spec.id] ?? spec.position
            let c = SIMD3<Double>(p[0], p[1], p[2]) + (objectCenters[spec.id] ?? .zero)
            let h = m * SIMD4<Double>(c, 1)
            return (spec.id, SIMD3<Double>(h.x, h.y, h.z))
        }
    }

    // ---------- calibration ----------
    func calibrate(_ newMarkers: [(position: SIMD3<Float>, color: UIColor)]) {
        markers = newMarkers
        calibrating = !newMarkers.isEmpty
        applyCalibration()
    }

    private func applyCalibration() {
        for child in Array(calibrationRoot.children) { child.removeFromParent() }
        let sphere = MeshResource.generateSphere(radius: 0.012)
        for marker in markers {
            let e = ModelEntity(mesh: sphere, materials: [UnlitMaterial(color: marker.color, applyPostProcessToneMap: false)])
            e.position = marker.position
            calibrationRoot.addChild(e)
        }
        builder?.root.isEnabled = !calibrating
        panel?.isEnabled = !calibrating
    }

    // ---------- scene lifecycle ----------
    func makeScene(_ content: inout RealityViewContent, _ attachments: RealityViewAttachments) async {
        if let head {
            content.add(head)
            return
        }
        guard !building else { return }
        building = true
        let started = now
        let q = quality
        let data = await Task.detached(priority: .userInitiated) { TextureFactory.generate(quality: q) }.value
        let generated = msSince(started)
        let textures = await TextureFactory.makeTextures(data)
        var environment: EnvironmentResource?
        if let image = data.environment {
            do { environment = try await EnvironmentResource(equirectangular: image) } catch { Log.info("environment failed: \(error)") }
        }
        let builder = RoomBuilder(quality: q, textures: textures, environment: environment)
        objectEntities = builder.build(positions: positions)
        self.builder = builder

        let head = AnchorEntity(.head)
        head.name = "head"
        head.anchoring.trackingMode = .continuous
        head.addChild(builder.root)
        head.addChild(calibrationRoot)
        if let panel = attachments.entity(for: "panel") {
            // Upper left of the view (about 22° left and 19° up, 1 m away), clear of the table,
            // parallel to the image plane so it is not skewed in the wide-angle view.
            panel.position = [-0.37, 0.32, -0.92]
            panel.scale = SIMD3<Float>(repeating: 1.25)
            panel.components.set(DynamicLightShadowComponent(castsShadow: false))
            head.addChild(panel)
            self.panel = panel
        }
        applyView()
        applyPositions()
        applyCalibration()
        content.add(head)
        self.head = head
        sceneAddedAt = now
        updateSubscription = content.subscribe(to: SceneEvents.Update.self) { event in
            let dt = event.deltaTime
            MainActor.assumeIsolated { StudyModel.shared.frameTick(dt) }
        }
        Log.info("scene built: textures \(generated) ms, total \(msSince(started)) ms")
    }

    /// Ready = the scene was added, at least a second has passed, and the last 30 frames ran
    /// smoothly (RealityKit stalls the update loop while it uploads textures and compiles shaders).
    private func frameTick(_ dt: TimeInterval) {
        frameCount += 1
        smoothFrames = dt < 0.1 ? smoothFrames + 1 : 0
        if !ready && head != nil && smoothFrames >= 30 && msSince(sceneAddedAt) >= 1000 {
            ready = true
            readyAt = now
            Log.info("ready (\(msSince(clockOrigin)) ms after launch)")
        }
        let due = frameWaiters.filter { $0.value.target <= frameCount }
        for (id, waiter) in due {
            frameWaiters.removeValue(forKey: id)
            waiter.continuation.resume()
        }
    }

    /// Waits until `n` more frames were simulated (or the timeout passed), so a change is on screen.
    func waitFrames(_ n: Int, timeout: Double = 1.0) async {
        let id = UUID()
        let target = frameCount + n
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            frameWaiters[id] = (target, continuation)
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1e9))
                if let waiter = StudyModel.shared.frameWaiters.removeValue(forKey: id) { waiter.continuation.resume() }
            }
        }
    }

    // ---------- RPC ----------
    func handleRPC(_ body: Data) async -> JSONValue {
        let started = now
        var method = "?"
        let reply: JSONValue
        do {
            guard let object = (try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed])) as? [String: Any] else {
                throw RPCError("Body must be a JSON object: {\"method\": \"...\", \"params\": {...}}.")
            }
            guard let m = object["method"] as? String else { throw RPCError("Missing \"method\".") }
            method = m
            let params = object["params"] as? [String: Any] ?? [:]
            reply = .object([("result", try await dispatch(m, params))])
        } catch let error as RPCError {
            reply = .object([("error", .string(error.message))])
        } catch {
            reply = .object([("error", .string("\(error)"))])
        }
        var summary = reply.serialized()
        if summary.count > 160 { summary = String(summary.prefix(160)) + "…" }
        Log.info("rpc \(method) -> \(summary) (\(msSince(started)) ms)")
        return reply
    }

    private func dispatch(_ method: String, _ params: [String: Any]) async throws -> JSONValue {
        switch method {
        case "hello":
            return .object([("app", .string("graphics-quality-visionos")), ("version", .string("1")),
                            ("quality", .string(quality.rawValue)), ("participant", .string(participant)),
                            ("os", .string(osString)), ("device", .string(deviceName)), ("ready", .bool(ready))])
        case "getState":
            return .object([
                ("phase", .string(done ? "questionnaire" : phase)),
                ("trial", .int(trial)),
                ("instruction", .string(instruction)),
                ("done", .bool(done)),
                ("timeMs", .int(ready ? msSince(readyAt) : 0)),
                ("public", .object([("found", .int(found)), ("targets", .int(targetCount)), ("wrongSelections", .int(errors))])),
            ])
        case "start":
            var requested: String?
            if let p = params["phase"], !(p is NSNull) {
                guard let s = p as? String else { throw RPCError("\"phase\" must be \"practice\" or \"main\".") }
                requested = s
            }
            try start(phase: requested)
            await waitFrames(2)
            return .object([("ok", .bool(true))])
        case "look":
            let az = params["azimuth"], pol = params["polar"]
            let azimuth = az == nil || az is NSNull ? nil : jsonNumber(az)
            let polar = pol == nil || pol is NSNull ? nil : jsonNumber(pol)
            if az != nil && !(az is NSNull) && azimuth == nil { throw RPCError("\"azimuth\" must be a number (degrees).") }
            if pol != nil && !(pol is NSNull) && polar == nil { throw RPCError("\"polar\" must be a number (degrees).") }
            let applied = look(azimuth: azimuth, polar: polar)
            await waitFrames(2)
            return .object([("azimuth", .double(applied.azimuth)), ("polar", .double(applied.polar))])
        case "objects":
            return .array(objectsInHead().map { o in
                .object([("id", .string(o.id)), ("head", .vector([o.head.x, o.head.y, o.head.z].map { ($0 * 1e6).rounded() / 1e6 }))])
            })
        case "select":
            let reply = select(params["id"] as? String)
            await waitFrames(2)
            return reply
        case "log":
            return .array(log)
        case "calibrate":
            guard let list = params["markers"] as? [Any] else { throw RPCError("\"markers\" must be an array (empty to restore the view).") }
            var parsed: [(position: SIMD3<Float>, color: UIColor)] = []
            for item in list {
                guard let marker = item as? [String: Any], let h = jsonNumbers(marker["head"], count: 3) else {
                    throw RPCError("Each marker needs \"head\": [x, y, z] (metres, head coordinates) and \"color\": [r, g, b] (0-255).")
                }
                var rgb = [255.0, 255.0, 255.0]
                if let c = marker["color"] {
                    guard let values = jsonNumbers(c, count: 3) else { throw RPCError("\"color\" must be [r, g, b] with values 0-255.") }
                    rgb = values.map { min(255, max(0, $0)) }
                }
                parsed.append((SIMD3<Float>(Float(h[0]), Float(h[1]), Float(h[2])),
                               UIColor(red: rgb[0] / 255, green: rgb[1] / 255, blue: rgb[2] / 255, alpha: 1)))
            }
            calibrate(parsed)
            await waitFrames(3)
            return .object([("ok", .bool(true))])
        default:
            throw RPCError("Unknown method \"\(method)\". Methods: hello, getState, start, look, objects, select, log, calibrate.")
        }
    }
}
