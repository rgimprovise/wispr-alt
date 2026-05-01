import Foundation
import Combine

/// Persists the JWT issued by /auth/verify, plus the user's email.
/// Standard UserDefaults — only the main app talks to the backend; the
/// keyboard extension never sees this. Move to Keychain when the threat
/// model demands it.
@MainActor
final class AuthStore: ObservableObject {
    private static let tokenKey = "auth.token"
    private static let emailKey = "auth.email"

    @Published private(set) var token: String?
    @Published private(set) var email: String?

    var isSignedIn: Bool { token != nil }

    init() {
        self.token = UserDefaults.standard.string(forKey: Self.tokenKey)
        self.email = UserDefaults.standard.string(forKey: Self.emailKey)
    }

    func save(token: String, email: String) {
        UserDefaults.standard.set(token, forKey: Self.tokenKey)
        UserDefaults.standard.set(email, forKey: Self.emailKey)
        self.token = token
        self.email = email
    }

    func clear() {
        UserDefaults.standard.removeObject(forKey: Self.tokenKey)
        UserDefaults.standard.removeObject(forKey: Self.emailKey)
        self.token = nil
        self.email = nil
    }
}

/// Exposes the session token to non-actor-isolated callers (e.g. URLSession
/// request setup). Reads UserDefaults directly so it works without an
/// AuthStore instance in scope. Stays in sync because save()/clear() also
/// write through UserDefaults.
enum AuthSession {
    static var token: String? {
        UserDefaults.standard.string(forKey: "auth.token")
    }
    static func clear() {
        UserDefaults.standard.removeObject(forKey: "auth.token")
        UserDefaults.standard.removeObject(forKey: "auth.email")
    }
}
