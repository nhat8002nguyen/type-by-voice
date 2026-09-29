import CoreAudio
import XCTest
@testable import TypeByVoice

private struct FakeListing: AudioInputDeviceListing {
    var inputs: [AudioInputDevice]
    var defaultID: AudioDeviceID?

    func listedInputs() -> [AudioInputDevice] { inputs }
    func listedDefaultInputID() -> AudioDeviceID? { defaultID }
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

@MainActor
final class AudioInputDeviceManagerTests: XCTestCase {
    func testUsableDefaultPreferredOverContinuity() {
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
            transport: AudioInputDeviceTransport.continuity
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [builtIn, continuity], defaultID: 1)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), builtIn)
    }

    func testContinuityWhenDefaultMissing() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        let usb = device(
            id: 3,
            uid: "usb",
            name: "USB Mic",
            transport: kAudioDeviceTransportTypeUSB
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [usb, continuity], defaultID: nil)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), continuity)
    }

    func testUnusableDefaultIDNotInInputsFallsThroughToContinuity() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [continuity], defaultID: 99)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), continuity)
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
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [builtIn, usb], defaultID: nil)
        )
        XCTAssertEqual(manager.resolveCaptureDevice(), usb)
    }

    func testEmptyReturnsNil() {
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [], defaultID: nil)
        )
        XCTAssertNil(manager.resolveCaptureDevice())
    }

    func testOnlyUnusableBuiltInWithDefaultIDMissingFromListReturnsNil() {
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [], defaultID: 1)
        )
        XCTAssertNil(manager.resolveCaptureDevice())
    }

    func testContinuityFlagOnDevice() {
        let continuity = device(
            id: 2,
            uid: "iphone",
            name: "iPhone Mic",
            transport: AudioInputDeviceTransport.continuity
        )
        XCTAssertTrue(continuity.isContinuity)
        XCTAssertFalse(continuity.isBuiltIn)
    }
}
