// Minimal HTTP/1.1 control endpoint for the study bridge (Network.framework).
// Listens on 127.0.0.1:<port>; one route, POST /rpc with a JSON body. Each connection
// gets one response and is then closed. Content-Length and chunked bodies are accepted,
// and "Expect: 100-continue" is answered.
import Foundation
import Network

final class ControlServer: @unchecked Sendable {
    typealias Handler = @Sendable (Data) async -> JSONValue

    private let port: UInt16
    private let handler: Handler
    private let queue = DispatchQueue(label: "org.xrstudysim.graphicsquality.control")
    private var listener: NWListener?
    private var attempts = 0
    private static let maxBody = 16 * 1024 * 1024

    init(port: UInt16, handler: @escaping Handler) {
        self.port = port
        self.handler = handler
    }

    func start() {
        queue.async { self.listen() }
    }

    private func listen() {
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: port)!)
            let listener = try NWListener(using: parameters)
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    Log.info("control endpoint listening on http://127.0.0.1:\(self.port)/rpc")
                case .failed(let error):
                    Log.info("control endpoint failed: \(error)")
                    listener.cancel()
                    self.retry()
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
            self.listener = listener
        } catch {
            Log.info("control endpoint could not start: \(error)")
            retry()
        }
    }

    private func retry() {
        attempts += 1
        guard attempts <= 30 else { return }
        queue.asyncAfter(deadline: .now() + 1) { self.listen() }
    }

    // ---------- connections ----------
    private struct Request {
        let method: String
        let path: String
        let body: Data
    }

    private enum Parse {
        case incomplete(expectsContinue: Bool)
        case complete(Request)
        case bad(Int, String)
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data(), sentContinue: false)
    }

    private func receive(_ connection: NWConnection, buffer: Data, sentContinue: Bool) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            switch Self.parse(buffer) {
            case .complete(let request):
                self.respond(connection, to: request)
            case .bad(let status, let message):
                self.send(connection, status: status, body: .object([("error", .string(message))]))
            case .incomplete(let expectsContinue):
                if error != nil || isComplete {
                    connection.cancel()
                    return
                }
                var sent = sentContinue
                if expectsContinue && !sentContinue {
                    connection.send(content: Data("HTTP/1.1 100 Continue\r\n\r\n".utf8), completion: .contentProcessed { _ in })
                    sent = true
                }
                self.receive(connection, buffer: buffer, sentContinue: sent)
            }
        }
    }

    private static func parse(_ data: Data) -> Parse {
        let bytes = [UInt8](data)
        guard let headerEnd = find([13, 10, 13, 10], in: bytes, from: 0) else {
            return bytes.count > 65536 ? .bad(431, "Request headers too large.") : .incomplete(expectsContinue: false)
        }
        let head = String(decoding: bytes[0..<headerEnd], as: UTF8.self)
        let lines = head.components(separatedBy: "\r\n")
        let requestLine = lines[0].split(separator: " ")
        guard requestLine.count >= 2 else { return .bad(400, "Malformed request line.") }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] =
                line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let method = String(requestLine[0]).uppercased()
        var path = String(requestLine[1])
        if let q = path.firstIndex(of: "?") { path = String(path[..<q]) }
        let expects = headers["expect"]?.lowercased() == "100-continue"
        let bodyStart = headerEnd + 4
        let available = Array(bytes[bodyStart...])

        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true {
            var body = [UInt8](), offset = 0
            while true {
                guard let lineEnd = find([13, 10], in: available, from: offset) else { return .incomplete(expectsContinue: expects) }
                let sizeText = String(decoding: available[offset..<lineEnd], as: UTF8.self).split(separator: ";")[0]
                guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16) else { return .bad(400, "Malformed chunk.") }
                let chunkStart = lineEnd + 2
                if size == 0 { break }
                guard available.count >= chunkStart + size + 2 else { return .incomplete(expectsContinue: expects) }
                body += available[chunkStart..<(chunkStart + size)]
                if body.count > maxBody { return .bad(413, "Body too large.") }
                offset = chunkStart + size + 2
            }
            return .complete(Request(method: method, path: path, body: Data(body)))
        }
        let length = Int(headers["content-length"] ?? "0") ?? -1
        guard length >= 0 else { return .bad(400, "Bad Content-Length.") }
        guard length <= maxBody else { return .bad(413, "Body too large.") }
        guard available.count >= length else { return .incomplete(expectsContinue: expects) }
        return .complete(Request(method: method, path: path, body: Data(available[0..<length])))
    }

    private static func find(_ needle: [UInt8], in haystack: [UInt8], from start: Int) -> Int? {
        guard haystack.count >= needle.count, start <= haystack.count - needle.count else { return nil }
        for i in start...(haystack.count - needle.count) where haystack[i] == needle[0] {
            if Array(haystack[i..<(i + needle.count)]) == needle { return i }
        }
        return nil
    }

    private func respond(_ connection: NWConnection, to request: Request) {
        guard request.path == "/rpc" || request.path == "/rpc/" else {
            send(connection, status: 404, body: .object([("error", .string("Not found. Use POST /rpc."))]))
            return
        }
        guard request.method == "POST" else {
            send(connection, status: 405, body: .object([("error", .string("Use POST /rpc with a JSON body."))]))
            return
        }
        let handler = self.handler
        let body = request.body
        Task {
            let reply = await handler(body)
            self.queue.async { self.send(connection, status: 200, body: reply) }
        }
    }

    private func send(_ connection: NWConnection, status: Int, body: JSONValue) {
        let payload = Data(body.serialized().utf8)
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 413: "Payload Too Large",
                      431: "Request Header Fields Too Large"][status] ?? "Error"
        var response = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n".utf8)
        response.append(payload)
        connection.send(content: response, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            connection.cancel()
        })
    }
}
