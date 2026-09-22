import Foundation

@MainActor
protocol AudioCaptureStarting: AnyObject {
    func startCapture()
    func stopCapture()
}

final class FakeAudioCapture: AudioCaptureStarting {
    private(set) var isCapturing = false

    func startCapture() {
        isCapturing = true
    }

    func stopCapture() {
        isCapturing = false
    }
}
