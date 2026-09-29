import CoreAudio
import XCTest
@testable import TypeByVoice

private struct FakeListing: AudioInputDeviceListing {
    var inputs: [AudioInputDevice]
    var defaultID: AudioDeviceID?

    func listedInputs() -> [AudioInputDevice] { inputs }
    func listedDefaultInputID() -> AudioDeviceID? { defaultID }
}

@MainActor
final class AudioCaptureResolveTests: XCTestCase {
    func testResolveAndBindThrowsWhenNoDevice() throws {
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [], defaultID: nil)
        )
        let capture = AudioCaptureService(
            prepareImmediately: false,
            deviceManager: manager
        )
        XCTAssertThrowsError(try capture.resolveAndBindInput(audioUnit: nil)) { error in
            XCTAssertEqual(error as? AudioCaptureStartError, .noInputDevice)
        }
        XCTAssertNil(capture.activeInputUID)
    }

    func testResolveAndBindSetsActiveUIDWithoutAudioUnit() throws {
        let usb = AudioInputDevice(
            id: 3,
            uid: "usb-uid",
            name: "USB Mic",
            transportType: kAudioDeviceTransportTypeUSB
        )
        let manager = AudioInputDeviceManager(
            listing: FakeListing(inputs: [usb], defaultID: 3)
        )
        let capture = AudioCaptureService(
            prepareImmediately: false,
            deviceManager: manager
        )
        let bound = try capture.resolveAndBindInput(audioUnit: nil)
        XCTAssertEqual(bound.uid, "usb-uid")
        XCTAssertEqual(capture.activeInputUID, "usb-uid")
        capture.stopCapture()
        XCTAssertNil(capture.activeInputUID)
    }
}
