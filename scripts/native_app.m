#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#include <unistd.h>

@interface WordPaperApp : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate>
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) WKWebView *web;
@property(nonatomic, strong) NSTask *service;
@property(nonatomic, strong) NSTimer *startupTimer;
@property(nonatomic, strong) NSURL *origin;
@property(nonatomic, copy) NSString *readyFile;
@property(nonatomic, copy) NSString *pendingPath;
@property BOOL ownsService;
@property BOOL terminating;
@end

@implementation WordPaperApp
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSMenu *menu = [NSMenu new];
    NSMenuItem *appItem = [NSMenuItem new];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"WordPaper"];
    [appMenu addItemWithTitle:@"关于 WordPaper" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"隐藏 WordPaper" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItemWithTitle:@"退出 WordPaper" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu; [menu addItem:appItem];
    NSMenuItem *editItem = [NSMenuItem new];
    NSMenu *edit = [[NSMenu alloc] initWithTitle:@"编辑"];
    [edit addItemWithTitle:@"撤销" action:@selector(undo:) keyEquivalent:@"z"];
    [edit addItemWithTitle:@"剪切" action:@selector(cut:) keyEquivalent:@"x"];
    [edit addItemWithTitle:@"拷贝" action:@selector(copy:) keyEquivalent:@"c"];
    [edit addItemWithTitle:@"粘贴" action:@selector(paste:) keyEquivalent:@"v"];
    [edit addItemWithTitle:@"全选" action:@selector(selectAll:) keyEquivalent:@"a"];
    editItem.submenu = edit; [menu addItem:editItem];
    NSMenuItem *viewItem = [NSMenuItem new];
    NSMenu *view = [[NSMenu alloc] initWithTitle:@"窗口"];
    NSMenuItem *reload = [view addItemWithTitle:@"重新载入" action:@selector(reload:) keyEquivalent:@"r"]; reload.target = self;
    NSMenuItem *show = [view addItemWithTitle:@"显示 WordPaper" action:@selector(showWindow:) keyEquivalent:@"0"]; show.target = self;
    viewItem.submenu = view; [menu addItem:viewItem];
    NSApp.mainMenu = menu;

    self.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1280, 860)
        styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
        backing:NSBackingStoreBuffered defer:NO];
    self.window.title = @"WordPaper"; self.window.minSize = NSMakeSize(860, 620);
    self.window.releasedWhenClosed = NO;
    if (![self navigationTestEnabled]) [self.window setFrameAutosaveName:@"WordPaperWorkspace"];
    [self.window center];
    WKWebViewConfiguration *config = [WKWebViewConfiguration new];
    if ([self navigationTestEnabled]) {
        config.websiteDataStore = WKWebsiteDataStore.nonPersistentDataStore;
        [config.userContentController addScriptMessageHandler:self name:@"nativeTest"];
    }
    [config.userContentController addScriptMessageHandler:self name:@"external"];
    NSString *bridge = @"window.WordPaperDesktop=Object.freeze({openExternal:function(url){window.webkit.messageHandlers.external.postMessage(String(url));}});";
    [config.userContentController addUserScript:[[WKUserScript alloc] initWithSource:bridge injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
    self.web = [[WKWebView alloc] initWithFrame:self.window.contentView.bounds configuration:config];
    self.web.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    self.web.navigationDelegate = self; self.web.UIDelegate = self;
    [self.window.contentView addSubview:self.web];
    [self showWindow:nil];
    [self.web loadHTMLString:@"<html lang='zh-CN'><body style='font:18px -apple-system;padding:70px;color:#17503F'><h1>WordPaper</h1><p>正在打开你的工作区…</p></body></html>" baseURL:nil];

    NSDictionary *env = NSProcessInfo.processInfo.environment;
    // Isolated native UI tests can supply a loopback server, without starting a
    // companion or changing the user's actual wallpaper/data directory.
    NSURL *testURL = [NSURL URLWithString:env[@"WORDPAPER_NATIVE_TEST_URL"] ?: @""];
    if ([env[@"NODE_ENV"] isEqual:@"test"] && [self isLoopback:testURL]) { [self loadOrigin:testURL]; return; }
    self.readyFile = [NSTemporaryDirectory() stringByAppendingPathComponent:[NSString stringWithFormat:@"wordpaper-ready-%@.json", NSUUID.UUID.UUIDString]];
    self.service = [NSTask new];
    self.service.executableURL = [NSURL fileURLWithPath:@"/bin/bash"];
    self.service.arguments = @[[NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"Contents/MacOS/launcher.sh"]];
    NSMutableDictionary *childEnv = [env mutableCopy];
    childEnv[@"WORDPAPER_NATIVE_UI"] = @"1";
    childEnv[@"WORDPAPER_COMPANION_SILENT"] = @"1";
    childEnv[@"WORDPAPER_NATIVE_READY_FILE"] = self.readyFile;
    self.service.environment = childEnv;
    self.service.standardOutput = NSFileHandle.fileHandleWithNullDevice;
    self.service.standardError = NSFileHandle.fileHandleWithNullDevice;
    __weak WordPaperApp *weakSelf = self;
    self.service.terminationHandler = ^(NSTask *task) {
        dispatch_async(dispatch_get_main_queue(), ^{
            WordPaperApp *app = weakSelf;
            if (app.terminating) return;
            if (app.ownsService) [NSApp terminate:nil];
            else if (!app.origin && task.terminationStatus != 0) [app showStartupError];
        });
    };
    NSError *error;
    if (![self.service launchAndReturnError:&error]) { [self showStartupError]; return; }
    self.startupTimer = [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
        WordPaperApp *app = weakSelf;
        NSData *data = [NSData dataWithContentsOfFile:app.readyFile];
        if (!data) return;
        NSDictionary *ready = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        NSURL *url = [NSURL URLWithString:ready[@"url"] ?: @""];
        if (![app isLoopback:url]) return;
        app.ownsService = [ready[@"owned"] boolValue];
        [timer invalidate]; [app loadOrigin:url];
    }];
}
- (BOOL)isLoopback:(NSURL *)url {
    return [url.scheme isEqual:@"http"] && [@[@"localhost", @"127.0.0.1", @"::1"] containsObject:url.host] && url.port != nil && !url.user && !url.password;
}
- (BOOL)isWorkspace:(NSURL *)url {
    return self.origin && [url.scheme isEqual:self.origin.scheme] && [url.host isEqual:self.origin.host] && [url.port isEqual:self.origin.port];
}
// Loopback aliases identify the same local service, but WebKit cookies and
// storage still belong to the original origin. Rewrite before loading rather
// than relaxing isWorkspace, which also protects the privileged JS bridge.
- (NSURL *)canonicalWorkspaceURL:(NSURL *)url {
    if (![self isLoopback:self.origin] || ![self isLoopback:url] || ![url.port isEqual:self.origin.port]) return nil;
    NSURLComponents *parts = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:YES];
    parts.scheme = self.origin.scheme; parts.host = self.origin.host; parts.port = self.origin.port;
    return parts.URL;
}
- (void)loadOrigin:(NSURL *)url {
    self.origin = url;
    NSString *path = self.pendingPath ?: @"/";
    [self.web loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:path relativeToURL:url]]];
    self.pendingPath = nil;
}
- (void)showStartupError {
    [self.startupTimer invalidate];
    [self.web loadHTMLString:@"<html lang='zh-CN'><body style='font:17px -apple-system;padding:70px'><h1>WordPaper 暂时没有启动</h1><p>请退出 App 后重试。日志位于 ~/Library/Logs/wordpaper/server.log。</p></body></html>" baseURL:nil];
}
- (void)showWindow:(id)sender { [self.window makeKeyAndOrderFront:nil]; [NSApp activateIgnoringOtherApps:YES]; }
- (void)reload:(id)sender { if (self.origin) [self.web reload]; }
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)visible { [self showWindow:nil]; return YES; }
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return NO; }
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender {
    self.terminating = YES;
    if (!self.service.running) return NSTerminateNow;
    [self.service terminate];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ [NSApp replyToApplicationShouldTerminate:YES]; });
    return NSTerminateLater;
}
- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.startupTimer invalidate];
    if (self.readyFile) [NSFileManager.defaultManager removeItemAtPath:self.readyFile error:nil];
}
- (void)application:(NSApplication *)application openURLs:(NSArray<NSURL *> *)urls {
    for (NSURL *url in urls) {
        if (![url.scheme isEqual:@"wordpaper"] || ![url.host isEqual:@"open"]) continue;
        NSString *path = @"/";
        for (NSURLQueryItem *item in [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO].queryItems) if ([item.name isEqual:@"path"]) path = item.value ?: @"/";
        if (![path hasPrefix:@"/"] || [path hasPrefix:@"//"] || [path containsString:@"\\"]) continue;
        // The custom scheme carries only UI destinations, never auth tokens.
        NSURL *target = [NSURL URLWithString:path relativeToURL:self.origin];
        if (self.origin && [self isWorkspace:target.absoluteURL]) [self.web loadRequest:[NSURLRequest requestWithURL:target]];
        else self.pendingPath = path;
        [self showWindow:nil];
    }
}
- (void)openExternal:(NSURL *)url {
    NSURL *workspace = [self canonicalWorkspaceURL:url];
    if (workspace) {
        [self.web loadRequest:[NSURLRequest requestWithURL:workspace]]; [self showWindow:nil]; return;
    }
    if ([url.scheme isEqual:@"https"] || [url.scheme isEqual:@"mailto"] || [self isLoopback:url]) {
        if ([self navigationTestEnabled]) { [self recordNavigationTestEvent:@"external" URL:url]; return; }
        [NSWorkspace.sharedWorkspace openURL:url];
    }
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    if (!message.frameInfo.mainFrame || ![self isWorkspace:message.frameInfo.request.URL] || ![message.body isKindOfClass:NSString.class]) return;
    if ([message.name isEqual:@"nativeTest"] && [self navigationTestEnabled]) {
        if ([message.body isEqual:@"hide"]) { [self.window orderOut:nil]; [self recordNavigationTestEvent:@"hidden" URL:self.web.URL]; }
        return;
    }
    [self openExternal:[NSURL URLWithString:message.body]];
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decision {
    NSURL *url = action.request.URL;
    NSURL *workspace = [self canonicalWorkspaceURL:url];
    if (workspace && ![self isWorkspace:url]) {
        NSMutableURLRequest *request = [action.request mutableCopy]; request.URL = workspace;
        decision(WKNavigationActionPolicyCancel);
        if (action.shouldPerformDownload) {
            [webView startDownloadUsingRequest:request completionHandler:^(WKDownload *download) { download.delegate = self; }];
        } else { [webView loadRequest:request]; [self showWindow:nil]; }
        return;
    }
    if (action.shouldPerformDownload && ([self isWorkspace:url] || [url.scheme isEqual:@"blob"] || [url.scheme isEqual:@"data"])) { decision(WKNavigationActionPolicyDownload); return; }
    if ([self isWorkspace:url] || [url.scheme isEqual:@"about"]) { decision(WKNavigationActionPolicyAllow); return; }
    [self openExternal:url]; decision(WKNavigationActionPolicyCancel);
}
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    NSURL *workspace = [self canonicalWorkspaceURL:action.request.URL];
    if (workspace) {
        NSMutableURLRequest *request = [action.request mutableCopy]; request.URL = workspace;
        [webView loadRequest:request]; [self showWindow:nil];
    } else [self openExternal:action.request.URL];
    return nil;
}
- (void)webView:(WKWebView *)webView runJavaScriptConfirmPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(BOOL))completion {
    NSAlert *alert = [NSAlert new]; alert.messageText = @"WordPaper"; alert.informativeText = message;
    [alert addButtonWithTitle:@"确认"]; [alert addButtonWithTitle:@"取消"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) { completion(response == NSAlertFirstButtonReturn); }];
}
- (void)webView:(WKWebView *)webView runJavaScriptAlertPanelWithMessage:(NSString *)message initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(void))completion {
    NSAlert *alert = [NSAlert new]; alert.messageText = @"WordPaper"; alert.informativeText = message;
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) { completion(); }];
}
- (void)webView:(WKWebView *)webView runJavaScriptTextInputPanelWithPrompt:(NSString *)prompt defaultText:(NSString *)text initiatedByFrame:(WKFrameInfo *)frame completionHandler:(void (^)(NSString *))completion {
    NSAlert *alert = [NSAlert new]; alert.messageText = @"WordPaper"; alert.informativeText = prompt;
    NSTextField *input = [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 280, 24)]; input.stringValue = text ?: @""; alert.accessoryView = input;
    [alert addButtonWithTitle:@"确认"]; [alert addButtonWithTitle:@"取消"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) { completion(response == NSAlertFirstButtonReturn ? input.stringValue : nil); }];
}
- (void)webView:(WKWebView *)webView navigationAction:(WKNavigationAction *)action didBecomeDownload:(WKDownload *)download { download.delegate = self; }
- (void)download:(WKDownload *)download decideDestinationUsingResponse:(NSURLResponse *)response suggestedFilename:(NSString *)name completionHandler:(void (^)(NSURL *))completion {
    NSSavePanel *panel = NSSavePanel.savePanel; panel.nameFieldStringValue = name;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) { completion(result == NSModalResponseOK ? panel.URL : nil); }];
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView { [webView reload]; }
// Only the isolated navigation test enables this recorder. External dispatch
// is captured before NSWorkspace so regression tests never open a browser.
- (BOOL)navigationTestEnabled {
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    return [env[@"NODE_ENV"] isEqual:@"test"] && [env[@"WORDPAPER_NATIVE_NAVIGATION_REPORT"] length] > 0;
}
- (void)recordNavigationTestEvent:(NSString *)event URL:(NSURL *)url {
    if (![self navigationTestEnabled]) return;
    NSString *report = NSProcessInfo.processInfo.environment[@"WORDPAPER_NATIVE_NAVIGATION_REPORT"];
    NSDictionary *state = @{@"event": event, @"url": url.absoluteString ?: @"", @"workspaceURL": self.web.URL.absoluteString ?: @"",
        @"visible": @(self.window.visible), @"windowNumber": @(self.window.windowNumber), @"pid": @(getpid())};
    NSMutableData *line = [[NSJSONSerialization dataWithJSONObject:state options:0 error:nil] mutableCopy];
    [line appendData:[@"\n" dataUsingEncoding:NSUTF8StringEncoding]];
    if (![NSFileManager.defaultManager fileExistsAtPath:report]) [NSFileManager.defaultManager createFileAtPath:report contents:nil attributes:nil];
    NSFileHandle *file = [NSFileHandle fileHandleForWritingAtPath:report];
    [file seekToEndOfFile]; [file writeData:line]; [file closeFile];
}
- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if ([self isWorkspace:webView.URL]) [self recordNavigationTestEvent:@"loaded" URL:webView.URL];
    NSDictionary *env = NSProcessInfo.processInfo.environment;
    NSString *report = env[@"WORDPAPER_NATIVE_TEST_REPORT"];
    if (![env[@"NODE_ENV"] isEqual:@"test"] || !report || ![self isWorkspace:webView.URL]) return;
    [webView evaluateJavaScript:@"({title:document.title,bridge:!!window.WordPaperDesktop,cloudLogin:!!document.querySelector('#desktop-sync'),native:true})" completionHandler:^(id result, NSError *error) {
        if (!error && result) {
            NSMutableDictionary *state = [result mutableCopy];
            state[@"visible"] = @(self.window.visible);
            [[NSJSONSerialization dataWithJSONObject:state options:0 error:nil] writeToFile:report atomically:YES];
            if ([env[@"WORDPAPER_NATIVE_TEST_EXIT"] isEqual:@"1"]) [NSApp terminate:nil];
        }
    }];
}
@end

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        // Keep command-line runtime/package self-tests free of GUI processes.
        if (getenv("WORDPAPER_SELFTEST") && strcmp(getenv("WORDPAPER_SELFTEST"), "1") == 0) {
            NSString *script = [NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"Contents/MacOS/launcher.sh"];
            execl("/bin/bash", "bash", script.fileSystemRepresentation, (char *)NULL);
            return 1;
        }
        NSApplication *app = NSApplication.sharedApplication;
        WordPaperApp *delegate = [WordPaperApp new]; app.delegate = delegate;
        [app run];
    }
    return 0;
}
