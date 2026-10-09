import PiRemoteKit
import SwiftUI

private let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/// "14:30" today, "Mon 09:00" on another day, "now" when it is due.
private func nextLabel(_ at: Double) -> String {
    let now = Date()
    if at <= now.timeIntervalSince1970 * 1000 { return "now" }
    let date = Date(timeIntervalSince1970: at / 1000)
    let calendar = Calendar.current
    let parts = calendar.dateComponents([.hour, .minute, .weekday], from: date)
    let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    return calendar.isDate(date, inSameDayAs: now) ? time : "\(weekdays[(parts.weekday ?? 1) - 1]) \(time)"
}

@MainActor
private func runLine(_ automation: Automation) -> String {
    var last = "never run"
    if let lastRun = automation.lastRunAt {
        let age = relativeTime(lastRun)
        last = age == "now" || age.isEmpty ? "last run just now" : "last run \(age) ago"
    }
    guard automation.enabled else { return last }
    // A daily time is the computer's: with the phone in another time zone the
    // next run worked out here would be off, so only the schedule is shown.
    let computerOffset = Connection.shared.server?.tzOffset
    let phoneOffset = -TimeZone.current.secondsFromGMT() / 60
    let sameZone = computerOffset == nil || computerOffset == phoneOffset
    if case .interval = automation.schedule {
        return "\(last) · next \(nextLabel(automation.nextRunAt()))"
    }
    return sameZone ? "\(last) · next \(nextLabel(automation.nextRunAt()))" : "\(last) · computer time"
}

/// Prompts pi runs on a schedule on the computer.
struct AutomationsTab: View {
    @Environment(\.theme) private var theme
    @State private var automations: [Automation]?
    @State private var error: String?
    @State private var bag = SubscriptionBag()
    @State private var router = Router.shared

    var body: some View {
        List {
            VStack(alignment: .leading, spacing: Space.md) {
                Text("Prompts pi runs on a schedule while Pi Desktop (or pi-remote) is running on the computer.")
                    .font(.system(size: 14))
                    .foregroundStyle(theme.muted)
                Button {
                    router.push(.automationEdit(id: nil))
                } label: {
                    Label("New automation", systemImage: "plus").frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryButtonStyle())
            }
            .padding(.horizontal, Space.lg)
            .padding(.vertical, Space.lg)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(theme.bg)

            if let automations {
                if automations.isEmpty {
                    EmptyState(icon: "clock", title: "No automations yet", detail: "Create one to have pi run a prompt every few hours or at a set time.")
                        .frame(minHeight: 260)
                        .listRowSeparator(.hidden)
                        .listRowBackground(theme.bg)
                }
                ForEach(automations) { automation in
                    row(automation)
                        .listRowInsets(EdgeInsets())
                        .listRowSeparator(.hidden)
                        .listRowBackground(theme.bg)
                }
            } else if let error {
                EmptyState(title: "Could not load automations", detail: error, actionTitle: "Retry") { Task { await load() } }
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.bg)
            } else {
                LoadingLine(text: "Loading…")
                    .padding(Space.lg)
                    .listRowSeparator(.hidden)
                    .listRowBackground(theme.bg)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(theme.bg)
        .refreshable { await load() }
        .task {
            await load()
            bag.add(Connection.shared.onOnline { Task { await load() } })
            bag.add(Connection.shared.on(RemoteEvent.automationsChanged) { _ in Task { await load() } })
        }
        .onDisappear { bag.cancelAll() }
    }

    private func row(_ automation: Automation) -> some View {
        HStack(spacing: Space.md) {
            Button {
                router.push(.automationEdit(id: automation.id))
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(automation.name).foregroundStyle(automation.enabled ? theme.text : theme.text2).lineLimit(1)
                    Text("\(automation.schedule.description) · \(automation.cwd.isEmpty ? "no project" : baseName(automation.cwd))")
                        .font(.mono(12))
                        .foregroundStyle(theme.text2)
                        .lineLimit(1)
                    Text(runLine(automation)).font(.mono(12)).foregroundStyle(theme.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Toggle(
                "",
                isOn: Binding(get: { automation.enabled }, set: { _ in toggle(automation) })
            )
            .labelsHidden()
            .accessibilityLabel("\(automation.name) enabled")
        }
        .padding(.leading, Space.lg)
        .padding(.trailing, Space.md)
        .padding(.vertical, 10)
        .frame(minHeight: touchTarget + 24)
        .contextMenu {
            Button { Task { await runNow(automation) } } label: { Label("Run now", systemImage: "play") }
            if automation.lastSessionPath != nil {
                Button { openLastRun(automation) } label: { Label("Open last run", systemImage: "clock.arrow.circlepath") }
            }
            Button(role: .destructive) { Task { await remove(automation) } } label: { Label("Delete…", systemImage: "trash") }
        }
        .swipeActions {
            Button(role: .destructive) { Task { await remove(automation) } } label: { Label("Delete", systemImage: "trash") }
            Button { Task { await runNow(automation) } } label: { Label("Run now", systemImage: "play") }.tint(theme.accent)
        }
        .accessibilityElement(children: .contain)
    }

    private func load() async {
        do {
            automations = try await API.automations()
            error = nil
        } catch {
            self.error = errorText(error)
        }
    }

    private func toggle(_ automation: Automation) {
        let enabled = !automation.enabled
        automations = automations?.map { item in
            var copy = item
            if copy.id == automation.id { copy.enabled = enabled }
            return copy
        }
        Task {
            do {
                try await API.saveAutomation(
                    AutomationInput(id: automation.id, name: automation.name, prompt: automation.prompt, cwd: automation.cwd, schedule: automation.schedule, enabled: enabled)
                )
                await load()
            } catch {
                toast(errorText(error))
                await load()
            }
        }
    }

    private func runNow(_ automation: Automation) async {
        do {
            try await API.runAutomation(automation.id)
            toast("Started on the computer")
        } catch {
            toast(errorText(error))
        }
    }

    private func openLastRun(_ automation: Automation) {
        if let session = DataStore.shared.session(automation.lastSessionPath) {
            router.openSession(session)
        } else {
            toast("The chat of the last run is no longer there")
        }
    }

    private func remove(_ automation: Automation) async {
        let sure = await Dialogs.confirm(
            title: "Delete \"\(automation.name)\"?",
            message: "It stops running. Chats from earlier runs are kept.",
            action: "Delete",
            danger: true
        )
        guard sure else { return }
        do {
            try await API.deleteAutomation(automation.id)
            await load()
        } catch {
            toast(errorText(error))
        }
    }
}

/// Create or edit an automation.
struct AutomationEditView: View {
    let id: String?

    private enum Kind: String { case interval, daily }
    private enum Unit: String { case minutes, hours }

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var data = DataStore.shared
    @State private var state: LoadState = .ready
    @State private var name = ""
    @State private var prompt = ""
    @State private var cwd = ""
    @State private var kind: Kind = .interval
    @State private var amount = "1"
    @State private var unit: Unit = .hours
    @State private var time = "09:00"
    @State private var weekdaysOnly = false
    @State private var enabled = true
    @State private var saving = false
    @State private var initial: String?

    private enum LoadState: Equatable {
        case loading, ready, error(String)
    }

    private var draftKey: String { [name, prompt, cwd, kind.rawValue, amount, unit.rawValue, time, "\(weekdaysOnly)", "\(enabled)"].joined(separator: "\u{1f}") }

    private var schedule: AutomationSchedule {
        if kind == .daily { return .daily(time: time.trimmingCharacters(in: .whitespaces), weekdaysOnly: weekdaysOnly) }
        let n = Int(amount.trimmingCharacters(in: .whitespaces)) ?? -1
        return .interval(minutes: unit == .hours ? n * 60 : n)
    }

    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty && !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && schedule.isValid
    }

    private var dirty: Bool { initial != nil && initial != draftKey }

    var body: some View {
        Group {
            switch state {
            case .loading:
                LoadingLine(text: "Loading…").padding(Space.lg).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            case .error(let message):
                EmptyState(title: "Could not load the automation", detail: message, actionTitle: "Retry") { Task { await load() } }
            case .ready:
                form
            }
        }
        .background(theme.bg.ignoresSafeArea())
        .navigationTitle(id == nil ? "New automation" : "Edit automation")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(dirty)
        .toolbar {
            if dirty {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        Task {
                            // Back would throw away what was typed here: ask first.
                            if await Dialogs.confirm(title: "Discard your changes?", message: "This automation has not been saved.", action: "Discard", danger: true) {
                                dismiss()
                            }
                        }
                    }
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(saving ? "Saving…" : "Save") { Task { await save() } }
                    .fontWeight(.semibold)
                    .disabled(!canSave || saving)
            }
        }
        .task {
            if id != nil {
                await load()
            } else if initial == nil {
                initial = draftKey
            }
        }
    }

    private var form: some View {
        Form {
            Section("Name") {
                TextField("Morning dependency check", text: $name)
                    .onChange(of: name) { _, value in if value.count > 80 { name = String(value.prefix(80)) } }
            }
            Section("Prompt") {
                TextField("What pi should do on each run", text: $prompt, axis: .vertical)
                    .lineLimit(4...12)
            }
            Section("Project") {
                Menu {
                    Button { cwd = "" } label: { Label("No project", systemImage: cwd.isEmpty ? "checkmark" : "square.dashed") }
                    ForEach(data.projects) { project in
                        Button { cwd = project.cwd } label: { Label(project.name, systemImage: cwd == project.cwd ? "checkmark" : "folder") }
                    }
                    Button {
                        Task { if let path = await Router.shared.pickFolder("Choose a folder") { cwd = path } }
                    } label: {
                        Label("Choose another folder…", systemImage: "folder.badge.plus")
                    }
                } label: {
                    HStack {
                        if cwd.isEmpty {
                            Text("No project").foregroundStyle(theme.text2)
                        } else {
                            Text(tildePath(cwd, homeDir: data.appInfo?.homeDir))
                                .font(.mono(14))
                                .foregroundStyle(theme.text)
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").foregroundStyle(theme.muted)
                    }
                }
            }
            Section {
                Picker("Schedule", selection: $kind) {
                    Text("Every…").tag(Kind.interval)
                    Text("Daily at…").tag(Kind.daily)
                }
                .pickerStyle(.segmented)
                if kind == .interval {
                    HStack {
                        TextField("1", text: $amount)
                            .keyboardType(.numberPad)
                            .frame(width: 72)
                            .onChange(of: amount) { _, value in
                                let digits = value.filter(\.isNumber)
                                if digits != value { amount = String(digits.prefix(5)) }
                            }
                        Picker("Unit", selection: $unit) {
                            Text("minutes").tag(Unit.minutes)
                            Text("hours").tag(Unit.hours)
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: unit) { _, next in clamp(per: next == .hours ? 60 : 1) }
                    }
                    Text("between \(AutomationSchedule.minIntervalMinutes) minutes and \(AutomationSchedule.maxIntervalMinutes / 1440) days")
                        .font(.mono(12))
                        .foregroundStyle(schedule.isValid ? theme.muted : theme.danger)
                } else {
                    DatePicker("Time of day", selection: timeBinding, displayedComponents: .hourAndMinute)
                        .environment(\.locale, Locale(identifier: "en_GB"))
                    Text("24-hour HH:MM, the computer's time").font(.mono(12)).foregroundStyle(theme.muted)
                    Toggle("Weekdays only", isOn: $weekdaysOnly)
                }
            } header: {
                Text("Schedule")
            }
            Section {
                Toggle(isOn: $enabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Enabled")
                        Text("Runs only while Pi Desktop (or pi-remote) is running on the computer.")
                            .font(.system(size: 13))
                            .foregroundStyle(theme.muted)
                    }
                }
            }
            if id != nil {
                Section {
                    Button(role: .destructive) {
                        Task { await remove() }
                    } label: {
                        Label("Delete automation", systemImage: "trash")
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
    }

    /// The daily time as a Date for the picker (the computer's wall clock).
    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                let parts = time.split(separator: ":").compactMap { Int($0) }
                return Calendar.current.date(bySettingHour: parts.first ?? 9, minute: parts.count > 1 ? parts[1] : 0, second: 0, of: Date()) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
            }
        )
    }

    /// Bring a typed interval back inside what the desktop accepts.
    private func clamp(per: Int) {
        guard let n = Int(amount) else { return }
        let minutes = min(AutomationSchedule.maxIntervalMinutes, max(AutomationSchedule.minIntervalMinutes, n * per))
        amount = String(max(1, Int((Double(minutes) / Double(per)).rounded())))
    }

    private func load() async {
        guard let id else { return }
        state = .loading
        do {
            guard let found = try await API.automations().first(where: { $0.id == id }) else {
                state = .error("This automation no longer exists.")
                return
            }
            name = found.name
            prompt = found.prompt
            cwd = found.cwd
            enabled = found.enabled
            switch found.schedule {
            case .interval(let minutes):
                kind = .interval
                let hours = minutes % 60 == 0
                unit = hours ? .hours : .minutes
                amount = String(hours ? minutes / 60 : minutes)
            case .daily(let at, let weekdays):
                kind = .daily
                time = at
                weekdaysOnly = weekdays
            }
            state = .ready
            initial = draftKey
        } catch {
            state = .error(errorText(error))
        }
    }

    private func save() async {
        guard canSave else { return }
        saving = true
        do {
            try await API.saveAutomation(
                AutomationInput(
                    id: id,
                    name: name.trimmingCharacters(in: .whitespaces),
                    prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    cwd: cwd,
                    schedule: schedule,
                    enabled: enabled
                )
            )
            initial = draftKey
            dismiss()
        } catch {
            toast(errorText(error))
            saving = false
        }
    }

    private func remove() async {
        guard let id else { return }
        let sure = await Dialogs.confirm(
            title: "Delete \"\(name.isEmpty ? "this automation" : name)\"?",
            message: "It stops running. Chats from earlier runs are kept.",
            action: "Delete",
            danger: true
        )
        guard sure else { return }
        do {
            try await API.deleteAutomation(id)
            initial = draftKey
            dismiss()
        } catch {
            toast(errorText(error))
        }
    }
}
