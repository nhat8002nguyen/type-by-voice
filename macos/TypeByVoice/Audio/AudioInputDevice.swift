import CoreAudio
import Foundation

enum AudioInputDeviceTransport {
    /// Continuity Capture wired FourCC `'ccwd'`.
    static let continuityWired: UInt32 = kAudioDeviceTransportTypeContinuityCaptureWired
    /// Continuity Capture wireless FourCC `'ccwl'` (typical iPhone Continuity mic).
    static let continuityWireless: UInt32 = kAudioDeviceTransportTypeContinuityCaptureWireless

    static func isContinuity(_ transportType: UInt32) -> Bool {
        transportType == continuityWired || transportType == continuityWireless
    }
}

struct AudioInputDevice: Equatable {
    var id: AudioDeviceID
    var uid: String
    var name: String
    var transportType: UInt32

    var isBuiltIn: Bool {
        transportType == kAudioDeviceTransportTypeBuiltIn
    }

    var isContinuity: Bool {
        AudioInputDeviceTransport.isContinuity(transportType)
    }

    /// Real headset/USB/etc. mics — not Continuity, built-in, or virtual loopbacks.
    var isPhysicalExternal: Bool {
        switch transportType {
        case kAudioDeviceTransportTypeUSB,
             kAudioDeviceTransportTypeBluetooth,
             kAudioDeviceTransportTypeBluetoothLE,
             kAudioDeviceTransportTypeFireWire,
             kAudioDeviceTransportTypeThunderbolt,
             kAudioDeviceTransportTypePCI,
             kAudioDeviceTransportTypeHDMI,
             kAudioDeviceTransportTypeDisplayPort,
             kAudioDeviceTransportTypeAirPlay,
             kAudioDeviceTransportTypeAVB:
            return true
        default:
            return false
        }
    }
}
