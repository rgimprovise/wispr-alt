import Foundation

/// App Group storage shared between the main app and the keyboard extension.
///
/// Setup in Xcode (manual, once per developer):
///   1. Both targets → Signing & Capabilities → + Capability → App Groups
///   2. Add a group with this exact identifier on BOTH targets.
///
/// The keyboard polls this storage on every viewWillAppear and commits any
/// pending transcript to the current input field, then clears it.
enum SharedStorage {
    static let appGroup = "group.com.rgimprovise.belovik"
    static let pendingKey = "pendingTranscript"
    static let timestampKey = "pendingTranscriptAt"

    static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroup)
    }

    static func savePendingTranscript(_ text: String) {
        defaults?.set(text, forKey: pendingKey)
        defaults?.set(Date(), forKey: timestampKey)
    }

    static func consumePendingTranscript() -> String? {
        guard let d = defaults,
              let text = d.string(forKey: pendingKey),
              !text.isEmpty
        else { return nil }
        d.removeObject(forKey: pendingKey)
        d.removeObject(forKey: timestampKey)
        return text
    }
}
