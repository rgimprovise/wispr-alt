import SwiftUI
import AVFoundation

/// Recording screen launched via wispralt://dictate from the keyboard.
struct DictateView: View {
    enum State {
        case idle
        case recording
        case transcribing
        case done(String)
        case error(String)
    }

    @StateObject private var recorder = AudioRecorder()
    @State private var state: State = .idle

    var body: some View {
        ZStack {
            BelovikColor.paper.ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer()

                statusBadge
                    .padding(.bottom, 8)

                Text(statusText)
                    .font(.belovikDisplay(26))
                    .foregroundStyle(BelovikColor.textPrimary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)

                if case .done(let text) = state {
                    transcriptCard(text: text)
                        .padding(.horizontal, 24)
                }

                Spacer()

                primaryButton
                    .padding(.horizontal, 24)
                    .padding(.bottom, 32)
            }
        }
        .onAppear { startRecording() }
    }

    private var statusBadge: some View {
        ZStack {
            Circle()
                .fill(badgeColor.opacity(0.10))
                .frame(width: 96, height: 96)
            Circle()
                .stroke(badgeColor.opacity(0.20), lineWidth: 1)
                .frame(width: 96, height: 96)
            Image(systemName: badgeIcon)
                .font(.system(size: 40, weight: .medium))
                .foregroundStyle(badgeColor)
        }
    }

    private var badgeIcon: String {
        switch state {
        case .idle, .recording: return "waveform"
        case .transcribing:     return "sparkles"
        case .done:             return "checkmark"
        case .error:            return "exclamationmark.triangle"
        }
    }

    private var badgeColor: Color {
        switch state {
        case .idle, .recording: return BelovikColor.rec
        case .transcribing:     return BelovikColor.transcribing
        case .done:             return BelovikColor.success
        case .error:            return BelovikColor.error
        }
    }

    private var statusText: String {
        switch state {
        case .idle:           return "Готов"
        case .recording:      return "Слушаю…"
        case .transcribing:   return "Расшифровываю"
        case .done:           return "Готово"
        case .error(let m):   return "Ошибка: \(m)"
        }
    }

    private func transcriptCard(text: String) -> some View {
        ScrollView {
            Text(text)
                .font(.belovikUI(15))
                .foregroundStyle(BelovikColor.textPrimary)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
        .background(BelovikColor.surface, in: RoundedRectangle(cornerRadius: BelovikRadius.xxl))
        .overlay(
            RoundedRectangle(cornerRadius: BelovikRadius.xxl)
                .stroke(BelovikColor.borderSubtle, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch state {
        case .recording:
            Button(action: stopAndTranscribe) {
                Label("Готово", systemImage: "stop.fill")
                    .font(.belovikUI(16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(BelovikColor.graphite, in: Capsule())
                    .foregroundStyle(BelovikColor.textInverse)
            }
        case .done:
            VStack(spacing: 10) {
                Button(action: handoffToKeyboard) {
                    Label("Передать в клавиатуру", systemImage: "keyboard")
                        .font(.belovikUI(16, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(BelovikColor.graphite, in: Capsule())
                        .foregroundStyle(BelovikColor.textInverse)
                }
                Button("Записать ещё раз", action: startRecording)
                    .font(.belovikUI(14))
                    .foregroundStyle(BelovikColor.textSecondary)
            }
        case .error:
            Button(action: startRecording) {
                Text("Попробовать снова")
                    .font(.belovikUI(16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(BelovikColor.graphite, in: Capsule())
                    .foregroundStyle(BelovikColor.textInverse)
            }
        default:
            EmptyView()
        }
    }

    private func startRecording() {
        do {
            try recorder.start()
            state = .recording
        } catch {
            state = .error("\(error)")
        }
    }

    private func stopAndTranscribe() {
        guard let wav = recorder.stop() else {
            state = .error("Запись пуста")
            return
        }
        state = .transcribing
        Task {
            do {
                let text = try await Backend.transcribe(wav: wav)
                await MainActor.run {
                    SharedStorage.savePendingTranscript(text)
                    state = .done(text)
                }
            } catch {
                await MainActor.run { state = .error("\(error)") }
            }
        }
    }

    private func handoffToKeyboard() {
        if case .done(let text) = state {
            SharedStorage.savePendingTranscript(text)
            UIPasteboard.general.string = text
            state = .done("\(text)\n\n(текст передан в клавиатуру — вернитесь в приложение)")
        }
    }
}
