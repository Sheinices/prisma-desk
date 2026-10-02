// Prisma Desktop — Copyright (C) 2026 Sheinices
// SPDX-License-Identifier: AGPL-3.0-only
// Runs an isolated, silent WKWebView test against the real Rust decoder.
import AppKit
import WebKit
import Foundation
import Darwin

let arguments = CommandLine.arguments
guard arguments.count == 4 else { fatalError("Usage: swift verify-media-webkit.swift SERVER FFMPEG FFPROBE") }
let backend = Process()
backend.executableURL = URL(fileURLWithPath: arguments[1])
backend.arguments = Array(arguments[2...3])
let output = Pipe()
backend.standardOutput = output
try backend.run()
var line = Data()
while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
    if byte[0] == 10 { break }
    line.append(byte)
}
let origin = String(data: line, encoding: .utf8)!
guard let page = URL(string: origin), page.scheme == "http" else { fatalError("Backend did not start: \(origin)") }

var finishing = false
func finish(_ result: Any, code: Int32) -> Never {
    if finishing { exit(code) }
    finishing = true
    if let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]), let json = String(data: data, encoding: .utf8) { print(json) }
    let completed = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: URL(string: "\(origin)/shutdown")!) { _, _, _ in completed.signal() }.resume()
    if completed.wait(timeout: .now() + 5) == .timedOut && backend.isRunning { backend.terminate() }
    if backend.isRunning {
        backend.terminate()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if backend.isRunning { kill(backend.processIdentifier, SIGKILL) }
        }
        backend.waitUntilExit()
    }
    exit(code)
}
class ResultHandler: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let result = message.body as? [String: Any] ?? [:]
        finish(result, code: result["ok"] as? Bool == true ? 0 : 1)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(["ok": false, "error": error.localizedDescription], code: 1)
    }
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.mediaTypesRequiringUserActionForPlayback = []
let handler = ResultHandler()
config.userContentController.add(handler, name: "testResult")
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240), configuration: config)
webView.navigationDelegate = handler
let window = NSWindow(contentRect: webView.frame, styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Prisma — проверка видео"
window.alphaValue = 1
window.contentView = webView
window.makeKeyAndOrderFront(nil)
application.activate(ignoringOtherApps: true)
webView.load(URLRequest(url: page))
DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
    webView.evaluateJavaScript("JSON.stringify({time:video?.currentTime,paused:video?.paused,ready:video?.readyState,error:video?.error?.code,calls:calls.slice(-8),notifications,results,subtitleText})") { result, _ in
        finish(["ok": false, "error": "WKWebView test timed out", "diagnostics": result ?? "unavailable"], code: 1)
    }
}
application.run()
