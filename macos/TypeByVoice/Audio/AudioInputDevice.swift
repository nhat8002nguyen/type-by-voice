import CoreAudio
import Foundation

enum AudioInputDeviceTransport {
    /// Continuity Camera microphone FourCC `'ccwd'`.
    static let continuity: UInt32 = 0x63637764
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
        transportType == AudioInputDeviceTransport.continuity
    }
}
