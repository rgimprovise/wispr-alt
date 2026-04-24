import Foundation

enum Backend {
    /// Reads WISPR_BACKEND_URL from build settings (xcconfig). Falls back
    /// to the production VPS URL if missing.
    static var url: String {
        Bundle.main.object(forInfoDictionaryKey: "WISPR_BACKEND_URL") as? String
            ?? "https://alrcvscribe.n8nrgimprovise.space"
    }

    /// POSTs the WAV to /transcribe and returns the cleaned transcript.
    static func transcribe(wav: Data) async throws -> String {
        let endpoint = URL(string: "\(url)/transcribe")!
        let boundary = "----wispr-\(UUID().uuidString)"

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }

        // audio file part
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n")
        append("Content-Type: audio/wav\r\n\r\n")
        body.append(wav)
        append("\r\n")

        // postprocess flag
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"postprocess\"\r\n\r\n")
        append("true\r\n")

        append("--\(boundary)--\r\n")
        req.httpBody = body

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let snippet = String(data: data, encoding: .utf8) ?? "(non-utf8)"
            throw NSError(
                domain: "Backend",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1): \(snippet)"]
            )
        }

        struct Result: Decodable { let raw: String; let clean: String }
        let result = try JSONDecoder().decode(Result.self, from: data)
        return result.clean.isEmpty ? result.raw : result.clean
    }
}

// Add WISPR_BACKEND_URL key to the main app's Info.plist so xcconfig
// substitution picks it up. (Done via Info.plist additions in xcodegen.)
