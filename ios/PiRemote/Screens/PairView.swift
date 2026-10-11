import AVFoundation
import PiRemoteKit
import SwiftUI
import UIKit

/// Where to get Pi Desktop and read about Pi Remote.
let projectURL = URL(string: "https://github.com/azygoss/pi-desktop")

private let pairingSteps = [
    "Open Pi Desktop on your computer",
    "Go to Settings → Remote control",
    "Choose \"Show pairing code\" and scan it here"
]

/**
 * Pair this phone with a computer by scanning the one-time QR code Pi
 * Desktop (or `pi-remote pair`) shows, or by pasting its link. The first
 * run shows it on its own; later it opens over the app to add a computer.
 */
struct PairView: View {
    let adding: Bool
    let link: String?

    @Environment(\.theme) private var theme
    @Environment(\.dismiss) private var dismiss
    @State private var connection = Connection.shared
    @State private var router = Router.shared
    @State private var scanning = false
    @State private var busy: String?
    @State private var error: String?
    @State private var pasted = ""
    @State private var handled = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.xl) {
                if adding {
                    HStack {
                        Spacer()
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark").uiFont(17, weight: .semibold)
                                .frame(width: touchTarget, height: touchTarget)
                        }
                        .accessibilityLabel("Close")
                        .foregroundStyle(theme.text2)
                    }
                }
                PiMark()
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text(adding ? "Pair another computer" : "Pair with your computer")
                        .uiFont(22, weight: .semibold)
                        .foregroundStyle(theme.text)
                        .accessibilityAddTraits(.isHeader)
                    if adding {
                        Text("It is added to your computers and used from now on. Switch between them in Settings.")
                            .foregroundStyle(theme.text2)
                    }
                    Text(
                        "Pi Remote controls Pi Desktop from your phone: start and follow chats, answer pi's questions, review and commit changes. The two talk directly over your network, end-to-end encrypted. On a server without the desktop app, run pi-remote there and scan the code from \"pi-remote pair\"."
                    )
                    .foregroundStyle(theme.text2)
                }
                VStack(alignment: .leading, spacing: Space.md) {
                    ForEach(Array(pairingSteps.enumerated()), id: \.offset) { index, step in
                        HStack(alignment: .firstTextBaseline, spacing: Space.md) {
                            Text("\(index + 1)").font(.mono(14)).foregroundStyle(theme.muted)
                            Text(step).foregroundStyle(theme.text)
                        }
                    }
                    if let projectURL {
                        Link(destination: projectURL) {
                            Label("Get Pi Desktop", systemImage: "arrow.up.right.square")
                                .font(.subheadline.weight(.medium))
                                .frame(minHeight: touchTarget)
                        }
                        .tint(theme.accent)
                    }
                }
                if let busy {
                    HStack(spacing: Space.sm) {
                        Pixel(tone: .working)
                        Text("Connecting to \(busy)…").foregroundStyle(theme.text2)
                    }
                } else {
                    Button {
                        Task { await startScan() }
                    } label: {
                        Label("Scan pairing code", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                if let shown = error ?? connection.error {
                    Text(shown)
                        .uiFont(14)
                        .foregroundStyle(theme.danger)
                        .padding(.leading, Space.md)
                        .padding(.vertical, Space.xs)
                        .overlay(alignment: .leading) { Rectangle().fill(theme.danger).frame(width: 2) }
                        .accessibilityAddTraits(.isStaticText)
                }
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("No camera? Choose \"Copy pairing link\" on the computer, send it to this phone and paste it here.")
                        .uiFont(14)
                        .foregroundStyle(theme.muted)
                    TextField("pidesktop://pair?…", text: $pasted)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .fieldStyle()
                        .accessibilityLabel("Pairing link")
                    HStack(spacing: Space.sm) {
                        // The system paste button reads the clipboard without the "Allow Paste" prompt.
                        PasteButton(payloadType: String.self) { strings in
                            pasted = strings.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        }
                        .buttonBorderShape(.roundedRectangle(radius: Radius.md))
                        .tint(theme.raised)
                        .foregroundStyle(theme.text)
                        .labelStyle(.titleAndIcon)
                        .frame(maxWidth: .infinity)
                        Button {
                            Task { await pair(pasted) }
                        } label: {
                            Text("Pair").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle())
                        .disabled(pasted.trimmingCharacters(in: .whitespaces).isEmpty || busy != nil)
                    }
                }
                Text("Both devices need to reach each other: the same Wi-Fi, or a VPN such as Tailscale.")
                    .uiFont(13)
                    .foregroundStyle(theme.muted)
            }
            .padding(Space.xl)
            .padding(.top, adding ? 0 : Space.xxl)
            // A readable column on iPad.
            .frame(maxWidth: 600)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(theme.bg.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            QRScannerScreen { code in
                guard PairingPayload.parse(code) != nil else { return false }
                guard !handled else { return true }
                handled = true
                scanning = false
                Task { await pair(code) }
                return true
            }
        }
        .task {
            // The system camera (or a tapped link) can open the app with the
            // pairing link itself. A link can come from anywhere, so ask first.
            if adding, let link {
                await pairFromLink(link)
            } else if let pending = router.pendingPairLink {
                router.pendingPairLink = nil
                await pairFromLink(pending)
            }
        }
        // Editing the pasted link makes an earlier error stale — drop it.
        .onChange(of: pasted) { _, _ in error = nil }
        .onChange(of: router.pendingPairLink) { _, pending in
            guard let pending, !adding else { return }
            router.pendingPairLink = nil
            Task { await pairFromLink(pending) }
        }
    }

    /// A link opened the app: say which computer it pairs with before trusting it.
    /// Whoever runs that computer sees the prompts, files and photos sent to it.
    private func pairFromLink(_ text: String) async {
        guard let payload = PairingPayload.parse(text) else {
            error = "That link is not a Pi Desktop pairing code."
            return
        }
        let confirmed = await Dialogs.confirm(
            title: "Pair with \(payload.name)?",
            message: "This link pairs Pi Remote with \(payload.name) at \(payload.hosts.first ?? "an unknown address"). Continue only if it comes from your own computer: everything you send in Pi Remote goes to it.",
            action: "Pair"
        )
        guard confirmed else {
            if adding { dismiss() }
            return
        }
        await pair(text)
    }

    private func startScan() async {
        error = nil
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            break
        case .notDetermined:
            guard await AVCaptureDevice.requestAccess(for: .video) else {
                error = "Camera access is needed to scan the code. You can also paste the pairing link below."
                return
            }
        case .restricted:
            error = "The camera is not available on this iPhone. Paste the pairing link below instead."
            return
        default:
            error = "Camera access is off for Pi Remote. Turn it on in Settings, or paste the pairing link below."
            let open = await Dialogs.confirm(
                title: "Camera access is off",
                message: "Turn on Camera for Pi Remote in Settings to scan pairing codes.",
                action: "Open Settings"
            )
            if open, let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
            return
        }
        handled = false
        scanning = true
    }

    private func pair(_ text: String) async {
        guard let payload = PairingPayload.parse(text) else {
            error = "That is not a Pi Desktop pairing code."
            return
        }
        error = nil
        busy = payload.name
        defer {
            busy = nil
            handled = false
        }
        do {
            try await connection.pair(text)
            Haptic.success.play()
            if adding {
                toast("Paired with \(connection.pairing?.name ?? payload.name)")
                dismiss()
            }
        } catch {
            Haptic.warning.play()
            self.error = connection.error ?? errorText(error)
        }
    }
}

// MARK: - Scanner

private struct QRScannerScreen: View {
    /// True when the code is a pairing code.
    let onCode: (String) -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var unavailable = false
    @State private var wrongCode = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            QRScanner(
                onCode: { code in if !onCode(code) { wrongCode = true } },
                onUnavailable: { unavailable = true }
            )
            .ignoresSafeArea()
            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .uiFont(17, weight: .semibold)
                            .foregroundStyle(.white)
                            .frame(width: touchTarget, height: touchTarget)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                    }
                    .accessibilityLabel("Stop scanning")
                    Spacer()
                }
                .padding(Space.sm)
                Spacer()
                Text(
                    unavailable
                        ? "The camera could not start. Close this and paste the pairing link instead."
                        : wrongCode ? "That code is not a Pi Desktop pairing code" : "Point the camera at the pairing code"
                )
                .multilineTextAlignment(.center)
                    .uiFont(14)
                    .foregroundStyle(Color(hex: 0xECECEE))
                    .padding(.horizontal, Space.lg)
                    .padding(.vertical, Space.md)
                    .background(RoundedRectangle(cornerRadius: Radius.md).fill(Color.black.opacity(0.65)))
                    .padding(.bottom, Space.xxl)
            }
        }
    }
}

/// The camera with a QR code reader (AVFoundation metadata output).
private struct QRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void
    let onUnavailable: () -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        controller.onUnavailable = onUnavailable
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onCode = onCode
        controller.onUnavailable = onUnavailable
    }

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        var onUnavailable: (() -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        /// Keeps the picture upright as an iPad turns.
        private var rotation: AVCaptureDevice.RotationCoordinator?
        private var rotationObservation: NSKeyValueObservation?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                session.canAddInput(input)
            else {
                DispatchQueue.main.async { self.onUnavailable?() }
                return
            }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                DispatchQueue.main.async { self.onUnavailable?() }
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
            let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: layer)
            layer.connection?.videoRotationAngle = coordinator.videoRotationAngleForHorizonLevelPreview
            rotationObservation = coordinator.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.new]) { [weak layer] coordinator, _ in
                let angle = coordinator.videoRotationAngleForHorizonLevelPreview
                DispatchQueue.main.async { layer?.connection?.videoRotationAngle = angle }
            }
            rotation = coordinator
        }

        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }

        override func viewWillAppear(_ animated: Bool) {
            super.viewWillAppear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            let session = session
            DispatchQueue.global(qos: .userInitiated).async { session.stopRunning() }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
            // The camera reports the same code many times a second; the view dedupes.
            for object in objects {
                if let code = (object as? AVMetadataMachineReadableCodeObject)?.stringValue { onCode?(code) }
            }
        }
    }
}
