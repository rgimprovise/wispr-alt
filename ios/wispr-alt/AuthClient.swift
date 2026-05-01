import Foundation

/// Thin URLSession wrapper around /auth/request and /auth/verify on the
/// backend. Pure async functions, no UI types — call from any context.
enum AuthClient {
    struct Session {
        let token: String
        let email: String
    }

    enum AuthError: LocalizedError {
        case server(String)
        case network(String)

        var errorDescription: String? {
            switch self {
            case .server(let m), .network(let m): return m
            }
        }
    }

    /// POST /auth/request — emails a 6-digit code to [email].
    static func requestCode(email: String) async throws {
        let url = URL(string: "\(Backend.url)/auth/request")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["email": email],
            options: []
        )

        let (data, resp) = try await URLSession.shared.data(for: req)
        try ensureOk(data: data, resp: resp)
    }

    /// POST /auth/verify — exchanges the code for a JWT.
    static func verifyCode(email: String, code: String) async throws -> Session {
        let url = URL(string: "\(Backend.url)/auth/verify")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["email": email, "code": code],
            options: []
        )

        let (data, resp) = try await URLSession.shared.data(for: req)
        try ensureOk(data: data, resp: resp)

        struct VerifyResponse: Decodable {
            let token: String
            let user: User
            struct User: Decodable { let id: String; let email: String }
        }
        let decoded = try JSONDecoder().decode(VerifyResponse.self, from: data)
        return Session(token: decoded.token, email: decoded.user.email)
    }

    private static func ensureOk(data: Data, resp: URLResponse) throws {
        guard let http = resp as? HTTPURLResponse else {
            throw AuthError.network("invalid response")
        }
        if (200..<300).contains(http.statusCode) { return }
        // Try to surface the backend's `error` field; fall back to status code.
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let msg = obj["error"] as? String, !msg.isEmpty {
            throw AuthError.server(msg)
        }
        throw AuthError.server("HTTP \(http.statusCode)")
    }
}
