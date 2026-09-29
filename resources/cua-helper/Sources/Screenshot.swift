import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Window-bounded and display screenshots, downscaled to a model-friendly
// size and JPEG-encoded. `scale` in the result maps image px to window
// points so the model can convert coordinates back.

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ window: UnsafeMutablePointer<CGWindowID>) -> AXError

let maxScreenshotSide: CGFloat = 1568
/// Vision models downscale anything larger than ~1.15 megapixels server-side
/// (Anthropic's documented limit; OpenAI's high-detail tiles land nearby), so
/// pixels beyond it only add upload size and latency. A 16:10 Retina window
/// goes from 1568x980 (~470KB) to ~1356x848.
let maxScreenshotPixels: CGFloat = 1_150_000

struct Shot {
    let jpegBase64: String
    let width: Int
    let height: Int
    /// Image pixels per point of the captured region.
    let scale: Double
}

/// Downscale + JPEG-encode with CoreGraphics/ImageIO only (no AppKit
/// graphics context), so it is safe on the background queue app_state uses
/// to capture while the AX tree walk runs.
func encodeShot(_ image: CGImage, pointsWidth: CGFloat, pointsHeight: CGFloat) -> Shot? {
    let iw = CGFloat(image.width)
    let ih = CGFloat(image.height)
    let scale = min(
        1.0, maxScreenshotSide / max(iw, ih), (maxScreenshotPixels / (iw * ih)).squareRoot())
    let w = max(1, Int((iw * scale).rounded()))
    let h = max(1, Int((ih * scale).rounded()))
    var source = image
    if w != image.width || h != image.height {
        guard
            let space = CGColorSpace(name: CGColorSpace.sRGB),
            let ctx = CGContext(
                data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                space: space, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)
        else {
            return nil
        }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        guard let scaled = ctx.makeImage() else {
            return nil
        }
        source = scaled
    }
    let data = NSMutableData()
    guard
        let dest = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil)
    else {
        return nil
    }
    CGImageDestinationAddImage(
        dest, source, [kCGImageDestinationLossyCompressionQuality: 0.7] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
        return nil
    }
    let ptScale = pointsWidth > 0 ? Double(w) / Double(pointsWidth) : 1
    return Shot(
        jpegBase64: (data as Data).base64EncodedString(), width: w, height: h, scale: ptScale)
}

/// Window-bounded capture: prefer the CGWindowID from the private (but
/// long-stable) _AXUIElementGetWindow; fall back to the screen rect.
func captureWindow(_ window: AXUIElement, frame: CGRect) -> Shot? {
    var windowID = CGWindowID(0)
    if _AXUIElementGetWindow(window, &windowID) == .success, windowID != 0,
        let image = CGWindowListCreateImage(
            .null, .optionIncludingWindow, windowID,
            [.boundsIgnoreFraming, .bestResolution])
    {
        return encodeShot(image, pointsWidth: frame.width, pointsHeight: frame.height)
    }
    guard
        let image = CGWindowListCreateImage(
            frame, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
    else {
        return nil
    }
    return encodeShot(image, pointsWidth: frame.width, pointsHeight: frame.height)
}

func captureScreen() -> Shot? {
    let display = CGMainDisplayID()
    guard let image = CGDisplayCreateImage(display) else {
        return nil
    }
    let bounds = CGDisplayBounds(display)
    return encodeShot(image, pointsWidth: bounds.width, pointsHeight: bounds.height)
}
