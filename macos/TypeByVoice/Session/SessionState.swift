import Foundation

enum SessionState: Equatable {
    case idle
    case connecting
    case recording
    case transcribing
    case inserting
}

struct SessionError: Equatable {
    var code: String
    var message: String
    var retryable: Bool
}

struct SessionTimeouts: Equatable {
    var connecting: TimeInterval = 5
    var transcribing: TimeInterval = 15
    var inserting: TimeInterval = 2
    var recordingHardCap: TimeInterval = 120
    var silenceDurationMs: Int = 3_000
    var noSpeechTimeoutMs: Int = 10_000
    var minDurationMs: Int = 400
    var trailingHangoverMs: Int = 100
    var warmSocketSeconds: TimeInterval = 60
}
