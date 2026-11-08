import Foundation
import WebKit

/* Serves the bundled collection from a private aomg:// origin instead of file://.
 *
 * Why not file://: WKWebView gives every file its own opaque origin, so the shell
 * and each game would get separate localStorage (saves silently vanish between
 * titles) and media playback from file URLs is unreliable. One custom origin makes
 * the app behave like the web build the tests already cover, with no network.
 */
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "aomg"
    static let host = "app"

    static var startURL: URL { URL(string: "\(scheme)://\(host)/index.html")! }

    private let root: URL
    private let lock = NSLock()
    private var stopped: Set<ObjectIdentifier> = []

    init(root: URL) {
        self.root = root.standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return fail(urlSchemeTask, 400, url: nil) }
        var requestPath = url.path
        if requestPath.isEmpty || requestPath == "/" { requestPath = "/index.html" }
        guard let file = resolve(String(requestPath.dropFirst())) else {
            return fail(urlSchemeTask, 403, url: url)
        }
        guard let data = try? Data(contentsOf: file) else {
            return fail(urlSchemeTask, 404, url: url)
        }

        let total = data.count
        var status = 200
        var headers: [String: String] = [
            "Content-Type": mimeType(for: file.path),
            "Content-Length": String(total),
            "Accept-Ranges": "bytes",
            "Cache-Control": "no-cache",
        ]
        var body = data

        if let rangeHeader = urlSchemeTask.request.value(forHTTPHeaderField: "Range"),
           let bounds = parseRange(rangeHeader, total: total) {
            status = 206
            body = data.subdata(in: bounds)
            headers["Content-Length"] = String(body.count)
            headers["Content-Range"] = "bytes \(bounds.lowerBound)-\(bounds.upperBound - 1)/\(total)"
        }

        guard !isStopped(urlSchemeTask) else { return }
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return fail(urlSchemeTask, 500, url: url)
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        lock.lock()
        stopped.insert(ObjectIdentifier(urlSchemeTask))
        lock.unlock()
    }

    // MARK: - helpers

    private func isStopped(_ task: WKURLSchemeTask) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped.contains(ObjectIdentifier(task))
    }

    private func fail(_ task: WKURLSchemeTask, _ status: Int, url: URL?) {
        guard !isStopped(task) else { return }
        let resolved = url ?? URL(string: "\(Self.scheme)://\(Self.host)/")!
        if let response = HTTPURLResponse(url: resolved, statusCode: status, httpVersion: "HTTP/1.1",
                                          headerFields: ["Content-Type": "text/plain; charset=utf-8"]) {
            task.didReceive(response)
            task.didReceive(Data("\(status)".utf8))
            task.didFinish()
        } else {
            task.didFailWithError(NSError(domain: "AOMG", code: status))
        }
    }

    /// Resolves a request path inside the payload, refusing anything that escapes it.
    private func resolve(_ relativePath: String) -> URL? {
        let decoded = relativePath.removingPercentEncoding ?? relativePath
        let candidate = root.appendingPathComponent(decoded).standardizedFileURL
        let base = root.path
        guard candidate.path == base || candidate.path.hasPrefix(base + "/") else { return nil }
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory), isDirectory.boolValue {
            return candidate.appendingPathComponent("index.html")
        }
        return candidate
    }

    private func parseRange(_ header: String, total: Int) -> Range<Int>? {
        guard header.lowercased().hasPrefix("bytes=") else { return nil }
        let spec = header.dropFirst("bytes=".count).split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        guard spec.count == 2 else { return nil }
        if spec[0].isEmpty {
            // bytes=-N — the last N bytes
            guard let tail = Int(spec[1]), tail > 0, total > 0 else { return nil }
            return max(0, total - tail)..<total
        }
        guard let start = Int(spec[0]), start >= 0, start < total else { return nil }
        let endRaw = spec[1].isEmpty ? total - 1 : (Int(spec[1]) ?? total - 1)
        let end = min(endRaw, total - 1)
        guard end >= start else { return nil }
        return start..<(end + 1)
    }

    private func mimeType(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "webmanifest": return "application/manifest+json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "ico": return "image/x-icon"
        case "opus", "ogg": return "audio/ogg"
        case "wav": return "audio/wav"
        case "mp3": return "audio/mpeg"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "txt", "md": return "text/plain; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
