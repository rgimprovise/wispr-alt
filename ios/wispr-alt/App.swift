import SwiftUI

@main
struct WisprAltApp: App {
    @StateObject private var router = Router()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(router)
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

    var body: some View {
        switch router.screen {
        case .onboarding: OnboardingView()
        case .dictate:    DictateView()
        }
    }
}
