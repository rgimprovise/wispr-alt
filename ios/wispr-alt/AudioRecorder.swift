import AVFoundation

/// Wraps AVAudioRecorder to capture mono 16 kHz PCM-16 WAV in a temp file.
final class AudioRecorder: ObservableObject {
    private var recorder: AVAudioRecorder?
    private var url: URL?

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .default, options: [])
        try session.setActive(true)

        let dir = FileManager.default.temporaryDirectory
        let file = dir.appendingPathComponent("wispr-\(UUID().uuidString).wav")
        url = file

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]

        let r = try AVAudioRecorder(url: file, settings: settings)
        r.prepareToRecord()
        if !r.record() {
            throw NSError(domain: "Recorder", code: 1)
        }
        recorder = r
    }

    /// Stops recording and returns the WAV file contents in memory.
    func stop() -> Data? {
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        guard let url else { return nil }
        return try? Data(contentsOf: url)
    }
}
