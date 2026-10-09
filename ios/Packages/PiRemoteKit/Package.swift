// swift-tools-version:5.9
import PackageDescription

// The platform-neutral half of Pi Remote for iOS: the encrypted link's
// cryptography and wire protocol, the desktop's data model, and the pure
// helpers the desktop renders a chat with (ported from src/shared and
// src/renderer/src/lib). No UIKit, so `swift test` runs it on a Mac.
let package = Package(
    name: "PiRemoteKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PiRemoteKit", targets: ["PiRemoteKit"])
    ],
    targets: [
        .target(name: "PiRemoteKit"),
        .testTarget(name: "PiRemoteKitTests", dependencies: ["PiRemoteKit"])
    ]
)
