import Carbon.HIToolbox
import Foundation

struct SettingsStore: Equatable, Codable {
    var keyCode: UInt32
    var modifiers: UInt32
    var silenceDurationMs: Int
    var hardCapMs: Int
    var clipboardRestoreDelayMs: Int
    var launchAtLogin: Bool

    static let defaults = SettingsStore(
        keyCode: UInt32(kVK_ANSI_D),
        modifiers: UInt32(cmdKey | shiftKey),
        silenceDurationMs: 3_000,
        hardCapMs: 120_000,
        clipboardRestoreDelayMs: 150,
        launchAtLogin: false
    )

    private static let defaultsKey = "app.typebyvoice.settings"

    static func load() -> SettingsStore {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let decoded = try? JSONDecoder().decode(SettingsStore.self, from: data) else {
            return .defaults
        }
        return decoded
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}
