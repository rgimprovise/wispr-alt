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
                .onOpenURL { router.handleDeepLink($0) }
        }
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
