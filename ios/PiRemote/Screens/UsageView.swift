import Charts
import PiRemoteKit
import SwiftUI

private let maxRows = 12

/// Tokens and cost over the last 30 days, as recorded in the session files.
struct UsageView: View {
    @Environment(\.theme) private var theme
    @State private var data = DataStore.shared
    @State private var report: UsageReport?
    @State private var error: String?

    var body: some View {
        Group {
            if let error {
                EmptyState(title: "Could not load usage", detail: error, actionTitle: "Retry") { Task { await load() } }
            } else if let report {
                if report.total.requests == 0 {
                    EmptyState(title: "No usage recorded", detail: "Nothing ran on the computer in the last 30 days.")
                } else {
                    content(report)
                }
            } else {
                LoadingLine(text: "Loading…").padding(Space.lg).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .background(theme.bg.ignoresSafeArea())
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        error = nil
        do {
            report = try await API.usage()
        } catch {
            self.error = errorText(error)
        }
    }

    private func content(_ report: UsageReport) -> some View {
        let peak = report.days.max { $0.totals.cost < $1.totals.cost }
        return ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                LazyVGrid(columns: [GridItem(.flexible(), spacing: Space.sm), GridItem(.flexible(), spacing: Space.sm)], spacing: Space.sm) {
                    tile("cost", formatCost(report.total.cost))
                    tile("requests", compactNumber(Double(report.total.requests)))
                    tile("input tokens", compactNumber(report.total.input))
                    tile("output tokens", compactNumber(report.total.output))
                }
                VStack(alignment: .leading, spacing: Space.sm) {
                    SectionLabel("Cost per day")
                    VStack(alignment: .leading, spacing: Space.sm) {
                        Chart(report.days, id: \.day) { day in
                            BarMark(x: .value("Day", day.day), y: .value("Cost", day.totals.cost))
                                .foregroundStyle(day.totals.cost > 0 ? theme.accent : theme.faint)
                                .cornerRadius(1)
                        }
                        .chartXAxis(.hidden)
                        .chartYAxis(.hidden)
                        .frame(height: 96)
                        HStack {
                            Text(report.days.first?.day ?? "").font(.mono(12)).foregroundStyle(theme.muted)
                            Spacer()
                            Text(report.days.last?.day ?? "").font(.mono(12)).foregroundStyle(theme.muted)
                        }
                    }
                    .padding(Space.md)
                    .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
                    .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 0.5))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        "Cost per day over \(report.days.count) days. Total \(formatCost(report.total.cost))\(peak.map { ", highest \(formatCost($0.totals.cost)) on \($0.day)" } ?? "")."
                    )
                }
                breakdown("By model", rows: report.models.sorted { $0.totals.cost > $1.totals.cost }.prefix(maxRows).map { ($0.name, $0.totals) })
                breakdown("By project", rows: projectRows(report))
            }
            .padding(Space.lg)
            .padding(.bottom, Space.xxl)
        }
        .refreshable { await load() }
    }

    private func projectRows(_ report: UsageReport) -> [(String, UsageTotals)] {
        // Folders that share a base name stay apart.
        var seen: [String: Int] = [:]
        return report.projects.sorted { $0.totals.cost > $1.totals.cost }.prefix(maxRows).map { project in
            let base = project.name == data.appInfo?.workspaceDir || project.name.isEmpty ? "No project" : baseName(project.name)
            let count = (seen[base] ?? 0) + 1
            seen[base] = count
            return (count > 1 ? "\(base) (\(count))" : base, project.totals)
        }
    }

    private func tile(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            Text(label).font(.mono(12)).foregroundStyle(theme.muted)
            Text(value).font(.mono(20, .medium)).foregroundStyle(theme.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Space.md)
        .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
        .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func breakdown(_ label: String, rows: [(String, UsageTotals)]) -> some View {
        if !rows.isEmpty {
            let top = rows.map(\.1.cost).max() ?? 0
            VStack(alignment: .leading, spacing: Space.sm) {
                SectionLabel(label)
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(alignment: .firstTextBaseline, spacing: Space.md) {
                                Text(row.0).font(.mono(13)).foregroundStyle(theme.text).lineLimit(1).truncationMode(.middle)
                                Spacer()
                                Text(compactNumber(row.1.input + row.1.output)).font(.mono(12)).foregroundStyle(theme.muted)
                                Text(formatCost(row.1.cost)).font(.mono(13)).foregroundStyle(theme.text2)
                            }
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    RoundedRectangle(cornerRadius: 1).fill(theme.border)
                                    RoundedRectangle(cornerRadius: 1).fill(theme.text2)
                                        .frame(width: top > 0 ? max(geo.size.width * 0.01, geo.size.width * CGFloat(row.1.cost / top)) : 0)
                                }
                            }
                            .frame(height: 3)
                        }
                        .padding(.vertical, Space.sm)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(row.0): \(formatCost(row.1.cost)), \(row.1.requests) requests")
                    }
                }
                .padding(Space.md)
                .background(RoundedRectangle(cornerRadius: Radius.md).fill(theme.surface))
                .overlay(RoundedRectangle(cornerRadius: Radius.md).strokeBorder(theme.border, lineWidth: 0.5))
            }
        }
    }
}
