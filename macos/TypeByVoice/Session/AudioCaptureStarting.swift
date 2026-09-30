import Foundation

@MainActor
protocol AudioCaptureStarting: AnyObject {
    func startCapture() throws
    func stopCapture()
}

final class FakeAudioCapture: AudioCaptureStarting {
    private(set) var isCapturing = false
    var startError: Error?

    func startCapture() throws {
        if let startError {
            throw startError
        }
        isCapturing = true
    }

    func stopCapture() {
        isCapturing = false
    }
}
