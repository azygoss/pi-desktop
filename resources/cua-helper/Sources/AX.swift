import ApplicationServices
import CoreGraphics
import Foundation

// Element snapshot: everything the tree walk needs from one element, fetched
// in a single AXUIElementCopyMultipleAttributeValues call.

struct ElInfo {
    var role: String = ""
    var subrole: String = ""
    var title: String?
    var desc: String?
    var value: String?
    var valueIsBool = false
    var roleDescription: String?
    var position = CGPoint.zero
    var size = CGSize.zero
    var hasFrame = false
    var enabled = true
    var focused = false
    var selected = false
    var placeholder: String?
    var help: String?
    var identifier: String?
    var children: [AXUIElement] = []
    var actions: [String] = []
}

private let batchAttributes: [String] = [
    kAXRoleAttribute,
    kAXSubroleAttribute,
    kAXTitleAttribute,
    kAXDescriptionAttribute,
    kAXValueAttribute,
    kAXRoleDescriptionAttribute,
    kAXPositionAttribute,
    kAXSizeAttribute,
    kAXEnabledAttribute,
    kAXFocusedAttribute,
    kAXChildrenAttribute,
    kAXSelectedAttribute,
    kAXPlaceholderValueAttribute,
    kAXHelpAttribute,
    kAXIdentifierAttribute
]

func axAttr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func axChildren(_ element: AXUIElement, _ attr: String = kAXChildrenAttribute) -> [AXUIElement] {
    (axAttr(element, attr) as? [AXUIElement]) ?? []
}

private func axPoint(_ value: Any?) -> CGPoint? {
    guard let value, CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else {
        return nil
    }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
}

private func axSize(_ value: Any?) -> CGSize? {
    guard let value, CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else {
        return nil
    }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
}

private func axBool(_ value: Any?, fallback: Bool) -> Bool {
    (value as? NSNumber)?.boolValue ?? fallback
}

private func axString(_ value: Any?) -> String? {
    guard let value else {
        return nil
    }
    if let s = value as? String {
        return s.isEmpty ? nil : s
    }
    if let n = value as? NSNumber {
        return n.stringValue
    }
    return nil
}

private func truncate(_ s: String, _ max: Int) -> String {
    s.count > max ? String(s.prefix(max - 1)) + "…" : s
}

/// AX action names like AXShowMenu come back as "showMenu" for the model.
func shortActionName(_ name: String) -> String {
    var s = name.hasPrefix("AX") ? String(name.dropFirst(2)) : name
    if let first = s.first {
        s = first.lowercased() + s.dropFirst()
    }
    return s
}

func shortRoleName(_ role: String) -> String {
    var s = role.hasPrefix("AX") ? String(role.dropFirst(2)) : role
    if let first = s.first {
        s = first.lowercased() + s.dropFirst()
    }
    return s
}

/// One batched attribute fetch per element. Failed entries in the returned
/// array are skipped, so partial failures degrade to missing fields.
func fetchInfo(_ element: AXUIElement) -> ElInfo {
    var info = ElInfo()
    var rawValues: CFArray?
    let error = AXUIElementCopyMultipleAttributeValues(
        element, batchAttributes as CFArray, [], &rawValues)
    let values = (error == .success ? rawValues as? [Any] : nil) ?? []
    func field(_ index: Int) -> Any? {
        index < values.count ? values[index] : nil
    }
    info.role = (field(0) as? String) ?? ""
    info.subrole = (field(1) as? String) ?? ""
    info.title = axString(field(2))
    info.desc = axString(field(3))
    if let raw = field(4) {
        if let b = raw as? Bool, CFGetTypeID(raw as CFTypeRef) == CFBooleanGetTypeID() {
            info.value = b ? "true" : "false"
            info.valueIsBool = true
        } else if let n = raw as? NSNumber {
            info.value = n.stringValue
        } else if let s = raw as? String {
            info.value = truncate(s, 120)
        }
    }
    info.roleDescription = axString(field(5))
    if let p = axPoint(field(6)), let s = axSize(field(7)) {
        info.position = p
        info.size = s
        info.hasFrame = true
    }
    info.enabled = axBool(field(8), fallback: true)
    info.focused = axBool(field(9), fallback: false)
    info.children = (field(10) as? [AXUIElement]) ?? []
    info.selected = axBool(field(11), fallback: false)
    info.placeholder = axString(field(12))
    info.help = axString(field(13))
    info.identifier = axString(field(14))

    var actionNames: CFArray?
    if AXUIElementCopyActionNames(element, &actionNames) == .success,
        let names = actionNames as? [String]
    {
        info.actions = names.map(shortActionName)
    }
    return info
}

/// Roles that may legitimately live outside the window frame (menus,
/// popovers, sheets are anchored elsewhere).
func roleCanFloat(_ role: String) -> Bool {
    role.hasPrefix("AXMenu") || role == "AXPopover" || role == "AXSheet"
        || role == "AXMenuBar" || role == "AXMenuBarItem"
}

/// Roles that collapse into their parent: invisible grouping containers with
/// no label/value of their own.
func roleCollapses(_ info: ElInfo) -> Bool {
    (info.role == "AXGroup" || info.role == "AXGenericElement" || info.role == "AXUnknown")
        && info.title == nil && info.desc == nil && info.value == nil
        && info.placeholder == nil && info.actions.isEmpty
}

/// Elements worth an id: labelled, valued or actionable.
let editableRoles: Set<String> = [
    "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider",
    "AXStepper", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXDateTimeArea",
    "AXIncrementor", "AXValueIndicator"
]

func elementDeservesId(_ info: ElInfo) -> Bool {
    if !info.actions.isEmpty || info.focused {
        return true
    }
    if info.title != nil || info.desc != nil || info.value != nil || info.placeholder != nil {
        return true
    }
    return editableRoles.contains(info.role)
}
