import SwiftUI

/// Inline screen for setting or changing the user's password. Detects
/// whether one is already set via /auth/check-email so it knows whether
/// to require currentPassword.
struct SetPasswordView: View {
    @EnvironmentObject var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var hasExistingPassword: Bool = false
    @State private var loadingState: Bool = true
    @State private var currentPassword: String = ""
    @State private var newPassword: String = ""
    @State private var confirmPassword: String = ""
    @State private var errorMessage: String?
    @State private var successMessage: String?
    @State private var inFlight: Bool = false

    var body: some View {
        ZStack {
            BelovikColor.paper.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(hasExistingPassword ? "Сменить пароль" : "Установить пароль")
                        .font(.belovikDisplay(32))
                        .foregroundStyle(BelovikColor.textPrimary)
                        .padding(.top, 24)

                    Text("Минимум 8 символов. Используется для быстрого входа без кода из почты.")
                        .font(.belovikUI(14))
                        .foregroundStyle(BelovikColor.textSecondary)

                    if loadingState {
                        ProgressView().padding(.vertical, 32)
                    } else {
                        formFields
                    }
                }
                .padding(.horizontal, 24)
                .padding(.bottom, 32)
            }
        }
        .task { await loadState() }
    }

    private var formFields: some View {
        VStack(alignment: .leading, spacing: 12) {
            if hasExistingPassword {
                secureField("Текущий пароль", text: $currentPassword,
                            content: .password)
            }
            secureField("Новый пароль", text: $newPassword, content: .newPassword)
            secureField("Повторите пароль", text: $confirmPassword, content: .newPassword)

            if let msg = errorMessage {
                Text(msg)
                    .font(.belovikUI(13))
                    .foregroundStyle(Color(red: 185/255, green: 69/255, blue: 69/255))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        Color(red: 185/255, green: 69/255, blue: 69/255).opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
            }
            if let msg = successMessage {
                Text(msg)
                    .font(.belovikUI(13))
                    .foregroundStyle(Color(red: 74/255, green: 122/255, blue: 92/255))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        Color(red: 74/255, green: 122/255, blue: 92/255).opacity(0.10),
                        in: RoundedRectangle(cornerRadius: 8)
                    )
            }

            Button(action: submit) {
                Text(inFlight ? "Сохраняем…" : "Сохранить")
                    .font(.belovikUI(15, weight: .semibold))
                    .foregroundStyle(BelovikColor.textInverse)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(BelovikColor.graphite, in: RoundedRectangle(cornerRadius: 14))
            }
            .disabled(inFlight || newPassword.count < 8)
            .opacity(inFlight ? 0.6 : 1)

            Button("Назад") { dismiss() }
                .font(.belovikUI(14))
                .foregroundStyle(BelovikColor.textSecondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        }
    }

    private func secureField(
        _ label: String,
        text: Binding<String>,
        content: UITextContentType
    ) -> some View {
        SecureField(label, text: text)
            .textFieldStyle(.plain)
            .textContentType(content)
            .font(.belovikUI(16))
            .foregroundStyle(BelovikColor.textPrimary)
            .padding(14)
            .background(BelovikColor.surfaceSunk, in: RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .stroke(BelovikColor.borderSubtle, lineWidth: 1)
            )
    }

    private func loadState() async {
        defer { loadingState = false }
        guard let email = auth.email else { return }
        do {
            let status = try await AuthClient.checkEmail(email: email)
            hasExistingPassword = status.hasPassword
        } catch {
            // Default to "no current password" — server will reject if wrong.
            hasExistingPassword = false
        }
    }

    private func submit() {
        errorMessage = nil
        successMessage = nil
        guard newPassword.count >= 8 else {
            errorMessage = "Пароль должен быть минимум 8 символов"
            return
        }
        guard newPassword == confirmPassword else {
            errorMessage = "Пароли не совпадают"
            return
        }
        if hasExistingPassword && currentPassword.isEmpty {
            errorMessage = "Введите текущий пароль"
            return
        }
        guard let token = auth.token else {
            errorMessage = "Сессия истекла, войдите заново"
            return
        }
        inFlight = true
        Task {
            defer { inFlight = false }
            do {
                try await AuthClient.setPassword(
                    token: token,
                    newPassword: newPassword,
                    currentPassword: currentPassword.isEmpty ? nil : currentPassword
                )
                successMessage = "Пароль сохранён"
                hasExistingPassword = true
                currentPassword = ""
                newPassword = ""
                confirmPassword = ""
            } catch let err as AuthClient.AuthError {
                errorMessage = err.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}
