// pi-desktop-dictation — speech dictation helper for Pi Desktop.
// JSONL over stdio; the app spawns this as a child so macOS attributes the
// Microphone and Speech Recognition prompts to Pi Desktop.
//
// Commands (one per line on stdin):
//   {"id":N,"cmd":"permissions","args":{}}     -> {"id":N,"ok":true,"result":{microphone,speech}}
//   {"id":N,"cmd":"locales","args":{}}         -> {"id":N,"ok":true,"result":{locales:[...]}}
//   {"id":N,"cmd":"start","args":{"locale":"tr-TR","autoStop":false}}
//                                              -> {"id":N,"ok":true} then events
//   {"id":N,"cmd":"stop","args":{}}            -> final transcript then {"event":"stopped"}
//   {"id":N,"cmd":"cancel","args":{}}          -> {"event":"cancelled"}
//
// Events (no id):
//   {"event":"partial","text":"..."}   interim transcript
//   {"event":"final","text":"..."}    committed transcript
//   {"event":"level","rms":0.0-1.0}   input level (~15/s while recording)
//   {"event":"error","message":"..."} fatal for this recording session
//   {"event":"stopped"}               recognition ended (stop/silence/cap)
//   {"event":"cancelled"}             discard confirmed
//
// EOF on stdin exits the process.

import AVFoundation
import Foundation
import Speech

// MARK: - JSONL plumbing

let stdoutLock = NSLock()
func writeLine(_ obj: [String: Any]) {
    stdoutLock.lock()
    defer { stdoutLock.unlock() }
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let text = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

func reply(_ id: Any?, ok: Bool, result: Any? = nil, error: String? = nil) {
    var obj: [String: Any] = ["id": id ?? NSNull(), "ok": ok]
    if let result { obj["result"] = result }
    if let error { obj["error"] = error }
    writeLine(obj)
}

func event(_ name: String, _ fields: [String: Any] = [:]) {
    var obj: [String: Any] = ["event": name]
    for (k, v) in fields { obj[k] = v }
    writeLine(obj)
}

// MARK: - Permissions

func avStatus(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func speechStatus(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "unknown"
    }
}

func currentPermissions() -> [String: String] {
    [
        "microphone": avStatus(AVCaptureDevice.authorizationStatus(for: .audio)),
        "speech": speechStatus(SFSpeechRecognizer.authorizationStatus())
    ]
}

// MARK: - Recognizer

final class Dictation {
    private let engine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognizer: SFSpeechRecognizer?
    private var started = false
    private var lastText = ""
    private var lastLevelAt = Date.distantPast
    private var lastSpeechAt = Date()
    private var autoStop = false
    private var silenceTimer: Timer?
    private var capTimer: Timer?

    static let hardCapSeconds: TimeInterval = 60
    static let silenceSeconds: TimeInterval = 2

    /// One-time authorizations; resolves false when either is denied.
    func requestPermissions(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { speech in
            guard speech == .authorized else {
                completion(false)
                return
            }
            let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
            if micStatus == .authorized {
                completion(true)
            } else if micStatus == .notDetermined {
                AVCaptureDevice.requestAccess(for: .audio) { granted in completion(granted) }
            } else {
                completion(false)
            }
        }
    }

    func start(localeId: String?, autoStop: Bool, completion: @escaping (String?) -> Void) {
        if started {
            completion("already recording")
            return
        }
        requestPermissions { [self] granted in
            guard granted else {
                event("error", ["message": "Microphone or speech recognition permission denied"])
                completion("permission denied")
                return
            }
            let locale = localeId.map { Locale(identifier: $0) } ?? Locale.current
            let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
            guard let recognizer, recognizer.isAvailable else {
                event("error", ["message": "Speech recognizer unavailable for \(locale.identifier)"])
                completion("recognizer unavailable")
                return
            }
            self.recognizer = recognizer
            self.autoStop = autoStop
            self.lastSpeechAt = Date()
            self.lastText = ""

            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            if recognizer.supportsOnDeviceRecognition {
                request.requiresOnDeviceRecognition = true
            }
            self.request = request

            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
                guard let self else { return }
                self.request?.append(buffer)
                self.emitLevel(buffer)
            }
            do {
                try engine.start()
            } catch {
                input.removeTap(onBus: 0)
                event("error", ["message": "Audio engine failed: \(error.localizedDescription)"])
                completion("audio engine failed")
                return
            }

            task = recognizer.recognitionTask(with: request) { [weak self] result, error in
                guard let self else { return }
                if let result {
                    let text = result.bestTranscription.formattedString
                    if text != self.lastText {
                        self.lastText = text
                        self.lastSpeechAt = Date()
                        if !result.isFinal {
                            event("partial", ["text": text])
                        }
                    }
                    if result.isFinal {
                        self.finish(finalText: self.lastText)
                        return
                    }
                }
                if let error {
                    // Cancellation by stop()/cancel() is not an error.
                    if self.started {
                        event("error", ["message": error.localizedDescription])
                        self.teardown()
                    }
                }
            }

            started = true
            capTimer = Timer.scheduledTimer(withTimeInterval: Self.hardCapSeconds, repeats: false) {
                [weak self] _ in self?.finish(finalText: self?.lastText ?? "")
            }
            if autoStop {
                silenceTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) {
                    [weak self] _ in
                    guard let self, self.started else { return }
                    if Date().timeIntervalSince(self.lastSpeechAt) >= Self.silenceSeconds {
                        self.finish(finalText: self.lastText)
                    }
                }
            }
            completion(nil)
        }
    }

    /// Compute a rough RMS level (0-1) and emit at ~15 Hz.
    private func emitLevel(_ buffer: AVAudioPCMBuffer) {
        let now = Date()
        if now.timeIntervalSince(lastLevelAt) < 0.066 { return }
        lastLevelAt = now
        guard let data = buffer.floatChannelData?[0] else { return }
        let frames = Int(buffer.frameLength)
        if frames == 0 { return }
        var sum: Float = 0
        for i in 0..<frames { sum += data[i] * data[i] }
        let rms = min(1, sqrt(sum / Float(frames)) * 4) // speech RMS is small; scale up
        event("level", ["rms": rms])
    }

    /// End the session and emit the final transcript (nil → last partial).
    func finish(finalText: String? = nil) {
        guard started else { return }
        event("final", ["text": finalText ?? lastText])
        event("stopped")
        teardown()
    }

    /// Discard the session without a final transcript.
    func discard() {
        guard started else { return }
        event("cancelled")
        teardown()
    }

    private func teardown() {
        started = false
        silenceTimer?.invalidate(); silenceTimer = nil
        capTimer?.invalidate(); capTimer = nil
        task?.cancel(); task = nil
        request?.endAudio(); request = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    var isRecording: Bool { started }
}

// MARK: - Command loop

let dictation = Dictation()

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let cmd = obj["cmd"] as? String else {
        return
    }
    let id = obj["id"]
    let args = obj["args"] as? [String: Any] ?? [:]

    switch cmd {
    case "permissions":
        reply(id, ok: true, result: currentPermissions())
    case "locales":
        let locales = SFSpeechRecognizer.supportedLocales()
            .map { $0.identifier }
            .sorted()
        reply(id, ok: true, result: ["locales": locales])
    case "start":
        let locale = args["locale"] as? String
        let autoStop = args["autoStop"] as? Bool ?? false
        dictation.start(localeId: locale, autoStop: autoStop) { error in
            if let error {
                reply(id, ok: false, error: error)
            } else {
                reply(id, ok: true, result: [:] as [String: Any])
            }
        }
    case "stop":
        reply(id, ok: true, result: [:] as [String: Any])
        dictation.finish()
    case "cancel":
        reply(id, ok: true, result: [:] as [String: Any])
        dictation.discard()
    default:
        reply(id, ok: false, error: "unknown command: \(cmd)")
    }
}

// Read stdin on a worker thread; dispatch commands on the main run loop so
// AVAudioEngine/SFSpeechRecognizer callbacks stay consistent.
Thread.detachNewThread {
    let stdin = FileHandle.standardInput
    var buffer = Data()
    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty {
            // EOF: queued handle() calls run first (FIFO), then the process
            // exits regardless of leftover run-loop sources.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                Foundation.exit(0)
            }
            return
        }
        buffer.append(chunk)
        while let idx = buffer.firstIndex(of: 0x0A) { // \n
            var line = buffer[..<idx]
            buffer = buffer[(idx + 1)...]
            if line.last == 0x0D { line = line.dropLast() } // \r
            guard !line.isEmpty, let text = String(data: line, encoding: .utf8) else { continue }
            DispatchQueue.main.async { handle(text) }
        }
    }
}

RunLoop.main.run()
