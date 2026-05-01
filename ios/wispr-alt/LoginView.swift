import SwiftUI

/// Two-step email magic-link / OTP login. Mirrors the desktop and Android
/// auth gates. Shown by RootView when AuthStore has no token.
struct LoginView: View {
    @EnvironmentObject var auth: AuthStore

    private enum Step {
        case email
        case code
    }

    @State private var step: Step = .email
    @State private var email: String = ""
    @State private var code: String = ""
    @State private var pendingEmail: String = ""
    @State private var errorMessage: String?
    @State private var inFlight: Bool = false

    var body: some View {
        ZStack {
            BelovikColor.paper.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                        .padding(.top, 48)

                    Group {
                        switch step {
                        case .email: emailStep
                        case .code:  codeStep
                        }
                    }
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 32)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Беловик")
                .font(.belovikDisplay(36))
                .foregroundStyle(BelovikColor.textPrimary)
            Text("Голосовой интерфейс для работы с текстом")
                .font(.belovikUI(14))
                .foregroundStyle(BelovikColor.textSecondary)
        }
    }

    // ─── Step 1 — email ─────────────────────────────────────────────────

    private var emailStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            card(title: "Вход", body: "Введите email — пришлём 6-значный код.")

            TextField("you@example.com", text: $email)
                .textFieldStyle(.plain)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(.belovikUI(16))
                .foregroundStyle(BelovikColor.textPrimary)
                .padding(14)
                .background(BelovikColor.surfaceSunk, in: RoundedRectangle(cornerRadius: 14))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(BelovikColor.borderSubtle, lineWidth: 1)
                )

            errorRow

            Button(action: submitEmail) {
                Text(inFlight ? "Отправляем…" : "Прислать код")
                    .font(.belovikUI(15, weight: .semibold))
                    .foregroundStyle(BelovikColor.textInverse)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(BelovikColor.graphite, in: RoundedRectangle(cornerRadius: 14))
            }
            .disabled(inFlight || email.trimmingCharacters(in: .whitespaces).isEmpty)
            .opacity(inFlight ? 0.6 : 1)
        }
    }

    private func submitEmail() {
        let normalized = email.trimmingCharacters(in: .whitespaces).lowercased()
        guard isValidEmail(normalized) else {
            errorMessage = "Неверный email"
            return
        }
        errorMessage = nil
        inFlight = true
        Task {
            defer { inFlight = false }
            do {
                try await AuthClient.requestCode(email: normalized)
                pendingEmail = normalized
                code = ""
                step = .code
            } catch let err as AuthClient.AuthError {
                errorMessage = err.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // ─── Step 2 — code ──────────────────────────────────────────────────

    private var codeStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Введите код")
                    .font(.belovikDisplay(28))
                    .foregroundStyle(BelovikColor.textPrimary)
                Text("Код отправлен на \(pendingEmail). Действует 10 минут.")
                    .font(.belovikUI(14))
                    .foregroundStyle(BelovikColor.textSecondary)
            }

            TextField("123456", text: $code)
                .textFieldStyle(.plain)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.system(size: 28, weight: .semibold, design: .monospaced))
                .tracking(8)
                .multilineTextAlignment(.center)
                .foregroundStyle(BelovikColor.textPrimary)
                .padding(14)
                .background(BelovikColor.surfaceSunk, in: RoundedRectangle(cornerRadius: 14))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(BelovikColor.borderSubtle, lineWidth: 1)
                )
                .onChange(of: code) { _, newVal in
                    // Strip non-digits and clamp to 6 chars.
                    let cleaned = newVal.filter(\.isNumber).prefix(6)
                    if cleaned != newVal { code = String(cleaned) }
                }

            errorRow

            Button(action: submitCode) {
                Text(inFlight ? "Проверяем…" : "Войти")
                    .font(.belovikUI(15, weight: .semibold))
                    .foregroundStyle(BelovikColor.textInverse)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(BelovikColor.graphite, in: RoundedRectangle(cornerRadius: 14))
            }
            .disabled(inFlight || code.count != 6)
            .opacity(inFlight ? 0.6 : 1)

            Button("Указать другой email") {
                pendingEmail = ""
                errorMessage = nil
                code = ""
                step = .email
            }
            .font(.belovikUI(14))
            .foregroundStyle(BelovikColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
    }

    private func submitCode() {
        guard code.count == 6, code.allSatisfy(\.isNumber) else {
            errorMessage = "Код состоит из 6 цифр"
            return
        }
        errorMessage = nil
        inFlight = true
        Task {
            defer { inFlight = false }
            do {
                let session = try await AuthClient.verifyCode(
                    email: pendingEmail, code: code
                )
                auth.save(token: session.token, email: session.email)
            } catch let err as AuthClient.AuthError {
                errorMessage = err.errorDescription
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────

    @ViewBuilder
    private var errorRow: some View {
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
    }

    private func card(title: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.belovikUI(17, weight: .semibold))
                .foregroundStyle(BelovikColor.textPrimary)
            Text(body)
                .font(.belovikUI(13))
                .foregroundStyle(BelovikColor.textSecondary)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(BelovikColor.surface, in: RoundedRectangle(cornerRadius: 20))
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .stroke(BelovikColor.borderSubtle, lineWidth: 1)
        )
    }

    private func isValidEmail(_ s: String) -> Bool {
        let pattern = #"^[^\s@]+@[^\s@]+\.[^\s@]+$"#
        return s.range(of: pattern, options: .regularExpression) != nil
    }
}
