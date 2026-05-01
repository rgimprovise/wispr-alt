import UIKit

/// Keyboard extension. Two layouts (EN QWERTY / RU ЙЦУКЕН) plus a
/// prominent microphone key. The mic key opens the main А-ГОЛОС app
/// via the agolos:// URL scheme; the main app records and writes the
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

    // А-ГОЛОС palette mirrored from AgolosTokens.swift / tokens.css.
    private struct Pal {
        // Light keyboard surface (matches paper-soft background).
        static let bg            = UIColor(red: 0xF4/255, green: 0xF1/255, blue: 0xEC/255, alpha: 1)
        static let keyBg         = UIColor(red: 0xFC/255, green: 0xFA/255, blue: 0xF6/255, alpha: 1)
        static let keyBgPressed  = UIColor(red: 0xE8/255, green: 0xE5/255, blue: 0xDD/255, alpha: 1)
        static let keyFg         = UIColor(red: 0x15/255, green: 0x17/255, blue: 0x1A/255, alpha: 1)
        static let modBg         = UIColor(red: 0xEC/255, green: 0xEF/255, blue: 0xEA/255, alpha: 1)
        static let modFg         = UIColor(red: 0x55/255, green: 0x5A/255, blue: 0x63/255, alpha: 1)
        static let micBg         = UIColor(red: 0x1F/255, green: 0x27/255, blue: 0x33/255, alpha: 1)
        static let statusFg      = UIColor(red: 0x8A/255, green: 0x8E/255, blue: 0x96/255, alpha: 1)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Pal.bg

        statusLabel = UILabel()
        statusLabel.text = "А-ГОЛОС"
        statusLabel.textColor = Pal.statusFg
        statusLabel.font = .systemFont(ofSize: 11, weight: .semibold)
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
                rowStack.addArrangedSubview(makeKey("⇧", weight: 1.5, modifier: true) { [weak self] _ in
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
                rowStack.addArrangedSubview(makeKey("⌫", weight: 1.5, modifier: true) { [weak self] _ in
                    self?.textDocumentProxy.deleteBackward()
                })
            }

            keyboardStack.addArrangedSubview(rowStack)
        }

        // Bottom row: lang switch | 🌐 | 🎤 | space | , . | enter
        let bottom = makeRow()
        bottom.addArrangedSubview(makeKey(currentLang == .en ? "RU" : "EN", weight: 1.2, modifier: true) { [weak self] _ in
            self?.currentLang = self?.currentLang == .en ? .ru : .en
            self?.rebuildKeyboard()
        })
        bottom.addArrangedSubview(makeKey("🌐", weight: 1.2, modifier: true) { [weak self] _ in
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
        bottom.addArrangedSubview(makeKey("⏎", weight: 1.2, modifier: true) { [weak self] _ in
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
        modifier: Bool = false,
        onTap: @escaping (UIButton) -> Void
    ) -> UIButton {
        let b = UIButton(type: .system)
        b.setTitle(title, for: .normal)
        b.setTitleColor(modifier ? Pal.modFg : Pal.keyFg, for: .normal)
        b.titleLabel?.font = .systemFont(
            ofSize: modifier ? 14 : 16,
            weight: modifier ? .semibold : .regular,
        )
        b.backgroundColor = modifier ? Pal.modBg : Pal.keyBg
        b.layer.cornerRadius = 8
        b.layer.shadowColor = UIColor.black.cgColor
        b.layer.shadowOpacity = 0.04
        b.layer.shadowRadius = 1
        b.layer.shadowOffset = CGSize(width: 0, height: 1)
        b.translatesAutoresizingMaskIntoConstraints = false
        let action = UIAction { _ in onTap(b) }
        b.addAction(action, for: .touchUpInside)
        b.setContentHuggingPriority(.defaultLow, for: .horizontal)
        b.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        if weight != 1 {
            b.widthAnchor.constraint(greaterThanOrEqualToConstant: 30 * weight).isActive = true
        }
        return b
    }

    private func makeMicKey() -> UIButton {
        // А-ГОЛОС dictation key: rounded square with the angular «А»
        // mark in signal red as the affordance. No mic emoji — the
        // brand mark IS the button.
        let b = UIButton(type: .custom)
        let size = CGSize(width: 60, height: 60)
        let signalRed = UIColor(red: 0xF2/255, green: 0x2A/255, blue: 0x37/255, alpha: 1)
        let aMark = AgolosMark.image(size: size, color: signalRed)
        b.setImage(aMark, for: .normal)
        b.imageView?.contentMode = .scaleAspectFit
        b.contentEdgeInsets = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
        b.backgroundColor = Pal.keyBg
        b.layer.cornerRadius = 12
        b.layer.borderWidth = 1
        b.layer.borderColor = UIColor(red: 0xF2/255, green: 0x2A/255, blue: 0x37/255, alpha: 0.40).cgColor
        b.layer.shadowColor = UIColor(red: 0xF2/255, green: 0x2A/255, blue: 0x37/255, alpha: 1).cgColor
        b.layer.shadowOpacity = 0.30
        b.layer.shadowRadius = 8
        b.layer.shadowOffset = CGSize(width: 0, height: 0)
        b.widthAnchor.constraint(greaterThanOrEqualToConstant: 60).isActive = true
        b.addAction(UIAction { [weak self] _ in self?.openMainAppForDictation() }, for: .touchUpInside)
        return b
    }

    private func flashStatus(_ text: String) {
        statusLabel.text = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.statusLabel.text = "А-ГОЛОС"
        }
    }

    // ─── Mic → open main app ──────────────────────────────────────────────

    /// Walks the responder chain to find UIApplication and opens the
    /// agolos://dictate URL. App extensions can't call
    /// UIApplication.shared directly, but the responder-chain workaround
    /// works on every iOS version we support.
    private func openMainAppForDictation() {
        guard let url = URL(string: "agolos://dictate") else { return }

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
