import Foundation

@MainActor
protocol TranscriptionEngine: AnyObject {
    func start(requestId: UUID, identity: ClientIdentity) async throws
    func sendAudio(_ data: Data) async
    func stop(durationMs: Int) async
    func cancel() async
    var events: AsyncStream<EngineEvent> { get }

    /// When true, events arrive via `setEventHandler` and the AsyncStream loop is skipped.
    var deliversEventsSynchronously: Bool { get }
    func setEventHandler(_ handler: (@MainActor (EngineEvent) -> Void)?)

    /// Outbound audio path that may complete synchronously (test doubles).
    func sendAudioNow(_ data: Data)

    /// Keep the socket warm until the given deadline after a completed dictation.
    func keepWarm(until: Date)
}

extension TranscriptionEngine {
    var deliversEventsSynchronously: Bool { false }

    func setEventHandler(_ handler: (@MainActor (EngineEvent) -> Void)?) {}

    func sendAudioNow(_ data: Data) {
        Task { await sendAudio(data) }
    }

    func keepWarm(until: Date) {}
}

enum EngineEvent: Equatable {
    case ready(maxDurationMs: Int, quota: QuotaSnapshot)
    case final(text: String, wordCount: Int, audioMs: Int, quota: QuotaSnapshot)
    case error(code: String, message: String, retryable: Bool, details: [String: String])
}

struct QuotaSnapshot: Equatable {
    var unit: String
    var limit: Int?
    var used: Int
    var resetAt: Date
}

struct ClientIdentity: Equatable {
    var platform: String
    var clientVersion: String
    var deviceId: UUID

    static let preview = ClientIdentity(
        platform: "macos",
        clientVersion: "1.0.0+12",
        deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!
    )
}
