import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

// Input synthesis: AX actions first, CGEvent for coordinates/keys. Every
// action settles the target window's AX tree afterwards so the following
// app_state is instant.

/// Cheap stability hash for the settle loop: children count plus a few
/// titles of the frontmost window.
private func treeHash(_ appElement: AXUIElement) -> Int {
    var hash = 5381
    guard let window = frontWindow(appElement) else {
        return 0
    }
    let children = axChildren(window)
    hash = hash &* 33 &+ children.count
    for child in children.prefix(24) {
        if let title = axAttr(child, kAXTitleAttribute) as? String {
            for u in title.unicodeScalars.prefix(64) {
                hash = hash &* 33 &+ Int(u.value)
            }
        }
    }
    return hash
}

/// Fallback settle for apps that never emit AX notifications: poll a cheap
/// tree hash until two consecutive reads match, capped by `capSeconds`.
@discardableResult
func settleByHash(_ appElement: AXUIElement, capSeconds: Double = 2.0) -> Int {
    let start = Date()
    var last = treeHash(appElement)
    var stable = 0
    while true {
        let elapsed = Date().timeIntervalSince(start)
        if elapsed >= capSeconds {
            break
        }
        Thread.sleep(forTimeInterval: 0.1)
        let current = treeHash(appElement)
        stable = current == last ? stable + 1 : 0
        last = current
        if stable >= 1, elapsed >= 0.15 {
            break
        }
    }
    return Int((Date().timeIntervalSince(start) * 1000).rounded())
}

/// Element center in screen coordinates.
func elementCenter(_ element: AXUIElement) -> CGPoint? {
    guard let frame = windowFrame(element) else {
        return nil
    }
    return CGPoint(x: frame.midX, y: frame.midY)
}

/// "AX<Name>" back from the short name the tree prints ("showMenu").
func axActionName(_ short: String) -> String {
    guard let first = short.first else {
        return short
    }
    return "AX" + first.uppercased() + short.dropFirst()
}

// MARK: - Mouse

private let mouseButtons: [String: (CGMouseButton, CGEventType, CGEventType)] = [
    "left": (.left, .leftMouseDown, .leftMouseUp),
    "right": (.right, .rightMouseDown, .rightMouseUp),
    "middle": (.center, .otherMouseDown, .otherMouseUp)
]

func postClick(at point: CGPoint, button: String, count: Int) {
    let (cgButton, down, up) = mouseButtons[button] ?? mouseButtons["left"]!
    if let move = CGEvent(
        mouseEventSource: nil, mouseType: .mouseMoved,
        mouseCursorPosition: point, mouseButton: cgButton)
    {
        move.post(tap: .cghidEventTap)
    }
    Thread.sleep(forTimeInterval: 0.02)
    for click in 1...max(1, count) {
        for type in [down, up] {
            guard
                let event = CGEvent(
                    mouseEventSource: nil, mouseType: type,
                    mouseCursorPosition: point, mouseButton: cgButton)
            else {
                continue
            }
            event.setIntegerValueField(.mouseEventClickState, value: Int64(click))
            event.post(tap: .cghidEventTap)
            Thread.sleep(forTimeInterval: 0.01)
        }
    }
}

// MARK: - Keyboard

private let namedKeyCodes: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "escape": 53, "esc": 53, "tab": 48,
    "space": 49, "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111
]

private let modifierFlags: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand, "super": .maskCommand,
    "shift": .maskShift, "alt": .maskAlternate, "option": .maskAlternate,
    "ctrl": .maskControl, "control": .maskControl
]

/// Reverse char → keycode map over the current keyboard layout, built once.
private var charKeyMap: [Character: (CGKeyCode, Bool)] = {
    var map = [Character: (CGKeyCode, Bool)]()
    // US layout fallbacks so typing still works without a TIS layout.
    let us: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7,
        "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
        "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
        "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
        "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37,
        "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
        "n": 45, "m": 46, ".": 47, "`": 50
    ]
    for (ch, code) in us {
        map[ch] = (code, false)
        if ch.isLetter {
            map[Character(ch.uppercased())] = (code, true)
        }
    }
    guard
        let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
        let layoutData = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
    else {
        return map
    }
    let data = unsafeBitCast(layoutData, to: CFData.self) as Data
    data.withUnsafeBytes { raw in
        guard let layout = raw.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self)
        else {
            return
        }
        for code in UInt16(0)..<UInt16(128) {
            for (shift, state) in [(false, UInt32(0)), (true, UInt32(0x02))] {
                var dead: UInt32 = 0
                var chars = [UniChar](repeating: 0, count: 4)
                var length = 0
                let status = UCKeyTranslate(
                    layout, code, UInt16(kUCKeyActionDisplay), state,
                    UInt32(LMGetKbdType()), OptionBits(kUCKeyTranslateNoDeadKeysMask),
                    &dead, 4, &length, &chars)
                if status == noErr, length == 1 {
                    let ch = Character(Unicode.Scalar(UInt32(chars[0])) ?? " ")
                    // Layout-derived bindings win over the US fallback.
                    map[ch] = (CGKeyCode(code), shift)
                }
            }
        }
    }
    return map
}()

func postKey(_ code: CGKeyCode, flags: CGEventFlags) {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
        else {
            continue
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.004)
    }
}

/// "cmd+shift+n", "Return", single chars → key events. Throws on unknown keys.
func pressChord(_ chord: String) throws {
    var flags = CGEventFlags()
    var key = ""
    for part in chord.split(separator: "+") {
        let token = String(part).trimmingCharacters(in: .whitespaces)
        if let flag = modifierFlags[token.lowercased()] {
            flags.insert(flag)
        } else if token.isEmpty {
            continue
        } else {
            key = token
        }
    }
    if key.isEmpty {
        throw HelperError(message: "no key in chord: \(chord)")
    }
    if let code = namedKeyCodes[key.lowercased()] {
        postKey(code, flags: flags)
        return
    }
    if key.count == 1, let ch = key.first, let (code, shift) = charKeyMap[ch] {
        var f = flags
        if shift {
            f.insert(.maskShift)
        }
        postKey(code, flags: f)
        return
    }
    throw HelperError(message: "unknown key: \(key)")
}

/// Type text as unicode chunks — works for arbitrary characters, not just
/// ones with a keycode. `submit` presses Return afterwards. Posting to the
/// target pid keeps the input in the right app even if focus moved between
/// activation and posting (the HID tap once silently dropped these events).
func typeText(_ text: String, submit: Bool, pid: pid_t) {
    // A nil event source drops the unicode payload — spell it out.
    let source = CGEventSource(stateID: .hidSystemState)
    var utf16 = Array(text.utf16)
    let chunk = 20
    while !utf16.isEmpty {
        let piece = Array(utf16.prefix(chunk))
        utf16 = Array(utf16.dropFirst(chunk))
        for down in [true, false] {
            guard
                let event = CGEvent(
                    keyboardEventSource: source, virtualKey: 0, keyDown: down)
            else {
                continue
            }
            piece.withUnsafeBufferPointer { buf in
                if let base = buf.baseAddress {
                    event.keyboardSetUnicodeString(
                        stringLength: piece.count, unicodeString: base)
                }
            }
            event.postToPid(pid)
            Thread.sleep(forTimeInterval: 0.002)
        }
    }
    if submit {
        postKey(namedKeyCodes["return"]!, flags: [])
    }
}

// MARK: - Scroll / drag

func postScroll(at point: CGPoint, dx: Int32, dy: Int32) {
    // Four smaller events read more like a real wheel than one big jump.
    for _ in 0..<4 {
        guard
            let event = CGEvent(
                scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                wheel1: dy / 4, wheel2: dx / 4, wheel3: 0)
        else {
            return
        }
        event.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.02)
    }
    _ = point
}

func postDrag(from: CGPoint, to: CGPoint) {
    if let down = CGEvent(
        mouseEventSource: nil, mouseType: .leftMouseDown,
        mouseCursorPosition: from, mouseButton: .left)
    {
        down.post(tap: .cghidEventTap)
    }
    for step in 1...8 {
        let t = CGFloat(step) / 8
        let point = CGPoint(
            x: from.x + (to.x - from.x) * t,
            y: from.y + (to.y - from.y) * t)
        if let move = CGEvent(
            mouseEventSource: nil, mouseType: .leftMouseDragged,
            mouseCursorPosition: point, mouseButton: .left)
        {
            move.post(tap: .cghidEventTap)
        }
        Thread.sleep(forTimeInterval: 0.025)
    }
    if let up = CGEvent(
        mouseEventSource: nil, mouseType: .leftMouseUp,
        mouseCursorPosition: to, mouseButton: .left)
    {
        up.post(tap: .cghidEventTap)
    }
}
