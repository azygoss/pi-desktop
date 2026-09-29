import ApplicationServices
import AppKit
import CoreGraphics
import Foundation

// Accessibility-tree snapshot: walks the frontmost window, prints one line
// per interesting element in window coordinates, assigns sequential ids and
// diffs against the previous snapshot of the same window.

let maxDepth = 40
let maxNodes = 1500

/// One snapshot's element map plus the lines it produced.
struct Snapshot {
    /// Printed lines including ids: `[12] button "Save" 120,44 80x24 {press}`
    var lines: [String] = []
    /// Same lines with the `[id] ` marker stripped — diff compares these.
    var comparable: [String] = []
    var elements: [Int: AXUIElement] = [:]
    var nodeCount = 0
    var skippedCount = 0
    /// Set when an element timed out: the walk stops rather than paying the
    /// messaging timeout again for every remaining node of a hung app.
    var unresponsive = false
}

final class SnapshotStore {
    /// Latest and previous element maps per app pid, so ids from the tree the
    /// model last saw still resolve after a refresh.
    var current: [pid_t: [Int: AXUIElement]] = [:]
    var previous: [pid_t: [Int: AXUIElement]] = [:]
    /// Last comparable lines per (pid, window title) for diffing.
    var trees: [String: [String]] = [:]

    func rotate(pid: pid_t, elements: [Int: AXUIElement]) {
        previous[pid] = current[pid]
        current[pid] = elements
    }

    /// Resolve an element id against the newest snapshot first, then the one
    /// before it. Returns the element and whether the id was stale.
    func element(pid: pid_t, id: Int) -> (AXUIElement, Bool)? {
        if let el = current[pid]?[id] {
            return (el, false)
        }
        if let el = previous[pid]?[id] {
            return (el, true)
        }
        return nil
    }
}

func formatElement(_ info: ElInfo, id: Int?, windowOrigin: CGPoint) -> String {
    var parts: [String] = []
    if let id {
        parts.append("[\(id)]")
    }
    parts.append(shortRoleName(info.role))
    let label = info.title ?? info.desc ?? info.placeholder
    if let label, !label.isEmpty {
        parts.append("\"\(label)\"")
    }
    if let value = info.value, !value.isEmpty {
        parts.append("= \"\(value)\"")
    }
    if info.hasFrame {
        let x = Int((info.position.x - windowOrigin.x).rounded())
        let y = Int((info.position.y - windowOrigin.y).rounded())
        let w = Int(info.size.width.rounded())
        let h = Int(info.size.height.rounded())
        parts.append("\(x),\(y) \(w)x\(h)")
    }
    if !info.actions.isEmpty {
        parts.append("{\(info.actions.joined(separator: ", "))}")
    }
    if info.focused {
        parts.append("focused")
    }
    if !info.enabled {
        parts.append("disabled")
    }
    if info.selected {
        parts.append("selected")
    }
    return parts.joined(separator: " ")
}

/// Formatting twice — once with and once without the id — is cheaper and
/// more reliable than regex-stripping the printed line afterwards.
private func formattedPair(_ info: ElInfo, id: Int?, indent: String, windowOrigin: CGPoint)
    -> (full: String, comparable: String)
{
    (
        indent + formatElement(info, id: id, windowOrigin: windowOrigin),
        indent + formatElement(info, id: nil, windowOrigin: windowOrigin)
    )
}

/// Walk `element` recursively; window-relative coordinates. `depth` is the
/// visual indent depth — collapsed groups pass their own depth to children.
func walk(
    _ element: AXUIElement,
    into snapshot: inout Snapshot,
    depth: Int,
    windowFrame: CGRect
) {
    if snapshot.unresponsive {
        return
    }
    if snapshot.nodeCount >= maxNodes {
        snapshot.skippedCount += 1
        return
    }
    snapshot.nodeCount += 1
    if depth > maxDepth {
        return
    }
    let info = fetchInfo(element)
    if info.unresponsive {
        snapshot.unresponsive = true
        return
    }

    let floats = roleCanFloat(info.role)
    if info.hasFrame && !floats {
        let frame = CGRect(origin: info.position, size: info.size)
        let empty = frame.width <= 0 || frame.height <= 0
        if empty || !frame.intersects(windowFrame) {
            // Outside the visible window (or invisible): skip the subtree
            // except children that float (menus etc.).
            for child in info.children {
                // Cheap probe: walking a hidden child still costs one fetch,
                // but menus under clipped parents are real. Only descend when
                // the child itself reports a floating role.
                if let role = axAttr(child, kAXRoleAttribute) as? String,
                    roleCanFloat(role)
                {
                    walk(child, into: &snapshot, depth: depth + 1, windowFrame: windowFrame)
                }
            }
            return
        }
    }

    var printedDepth = depth
    if roleCollapses(info) || isSingleChildGroup(info) {
        printedDepth -= 1 // children join the parent's level
    } else if info.hasFrame || floats || !info.children.isEmpty || elementDeservesId(info) {
        let id = elementDeservesId(info) ? snapshot.elements.count + 1 : nil
        if let id {
            snapshot.elements[id] = element
        }
        let indent = String(repeating: " ", count: max(depth, 0))
        let pair = formattedPair(info, id: id, indent: indent, windowOrigin: windowFrame.origin)
        snapshot.lines.append(pair.full)
        snapshot.comparable.append(pair.comparable)
    }
    for child in info.children {
        walk(child, into: &snapshot, depth: printedDepth + 1, windowFrame: windowFrame)
    }
}

/// Multiset diff: lines are compared without ids (they rotate per snapshot).
/// Returns nil when nothing changed.
func diffTrees(old: [String], newComparable: [String], newFull: [String])
    -> (text: String, ratio: Double)
{
    var remaining = [String: Int]()
    for line in old {
        remaining[line, default: 0] += 1
    }
    var added = [String]()
    for (i, line) in newComparable.enumerated() {
        if let left = remaining[line], left > 0 {
            remaining[line] = left - 1
        } else {
            added.append(newFull[i])
        }
    }
    var removed = [String]()
    var leftOver = remaining
    for line in old {
        if let left = leftOver[line], left > 0 {
            removed.append(line)
            leftOver[line] = left - 1
        }
    }
    if added.isEmpty && removed.isEmpty {
        return ("(no changes)", 0)
    }
    let ratio = Double(added.count + removed.count) / Double(max(newComparable.count, 1))
    var out: [String] = []
    out += added.map { "+ " + $0 }
    out += removed.map { "- " + $0 }
    return (out.joined(separator: "\n"), ratio)
}
