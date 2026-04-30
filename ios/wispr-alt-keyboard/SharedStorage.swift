// Same storage helpers as the main app — copy because Xcode targets
// don't share Swift sources directly. Keep these in sync.

import Foundation

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
