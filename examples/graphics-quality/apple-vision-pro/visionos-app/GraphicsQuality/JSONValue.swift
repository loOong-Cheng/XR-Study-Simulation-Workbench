// A small JSON value with ordered object keys (so replies and log entries keep the
// field order of the WebXR app) and helpers to read loosely typed request params.
import Foundation

indirect enum JSONValue {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([(String, JSONValue)])

    func serialized() -> String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d):
            if !d.isFinite { out += "null" }
            else if d == d.rounded(.towardZero) && abs(d) < 1e15 { out += String(Int64(d)) }
            else { out += "\(d)" }
        case .string(let s): JSONValue.writeString(s, to: &out)
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case .object(let fields):
            out += "{"
            for (i, (key, value)) in fields.enumerated() {
                if i > 0 { out += "," }
                JSONValue.writeString(key, to: &out)
                out += ":"
                value.write(to: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, to out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 { out += String(format: "\\u%04x", scalar.value) }
                else { out.unicodeScalars.append(scalar) }
            }
        }
        out += "\""
    }

    static func vector(_ v: [Double]) -> JSONValue { .array(v.map { .double($0) }) }
}

/// Reads a number from a JSONSerialization value (numbers or numeric strings; not booleans).
func jsonNumber(_ any: Any?) -> Double? {
    if let n = any as? NSNumber {
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }
    if let s = any as? String, let d = Double(s.trimmingCharacters(in: .whitespaces)), d.isFinite { return d }
    return nil
}

func jsonNumbers(_ any: Any?, count: Int) -> [Double]? {
    guard let list = any as? [Any], list.count == count else { return nil }
    let values = list.compactMap(jsonNumber)
    return values.count == count ? values : nil
}
