import SwiftUI
import AVFoundation

struct OnboardingView: View {
    @State private var micGranted = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("wispr-alt")
                .font(.largeTitle.weight(.bold))
            Text("Клавиатура с голосовым вводом")
                .foregroundStyle(.secondary)

            Divider().padding(.vertical, 8)

            stepRow(
                index: 1,
                title: "Разрешить микрофон",
                done: micGranted,
                action: requestMic
            )

            stepRow(
                index: 2,
                title: "Включить wispr-alt в настройках",
                hint: "Settings → General → Keyboard → Keyboards → Add New Keyboard… → wispr-alt",
                done: false,
                action: openKeyboardSettings
            )

            stepRow(
                index: 3,
                title: "Включить Allow Full Access",
                hint: "В том же экране настроек у клавиатуры wispr-alt включите тоггл Allow Full Access — нужен для сетевых запросов и микрофона",
                done: false,
                action: openKeyboardSettings
            )

            Spacer()

            Text("Использование:\n• В любом приложении тапни в текстовое поле\n• Свайпни вверх по globe-кнопке клавиатуры (или удерживай 🌐) → выбери wispr-alt\n• Тапни 🎤 → говори → продиктованный текст автоматически вставится в поле")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(24)
        .onAppear { refreshMicStatus() }
    }

    private func stepRow(
        index: Int,
        title: String,
        hint: String? = nil,
        done: Bool,
        action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top) {
            Image(systemName: done ? "checkmark.circle.fill" : "\(index).circle")
                .foregroundStyle(done ? .green : .accentColor)
                .imageScale(.large)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.body.weight(.medium))
                if let hint {
                    Text(hint).font(.caption).foregroundStyle(.secondary)
                }
                Button("Открыть", action: action)
                    .font(.caption.weight(.semibold))
            }
        }
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

    private func openKeyboardSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }
}
