import Foundation

/// Available cleanup styles. Must match the `Style` union in
/// backend/src/transcribe.ts.
enum DictationStyle: String, CaseIterable, Identifiable {
    case clean
    case business
    case casual
    case brief
    case telegram
    case email
    case task

    var id: String { rawValue }

    var label: String {
        switch self {
        case .clean:     return "Чистка"
        case .business:  return "Деловой"
        case .casual:    return "Неформальный"
        case .brief:     return "Краткий"
        case .telegram:  return "Telegram"
        case .email:     return "Email"
        case .task:      return "Задача"
        }
    }

    var hint: String {
        switch self {
        case .clean:    return "Снять «эээ», расставить пунктуацию, разбить на абзацы"
        case .business: return "Формальный рабочий тон, активный залог, структура"
        case .casual:   return "Сохранить разговорный тон, мягкая чистка"
        case .brief:    return "Только суть, маркированные пункты"
        case .telegram: return "Структурированный пост: крючок, абзацы, без эмодзи"
        case .email:    return "Письмо с приветствием, темами и подписью"
        case .task:     return "Action-item: контекст, что сделать, срок"
        }
    }
}

/// Persists the user's preferred dictation style across launches.
@MainActor
final class StyleStore: ObservableObject {
    private static let key = "preferredDictationStyle"

    @Published var current: DictationStyle {
        didSet {
            UserDefaults.standard.set(current.rawValue, forKey: Self.key)
        }
    }

    init() {
        if let raw = UserDefaults.standard.string(forKey: Self.key),
           let style = DictationStyle(rawValue: raw) {
            self.current = style
        } else {
            self.current = .clean
        }
    }
}
