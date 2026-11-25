// Study content shared with the WebXR app (examples/graphics-quality/webxr-app/main.js):
// object IDs, hidden truths, slot positions, trials and the seeded layout shuffle.
// Pure Foundation code (no RealityKit) so it can be checked against the JavaScript.
import Foundation

enum Quality: String, CaseIterable {
    case low, medium, high
}

enum ObjectKind {
    case mug(String)    // material pattern
    case bowl(String)
    case vase(String)
    case box
    case cushion
    case plant
}

struct ObjectSpec {
    let id: String
    let kind: ObjectKind
    /// Home slot in room coordinates (metres), as in main.js.
    let position: [Double]
    /// Hidden truth, used only for scoring and the log.
    let truth: String
}

let OBJECT_SPECS: [ObjectSpec] = [
    ObjectSpec(id: "obj-1", kind: .mug("ceramic-glossy"), position: [-0.6, 0.775, -0.15], truth: "ceramic-mug"),
    ObjectSpec(id: "obj-2", kind: .mug("ceramic-matte"), position: [-0.3, 0.775, 0.2], truth: "matte-mug"),
    ObjectSpec(id: "obj-3", kind: .bowl("metal-brushed"), position: [0.35, 0.775, -0.2], truth: "metal-bowl"),
    ObjectSpec(id: "obj-4", kind: .bowl("plastic"), position: [0.05, 0.775, 0.15], truth: "plastic-bowl"),
    ObjectSpec(id: "obj-5", kind: .vase("glass"), position: [0.65, 0.775, 0.15], truth: "glass-vase"),
    ObjectSpec(id: "obj-6", kind: .vase("plastic-blue"), position: [-0.05, 0.775, -0.25], truth: "plastic-vase"),
    ObjectSpec(id: "obj-7", kind: .box, position: [0.7, 0.775, -0.25], truth: "wooden-box"),
    ObjectSpec(id: "obj-8", kind: .cushion, position: [-0.7, 0.775, 0.25], truth: "cushion"),
    ObjectSpec(id: "obj-9", kind: .plant, position: [0.3, 0.775, 0.28], truth: "plant"),
]

struct Trial {
    let phase: String
    let title: String
    let text: String
    let targets: [String]
}

let MAIN_TEXT = "Select the glossy ceramic mug, the brushed-metal bowl and the glass vase."
let TRIALS: [Trial] = [Trial(phase: "practice", title: "Practice", text: "Select the wooden box.", targets: ["wooden-box"])]
    + (1...4).map { n in
        Trial(phase: "main", title: "Main task · trial \(n) of 4", text: MAIN_TEXT, targets: ["ceramic-mug", "metal-bowl", "glass-vase"])
    }

/// The six look-alikes swap places before every scored trial.
let LOOKALIKES = ["obj-1", "obj-2", "obj-3", "obj-4", "obj-5", "obj-6"]

/// Port of main.js `seeded(text)`: FNV-1a style hash over the UTF-16 code unit that
/// `c.charCodeAt(0)` returns for every code point, then a 32-bit mixing generator.
/// `Math.imul`, `^` and `>>>` all act on the 32-bit pattern, which UInt32 wrapping
/// arithmetic reproduces bit for bit.
func seeded(_ text: String) -> () -> Double {
    var h: UInt32 = 2_166_136_261
    for scalar in text.unicodeScalars {
        let v = scalar.value
        let unit: UInt32 = v > 0xFFFF ? 0xD800 + ((v - 0x10000) >> 10) : v
        h = (h ^ unit) &* 16_777_619
    }
    return {
        h = ((h ^ (h >> 15)) &* 2_246_822_507) ^ ((h ^ (h >> 13)) &* 3_266_489_909)
        h ^= h >> 16
        return Double(h) / 4_294_967_296
    }
}

/// Port of main.js `arrange(trial)`: returns, for each look-alike in LOOKALIKES order,
/// the index of the slot (in LOOKALIKES order) it moves to.
func arrangeOrder(trial: Int, participant: String, quality: String) -> [Int] {
    var order = Array(0..<LOOKALIKES.count)
    if trial > 0 {
        let rand = seeded("\(participant)|\(quality)|\(trial)")
        var i = order.count - 1
        while i > 0 {
            let j = Int((rand() * Double(i + 1)).rounded(.down))
            order.swapAt(i, j)
            i -= 1
        }
    }
    return order
}

/// Positions of all nine objects for a trial (non-look-alikes never move).
func layoutPositions(trial: Int, participant: String, quality: String) -> [String: [Double]] {
    var positions: [String: [Double]] = [:]
    for spec in OBJECT_SPECS { positions[spec.id] = spec.position }
    let slots = LOOKALIKES.map { id in OBJECT_SPECS.first { $0.id == id }!.position }
    let order = arrangeOrder(trial: trial, participant: participant, quality: quality)
    for (i, id) in LOOKALIKES.enumerated() { positions[id] = slots[order[i]] }
    return positions
}
