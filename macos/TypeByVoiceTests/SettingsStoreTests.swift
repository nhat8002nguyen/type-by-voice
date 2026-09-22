import Carbon.HIToolbox
import XCTest
@testable import TypeByVoice

final class SettingsStoreTests: XCTestCase {
    func testApplyRecordedHotkeyPersists() {
        let suite = "app.typebyvoice.settings.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }

        var settings = SettingsStore.defaults
        XCTAssertTrue(settings.applyRecordedHotkey(
            keyCode: UInt32(kVK_ANSI_S),
            modifiers: UInt32(cmdKey | optionKey)
        ))
        settings.save(defaults: defaults)

        let loaded = SettingsStore.load(defaults: defaults)
        XCTAssertEqual(loaded.keyCode, UInt32(kVK_ANSI_S))
        XCTAssertEqual(loaded.modifiers, UInt32(cmdKey | optionKey))
        XCTAssertEqual(loaded.hotkeyDisplayLabel, "⌥⌘S")
    }

    func testRejectsBareModifierKey() {
        var settings = SettingsStore.defaults
        let original = settings
        XCTAssertFalse(settings.applyRecordedHotkey(
            keyCode: UInt32(kVK_Command),
            modifiers: UInt32(cmdKey)
        ))
        XCTAssertEqual(settings, original)
    }
}
