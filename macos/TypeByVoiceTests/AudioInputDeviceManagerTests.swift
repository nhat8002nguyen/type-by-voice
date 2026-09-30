import CoreAudio
import XCTest
@testable import TypeByVoice

private struct FakeListing: AudioInputDeviceListing {
    var inputs: [AudioInputDevice]
    var defaultID: AudioDeviceID?

    func listedInputs() -> [AudioInputDevice] { inputs }
    func listedDefaultInputID() -> AudioDeviceID? { defaultID }
}

private struct FakeLidState: LidStateProviding {
    var isLidClosed: Bool
}

private func device(
    id: AudioDeviceID,
    uid: String,
    name: String,
    transport: UInt32
) -> AudioInputDevice {
    AudioInputDevice(
        id: id,
        uid: uid,
        name: name,
        transportType: transport
    )
}

private func manager(
    inputs: [AudioInputDevice],
    defaultID: AudioDeviceID?,
    lidClosed: Bool
) -> AudioInputDeviceManager {
    AudioInputDeviceManager(
        listing: FakeListing(inputs: inputs, defaultID: defaultID),
        lidState: FakeLidState(isLidClosed: lidClosed)
    )
}

@MainActor
final class AudioInputDeviceManagerTests: XCTestCase {
    func testLidOpenKeepsBuiltInDefaultOverContinuity() {
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let resolved = manager(
            inputs: [builtIn, continuity],
            defaultID: 1,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, builtIn)
    }

    func testLidClosedPrefersContinuityOverBuiltInDefault() {
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let resolved = manager(
            inputs: [builtIn, continuity],
            defaultID: 1,
            lidClosed: true
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, continuity)
    }

    func testLidClosedPrefersContinuityWiredOverBuiltInDefault() {
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let continuity = device(
            id: 2,
            uid: "iphone-wired",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWired
        )
        let resolved = manager(
            inputs: [builtIn, continuity],
            defaultID: 1,
            lidClosed: true
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, continuity)
    }

    func testBluetoothPreferredOverContinuityWhenLidClosed() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let bluetooth = device(
            id: 4,
            uid: "bt-headset",
            name: "AirPods",
            transport: kAudioDeviceTransportTypeBluetooth
        )
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let resolved = manager(
            inputs: [builtIn, continuity, bluetooth],
            defaultID: 1,
            lidClosed: true
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, bluetooth)
    }

    func testBluetoothDefaultPreferredOverContinuityWhenLidOpen() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let bluetooth = device(
            id: 4,
            uid: "bt-headset",
            name: "AirPods",
            transport: kAudioDeviceTransportTypeBluetooth
        )
        let resolved = manager(
            inputs: [bluetooth, continuity],
            defaultID: 4,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, bluetooth)
    }

    func testUSBPreferredOverContinuityWhenLidClosed() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let resolved = manager(
            inputs: [usb, continuity],
            defaultID: 3,
            lidClosed: true
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, usb)
    }

    func testVirtualLoopbackDoesNotBlockContinuityWhenLidClosed() {
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let blackHole = device(
            id: 5,
            uid: "BlackHole2ch_UID",
            name: "BlackHole 2ch",
            transport: kAudioDeviceTransportTypeVirtual
        )
        let resolved = manager(
            inputs: [builtIn, blackHole, continuity],
            defaultID: 1,
            lidClosed: true
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, continuity)
    }

    func testLidOpenKeepsUSBDefaultOverContinuity() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let resolved = manager(
            inputs: [usb, continuity],
            defaultID: 3,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, usb)
    }

    func testLidOpenPrefersUSBOverContinuityWhenDefaultMissing() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let resolved = manager(
            inputs: [usb, continuity],
            defaultID: nil,
            lidClosed: false
        ).resolveCaptureDevice()
        // USB is a physical external — it wins even when not the system default.
        XCTAssertEqual(resolved, usb)
    }

    func testUnusableDefaultIDNotInInputsFallsThroughToContinuity() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let resolved = manager(
            inputs: [continuity],
            defaultID: 99,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, continuity)
    }

    func testUSBWhenNoContinuityAndNoDefault() {
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let builtIn = device(
            id: 1,
            uid: "builtin",
            name: "MacBook Mic",
            transport: kAudioDeviceTransportTypeBuiltIn
        )
        let resolved = manager(
            inputs: [builtIn, usb],
            defaultID: nil,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertEqual(resolved, usb)
    }

    func testEmptyReturnsNil() {
        let resolved = manager(
            inputs: [],
            defaultID: nil,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertNil(resolved)
    }

    func testOnlyUnusableBuiltInWithDefaultIDMissingFromListReturnsNil() {
        let resolved = manager(
            inputs: [],
            defaultID: 1,
            lidClosed: false
        ).resolveCaptureDevice()
        XCTAssertNil(resolved)
    }

    func testContinuityFlagOnDevice() {
        let wireless = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuityWireless
        )
        let wired = device(
            id: 3,
            uid: "iphone-wired",
            name: "iPhone Mic Cable",
            transport: AudioInputDeviceTransport.continuityWired
        )
        XCTAssertTrue(wireless.isContinuity)
        XCTAssertTrue(wired.isContinuity)
        XCTAssertFalse(wireless.isBuiltIn)
        XCTAssertEqual(
            AudioInputDeviceTransport.continuityWireless,
            kAudioDeviceTransportTypeContinuityCaptureWireless
        )
        XCTAssertEqual(
            AudioInputDeviceTransport.continuityWired,
            kAudioDeviceTransportTypeContinuityCaptureWired
        )
    }
}
