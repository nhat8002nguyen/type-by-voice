import Carbon
import Carbon.HIToolbox
import Foundation

protocol HotkeyRegistering: AnyObject {
    func register(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) throws
    func unregister()
}

enum HotkeyServiceError: Error {
    case registrationFailed(OSStatus)
}

final class CarbonHotkeyRegistrar: HotkeyRegistering {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var handler: (() -> Void)?
    private let hotKeyID = EventHotKeyID(signature: OSType(0x5442_5631), id: 1) // 'TBV1'

    func register(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) throws {
        unregister()
        self.handler = handler

        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let status = InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, userData) -> OSStatus in
                guard let userData else { return noErr }
                let registrar = Unmanaged<CarbonHotkeyRegistrar>.fromOpaque(userData).takeUnretainedValue()
                var hkID = EventHotKeyID()
                let err = GetEventParameter(
                    event,
                    EventParamName(kEventParamDirectObject),
                    EventParamType(typeEventHotKeyID),
                    nil,
                    MemoryLayout<EventHotKeyID>.size,
                    nil,
                    &hkID
                )
                if err == noErr, hkID.id == registrar.hotKeyID.id {
                    registrar.handler?()
                }
                return noErr
            },
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &handlerRef
        )
        guard status == noErr else {
            throw HotkeyServiceError.registrationFailed(status)
        }

        var ref: EventHotKeyRef?
        let registerStatus = RegisterEventHotKey(
            keyCode,
            modifiers,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        guard registerStatus == noErr else {
            throw HotkeyServiceError.registrationFailed(registerStatus)
        }
        hotKeyRef = ref
    }

    func unregister() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
        }
        if let handlerRef {
            RemoveEventHandler(handlerRef)
            self.handlerRef = nil
        }
        handler = nil
    }

    deinit {
        unregister()
    }
}

final class HotkeyService {
    private let registrar: HotkeyRegistering

    init(registrar: HotkeyRegistering = CarbonHotkeyRegistrar()) {
        self.registrar = registrar
    }

    func register(keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void) throws {
        try registrar.register(keyCode: keyCode, modifiers: modifiers, handler: handler)
    }

    func unregister() {
        registrar.unregister()
    }
}
