import PhotosUI
import PiRemoteKit
import SwiftUI
import UIKit

/// Decoded base64 images, kept while memory allows (screenshots repeat in
/// a transcript and decoding them on every render would stutter).
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()
    private let cache = NSCache<NSString, UIImage>()

    private init() {
        cache.totalCostLimit = 96 * 1024 * 1024
    }

    func image(key: String, base64: String) -> UIImage? {
        if let hit = cache.object(forKey: key as NSString) { return hit }
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters), let image = UIImage(data: data) else {
            return nil
        }
        cache.setObject(image, forKey: key as NSString, cost: data.count)
        return image
    }
}

extension ImageContent {
    /// A stable cache key without hashing megabytes on every call.
    var cacheKey: String { "\(mimeType):\(data.count):\(data.prefix(48)):\(data.suffix(48))" }

    var uiImage: UIImage? { ImageCache.shared.image(key: cacheKey, base64: data) }
}

extension ToolShot {
    var uiImage: UIImage? { ImageCache.shared.image(key: key + ":\(data.count)", base64: data) }
}

/// An image to show full screen.
struct LightboxItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// Pinch-to-zoom image view (UIScrollView does this best).
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 8
        scroll.showsVerticalScrollIndicator = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.backgroundColor = .clear
        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.translatesAutoresizingMaskIntoConstraints = false
        imageView.isAccessibilityElement = true
        imageView.accessibilityLabel = "Image, full screen"
        scroll.addSubview(imageView)
        NSLayoutConstraint.activate([
            imageView.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
            imageView.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            imageView.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            imageView.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            imageView.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            imageView.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor)
        ])
        context.coordinator.imageView = imageView
        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ view: UIScrollView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        @objc func doubleTapped(_ recognizer: UITapGestureRecognizer) {
            guard let scroll = recognizer.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let point = recognizer.location(in: imageView)
                let size = CGSize(width: scroll.bounds.width / 3, height: scroll.bounds.height / 3)
                scroll.zoom(to: CGRect(origin: CGPoint(x: point.x - size.width / 2, y: point.y - size.height / 2), size: size), animated: true)
            }
        }
    }
}

/**
 * Full-screen image: pinch or double-tap to zoom (read a screenshot at
 * actual size), Share saves or sends it.
 */
struct LightboxView: View {
    let item: LightboxItem
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.opacity(0.96).ignoresSafeArea()
            ZoomableImage(image: item.image).ignoresSafeArea()
            HStack(spacing: Space.sm) {
                Button {
                    Dialogs.share([item.image])
                } label: {
                    Image(systemName: "square.and.arrow.up")
                        .frame(width: touchTarget, height: touchTarget)
                        .background(Circle().fill(Color.black.opacity(0.5)))
                }
                .accessibilityLabel("Share or save image")
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: touchTarget, height: touchTarget)
                        .background(Circle().fill(Color.black.opacity(0.5)))
                }
                .accessibilityLabel("Close image")
            }
            .foregroundStyle(.white)
            .font(.system(size: 17, weight: .semibold))
            .padding(Space.sm)
            VStack {
                Spacer()
                Text("\(Int(item.image.size.width * item.image.scale))×\(Int(item.image.size.height * item.image.scale)) · pinch to zoom")
                    .font(.mono(12))
                    .foregroundStyle(Color(hex: 0xA0A0A8))
                    .padding(.bottom, Space.lg)
            }
            .frame(maxWidth: .infinity)
            .allowsHitTesting(false)
        }
    }
}

// MARK: - Picking photos

enum ImagePrep {
    /// Longest edge sent to the model; larger photos are scaled down first.
    static let maxEdge: CGFloat = 1568

    /// Scaled to `maxEdge` and encoded as JPEG (base64), like the Android app.
    static func attachment(from image: UIImage) -> (content: ImageContent, preview: UIImage)? {
        let size = image.size
        let longest = max(size.width, size.height)
        var target = image
        if longest > maxEdge, longest > 0 {
            let scale = maxEdge / longest
            let newSize = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
            let format = UIGraphicsImageRendererFormat.default()
            format.scale = 1
            target = UIGraphicsImageRenderer(size: newSize, format: format).image { _ in
                image.draw(in: CGRect(origin: .zero, size: newSize))
            }
        }
        guard let data = target.jpegData(compressionQuality: 0.82) else { return nil }
        return (ImageContent(data: data.base64EncodedString(), mimeType: "image/jpeg"), target)
    }
}

/// The camera, for a photo attached to a message.
struct CameraPicker: UIViewControllerRepresentable {
    var onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker

        init(_ parent: CameraPicker) {
            self.parent = parent
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
