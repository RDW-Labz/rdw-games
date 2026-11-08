// Serves one page over a custom "tauri" scheme with a Content-Security-Policy
// header (as Tauri 2 does on macOS), loads a real captured PNG as a blob: URL
// and as a data: URL via <img>.onload and via img.decode() (the orb path).
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
static NSString *gCsp, *gHtml;
@interface Scheme : NSObject <WKURLSchemeHandler> @end
@implementation Scheme
- (void)webView:(WKWebView *)w startURLSchemeTask:(id<WKURLSchemeTask>)t {
  NSHTTPURLResponse *r = [[NSHTTPURLResponse alloc] initWithURL:t.request.URL statusCode:200 HTTPVersion:@"HTTP/1.1"
    headerFields:@{@"Content-Type": @"text/html", @"Content-Security-Policy": gCsp}];
  [t didReceiveResponse:r]; [t didReceiveData:[gHtml dataUsingEncoding:NSUTF8StringEncoding]]; [t didFinish];
}
- (void)webView:(WKWebView *)w stopURLSchemeTask:(id<WKURLSchemeTask>)t {}
@end
@interface Done : NSObject <WKScriptMessageHandler> @end
@implementation Done
- (void)userContentController:(WKUserContentController *)u didReceiveScriptMessage:(WKScriptMessage *)m { printf("%s\n", [[m.body description] UTF8String]); exit(0); }
@end
int main(int argc, char **argv) { @autoreleasepool {
  gCsp = [NSString stringWithUTF8String:argv[1]];
  NSString *b64 = [[NSData dataWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]] base64EncodedStringWithOptions:0];
  NSString *tpl = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[3]] encoding:NSUTF8StringEncoding error:nil];
  gHtml = [tpl stringByReplacingOccurrencesOfString:@"__B64__" withString:b64];
  [NSApplication sharedApplication];
  WKWebViewConfiguration *cfg = [WKWebViewConfiguration new];
  [cfg setURLSchemeHandler:[Scheme new] forURLScheme:@"tauri"];
  [cfg.userContentController addScriptMessageHandler:[Done new] name:@"done"];
  WKWebView *web = [[WKWebView alloc] initWithFrame:NSMakeRect(0,0,10,10) configuration:cfg];
  [web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:@"tauri://localhost/index.html"]]];
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 15*NSEC_PER_SEC), dispatch_get_main_queue(), ^{ printf("timeout\n"); exit(2); });
  [NSApp run];
} return 0; }
