import Foundation

/// Thin URLSession wrapper around /auth/request and /auth/verify on the
/// backend. Pure async functions, no UI types — call from any context.
enum AuthClient {
    struct Session {
        let token: String
        let email: String
    }

    struct EmailStatus {
        let exists: Bool
        let hasPassword: Bool
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

    /// POST /auth/check-email — tells the client password vs OTP path.
    static func checkEmail(email: String) async throws -> EmailStatus {
        let url = URL(string: "\(Backend.url)/auth/check-email")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["email": email], options: []
        )
        let (data, resp) = try await URLSession.shared.data(for: req)
        try ensureOk(data: data, resp: resp)
        struct Response: Decodable { let exists: Bool; let hasPassword: Bool }
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        return EmailStatus(exists: decoded.exists, hasPassword: decoded.hasPassword)
    }

    /// POST /auth/login — email + password → JWT.
    static func login(email: String, password: String) async throws -> Session {
        let url = URL(string: "\(Backend.url)/auth/login")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(
            withJSONObject: ["email": email, "password": password], options: []
        )
        let (data, resp) = try await URLSession.shared.data(for: req)
        try ensureOk(data: data, resp: resp)
        struct Response: Decodable {
            let token: String
            let user: User
            struct User: Decodable { let id: String; let email: String }
        }
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        return Session(token: decoded.token, email: decoded.user.email)
    }

    /// POST /auth/set-password — Bearer-gated. currentPassword required
    /// only when one is already set.
    static func setPassword(
        token: String,
        newPassword: String,
        currentPassword: String?
    ) async throws {
        let url = URL(string: "\(Backend.url)/auth/set-password")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        var payload: [String: String] = ["newPassword": newPassword]
        if let cur = currentPassword, !cur.isEmpty {
            payload["currentPassword"] = cur
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: payload, options: [])
        let (data, resp) = try await URLSession.shared.data(for: req)
        try ensureOk(data: data, resp: resp)
    }

    /// POST /auth/logout — best-effort acknowledgement.
    static func logout(token: String) async {
        let url = URL(string: "\(Backend.url)/auth/logout")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        _ = try? await URLSession.shared.data(for: req)
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
