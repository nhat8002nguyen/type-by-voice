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
}

struct SessionTimeouts: Equatable {
    var connecting: TimeInterval = 5
    var transcribing: TimeInterval = 15
    var inserting: TimeInterval = 2
    var recordingHardCap: TimeInterval = 120
}
