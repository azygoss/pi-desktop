import SwiftUI
import UIKit

/// Focus requests for a GrowingTextView (a nonce bumps to focus again).
final class TextFocus: ObservableObject {
    @Published var request = 0
    @Published var dismissRequest = 0

    func focus() { request += 1 }
    func dismiss() { dismissRequest += 1 }
}

/**
 * A multi-line text view that grows with its text up to `maxHeight`, and
 * reports the cursor (UTF-16 offset) so `@` mentions can be completed where
 * the user is typing. SwiftUI's TextField does not expose its selection on
 * iOS 17.
 */
struct GrowingTextView: UIViewRepresentable {
    @Binding var text: String
    @Binding var cursor: Int
    var placeholder: String
    var minHeight: CGFloat = 40
    var maxHeight: CGFloat = 148
    var font: UIFont = .systemFont(ofSize: 16)
    var textColor: UIColor
    var placeholderColor: UIColor
    var tintColor: UIColor
    @ObservedObject var focus: TextFocus
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = font
        view.textColor = textColor
        view.tintColor = tintColor
        view.isScrollEnabled = false
        view.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 6, right: 8)
        view.textContainer.lineFragmentPadding = 4
        view.adjustsFontForContentSizeCategory = true
        view.keyboardDismissMode = .interactive
        view.accessibilityLabel = placeholder
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let label = UILabel()
        label.text = placeholder
        label.font = font
        label.textColor = placeholderColor
        label.numberOfLines = 1
        label.translatesAutoresizingMaskIntoConstraints = false
        label.tag = 99
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            label.topAnchor.constraint(equalTo: view.topAnchor, constant: 10),
            label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, constant: -24)
        ])
        context.coordinator.lastFocus = focus.request
        context.coordinator.lastDismiss = focus.dismissRequest
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
            let end = (text as NSString).length
            view.selectedRange = NSRange(location: end, length: 0)
        }
        view.textColor = textColor
        view.tintColor = tintColor
        if let label = view.viewWithTag(99) as? UILabel {
            label.text = placeholder
            label.textColor = placeholderColor
            label.isHidden = !text.isEmpty
        }
        if context.coordinator.lastFocus != focus.request {
            context.coordinator.lastFocus = focus.request
            DispatchQueue.main.async { view.becomeFirstResponder() }
        }
        if context.coordinator.lastDismiss != focus.dismissRequest {
            context.coordinator.lastDismiss = focus.dismissRequest
            DispatchQueue.main.async { view.resignFirstResponder() }
        }
        context.coordinator.recalculateHeight(view)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: GrowingTextView
        var lastFocus = 0
        var lastDismiss = 0

        init(_ parent: GrowingTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.cursor = textView.selectedRange.location + textView.selectedRange.length
            recalculateHeight(textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            let position = textView.selectedRange.location + textView.selectedRange.length
            if parent.cursor != position {
                DispatchQueue.main.async { self.parent.cursor = position }
            }
        }

        func recalculateHeight(_ view: UITextView) {
            let width = view.bounds.width > 0 ? view.bounds.width : UIScreen.main.bounds.width - 120
            let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height
            let clamped = min(max(fitting, parent.minHeight), parent.maxHeight)
            view.isScrollEnabled = fitting > parent.maxHeight
            if abs(parent.height - clamped) > 0.5 {
                DispatchQueue.main.async { self.parent.height = clamped }
            }
        }
    }
}
