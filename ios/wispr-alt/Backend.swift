import Foundation

enum Backend {
    /// Reads WISPR_BACKEND_URL from build settings (xcconfig). Falls back
    /// to the production VPS URL if missing.
    static var url: String {
        Bundle.main.object(forInfoDictionaryKey: "WISPR_BACKEND_URL") as? String
            ?? "https://alrcvscribe.n8nrgimprovise.space"
    }

    /// Thrown when the backend returns 401. The caller should drop the
    /// session via AuthSession.clear() and route the user to LoginView.
    struct AuthExpired: Error {}

    /// POSTs the WAV to /transcribe with the given cleanup style and returns
    /// the cleaned transcript. Default style is `.clean`.
    static func transcribe(
        wav: Data,
        style: DictationStyle = .clean,
        language: String = "ru"
    ) async throws -> String {
        guard let token = AuthSession.token else {
            throw AuthExpired()
        }
        let endpoint = URL(string: "\(url)/transcribe")!
        let boundary = "----wispr-\(UUID().uuidString)"

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type"
        )

        var body = Data()
        func append(_ s: String) { body.append(s.data(using: .utf8)!) }
        func appendField(_ name: String, _ value: String) {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
            append("\(value)\r\n")
        }

        // audio file
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"audio\"; filename=\"recording.wav\"\r\n")
        append("Content-Type: audio/wav\r\n\r\n")
        body.append(wav)
        append("\r\n")

        // form fields
        appendField("postprocess", "true")
        appendField("style", style.rawValue)
        appendField("language", language)

        append("--\(boundary)--\r\n")
        req.httpBody = body

        let (data, resp) = try await URLSession.shared.data(for: req)
        if let http = resp as? HTTPURLResponse, http.statusCode == 401 {
            AuthSession.clear()
            throw AuthExpired()
        }
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let snippet = String(data: data, encoding: .utf8) ?? "(non-utf8)"
            throw NSError(
                domain: "Backend",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey:
                    "HTTP \((resp as? HTTPURLResponse)?.statusCode ?? -1): \(snippet)"]
            )
        }

        struct Result: Decodable {
            let raw: String
            let clean: String
        }
        let result = try JSONDecoder().decode(Result.self, from: data)
        return result.clean.isEmpty ? result.raw : result.clean
    }
}
