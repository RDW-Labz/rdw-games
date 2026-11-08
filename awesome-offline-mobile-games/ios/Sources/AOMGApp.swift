import SwiftUI

/* The whole collection is a web tree, so the app is one full-bleed WKWebView.
 * Full-bleed on purpose: the pages use viewport-fit=cover and pad themselves with
 * CSS env(safe-area-inset-*), so letting SwiftUI inset the view twice would leave
 * a dead band under the notch.
 */
@main
struct AOMGApp: App {
    var body: some Scene {
        WindowGroup {
            GameShellView()
                .ignoresSafeArea(.all)
                .preferredColorScheme(.dark)
                // aomg://app/games/<id>/index.html opens that title directly
                .onOpenURL { WebViewHost.shared.open($0) }
        }
    }
}
