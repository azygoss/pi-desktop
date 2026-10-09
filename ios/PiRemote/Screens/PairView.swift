import AVFoundation
import PiRemoteKit
import SwiftUI
import UIKit

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
                            Image(systemName: "xmark").font(.system(size: 17, weight: .semibold))
                                .frame(width: touchTarget, height: touchTarget)
                        }
                        .accessibilityLabel("Close")
                        .foregroundStyle(theme.text2)
                    }
                }
                PiMark()
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text(adding ? "Pair another computer" : "Pair with your computer")
                        .font(.system(size: 22, weight: .semibold))
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
                        .font(.system(size: 14))
                        .foregroundStyle(theme.danger)
                        .padding(.leading, Space.md)
                        .padding(.vertical, Space.xs)
                        .overlay(alignment: .leading) { Rectangle().fill(theme.danger).frame(width: 2) }
                        .accessibilityAddTraits(.isStaticText)
                }
                VStack(alignment: .leading, spacing: Space.sm) {
                    Text("No camera? Choose \"Copy pairing link\" on the computer, send it to this phone and paste it here.")
                        .font(.system(size: 14))
                        .foregroundStyle(theme.muted)
                    TextField("pidesktop://pair?…", text: $pasted)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .fieldStyle()
                        .accessibilityLabel("Pairing link")
                    HStack(spacing: Space.sm) {
                        Button {
                            pasted = UIPasteboard.general.string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        } label: {
                            Label("Paste", systemImage: "doc.on.clipboard").frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryButtonStyle())
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
                    .font(.system(size: 13))
                    .foregroundStyle(theme.muted)
            }
            .padding(Space.xl)
            .padding(.top, adding ? 0 : Space.xxl)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(theme.bg.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            QRScannerScreen { code in
                guard !handled, PairingPayload.parse(code) != nil else { return }
                handled = true
                scanning = false
                Task { await pair(code) }
            }
        }
        .task {
            // The system camera (or a tapped link) can open the app with the
            // pairing link itself: pair straight away.
            if adding, let link {
                await pair(link)
            } else if let pending = router.pendingPairLink {
                router.pendingPairLink = nil
                await pair(pending)
            }
        }
        .onChange(of: router.pendingPairLink) { _, pending in
            guard let pending, !adding else { return }
            router.pendingPairLink = nil
            Task { await pair(pending) }
        }
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
        default:
            error = "Camera access is off for Pi Remote. Turn it on in Settings, or paste the pairing link below."
            if let url = URL(string: UIApplication.openSettingsURLString) { await UIApplication.shared.open(url) }
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
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            QRScanner(onCode: onCode).ignoresSafeArea()
            VStack {
                HStack {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: touchTarget, height: touchTarget)
                            .background(Circle().fill(Color.black.opacity(0.5)))
                    }
                    .accessibilityLabel("Stop scanning")
                    Spacer()
                }
                .padding(Space.sm)
                Spacer()
                Text("Point the camera at the pairing code")
                    .font(.system(size: 14))
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

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onCode = onCode
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onCode = onCode
    }

    final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: ((String) -> Void)?
        private let session = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: device),
                session.canAddInput(input)
            else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
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
