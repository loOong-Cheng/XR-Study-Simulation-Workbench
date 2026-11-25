// Launch arguments (passed by `xcrun simctl launch <udid> org.xrstudysim.graphicsquality …`):
//   --quality low|medium|high   (default high)
//   --participant <id>          (default "anonymous")
//   --port <n>                  (default 47800)
// `--name=value` works too. Unknown arguments are ignored.
import Foundation
import os

enum Log {
    private static let logger = Logger(subsystem: "org.xrstudysim.graphicsquality", category: "app")

    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        FileHandle.standardError.write(Data("[GraphicsQuality] \(message)\n".utf8))
    }
}

struct LaunchOptions {
    var quality: Quality = .high
    var participant = "anonymous"
    var port: UInt16 = 47800

    static func parse(_ arguments: [String]) -> LaunchOptions {
        var options = LaunchOptions()
        var values: [String: String] = [:]
        var i = 1
        while i < arguments.count {
            let arg = arguments[i]
            if arg.hasPrefix("--") {
                let body = String(arg.dropFirst(2))
                if let eq = body.firstIndex(of: "=") {
                    values[String(body[..<eq])] = String(body[body.index(after: eq)...])
                } else if i + 1 < arguments.count {
                    values[body] = arguments[i + 1]
                    i += 1
                }
            }
            i += 1
        }
        if let q = values["quality"].flatMap({ Quality(rawValue: $0.lowercased()) }) { options.quality = q }
        if let p = values["participant"], !p.isEmpty { options.participant = p }
        if let n = values["port"].flatMap({ UInt16($0) }), n > 0 { options.port = n }
        return options
    }
}
