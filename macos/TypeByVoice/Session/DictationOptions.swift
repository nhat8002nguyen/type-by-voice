import Foundation

enum DictationLanguage: String, Codable, CaseIterable, Sendable {
    case english = "en"
    case vietnamese = "vi"
    case auto

    /// Wire value sent in the `start` message. `.auto` is `nil` so the key is
    /// omitted and the backend auto-detects the language.
    var apiValue: String? {
        self == .auto ? nil : rawValue
    }

    var displayName: String {
        switch self {
        case .english: return "English"
        case .vietnamese: return "Vietnamese"
        case .auto: return "Auto-detect"
        }
    }
}

struct DictationOptions: Equatable, Sendable {
    var language: DictationLanguage
    var translateToEnglish: Bool

    static let defaults = DictationOptions(language: .english, translateToEnglish: false)

    /// True when the backend would honor a translation request for this session.
    /// The server ignores `translateToEnglish` for explicit English input.
    var canTranslate: Bool {
        language != .english
    }
}
