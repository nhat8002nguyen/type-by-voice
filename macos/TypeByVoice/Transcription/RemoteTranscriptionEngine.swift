import Foundation

@MainActor
final class RemoteTranscriptionEngine: TranscriptionEngine {
    private let url: URL
    private let token: String

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var requestId: UUID?
    private var isReady = false
    private var pendingAudio: [Data] = []
    private var eventsContinuation: AsyncStream<EngineEvent>.Continuation?
    private var eventHandler: (@MainActor (EngineEvent) -> Void)?
    private var warmUntil: Date?

    lazy var events: AsyncStream<EngineEvent> = {
        AsyncStream { continuation in
            self.eventsContinuation = continuation
        }
    }()

    init(url: URL, token: String, identity: ClientIdentity) {
        self.url = url
        self.token = token
        _ = identity
    }

    func setEventHandler(_ handler: (@MainActor (EngineEvent) -> Void)?) {
        eventHandler = handler
    }

    func start(requestId: UUID, identity: ClientIdentity) async throws {
        await tearDownSocket()
        self.requestId = requestId
        isReady = false
        pendingAudio = []

        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        self.session = session
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }

        let payload = StartPayload(
            requestId: requestId.uuidString.lowercased(),
            platform: identity.platform,
            clientVersion: identity.clientVersion,
            deviceId: identity.deviceId.uuidString.lowercased(),
            listInHistory: true
        )
        let data = try JSONEncoder().encode(payload)
        guard let text = String(data: data, encoding: .utf8) else {
            throw URLError(.cannotParseResponse)
        }
        try await task.send(.string(text))
    }

    func sendAudio(_ data: Data) async {
        sendAudioNow(data)
    }

    func sendAudioNow(_ data: Data) {
        guard !data.isEmpty else { return }
        if isReady {
            sendBinary(data)
        } else {
            pendingAudio.append(data)
        }
    }

    func stop(durationMs: Int) async {
        guard let requestId else { return }
        let payload = StopPayload(
            requestId: requestId.uuidString.lowercased(),
            durationMs: durationMs
        )
        await sendJSON(payload)
    }

    func cancel() async {
        guard let requestId else {
            await tearDownSocket()
            return
        }
        let payload = CancelPayload(requestId: requestId.uuidString.lowercased())
        await sendJSON(payload)
        await tearDownSocket()
    }

    func keepWarm(until: Date) {
        warmUntil = until
    }

    private func receiveLoop() async {
        while let task, !Task.isCancelled {
            do {
                let message = try await task.receive()
                switch message {
                case .string(let text):
                    handleText(text)
                case .data:
                    break
                @unknown default:
                    break
                }
            } catch {
                handleClose(task.closeCode)
                return
            }
        }
    }

    private func handleText(_ text: String) {
        guard let data = text.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else {
            return
        }

        switch type {
        case "ready":
            isReady = true
            let queued = pendingAudio
            pendingAudio = []
            for chunk in queued {
                sendBinary(chunk)
            }
            if let maxDurationMs = json["maxDurationMs"] as? Int,
               let quota = parseQuota(json["quota"])
            {
                deliver(.ready(maxDurationMs: maxDurationMs, quota: quota))
            }
        case "final":
            guard let textValue = json["text"] as? String,
                  let wordCount = json["wordCount"] as? Int,
                  let audioMs = json["audioMs"] as? Int,
                  let quota = parseQuota(json["quota"])
            else {
                return
            }
            deliver(.final(text: textValue, wordCount: wordCount, audioMs: audioMs, quota: quota))
        case "error":
            let code = json["code"] as? String ?? "internal"
            let message = json["message"] as? String ?? "Unexpected server error."
            let retryable = json["retryable"] as? Bool ?? false
            var details: [String: String] = [:]
            if let raw = json["details"] as? [String: Any] {
                for (key, value) in raw {
                    details[key] = String(describing: value)
                }
            }
            deliver(.error(code: code, message: message, retryable: retryable, details: details))
        default:
            break
        }
    }

    private func handleClose(_ closeCode: URLSessionWebSocketTask.CloseCode) {
        let code = closeCode.rawValue
        if code == 4401 {
            deliver(.error(
                code: "unauthenticated",
                message: "Missing, invalid, or expired token.",
                retryable: false,
                details: [:]
            ))
        } else if code == 4403 {
            deliver(.error(
                code: "quota_exceeded",
                message: "Weekly limit reached.",
                retryable: false,
                details: [:]
            ))
        }
    }

    private func parseQuota(_ value: Any?) -> QuotaSnapshot? {
        guard let dict = value as? [String: Any],
              let unit = dict["unit"] as? String,
              let used = dict["used"] as? Int,
              let resetAtRaw = dict["resetAt"] as? String,
              let resetAt = Self.iso8601.date(from: resetAtRaw)
        else {
            return nil
        }
        let limit: Int?
        if dict["limit"] is NSNull || dict["limit"] == nil {
            limit = nil
        } else if let intLimit = dict["limit"] as? Int {
            limit = intLimit
        } else {
            return nil
        }
        return QuotaSnapshot(unit: unit, limit: limit, used: used, resetAt: resetAt)
    }

    private func sendBinary(_ data: Data) {
        task?.send(.data(data)) { _ in }
    }

    private func sendJSON<T: Encodable>(_ payload: T) async {
        guard let task,
              let data = try? JSONEncoder().encode(payload),
              let text = String(data: data, encoding: .utf8)
        else {
            return
        }
        try? await task.send(.string(text))
    }

    private func deliver(_ event: EngineEvent) {
        eventHandler?(event)
        eventsContinuation?.yield(event)
    }

    private func tearDownSocket() async {
        receiveTask?.cancel()
        receiveTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        isReady = false
        pendingAudio = []
        requestId = nil
    }

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

private struct StartPayload: Encodable {
    let type = "start"
    let requestId: String
    let codec = "opus"
    let container = "ogg"
    let sampleRate = 16_000
    let channels = 1
    let language = "en"
    let platform: String
    let clientVersion: String
    let deviceId: String
    let listInHistory: Bool
}

private struct StopPayload: Encodable {
    let type = "stop"
    let requestId: String
    let durationMs: Int
}

private struct CancelPayload: Encodable {
    let type = "cancel"
    let requestId: String
}
