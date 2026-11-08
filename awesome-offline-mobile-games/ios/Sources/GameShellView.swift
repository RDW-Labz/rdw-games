import SwiftUI
import WebKit
import os

struct GameShellView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default()

        // The handler MUST be registered before the WKWebView is created: the view
        // copies the configuration, so anything set afterwards never reaches it and
        // aomg:// requests fail as unsupported URLs — a black screen with no error.
        guard let root = Bundle.main.url(forResource: "web", withExtension: nil) else {
            let webView = WKWebView(frame: .zero, configuration: config)
            webView.isOpaque = false
            webView.backgroundColor = Self.background
            // A missing payload is a packaging bug, not a reason to crash on launch:
            // say so on screen so a TestFlight report is actionable.
            webView.loadHTMLString(Self.missingPayloadHTML, baseURL: nil)
            return webView
        }
        config.setURLSchemeHandler(BundleSchemeHandler(root: root), forURLScheme: BundleSchemeHandler.scheme)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.isOpaque = false
        webView.backgroundColor = Self.background
        webView.scrollView.backgroundColor = Self.background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsBackForwardNavigationGestures = false

        WebViewHost.shared.webView = webView
        webView.load(URLRequest(url: Self.startURL()))
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    /// `-AOMGStartGame <id>` boots straight into a title. The CI simulator check uses
    /// it to prove a game runs without needing to synthesise a tap.
    private static func startURL() -> URL {
        if let id = UserDefaults.standard.string(forKey: "AOMGStartGame"), !id.isEmpty,
           Bundle.main.url(forResource: "index.html", withExtension: nil, subdirectory: "web/games/\(id)") != nil {
            return URL(string: "\(BundleSchemeHandler.scheme)://\(BundleSchemeHandler.host)/games/\(id)/index.html")!
        }
        return BundleSchemeHandler.startURL
    }

    static let background = UIColor(red: 0.039, green: 0.047, blue: 0.067, alpha: 1)

    final class Coordinator: NSObject, WKNavigationDelegate {
        private let log = Logger(subsystem: "com.rdwlabz.awesomeofflinegames", category: "shell")

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            log.notice("loaded \(webView.url?.absoluteString ?? "?", privacy: .public)")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            log.error("load failed: \(error.localizedDescription, privacy: .public)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            log.error("provisional load failed: \(error.localizedDescription, privacy: .public) — \(webView.url?.absoluteString ?? "?", privacy: .public)")
        }

        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            log.error("web content process terminated — reloading")
            webView.reload()
        }

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
            if url.scheme == BundleSchemeHandler.scheme { return decisionHandler(.allow) }
            // Outbound links (upstream repos, licence texts) belong in Safari, not
            // inside a shell that has no back button.
            if navigationAction.navigationType == .linkActivated,
               let scheme = url.scheme, ["http", "https", "mailto"].contains(scheme) {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }
    }

    private static let missingPayloadHTML = """
    <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0a0c11;
    color:#e8ecf1;font:16px/1.5 -apple-system,sans-serif;text-align:center;padding:24px}</style>
    <p><b>The game payload is missing.</b><br>This build was packaged without ios/web —
    rebuild with <code>npm run build &amp;&amp; node tools/stage-ios.mjs</code>.</p>
    """
}
