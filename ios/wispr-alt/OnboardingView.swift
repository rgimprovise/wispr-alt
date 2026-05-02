import SwiftUI
import AVFoundation

struct OnboardingView: View {
    @State private var micGranted = false
    @State private var showingSetPassword = false
    @State private var passwordIsSet: Bool? = nil
    @AppStorage("setPasswordBannerDismissed") private var bannerDismissed = false
    @EnvironmentObject private var auth: AuthStore

    var body: some View {
        ZStack {
            AgolosColor.paper.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("А-ГОЛОС")
                        .font(.agolosDisplay(40))
                        .foregroundStyle(AgolosColor.textPrimary)
                        .padding(.top, 24)

                    Text("Скажите мысль. Получите текст.")
                        .font(.agolosUI(15))
                        .foregroundStyle(AgolosColor.textSecondary)

                    Spacer().frame(height: 8)

                    if passwordIsSet == false && !bannerDismissed {
                        setPasswordBanner
                    }

                    stepCard(
                        index: 1,
                        title: "Разрешить микрофон",
                        body: "Нужен чтобы записывать вашу речь. Аудио шифруется и не сохраняется.",
                        done: micGranted,
                        cta: "Разрешить",
                        action: requestMic
                    )

                    stepCard(
                        index: 2,
                        title: "Включить клавиатуру в настройках",
                        body: "Settings → General → Keyboard → Keyboards → Add New Keyboard… → А-ГОЛОС",
                        done: false,
                        cta: "Открыть настройки",
                        action: openSettings
                    )

                    stepCard(
                        index: 3,
                        title: "Включить Allow Full Access",
                        body: "В том же экране тапните по клавиатуре «А-ГОЛОС» и включите Allow Full Access — это нужно для сетевых запросов и микрофона.",
                        done: false,
                        cta: "Открыть настройки",
                        action: openSettings
                    )

                    Spacer().frame(height: 16)

                    instructionsCard

                    Spacer().frame(height: 16)

                    accountCard

                    Spacer().frame(height: 40)
                }
                .padding(.horizontal, 24)
            }
        }
        .onAppear {
            refreshMicStatus()
            Task { await refreshPasswordStatus() }
        }
        .sheet(isPresented: $showingSetPassword, onDismiss: {
            Task { await refreshPasswordStatus() }
        }) {
            SetPasswordView()
                .environmentObject(auth)
        }
    }

    private var setPasswordBanner: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Установите пароль")
                .font(.agolosUI(15, weight: .semibold))
                .foregroundStyle(AgolosColor.textPrimary)
            Text("В следующий раз войдёте без кода из почты.")
                .font(.agolosUI(13))
                .foregroundStyle(AgolosColor.textSecondary)
            HStack(spacing: 8) {
                Button("Установить") { showingSetPassword = true }
                    .font(.agolosUI(13, weight: .semibold))
                    .foregroundStyle(AgolosColor.textInverse)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(AgolosColor.graphite, in: RoundedRectangle(cornerRadius: 12))
                Button("Позже") { bannerDismissed = true }
                    .font(.agolosUI(13, weight: .semibold))
                    .foregroundStyle(AgolosColor.textPrimary)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(AgolosColor.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12)
                            .stroke(AgolosColor.borderSubtle, lineWidth: 1)
                    )
            }
            .padding(.top, 4)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AgolosColor.surfaceMint, in: RoundedRectangle(cornerRadius: AgolosRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: AgolosRadius.lg)
                .stroke(AgolosColor.borderSubtle, lineWidth: 1)
        )
    }

    private func refreshPasswordStatus() async {
        guard let email = auth.email else { return }
        do {
            let status = try await AuthClient.checkEmail(email: email)
            await MainActor.run { passwordIsSet = status.hasPassword }
        } catch {
            // leave nil — banner stays hidden until we know for sure
        }
    }

    private func stepCard(
        index: Int,
        title: String,
        body: String,
        done: Bool,
        cta: String,
        action: @escaping () -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                ZStack {
                    Circle()
                        .fill(done ? AgolosColor.success : AgolosColor.graphite)
                        .frame(width: 28, height: 28)
                    if done {
                        Image(systemName: "checkmark")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                    } else {
                        Text("\(index)")
                            .font(.agolosUI(13, weight: .bold))
                            .foregroundStyle(.white)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.agolosUI(16, weight: .semibold))
                        .foregroundStyle(AgolosColor.textPrimary)
                    Text(body)
                        .font(.agolosUI(13))
                        .foregroundStyle(AgolosColor.textSecondary)
                        .lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !done {
                Button(action: action) {
                    Text(cta)
                        .font(.agolosUI(14, weight: .semibold))
                        .foregroundStyle(AgolosColor.textInverse)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(AgolosColor.graphite, in: RoundedRectangle(cornerRadius: AgolosRadius.md))
                }
            }
        }
        .padding(20)
        .background(AgolosColor.surface, in: RoundedRectangle(cornerRadius: AgolosRadius.xxl))
        .overlay(
            RoundedRectangle(cornerRadius: AgolosRadius.xxl)
                .stroke(AgolosColor.borderSubtle, lineWidth: 1)
        )
    }

    private var instructionsCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Как использовать")
                .font(.agolosUI(14, weight: .bold))
                .foregroundStyle(AgolosColor.textPrimary)
                .textCase(.uppercase)
                .tracking(0.6)
            Text(
                "В любом приложении тапните в текстовое поле. Удерживайте 🌐 на клавиатуре → выберите А-ГОЛОС. Тап 🎤 → говорите → текст вставится автоматически."
            )
            .font(.agolosUI(13))
            .foregroundStyle(AgolosColor.textSecondary)
            .lineSpacing(3)
        }
        .padding(20)
        .background(AgolosColor.surfaceMint, in: RoundedRectangle(cornerRadius: AgolosRadius.lg))
    }

    private var accountCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Аккаунт")
                .font(.agolosUI(14, weight: .bold))
                .foregroundStyle(AgolosColor.textPrimary)
                .textCase(.uppercase)
                .tracking(0.6)
            Text(auth.email ?? "—")
                .font(.agolosUI(15))
                .foregroundStyle(AgolosColor.textSecondary)
            HStack(spacing: 12) {
                Button("Установить / сменить пароль") {
                    showingSetPassword = true
                }
                .font(.agolosUI(13, weight: .semibold))
                .foregroundStyle(AgolosColor.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(AgolosColor.surfaceSunk, in: RoundedRectangle(cornerRadius: 12))

                Button("Выйти") {
                    if let token = auth.token {
                        // Best-effort server logout. Fire and forget.
                        Task { await AuthClient.logout(token: token) }
                    }
                    auth.clear()
                }
                .font(.agolosUI(13, weight: .semibold))
                .foregroundStyle(AgolosColor.textPrimary)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(AgolosColor.surfaceSunk, in: RoundedRectangle(cornerRadius: 12))
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AgolosColor.surface, in: RoundedRectangle(cornerRadius: AgolosRadius.lg))
        .overlay(
            RoundedRectangle(cornerRadius: AgolosRadius.lg)
                .stroke(AgolosColor.borderSubtle, lineWidth: 1)
        )
    }

    private func refreshMicStatus() {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: micGranted = true
        default: micGranted = false
        }
    }

    private func requestMic() {
        AVAudioApplication.requestRecordPermission { granted in
            DispatchQueue.main.async { micGranted = granted }
        }
    }

    private func openSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
