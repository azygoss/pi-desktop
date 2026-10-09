import Foundation

/// One shared 1 Hz clock for every live indicator (the desktop's
/// live-clock.ts). The timer runs only while at least one view retains it.
@MainActor @Observable
public final class LiveClock {
    public static let shared = LiveClock()
    public private(set) var tick = Int(Date().timeIntervalSince1970)
    @ObservationIgnored private var subscribers = 0
    @ObservationIgnored private var timer: Timer?
    public var isRunning: Bool { timer != nil }
    public init() {}
    public func retain() { subscribers += 1; if timer == nil { start() } }
    public func release() {
        subscribers = max(0, subscribers - 1)
        if subscribers == 0 { timer?.invalidate(); timer = nil }
    }
    private func start() {
        tick = Int(Date().timeIntervalSince1970)
        let t = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick = Int(Date().timeIntervalSince1970) }
        }
        t.tolerance = 0.1
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }
}
