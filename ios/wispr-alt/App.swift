import SwiftUI

@main
struct WisprAltApp: App {
    @StateObject private var router = Router()
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(router)
                .environmentObject(auth)
                .onOpenURL { handleDeepLink($0) }
        }
    }

    /// Two URL schemes are registered for the app:
    ///   - `wispralt://` — internal, between the keyboard extension and the
    ///     main app (e.g. `wispralt://dictate` to open the recorder).
    ///   - `belovik://`  — external, used in magic-link emails. We accept
    ///     `belovik://auth?token=…&email=…` to sign the user in directly.
    private func handleDeepLink(_ url: URL) {
        if url.scheme == "belovik", url.host == "auth" {
            let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let items = comps?.queryItems ?? []
            let token = items.first { $0.name == "token" }?.value
            let email = items.first { $0.name == "email" }?.value
            if let token, !token.isEmpty {
                auth.save(token: token, email: email ?? auth.email ?? "")
            }
            return
        }
        router.handleDeepLink(url)
    }
}

/// Routes between onboarding and the record screen depending on whether
/// we were launched via the wispralt://dictate deep link from the keyboard.
final class Router: ObservableObject {
    enum Screen { case onboarding, dictate }

    @Published var screen: Screen = .onboarding

    func handleDeepLink(_ url: URL) {
        guard url.scheme == "wispralt" else { return }
        if url.host == "dictate" {
            screen = .dictate
        }
    }
}

struct RootView: View {
    @EnvironmentObject var router: Router
    @EnvironmentObject var auth: AuthStore

    var body: some View {
        // Auth gate: until a JWT exists, show LoginView. Everything else
        // (deep-link routing, onboarding) sits behind it.
        if !auth.isSignedIn {
            LoginView()
        } else {
            switch router.screen {
            case .onboarding: OnboardingView()
            case .dictate:    DictateView()
            }
        }
    }
}
