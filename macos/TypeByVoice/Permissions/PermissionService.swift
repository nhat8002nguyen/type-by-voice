import ApplicationServices
import AVFoundation
import Foundation

enum PermissionState: Equatable {
    case unknown
    case granted
    case denied
}

@MainActor
final class PermissionService {
    private(set) var microphone: PermissionState = .unknown
    private(set) var accessibility: PermissionState = .unknown

    init() {
        refresh()
    }

    func refresh() {
        microphone = Self.currentMicrophoneState()
        accessibility = Self.currentAccessibilityState()
    }

    func requestMicrophone() async {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            microphone = .granted
        case .denied, .restricted:
            microphone = .denied
        case .notDetermined:
            let granted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
            microphone = granted ? .granted : .denied
        @unknown default:
            microphone = .unknown
        }
    }

    /// Skippable — paste falls back to clipboard when denied.
    func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        accessibility = trusted ? .granted : .denied
    }

    var isAccessibilityGranted: Bool {
        refresh()
        return accessibility == .granted
    }

    private static func currentMicrophoneState() -> PermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .granted
        case .denied, .restricted:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }

    private static func currentAccessibilityState() -> PermissionState {
        AXIsProcessTrusted() ? .granted : .denied
    }
}
