import ApplicationServices
import Foundation

// Post-action settling via AX notifications. A dedicated thread owns a
// CFRunLoop for the AXObserver sources (observers must be created and their
// sources added on that thread's run loop). Settle = "no notification for
// 150ms" with a 60ms floor and a 1500ms cap (3000ms while the window reports
// AXBusy). Apps that never deliver notifications fall back to the old
// tree-hash poll with a 1s cap.

private let watchedNotifications = [
    kAXValueChangedNotification,
    kAXUIElementDestroyedNotification,
    kAXCreatedNotification,
    kAXFocusedUIElementChangedNotification,
    kAXWindowCreatedNotification,
    kAXTitleChangedNotification,
    kAXLayoutChangedNotification,
    kAXSelectedChildrenChangedNotification
]

private func axObserverCallback(
    _ observer: AXObserver, _ element: AXUIElement,
    _ notification: CFString, _ refcon: UnsafeMutableRawPointer?
) {
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    SettleMonitor.shared.noteEvent(pid: pid)
}

final class SettleMonitor {
    static let shared = SettleMonitor()

    private let lock = NSLock()
    private var lastEvent: [pid_t: Date] = [:]
    private var delivered: Set<pid_t> = []
    private var registered: Set<pid_t> = []
    private var runLoop: CFRunLoop?
    private let ready = DispatchSemaphore(value: 0)

    private init() {
        Thread.detachNewThread { [self] in
            let rl = CFRunLoopGetCurrent()
            lock.lock()
            runLoop = rl
            lock.unlock()
            ready.signal()
            // A no-op source keeps the run loop alive between observer adds.
            var context = CFRunLoopSourceContext()
            let keepAlive = CFRunLoopSourceCreate(nil, 0, &context)
            CFRunLoopAddSource(rl, keepAlive, .defaultMode)
            CFRunLoopRun()
        }
        ready.wait()
    }

    func noteEvent(pid: pid_t) {
        lock.lock()
        lastEvent[pid] = Date()
        delivered.insert(pid)
        lock.unlock()
    }

    private func register(pid: pid_t) {
        lock.lock()
        let already = registered.contains(pid)
        lock.unlock()
        if already {
            return
        }
        // Source management happens on the observer thread's run loop.
        let done = DispatchSemaphore(value: 0)
        lock.lock()
        let rl = runLoop
        lock.unlock()
        guard let rl else {
            return
        }
        CFRunLoopPerformBlock(rl, CFRunLoopMode.defaultMode.rawValue) {
            var observer: AXObserver?
            if AXObserverCreate(pid, axObserverCallback, &observer) == .success,
                let observer
            {
                let source = AXObserverGetRunLoopSource(observer)
                CFRunLoopAddSource(rl, source, .defaultMode)
                let app = AXUIElementCreateApplication(pid)
                for name in watchedNotifications {
                    _ = AXObserverAddNotification(
                        observer, app, name as CFString, nil)
                }
                SettleMonitor.shared.lock.lock()
                SettleMonitor.shared.registered.insert(pid)
                SettleMonitor.shared.lock.unlock()
            }
            done.signal()
        }
        CFRunLoopWakeUp(rl)
        _ = done.wait(timeout: .now() + 0.5)
    }

    /// ms since the last notification for pid; nil when none delivered yet.
    private func idleMs(pid: pid_t) -> Double? {
        lock.lock()
        defer { lock.unlock() }
        return lastEvent[pid].map { Date().timeIntervalSince($0) * 1000 }
    }

    private func hasDelivered(pid: pid_t) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return delivered.contains(pid)
    }

    /// Wait for the app's UI to quiet down after an action. Returns ms waited.
    func settle(pid: pid_t, appElement: AXUIElement) -> Int {
        let start = Date()
        register(pid: pid)

        // Grace window: give the app 60ms to produce its first notification.
        // Apps that never deliver (observers unsupported) fall back to the
        // hash poll instead of burning the whole cap.
        Thread.sleep(forTimeInterval: 0.06)
        if !hasDelivered(pid: pid) {
            return Int(start.timeIntervalSinceNow * -1000)
                + settleByHash(appElement, capSeconds: 1.0)
        }

        let busy = isWindowBusy(appElement)
        let capMs: Double = busy ? 3000 : 1500
        while Date().timeIntervalSince(start) * 1000 < capMs {
            if let idle = idleMs(pid: pid), idle >= 150 {
                break
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        return Int((Date().timeIntervalSince(start) * 1000).rounded())
    }

    private func isWindowBusy(_ appElement: AXUIElement) -> Bool {
        guard let window = frontWindow(appElement) else {
            return false
        }
        let value = axAttr(window, "AXBusy")
        return (value as? Bool) == true || (value as? NSNumber)?.boolValue == true
    }
}

/// Convenience for command handlers.
func settleAfterAction(_ resolved: ResolvedApp) -> Int {
    SettleMonitor.shared.settle(pid: resolved.pid, appElement: resolved.element)
}
