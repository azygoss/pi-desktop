import Foundation

/// Prompts pi runs on a schedule on the computer (src/shared/automations.ts).
public enum AutomationSchedule: Hashable, Sendable {
    case interval(minutes: Int)
    case daily(time: String, weekdaysOnly: Bool)

    public static let minIntervalMinutes = 5
    public static let maxIntervalMinutes = 7 * 24 * 60

    init?(json: JSONValue?) {
        switch json?["kind"]?.stringValue {
        case "interval":
            guard let minutes = json?["minutes"]?.intValue else { return nil }
            self = .interval(minutes: minutes)
        case "daily":
            guard let time = json?["time"]?.stringValue else { return nil }
            self = .daily(time: time, weekdaysOnly: json?["weekdaysOnly"]?.isTrue ?? false)
        default:
            return nil
        }
    }

    public var json: JSONValue {
        switch self {
        case .interval(let minutes):
            return ["kind": "interval", "minutes": .int(minutes)]
        case .daily(let time, let weekdaysOnly):
            return weekdaysOnly ? ["kind": "daily", "time": .string(time), "weekdaysOnly": true] : ["kind": "daily", "time": .string(time)]
        }
    }

    public static func isValidTime(_ text: String) -> Bool {
        text.range(of: "^([01]\\d|2[0-3]):([0-5]\\d)$", options: .regularExpression) != nil
    }

    public var isValid: Bool {
        switch self {
        case .interval(let minutes):
            return minutes >= Self.minIntervalMinutes && minutes <= Self.maxIntervalMinutes
        case .daily(let time, _):
            return Self.isValidTime(time)
        }
    }

    /// "Every 30 minutes", "Every 2 hours", "Weekdays at 09:00".
    public var description: String {
        switch self {
        case .daily(let time, let weekdaysOnly):
            return "\(weekdaysOnly ? "Weekdays" : "Every day") at \(time)"
        case .interval(let m):
            if m % 1440 == 0 { return m == 1440 ? "Every day" : "Every \(m / 1440) days" }
            if m % 60 == 0 { return m == 60 ? "Every hour" : "Every \(m / 60) hours" }
            return "Every \(m) minutes"
        }
    }
}

public struct Automation: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var prompt: String
    /// Project folder; "" runs it without a project.
    public var cwd: String
    public var schedule: AutomationSchedule
    public var enabled: Bool
    /// Epoch ms.
    public var createdAt: Double
    public var lastRunAt: Double?
    public var lastSessionPath: String?

    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, let schedule = AutomationSchedule(json: json["schedule"]) else { return nil }
        self.id = id
        name = json["name"]?.stringValue ?? ""
        prompt = json["prompt"]?.stringValue ?? ""
        cwd = json["cwd"]?.stringValue ?? ""
        self.schedule = schedule
        enabled = json["enabled"]?.isTrue ?? false
        createdAt = json["createdAt"]?.doubleValue ?? 0
        lastRunAt = json["lastRunAt"]?.doubleValue
        lastSessionPath = json["lastSessionPath"]?.stringValue
    }

    /// When it should next run (epoch ms), counted from its last run, in the
    /// phone's own time zone (callers check it matches the computer's).
    public func nextRunAt(calendar: Calendar = .current) -> Double {
        let base = lastRunAt ?? createdAt
        switch schedule {
        case .interval(let minutes):
            return base + Double(minutes) * 60_000
        case .daily(let time, let weekdaysOnly):
            let parts = time.split(separator: ":").compactMap { Int($0) }
            guard parts.count == 2 else { return base }
            let baseDate = Date(timeIntervalSince1970: base / 1000)
            var next = calendar.date(bySettingHour: parts[0], minute: parts[1], second: 0, of: baseDate) ?? baseDate
            if next.timeIntervalSince1970 * 1000 <= base {
                next = calendar.date(byAdding: .day, value: 1, to: next) ?? next
            }
            if weekdaysOnly {
                while calendar.isDateInWeekend(next) {
                    next = calendar.date(byAdding: .day, value: 1, to: next) ?? next
                }
            }
            return next.timeIntervalSince1970 * 1000
        }
    }
}

/// Editable fields of an automation; `id` updates an existing one.
public struct AutomationInput: Sendable {
    public var id: String?
    public var name: String
    public var prompt: String
    public var cwd: String
    public var schedule: AutomationSchedule
    public var enabled: Bool

    public init(id: String?, name: String, prompt: String, cwd: String, schedule: AutomationSchedule, enabled: Bool) {
        self.id = id
        self.name = name
        self.prompt = prompt
        self.cwd = cwd
        self.schedule = schedule
        self.enabled = enabled
    }

    public var json: JSONValue {
        .compact([
            "id": id.map(JSONValue.string),
            "name": .string(name),
            "prompt": .string(prompt),
            "cwd": .string(cwd),
            "schedule": schedule.json,
            "enabled": .bool(enabled)
        ])
    }
}
