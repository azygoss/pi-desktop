import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// App resolution, listing, permissions and post-action settling.

struct ResolvedApp {
    let name: String
    let bundleId: String
    let pid: pid_t
    let element: AXUIElement
}

func checkPermissions(prompt: Bool) -> [String: Any] {
    let ax: Bool
    if prompt {
        ax = AXIsProcessTrustedWithOptions(
            [kAXTrustedCheckOptionPrompt.takeRetainedValue(): true] as CFDictionary)
    } else {
        ax = AXIsProcessTrusted()
    }
    let screen: Bool
    if prompt {
        screen = CGRequestScreenCaptureAccess()
    } else {
        screen = CGPreflightScreenCaptureAccess()
    }
    return ["accessibility": ax, "screenRecording": screen]
}

/// Window titles of a pid via CGWindowList — needs no AX trust and works
/// even before the permission prompt is granted.
func windowTitles(pid: pid_t) -> [String] {
    guard
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID)
            as? [[String: Any]]
    else {
        return []
    }
    var titles: [String] = []
    for entry in list {
        guard
            (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
            (entry[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
            let name = entry[kCGWindowName as String] as? String, !name.isEmpty
        else {
            continue
        }
        titles.append(name)
    }
    return titles
}

private var installedAppsCache: (at: Date, apps: [[String: Any]])?

/// Non-running apps from /Applications and /System/Applications, top level
/// .app bundles only. Cached for 60s — folder scans are cheap but not free.
func installedApps(exclude: Set<String>) -> [[String: Any]] {
    if let cache = installedAppsCache, Date().timeIntervalSince(cache.at) < 60 {
        return cache.apps
    }
    let fm = FileManager.default
    var apps: [[String: Any]] = []
    for dir in ["/Applications", "/System/Applications"] {
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else {
            continue
        }
        for entry in entries where entry.hasSuffix(".app") {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(entry)
            guard let bundle = Bundle(url: url) else {
                continue
            }
            let bundleId = bundle.bundleIdentifier ?? ""
            if exclude.contains(bundleId) {
                continue
            }
            let name =
                (bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                ?? (bundle.object(forInfoDictionaryKey: "CFBundleName") as? String)
                ?? String(entry.dropLast(4))
            apps.append([
                "name": name,
                "bundleId": bundleId,
                "running": false,
                "windows": [String]()
            ])
        }
    }
    apps.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    if apps.count > 150 {
        apps = Array(apps.prefix(150))
    }
    installedAppsCache = (Date(), apps)
    return apps
}

func listApps(exclude: Set<String>) -> [[String: Any]] {
    var result: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications {
        guard app.activationPolicy == .regular else {
            continue
        }
        let bundleId = app.bundleIdentifier ?? ""
        if exclude.contains(bundleId) {
            continue
        }
        result.append([
            "name": app.localizedName ?? bundleId,
            "bundleId": bundleId,
            "running": true,
            "windows": windowTitles(pid: app.processIdentifier),
            "pid": app.processIdentifier
        ])
    }
    return result + installedApps(exclude: exclude)
}

/// Display-name match is case-insensitive against localizedName, the bundle
/// name and the bundle id (exact for ids).
func findRunningApp(_ query: String, exclude: Set<String>) -> NSRunningApplication? {
    let lower = query.lowercased()
    let candidates = NSWorkspace.shared.runningApplications.filter {
        $0.activationPolicy == .regular && !($0.bundleIdentifier.map(exclude.contains) ?? false)
    }
    if let exact = candidates.first(where: { $0.bundleIdentifier == query }) {
        return exact
    }
    return candidates.first {
        $0.localizedName?.lowercased() == lower
            || Bundle(url: $0.bundleURL ?? URL(fileURLWithPath: "/"))?
            .object(forInfoDictionaryKey: "CFBundleName") as? String == query
    }
}

func appUrlFor(_ query: String) -> URL? {
    if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: query) {
        return url
    }
    let lower = query.lowercased()
    for dir in ["/Applications", "/System/Applications", "/System/Applications/Utilities"] {
        guard
            let entries = try? FileManager.default.contentsOfDirectory(atPath: dir)
        else {
            continue
        }
        for entry in entries where entry.hasSuffix(".app") {
            let stem = String(entry.dropLast(4))
            if stem.lowercased() == lower {
                return URL(fileURLWithPath: dir).appendingPathComponent(entry)
            }
        }
    }
    return nil
}

/// First pid whose executable lives under the given .app bundle — via
/// `pgrep -f`, which reads the kernel process table directly and therefore
/// sees launches NSWorkspace hasn't reported to this process yet.
func pidForBundlePath(_ bundlePath: String) -> pid_t? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    p.arguments = ["-f", "\(bundlePath)/Contents/MacOS/"]
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = FileHandle.nullDevice
    guard let _ = try? p.run() else {
        return nil
    }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    guard
        let first = String(data: data, encoding: .utf8)?
            .split(separator: "\n").first,
        let pid = Int32(first.trimmingCharacters(in: .whitespaces))
    else {
        return nil
    }
    return pid
}

/// Enable AX reporting for Chromium/Electron apps — cheap on others.
func enableRichAccessibility(_ appElement: AXUIElement) {
    _ = AXUIElementSetAttributeValue(
        appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(
        appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

func runningAppNames(exclude: Set<String>) -> String {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular && !($0.bundleIdentifier.map(exclude.contains) ?? false) }
        .compactMap { $0.localizedName }
        .sorted()
        .joined(separator: ", ")
}

private var resolveCache: [String: (at: Date, resolved: ResolvedApp)] = [:]

/// Resolve an app query to a running AX application, launching it first when
/// needed. Resolved apps are cached by query for 2s so back-to-back calls
/// skip the app-list scan/pgrep; a dead pid invalidates the entry.
func resolveApp(_ query: String, exclude: Set<String>) throws -> ResolvedApp {
    let cacheKey = query.lowercased() + "|" + exclude.sorted().joined(separator: ",")
    if let entry = resolveCache[cacheKey],
        Date().timeIntervalSince(entry.at) < 2,
        kill(entry.resolved.pid, 0) == 0
    {
        return entry.resolved
    }
    let resolved = try resolveAppUncached(query, exclude: exclude)
    resolveCache[cacheKey] = (Date(), resolved)
    return resolved
}

private func resolveAppUncached(_ query: String, exclude: Set<String>) throws -> ResolvedApp {
    let app = findRunningApp(query, exclude: exclude)
    if app == nil {
        guard let url = appUrlFor(query) else {
            throw HelperError(
                message: "app not found: \(query) (running apps: \(runningAppNames(exclude: exclude)))"
            )
        }
        // Launch via /usr/bin/open (non-activating). Detect the new process
        // with pgrep: NSWorkspace.runningApplications is only as fresh as
        // this process's workspace notifications, which do not reliably
        // arrive for apps launched from a non-app command-line tool.
        let opener = Process()
        opener.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        opener.arguments = ["-g", url.path]
        try? opener.run()
        let bundle = Bundle(url: url)
        let bundleId = bundle?.bundleIdentifier ?? ""
        let name =
            (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
            ?? url.deletingPathExtension().lastPathComponent
        // Cold launches (Gatekeeper/dyld) can exceed 5s; 10s keeps the
        // common case fast without giving up on slow first runs.
        let deadline = Date().addingTimeInterval(10)
        var pid: pid_t?
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            if let found = pidForBundlePath(url.path) {
                pid = found
                break
            }
            // NSWorkspace may still catch up — prefer it when it does.
            if let running = findRunningApp(query, exclude: exclude) {
                pid = running.processIdentifier
                break
            }
        }
        guard let pid else {
            throw HelperError(
                message: "app not running after launch: \(query) (running apps: \(runningAppNames(exclude: exclude)))"
            )
        }
        let element = AXUIElementCreateApplication(pid)
        enableRichAccessibility(element)
        // A fresh launch may take a moment to put up its first window; give
        // it the remainder of the deadline, but a windowless app is still
        // a valid result (window comes back null).
        while axChildren(element, kAXWindowsAttribute).isEmpty, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        return ResolvedApp(name: name, bundleId: bundleId, pid: pid, element: element)
    }
    guard let app else {
        throw HelperError(
            message: "app not running after launch: \(query) (running apps: \(runningAppNames(exclude: exclude)))"
        )
    }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    enableRichAccessibility(element)
    return ResolvedApp(
        name: app.localizedName ?? query,
        bundleId: app.bundleIdentifier ?? "",
        pid: app.processIdentifier,
        element: element
    )
}

func appElement(_ app: NSRunningApplication) -> AXUIElement? {
    AXUIElementCreateApplication(app.processIdentifier)
}

/// The window the user is most likely interacting with: focused, then main,
/// then the first window.
func frontWindow(_ appElement: AXUIElement) -> AXUIElement? {
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if let window = axAttr(appElement, attr) {
            // Safe cast: the attribute returns an AXUIElement.
            if CFGetTypeID(window) == AXUIElementGetTypeID() {
                return (window as! AXUIElement)
            }
        }
    }
    return axChildren(appElement, kAXWindowsAttribute).first
}

func windowFrame(_ window: AXUIElement) -> CGRect? {
    guard
        let posValue = axAttr(window, kAXPositionAttribute),
        let sizeValue = axAttr(window, kAXSizeAttribute),
        CFGetTypeID(posValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else {
        return nil
    }
    var pos = CGPoint.zero
    var size = CGSize.zero
    guard
        AXValueGetValue(posValue as! AXValue, .cgPoint, &pos),
        AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(origin: pos, size: size)
}

/// Frontmost app pid via the system-wide AX element — fresh and callable
/// from any thread, unlike NSWorkspace.frontmostApplication.
func frontmostPid() -> pid_t? {
    let systemWide = AXUIElementCreateSystemWide()
    guard
        let focused = axAttr(systemWide, kAXFocusedApplicationAttribute),
        CFGetTypeID(focused) == AXUIElementGetTypeID()
    else {
        return nil
    }
    var pid: pid_t = 0
    guard AXUIElementGetPid(focused as! AXUIElement, &pid) == .success else {
        return nil
    }
    return pid
}

/// Debug timing for activation phases; logs go to stderr (stdout is protocol).
private let debugTiming = ProcessInfo.processInfo.environment["PI_CUA_DEBUG"] != nil
private func debugLog(_ message: String) {
    if debugTiming {
        FileHandle.standardError.write("cua: \(message)\n".data(using: .utf8)!)
    }
}

/// activate() does a blocking LaunchServices round-trip (~1s on the first
/// call per process) — never run it on the command queue.
func dispatchActivate(_ running: NSRunningApplication) {
    DispatchQueue.global().async {
        running.activate(options: [])
    }
}

/// Activate the app and raise its window so posted CGEvents land. No-op when
/// the app is already frontmost; waits up to 200ms for the switch.
func activateApp(_ resolved: ResolvedApp, window: AXUIElement?) {
    var t = Date()
    if frontmostPid() == resolved.pid {
        return
    }
    debugLog("activate: initial frontmostPid \(Int(-t.timeIntervalSinceNow * 1000))ms")
    if let running = NSRunningApplication(processIdentifier: resolved.pid) {
        t = Date()
        dispatchActivate(running)
        debugLog("activate: activate() dispatch \(Int(-t.timeIntervalSinceNow * 1000))ms")
    }
    if let window {
        t = Date()
        _ = AXUIElementPerformAction(window, "AXRaise" as CFString)
        debugLog("activate: AXRaise \(Int(-t.timeIntervalSinceNow * 1000))ms")
    }
    let deadline = Date().addingTimeInterval(0.2)
    while Date() < deadline {
        if frontmostPid() == resolved.pid {
            debugLog("activate: frontmost after \(Int(-t.timeIntervalSinceNow * 1000))ms")
            return
        }
        Thread.sleep(forTimeInterval: 0.02)
    }
    debugLog("activate: timed out at 200ms")
}
