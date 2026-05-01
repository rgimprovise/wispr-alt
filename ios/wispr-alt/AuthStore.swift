import Foundation
import Combine

/// Persists the JWT issued by /auth/verify, plus the user's email.
///
/// v0.x and earlier used UserDefaults (plaintext on disk). Current
/// builds use the iOS Keychain via [Keychain]. On first launch after
/// upgrade we migrate the old UserDefaults entries into the Keychain
/// and wipe them.
@MainActor
final class AuthStore: ObservableObject {
    private static let tokenKey = "auth.token"
    private static let emailKey = "auth.email"

    @Published private(set) var token: String?
    @Published private(set) var email: String?

    var isSignedIn: Bool { token != nil }

    init() {
        Self.migrateFromUserDefaultsIfNeeded()
        self.token = Keychain.string(forKey: Self.tokenKey)
        self.email = Keychain.string(forKey: Self.emailKey)
    }

    func save(token: String, email: String) {
        Keychain.set(token, forKey: Self.tokenKey)
        Keychain.set(email, forKey: Self.emailKey)
        self.token = token
        self.email = email
    }

    func clear() {
        Keychain.remove(forKey: Self.tokenKey)
        Keychain.remove(forKey: Self.emailKey)
        self.token = nil
        self.email = nil
    }

    /// One-shot migration of plaintext UserDefaults entries (≤v0.3) into
    /// the Keychain. Idempotent — fresh installs and post-migration
    /// launches both no-op.
    private static func migrateFromUserDefaultsIfNeeded() {
        let defaults = UserDefaults.standard
        guard let legacyToken = defaults.string(forKey: tokenKey),
              !legacyToken.isEmpty else { return }
        let legacyEmail = defaults.string(forKey: emailKey) ?? ""
        if Keychain.string(forKey: tokenKey) == nil {
            Keychain.set(legacyToken, forKey: tokenKey)
            Keychain.set(legacyEmail, forKey: emailKey)
        }
        defaults.removeObject(forKey: tokenKey)
        defaults.removeObject(forKey: emailKey)
    }
}

/// Exposes the session token to non-actor-isolated callers (e.g. URLSession
/// request setup). Reads the Keychain directly so it works without an
/// AuthStore instance in scope.
enum AuthSession {
    static var token: String? {
        Keychain.string(forKey: "auth.token")
    }
    static func clear() {
        Keychain.remove(forKey: "auth.token")
        Keychain.remove(forKey: "auth.email")
    }
}
