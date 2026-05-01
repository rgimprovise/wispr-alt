import SwiftUI
import AVFoundation

/// Recording screen launched via agolos://dictate from the keyboard.
struct DictateView: View {
    enum Phase {
        case idle
        case recording
        case transcribing
        case done(String)
        case error(String)
    }

    @StateObject private var recorder = AudioRecorder()
    @StateObject private var styleStore = StyleStore()
    @EnvironmentObject private var auth: AuthStore
    @State private var state: Phase = .idle
    @State private var showingStylePicker = false

    var body: some View {
        ZStack {
            AgolosColor.paper.ignoresSafeArea()

            VStack(spacing: 24) {
                styleChip
                    .padding(.top, 16)

                Spacer()

                statusBadge
                    .padding(.bottom, 8)

                Text(statusText)
                    .font(.agolosDisplay(26))
                    .foregroundStyle(AgolosColor.textPrimary)
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
        .confirmationDialog(
            "Стиль обработки",
            isPresented: $showingStylePicker,
            titleVisibility: .visible
        ) {
            ForEach(DictationStyle.allCases) { style in
                Button(style.label) { styleStore.current = style }
            }
            Button("Отмена", role: .cancel) {}
        } message: {
            Text(styleStore.current.hint)
        }
    }

    /// Compact pill at the top showing the active style. Tap = open picker.
    private var styleChip: some View {
        Button { showingStylePicker = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "wand.and.stars")
                    .font(.system(size: 11, weight: .medium))
                Text(styleStore.current.label)
                    .font(.agolosUI(12, weight: .semibold))
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .foregroundStyle(AgolosColor.textPrimary)
            .background(AgolosColor.surface, in: Capsule())
            .overlay(Capsule().stroke(AgolosColor.borderSubtle, lineWidth: 1))
        }
        .buttonStyle(.plain)
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
        case .idle, .recording: return AgolosColor.rec
        case .transcribing:     return AgolosColor.transcribing
        case .done:             return AgolosColor.success
        case .error:            return AgolosColor.error
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
                .font(.agolosUI(15))
                .foregroundStyle(AgolosColor.textPrimary)
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 220)
        .background(AgolosColor.surface, in: RoundedRectangle(cornerRadius: AgolosRadius.xxl))
        .overlay(
            RoundedRectangle(cornerRadius: AgolosRadius.xxl)
                .stroke(AgolosColor.borderSubtle, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch state {
        case .recording:
            Button(action: stopAndTranscribe) {
                Label("Готово", systemImage: "stop.fill")
                    .font(.agolosUI(16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(AgolosColor.graphite, in: Capsule())
                    .foregroundStyle(AgolosColor.textInverse)
            }
        case .done:
            VStack(spacing: 10) {
                Button(action: handoffToKeyboard) {
                    Label("Передать в клавиатуру", systemImage: "keyboard")
                        .font(.agolosUI(16, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(AgolosColor.graphite, in: Capsule())
                        .foregroundStyle(AgolosColor.textInverse)
                }
                Button("Записать ещё раз", action: startRecording)
                    .font(.agolosUI(14))
                    .foregroundStyle(AgolosColor.textSecondary)
            }
        case .error:
            Button(action: startRecording) {
                Text("Попробовать снова")
                    .font(.agolosUI(16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(AgolosColor.graphite, in: Capsule())
                    .foregroundStyle(AgolosColor.textInverse)
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
        let style = styleStore.current
        Task {
            do {
                let text = try await Backend.transcribe(wav: wav, style: style)
                await MainActor.run {
                    SharedStorage.savePendingTranscript(text)
                    state = .done(text)
                }
            } catch is Backend.AuthExpired {
                // Backend already cleared the persisted token; sync the
                // observable so RootView swaps to LoginView.
                await MainActor.run { auth.clear() }
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
