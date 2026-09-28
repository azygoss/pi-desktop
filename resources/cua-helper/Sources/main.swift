import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// pi-desktop-cua: computer-use helper. JSONL over stdin/stdout, all AX work
// on the main thread. See the repo's resources/cua-helper/README.md (and the
// main-process CuaService) for the protocol.

let store = SnapshotStore()
var lastActionAt = [pid_t: Date]()

func excludedBundleIds(_ args: [String: Any]) -> Set<String> {
    var ids = Set<String>()
    if let one = argString(args, "excludeBundleId") {
        ids.insert(one)
    }
    if let many = args["excludeBundleIds"] as? [String] {
        ids.formUnion(many)
    }
    return ids
}

func requireApp(_ args: [String: Any]) throws -> ResolvedApp {
    guard let query = argString(args, "app"), !query.isEmpty else {
        throw HelperError(message: "missing required arg: app")
    }
    let resolved = try resolveApp(query, exclude: excludedBundleIds(args))
    return resolved
}

func requireElement(
    _ args: [String: Any], _ resolved: ResolvedApp
) throws -> (element: AXUIElement, staleId: Bool) {
    guard let id = argInt(args, "element") else {
        throw HelperError(message: "missing required arg: element")
    }
    guard let found = store.element(pid: resolved.pid, id: id) else {
        throw HelperError(
            message:
                "element \(id) not found in latest state of \(resolved.name) — call computer_state again"
        )
    }
    return found
}

func elementSummary(_ element: AXUIElement) -> [String: Any] {
    let info = fetchInfo(element)
    var summary: [String: Any] = ["role": shortRoleName(info.role)]
    if let label = info.title ?? info.desc ?? info.placeholder {
        summary["label"] = label
    }
    return summary
}

/// Children of the app element that float outside window frames — open
/// menus, popovers, sheets (the menu bar is intentionally skipped: huge).
func floatingChildren(_ appElement: AXUIElement) -> [AXUIElement] {
    axChildren(appElement).filter {
        if let role = axAttr($0, kAXRoleAttribute) as? String {
            return role == "AXMenu" || role == "AXPopover" || role == "AXSheet"
        }
        return false
    }
}

/// Keep matching lines plus their ancestors (lines with smaller indentation
/// above each match). `comparable` lines carry their indent as leading
/// spaces.
func filterByQuery(_ query: String, lines: [String], comparable: [String]) -> [String] {
    let needle = query.lowercased()
    var keep = Array(repeating: false, count: comparable.count)
    // Track the most recent line index per indent level: a match keeps all
    // shallower ancestors on the path to the root.
    var stack: [(indent: Int, index: Int)] = []
    for (i, line) in comparable.enumerated() {
        let indent = line.prefix(while: { $0 == " " }).count
        while let top = stack.last, top.indent >= indent {
            stack.removeLast()
        }
        stack.append((indent, i))
        if line.lowercased().contains(needle) {
            keep[i] = true
            for entry in stack.dropLast() {
                keep[entry.index] = true
            }
        }
    }
    return lines.enumerated().compactMap { keep[$0.offset] ? $0.element : nil }
}

func doAppState(_ args: [String: Any]) throws -> [String: Any] {
    let resolved = try requireApp(args)
    let window = frontWindow(resolved.element)
    var windowInfo: [String: Any]?
    var snapshot = Snapshot()
    var frame = CGRect.zero
    var windowTitle = ""

    if let window {
        frame = windowFrame(window) ?? .zero
        windowTitle = (axAttr(window, kAXTitleAttribute) as? String) ?? ""
        walk(window, into: &snapshot, depth: 0, windowFrame: frame)
        windowInfo = [
            "title": windowTitle,
            "x": Int(frame.origin.x), "y": Int(frame.origin.y),
            "width": Int(frame.width), "height": Int(frame.height)
        ]
    }
    // No window (fresh launch / minimized): floating children below still
    // capture open menus and sheets; window stays null in the result.
    for floating in floatingChildren(resolved.element) {
        walk(floating, into: &snapshot, depth: 0, windowFrame: frame)
    }
    if snapshot.nodeCount >= maxNodes {
        snapshot.lines.append("… truncated \(snapshot.skippedCount) more elements")
    }

    store.rotate(pid: resolved.pid, elements: snapshot.elements)

    let key = "\(resolved.pid)|\(windowTitle)"
    let wantFull = argBool(args, "full")
    let query = argString(args, "query")
    var tree: String
    var isDiff = false
    if let query, !query.isEmpty {
        tree = filterByQuery(query, lines: snapshot.lines, comparable: snapshot.comparable)
            .joined(separator: "\n")
    } else {
        let previous = store.trees[key]
        store.trees[key] = snapshot.comparable
        if wantFull || previous == nil {
            tree = snapshot.lines.joined(separator: "\n")
        } else {
            let result = diffTrees(
                old: previous!, newComparable: snapshot.comparable,
                newFull: snapshot.lines)
            if result.ratio > 0.6 {
                tree = snapshot.lines.joined(separator: "\n")
            } else {
                tree = result.text
                isDiff = true
            }
        }
    }

    var result: [String: Any] = [
        "app": [
            "name": resolved.name,
            "bundleId": resolved.bundleId,
            "pid": resolved.pid
        ],
        "window": windowInfo ?? NSNull(),
        "tree": tree.isEmpty ? "(empty)" : tree,
        "diff": isDiff
    ]

    if argBool(args, "screenshot") {
        if !CGPreflightScreenCaptureAccess() {
            result["screenshotError"] = "Screen Recording permission not granted"
        } else if let window, let shot = captureWindow(window, frame: frame) {
            result["screenshot"] = [
                "jpegBase64": shot.jpegBase64,
                "width": shot.width,
                "height": shot.height,
                "scale": shot.scale
            ]
        } else {
            result["screenshotError"] = "no window to capture"
        }
    }
    return result
}

/// Shared tail for action commands: resolve, act, settle. Callers receive an
/// `activate` closure and invoke it only before posting CGEvents — pure AX
/// actions (AXPress, set_value, AX actions) work on background apps and skip
/// activation entirely.
func doAction(
    _ args: [String: Any],
    preactivate: Bool = false,
    body: (ResolvedApp, () -> Void) throws -> AXUIElement?
) throws -> [String: Any] {
    let t0 = Date()
    let resolved = try requireApp(args)
    let tResolve = Date()
    if preactivate, frontmostPid() != resolved.pid,
        let running = NSRunningApplication(processIdentifier: resolved.pid)
    {
        // The LaunchServices handshake takes ~1s cold; starting it before the
        // action body runs lets most of it overlap the AX work + 200ms wait.
        dispatchActivate(running)
    }
    var activateMs = 0
    var activated = false
    let activate = {
        if !activated {
            activated = true
            let t = Date()
            activateApp(resolved, window: frontWindow(resolved.element))
            activateMs += Int((Date().timeIntervalSince(t) * 1000).rounded())
        }
    }
    let element = try body(resolved, activate)
    let tAction = Date()
    lastActionAt[resolved.pid] = tAction
    let settledMs = settleAfterAction(resolved)
    let totalMs = Int((Date().timeIntervalSince(t0) * 1000).rounded())
    var result: [String: Any] = [
        "app": resolved.name,
        "settledMs": settledMs,
        "timings": [
            "resolveMs": Int((tResolve.timeIntervalSince(t0) * 1000).rounded()),
            "activateMs": activateMs,
            // Body duration minus whatever it spent inside activate().
            "actionMs": max(
                0,
                Int((tAction.timeIntervalSince(tResolve) * 1000).rounded())
                    - activateMs),
            "settleMs": settledMs,
            "totalMs": totalMs
        ]
    ]
    if let element {
        result["element"] = elementSummary(element)
    }
    return result
}

func windowPoint(_ args: [String: Any], _ resolved: ResolvedApp, _ prefix: String)
    throws -> CGPoint
{
    guard
        let x = argNumber(args, "\(prefix)X"),
        let y = argNumber(args, "\(prefix)Y")
    else {
        throw HelperError(message: "missing coordinates: \(prefix)X/\(prefix)Y")
    }
    let frame = frontWindow(resolved.element).flatMap(windowFrame) ?? .zero
    return CGPoint(x: frame.origin.x + CGFloat(x), y: frame.origin.y + CGFloat(y))
}

func handle(_ cmd: String, _ args: [String: Any]) throws -> Any {
    switch cmd {
    case "permissions":
        return checkPermissions(prompt: argBool(args, "prompt"))

    case "list_apps":
        return listApps(exclude: excludedBundleIds(args))

    case "app_state":
        return try doAppState(args)

    case "click":
        // Coordinate clicks always post CGEvents; element clicks may still
        // take the AXPress path, so activation must not be prefired for them.
        return try doAction(args, preactivate: argInt(args, "element") == nil) { resolved, activate in
            if let elementId = argInt(args, "element") {
                guard let (element, stale) = store.element(pid: resolved.pid, id: elementId)
                else {
                    throw HelperError(
                        message:
                            "element \(elementId) not found in latest state of \(resolved.name) — call computer_state again"
                    )
                }
                let button = argString(args, "button") ?? "left"
                let count = argInt(args, "count") ?? 1
                let info = fetchInfo(element)
                if button == "left", count == 1,
                    info.actions.contains("press")
                {
                    // AXPress: instant, no pointer move, works on background
                    // apps — no activation needed.
                    let err = AXUIElementPerformAction(element, kAXPressAction as CFString)
                    if err == .success {
                        _ = stale
                        return element
                    }
                }
                guard let center = elementCenter(element) else {
                    throw HelperError(message: "element \(elementId) has no frame")
                }
                activate()
                postClick(at: center, button: button, count: count)
                return element
            }
            guard let x = argNumber(args, "x"), let y = argNumber(args, "y") else {
                throw HelperError(message: "click needs element or x+y")
            }
            let frame = frontWindow(resolved.element).flatMap(windowFrame) ?? .zero
            activate()
            postClick(
                at: CGPoint(
                    x: frame.origin.x + CGFloat(x), y: frame.origin.y + CGFloat(y)),
                button: argString(args, "button") ?? "left",
                count: argInt(args, "count") ?? 1)
            return nil
        }

    case "set_value":
        return try doAction(args) { resolved, activate in
            let (element, _) = try requireElement(args, resolved)
            guard let value = argString(args, "value") else {
                throw HelperError(message: "missing required arg: value")
            }
            let info = fetchInfo(element)
            var written = false
            if info.role == "AXCheckBox" || info.role == "AXRadioButton"
                || info.valueIsBool
            {
                if value == "true" || value == "false" {
                    let n = NSNumber(value: value == "true" ? 1 : 0)
                    written =
                        AXUIElementSetAttributeValue(
                            element, kAXValueAttribute as CFString, n) == .success
                }
            }
            if !written {
                // Text fields take focus before accepting a value.
                if editableRoles.contains(info.role) {
                    _ = AXUIElementSetAttributeValue(
                        element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                }
                written =
                    AXUIElementSetAttributeValue(
                        element, kAXValueAttribute as CFString, value as CFString) == .success
            }
            if !written {
                // Not writable: focus, select all, type it instead — that
                // path posts real key events, so the app must be frontmost.
                _ = AXUIElementSetAttributeValue(
                    element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                activate()
                try pressChord("cmd+a")
                typeText(value, submit: false, pid: resolved.pid)
            }
            return element
        }

    case "type_text":
        return try doAction(args, preactivate: true) { resolved, activate in
            guard let text = argString(args, "text") else {
                throw HelperError(message: "missing required arg: text")
            }
            activate()
            typeText(text, submit: argBool(args, "submit"), pid: resolved.pid)
            return nil
        }

    case "press_key":
        return try doAction(args, preactivate: true) { _, activate in
            guard let key = argString(args, "key") else {
                throw HelperError(message: "missing required arg: key")
            }
            activate()
            try pressChord(key)
            return nil
        }

    case "scroll":
        return try doAction(args, preactivate: true) { resolved, activate in
            let (element, _) = argInt(args, "element") != nil
                ? try requireElement(args, resolved)
                : (nil, false)
            let direction = argString(args, "direction") ?? "down"
            let pages = argNumber(args, "pages") ?? 1
            var point: CGPoint
            var extent: CGSize
            if let element, let center = elementCenter(element),
                let frame = windowFrame(element)
            {
                point = center
                extent = frame.size
            } else if let window = frontWindow(resolved.element),
                let frame = windowFrame(window)
            {
                point = CGPoint(x: frame.midX, y: frame.midY)
                extent = frame.size
            } else {
                throw HelperError(message: "no element or window to scroll")
            }
            // Hover the target first: wheel events go to what's under the
            // pointer.
            if let move = CGEvent(
                mouseEventSource: nil, mouseType: .mouseMoved,
                mouseCursorPosition: point, mouseButton: .left)
            {
                move.post(tap: .cghidEventTap)
                Thread.sleep(forTimeInterval: 0.03)
            }
            let vertical = Int32(extent.height * 0.8 * CGFloat(pages))
            let horizontal = Int32(extent.width * 0.8 * CGFloat(pages))
            let dx: Int32 = direction == "right" ? horizontal : (direction == "left" ? -horizontal : 0)
            let dy: Int32 = direction == "down" ? -vertical : (direction == "up" ? vertical : 0)
            activate()
            postScroll(at: point, dx: dx, dy: dy)
            return element
        }

    case "drag":
        return try doAction(args, preactivate: true) { resolved, activate in
            let from: CGPoint
            let to: CGPoint
            var el: AXUIElement?
            if let fromId = argInt(args, "fromElement") {
                guard let found = store.element(pid: resolved.pid, id: fromId)?.0 else {
                    throw HelperError(message: "element \(fromId) not found")
                }
                guard let center = elementCenter(found) else {
                    throw HelperError(message: "fromElement has no frame")
                }
                from = center
                el = found
            } else {
                from = try windowPoint(args, resolved, "from")
            }
            if let toId = argInt(args, "toElement") {
                guard let found = store.element(pid: resolved.pid, id: toId)?.0 else {
                    throw HelperError(message: "element \(toId) not found")
                }
                guard let center = elementCenter(found) else {
                    throw HelperError(message: "toElement has no frame")
                }
                to = center
            } else {
                to = try windowPoint(args, resolved, "to")
            }
            activate()
            postDrag(from: from, to: to)
            return el
        }

    case "secondary_action":
        return try doAction(args) { resolved, _ in
            let (element, _) = try requireElement(args, resolved)
            guard let action = argString(args, "action") else {
                throw HelperError(message: "missing required arg: action")
            }
            let name = axActionName(action)
            let err = AXUIElementPerformAction(element, name as CFString)
            if err != .success {
                throw HelperError(
                    message: "action \(action) failed (\(err.rawValue))")
            }
            return element
        }

    case "activate", "launch":
        let resolved = try requireApp(args)
        if cmd == "activate" {
            activateApp(resolved, window: frontWindow(resolved.element))
        }
        return [
            "app": [
                "name": resolved.name, "bundleId": resolved.bundleId,
                "pid": resolved.pid
            ]
        ]

    case "screenshot":
        if argBool(args, "screen") {
            guard CGPreflightScreenCaptureAccess() else {
                throw HelperError(message: "Screen Recording permission not granted")
            }
            guard let shot = captureScreen() else {
                throw HelperError(message: "screen capture failed")
            }
            return [
                "jpegBase64": shot.jpegBase64, "width": shot.width,
                "height": shot.height, "scale": shot.scale
            ]
        }
        let resolved = try requireApp(args)
        guard CGPreflightScreenCaptureAccess() else {
            throw HelperError(message: "Screen Recording permission not granted")
        }
        guard let window = frontWindow(resolved.element),
            let frame = windowFrame(window),
            let shot = captureWindow(window, frame: frame)
        else {
            throw HelperError(message: "no window to capture")
        }
        return [
            "jpegBase64": shot.jpegBase64, "width": shot.width,
            "height": shot.height, "scale": shot.scale,
            "window": (axAttr(window, kAXTitleAttribute) as? String) ?? ""
        ]

    default:
        throw HelperError(message: "unknown command: \(cmd)")
    }
}

// MARK: - entry

if CommandLine.arguments.contains("--self-test") {
    let perms = checkPermissions(prompt: false)
    let apps = listApps(exclude: [])
    print(
        "self-test: accessibility=\(perms["accessibility"] ?? false) "
            + "screenRecording=\(perms["screenRecording"] ?? false) "
            + "apps=\(apps.count)")
    exit(0)
}

// Read stdin on a background thread; requests execute sequentially on a
// dedicated serial queue. They must NOT run on the main queue: a block
// executing there starves it (the serial queue can't re-enter), which
// freezes NSWorkspace's runningApplications snapshot and launch callbacks.
// The main thread stays in dispatchMain() so those updates keep flowing.
let commandQueue = DispatchQueue(label: "pi-desktop.cua.commands")

// Warm the LaunchServices activation path: the first NSRunningApplication
// .activate() in a process blocks ~1s on an XPC handshake. Doing a harmless
// self-activation off the command queue makes the first real activation
// land inside its 200ms wait window instead of timing out.
DispatchQueue.global().async {
    NSRunningApplication.current.activate(options: [])
}

DispatchQueue.global().async {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            continue
        }
        commandQueue.sync {
            var id: Any = NSNull()
            var cmd = ""
            var args: [String: Any] = [:]
            var replyError: String?
            var result: Any?
            if let data = trimmed.data(using: .utf8),
                let object = try? JSONSerialization.jsonObject(with: data)
                    as? [String: Any]
            {
                id = object["id"] ?? NSNull()
                cmd = (object["cmd"] as? String) ?? ""
                args = (object["args"] as? [String: Any]) ?? [:]
            } else {
                replyError = "invalid JSON"
            }
            if replyError == nil {
                do {
                    result = try handle(cmd, args)
                } catch let e as HelperError {
                    replyError = e.message
                } catch {
                    replyError = String(describing: error)
                }
            }
            writeResponse(id: id, result: result, error: replyError)
        }
    }
    // stdin EOF: the parent is gone — exit.
    exit(0)
}

dispatchMain()
