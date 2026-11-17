import Foundation
import WebKit

/* The app owns exactly one web view. This is the hand-off for deep links
 * (aomg://app/games/<id>/index.html) so a link — or the CI simulator check — can
 * drop straight into a title instead of the launcher.
 */
final class WebViewHost {
    static let shared = WebViewHost()

    weak var webView: WKWebView?

    func open(_ url: URL) {
        guard url.scheme == BundleSchemeHandler.scheme else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.load(URLRequest(url: url))
        }
    }
}
