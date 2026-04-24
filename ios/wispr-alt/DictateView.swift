import SwiftUI
import AVFoundation

/// Recording screen launched via wispralt://dictate from the keyboard.
struct DictateView: View {
    enum State { case idle, recording, transcribing, done(String), error(String) }

    @StateObject private var recorder = AudioRecorder()
    @State private var state: State = .idle

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            statusIcon
                .font(.system(size: 80))

            Text(statusText)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            if case .done(let text) = state {
                ScrollView {
                    Text(text)
                        .font(.body)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .frame(maxHeight: 220)
                .padding(.horizontal)
            }

            Spacer()

            primaryButton
        }
        .padding(.bottom, 40)
        .onAppear { startRecording() }
    }

    private var statusIcon: some View {
        switch state {
        case .idle, .recording:
            return Image(systemName: "mic.fill").foregroundStyle(.red)
        case .transcribing:
            return Image(systemName: "waveform").foregroundStyle(.orange)
        case .done:
            return Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .error:
            return Image(systemName: "xmark.octagon.fill").foregroundStyle(.red)
        }
    }

    private var statusText: String {
        switch state {
        case .idle: return "Готов к записи"
        case .recording: return "Говорите…\nЗатем нажмите «Готово»"
        case .transcribing: return "Распознаю…"
        case .done: return "Готово — переключитесь обратно в приложение"
        case .error(let msg): return "Ошибка: \(msg)"
        }
    }

    @ViewBuilder
    private var primaryButton: some View {
        switch state {
        case .recording:
            Button {
                stopAndTranscribe()
            } label: {
                Label("Готово", systemImage: "stop.circle.fill")
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.red)
                    .foregroundStyle(.white)
                    .clipShape(Capsule())
            }
            .padding(.horizontal)
        case .done(let text):
            VStack(spacing: 8) {
                Button {
                    SharedStorage.savePendingTranscript(text)
                    UIPasteboard.general.string = text
                    // Show simple confirmation; iOS doesn't allow programmatic
                    // app-switching so user must swipe back to source app.
                    state = .done("\(text)\n\n(текст сохранён, вернитесь в приложение)")
                } label: {
                    Label("Передать в клавиатуру", systemImage: "keyboard")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)

                Button("Записать ещё раз") { startRecording() }
                    .font(.subheadline)
            }
        case .error:
            Button("Попробовать снова") { startRecording() }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)
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
}
