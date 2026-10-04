import AppKit
import Carbon.HIToolbox
import Foundation

struct SettingsStore: Equatable, Codable {
    var keyCode: UInt32
    var modifiers: UInt32
    var silenceDurationMs: Int
    var hardCapMs: Int
    var clipboardRestoreDelayMs: Int
    var launchAtLogin: Bool
    var dictationLanguage: DictationLanguage
    var translateToEnglish: Bool

    static let defaults = SettingsStore(
        keyCode: UInt32(kVK_ANSI_D),
        modifiers: UInt32(cmdKey | shiftKey),
        silenceDurationMs: 3_000,
        hardCapMs: 120_000,
        clipboardRestoreDelayMs: 150,
        launchAtLogin: false,
        dictationLanguage: .english,
        translateToEnglish: false
    )

    private static let defaultsKey = "app.typebyvoice.settings"

    static func load(defaults: UserDefaults = .standard) -> SettingsStore {
        guard let data = defaults.data(forKey: defaultsKey),
              let decoded = try? JSONDecoder().decode(SettingsStore.self, from: data) else {
            return .defaults
        }
        return decoded
    }

    func save(defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(self) {
            defaults.set(data, forKey: Self.defaultsKey)
        }
    }

    /// Accepts a recorded combination. Rejects bare modifier key-downs.
    @discardableResult
    mutating func applyRecordedHotkey(keyCode: UInt32, modifiers: UInt32) -> Bool {
        guard !Self.isModifierOnlyKeyCode(keyCode) else { return false }
        self.keyCode = keyCode
        self.modifiers = modifiers
        return true
    }

    var hotkeyDisplayLabel: String {
        HotkeyFormatter.displayLabel(keyCode: keyCode, modifiers: modifiers)
    }

    var dictationOptions: DictationOptions {
        DictationOptions(language: dictationLanguage, translateToEnglish: translateToEnglish)
    }

    static func isModifierOnlyKeyCode(_ keyCode: UInt32) -> Bool {
        switch Int(keyCode) {
        case kVK_Shift, kVK_RightShift,
             kVK_Command, kVK_RightCommand,
             kVK_Option, kVK_RightOption,
             kVK_Control, kVK_RightControl,
             kVK_CapsLock, kVK_Function:
            return true
        default:
            return false
        }
    }
}

enum HotkeyFormatter {
    static func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
        var mods: UInt32 = 0
        if flags.contains(.command) { mods |= UInt32(cmdKey) }
        if flags.contains(.shift) { mods |= UInt32(shiftKey) }
        if flags.contains(.option) { mods |= UInt32(optionKey) }
        if flags.contains(.control) { mods |= UInt32(controlKey) }
        return mods
    }

    static func displayLabel(keyCode: UInt32, modifiers: UInt32) -> String {
        var parts: [String] = []
        if modifiers & UInt32(controlKey) != 0 { parts.append("⌃") }
        if modifiers & UInt32(optionKey) != 0 { parts.append("⌥") }
        if modifiers & UInt32(shiftKey) != 0 { parts.append("⇧") }
        if modifiers & UInt32(cmdKey) != 0 { parts.append("⌘") }
        parts.append(keyName(keyCode))
        return parts.joined()
    }

    private static func keyName(_ keyCode: UInt32) -> String {
        switch Int(keyCode) {
        case kVK_ANSI_A: return "A"
        case kVK_ANSI_B: return "B"
        case kVK_ANSI_C: return "C"
        case kVK_ANSI_D: return "D"
        case kVK_ANSI_E: return "E"
        case kVK_ANSI_F: return "F"
        case kVK_ANSI_G: return "G"
        case kVK_ANSI_H: return "H"
        case kVK_ANSI_I: return "I"
        case kVK_ANSI_J: return "J"
        case kVK_ANSI_K: return "K"
        case kVK_ANSI_L: return "L"
        case kVK_ANSI_M: return "M"
        case kVK_ANSI_N: return "N"
        case kVK_ANSI_O: return "O"
        case kVK_ANSI_P: return "P"
        case kVK_ANSI_Q: return "Q"
        case kVK_ANSI_R: return "R"
        case kVK_ANSI_S: return "S"
        case kVK_ANSI_T: return "T"
        case kVK_ANSI_U: return "U"
        case kVK_ANSI_V: return "V"
        case kVK_ANSI_W: return "W"
        case kVK_ANSI_X: return "X"
        case kVK_ANSI_Y: return "Y"
        case kVK_ANSI_Z: return "Z"
        case kVK_Space: return "Space"
        case kVK_Return: return "↩"
        case kVK_Escape: return "Esc"
        default: return "Key\(keyCode)"
        }
    }
}
