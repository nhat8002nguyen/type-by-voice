import Foundation

enum AudioCaptureStartError: Error, Equatable {
    case noInputDevice

    var code: String {
        switch self {
        case .noInputDevice:
            return "no_input_device"
        }
    }

    var message: String {
        switch self {
        case .noInputDevice:
            return "No microphone available. Connect a mic or use Continuity Camera with your iPhone."
        }
    }

    var retryable: Bool {
        switch self {
        case .noInputDevice:
            return true
        }
    }
}
