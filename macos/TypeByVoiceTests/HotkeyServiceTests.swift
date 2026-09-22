import Carbon.HIToolbox
import XCTest
@testable import TypeByVoice

final class FakeHotkeyRegistrar: HotkeyRegistering {
    private(set) var registeredKeyCode: UInt32?
    private(set) var registeredModifiers: UInt32?
    private(set) var unregisterCount = 0
    var handler: (() -> Void)?

    func register(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) throws {
        registeredKeyCode = keyCode
        registeredModifiers = modifiers
        self.handler = handler
    }

    func unregister() {
        unregisterCount += 1
        registeredKeyCode = nil
        registeredModifiers = nil
        handler = nil
    }
}

final class HotkeyServiceTests: XCTestCase {
    func testRegisterUsesCommandShiftDByDefault() throws {
        let registrar = FakeHotkeyRegistrar()
        let service = HotkeyService(registrar: registrar)
        let settings = SettingsStore.defaults

        try service.register(
            keyCode: settings.keyCode,
            modifiers: settings.modifiers,
            handler: {}
        )

        XCTAssertEqual(settings.keyCode, UInt32(kVK_ANSI_D))
        XCTAssertEqual(settings.modifiers, UInt32(cmdKey | shiftKey))
        XCTAssertEqual(registrar.registeredKeyCode, UInt32(kVK_ANSI_D))
        XCTAssertEqual(registrar.registeredModifiers, UInt32(cmdKey | shiftKey))
    }

    func testUnregisterDelegatesToRegistrar() throws {
        let registrar = FakeHotkeyRegistrar()
        let service = HotkeyService(registrar: registrar)
        try service.register(keyCode: UInt32(kVK_ANSI_D), modifiers: UInt32(cmdKey | shiftKey), handler: {})
        service.unregister()
        XCTAssertEqual(registrar.unregisterCount, 1)
        XCTAssertNil(registrar.registeredKeyCode)
    }
}
