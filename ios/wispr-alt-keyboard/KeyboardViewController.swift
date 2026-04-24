import UIKit

/// Keyboard extension. Two layouts (EN QWERTY / RU ЙЦУКЕН) plus a
/// prominent microphone key. The mic key opens the main wispr-alt app
/// via the wispralt:// URL scheme; the main app records and writes the
/// transcript to a shared App Group. On every viewWillAppear we poll
/// the shared store and commit any pending text to the active field.
final class KeyboardViewController: UIInputViewController {

    private enum Lang { case en, ru }

    private var currentLang: Lang = .en
    private var shiftOn = false

    private var keyboardStack: UIStackView!
    private var statusLabel: UILabel!

    // Layouts (3 letter rows each).
    private let rowsEN = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
    private let rowsRU = ["йцукенгшщзх", "фывапролджэ", "ячсмитьбю"]

    // ─── Lifecycle ────────────────────────────────────────────────────────

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 14/255, green: 14/255, blue: 16/255, alpha: 1)

        statusLabel = UILabel()
        statusLabel.text = "wispr-alt"
        statusLabel.textColor = UIColor(white: 0.6, alpha: 1)
        statusLabel.font = .systemFont(ofSize: 11, weight: .medium)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false

        keyboardStack = UIStackView()
        keyboardStack.axis = .vertical
        keyboardStack.spacing = 6
        keyboardStack.distribution = .fillEqually
        keyboardStack.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(statusLabel)
        view.addSubview(keyboardStack)

        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),

            keyboardStack.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 6),
            keyboardStack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 6),
            keyboardStack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -6),
            keyboardStack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -8),
            keyboardStack.heightAnchor.constraint(equalToConstant: 220),
        ])

        rebuildKeyboard()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // If main app finished a dictation while we were away, commit it.
        if let pending = SharedStorage.consumePendingTranscript() {
            textDocumentProxy.insertText(pending)
            flashStatus("✓ вставлено")
        }
    }

    // ─── Build keyboard ───────────────────────────────────────────────────

    private func rebuildKeyboard() {
        keyboardStack.arrangedSubviews.forEach { $0.removeFromSuperview() }

        let rows = currentLang == .en ? rowsEN : rowsRU
        for (i, row) in rows.enumerated() {
            let rowStack = makeRow()

            if i == 2 {
                rowStack.addArrangedSubview(makeKey("⇧", weight: 1.5) { [weak self] _ in
                    self?.shiftOn.toggle(); self?.rebuildKeyboard()
                })
            }

            for ch in row {
                let display = shiftOn ? String(ch).uppercased() : String(ch)
                rowStack.addArrangedSubview(makeKey(display) { [weak self] _ in
                    self?.textDocumentProxy.insertText(display)
                    if self?.shiftOn == true {
                        self?.shiftOn = false
                        self?.rebuildKeyboard()
                    }
                })
            }

            if i == 2 {
                rowStack.addArrangedSubview(makeKey("⌫", weight: 1.5) { [weak self] _ in
                    self?.textDocumentProxy.deleteBackward()
                })
            }

            keyboardStack.addArrangedSubview(rowStack)
        }

        // Bottom row: lang switch | 🌐 | 🎤 | space | , . | enter
        let bottom = makeRow()
        bottom.addArrangedSubview(makeKey(currentLang == .en ? "RU" : "EN", weight: 1.2) { [weak self] _ in
            self?.currentLang = self?.currentLang == .en ? .ru : .en
            self?.rebuildKeyboard()
        })
        bottom.addArrangedSubview(makeKey("🌐", weight: 1.2) { [weak self] _ in
            self?.advanceToNextInputMode()
        })
        bottom.addArrangedSubview(makeMicKey())
        bottom.addArrangedSubview(makeKey(" ", weight: 4) { [weak self] _ in
            self?.textDocumentProxy.insertText(" ")
        })
        bottom.addArrangedSubview(makeKey(",", weight: 0.9) { [weak self] _ in
            self?.textDocumentProxy.insertText(",")
        })
        bottom.addArrangedSubview(makeKey(".", weight: 0.9) { [weak self] _ in
            self?.textDocumentProxy.insertText(".")
        })
        bottom.addArrangedSubview(makeKey("⏎", weight: 1.2) { [weak self] _ in
            self?.textDocumentProxy.insertText("\n")
        })

        keyboardStack.addArrangedSubview(bottom)
    }

    private func makeRow() -> UIStackView {
        let s = UIStackView()
        s.axis = .horizontal
        s.spacing = 4
        s.distribution = .fill
        return s
    }

    private func makeKey(
        _ title: String,
        weight: CGFloat = 1,
        onTap: @escaping (UIButton) -> Void
    ) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(.white, for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .regular)
        b.backgroundColor = UIColor(red: 29/255, green: 29/255, blue: 34/255, alpha: 1)
        b.layer.cornerRadius = 6
        b.translatesAutoresizingMaskIntoConstraints = false
        let action = UIAction { _ in onTap(b) }
        b.addAction(action, for: .touchUpInside)
        b.setContentHuggingPriority(.defaultLow, for: .horizontal)
        b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // Encode weight via a width multiplier among siblings (handled by
        // distribution=.fill + custom widths via constraints between buttons
        // is complex; simpler: use intrinsic baseline + weight via width.
        // We use distribution=.fill and width via multiplier on an invisible
        // anchor — for simplicity here, we add a width constraint relative
        // to the row's first button. For MVP, distribution=.fillEqually
        // approximation by cloning, not weighted. To keep code small:
        // approximate weight with a min-width contentHuggingPriority delta.
        if weight != 1 {
            // Fallback: set explicit width via multiplier later in row layout.
            b.widthAnchor.constraint(greaterThanOrEqualToConstant: 30 * weight).isActive = true
        }
        return b
    }

    private func makeMicKey() -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle("🎤", for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 22, weight: .semibold)
        b.backgroundColor = UIColor(red: 239/255, green: 68/255, blue: 68/255, alpha: 1)
        b.layer.cornerRadius = 6
        b.widthAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
        b.addAction(UIAction { [weak self] _ in self?.openMainAppForDictation() }, for: .touchUpInside)
        return b
    }

    private func flashStatus(_ text: String) {
        statusLabel.text = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.statusLabel.text = "wispr-alt"
        }
    }

    // ─── Mic → open main app ──────────────────────────────────────────────

    /// Walks the responder chain to find UIApplication and opens the
    /// wispralt://dictate URL. App extensions can't call
    /// UIApplication.shared directly, but the responder-chain workaround
    /// works on every iOS version we support.
    private func openMainAppForDictation() {
        guard let url = URL(string: "wispralt://dictate") else { return }

        var responder: UIResponder? = self
        while responder != nil {
            if let app = responder as? UIApplication {
                app.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = responder?.next
        }
        flashStatus("ошибка открытия приложения")
    }
}
