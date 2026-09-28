import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

// Window-bounded and display screenshots, downscaled to a model-friendly
// size and JPEG-encoded. `scale` in the result maps image px to window
// points so the model can convert coordinates back.

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ window: UnsafeMutablePointer<CGWindowID>) -> AXError

let maxScreenshotSide: CGFloat = 1568

struct Shot {
    let jpegBase64: String
    let width: Int
    let height: Int
    /// Image pixels per point of the captured region.
    let scale: Double
}

func encodeShot(_ image: CGImage, pointsWidth: CGFloat, pointsHeight: CGFloat) -> Shot? {
    let scale = min(1.0, maxScreenshotSide / max(CGFloat(image.width), CGFloat(image.height)))
    let w = max(1, Int((CGFloat(image.width) * scale).rounded()))
    let h = max(1, Int((CGFloat(image.height) * scale).rounded()))
    guard
        let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: w,
            pixelsHigh: h,
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .calibratedRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        )
    else {
        return nil
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    NSGraphicsContext.current?.imageInterpolation = .high
    NSGraphicsContext.current?.cgContext.draw(
        image, in: CGRect(x: 0, y: 0, width: w, height: h))
    NSGraphicsContext.restoreGraphicsState()
    guard
        let jpeg = rep.representation(
            using: .jpeg, properties: [.compressionFactor: 0.7])
    else {
        return nil
    }
    let ptScale = pointsWidth > 0 ? Double(w) / Double(pointsWidth) : 1
    return Shot(
        jpegBase64: jpeg.base64EncodedString(), width: w, height: h, scale: ptScale)
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
