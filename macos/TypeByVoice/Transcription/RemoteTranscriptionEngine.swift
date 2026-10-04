import Foundation

@MainActor
final class RemoteTranscriptionEngine: TranscriptionEngine {
    private let url: URL
    private(set) var accessToken: String

    let deliversEventsSynchronously = true

    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var warmCloseTask: Task<Void, Never>?
    private var requestId: UUID?
    private var isReady = false
    private var pendingAudio: [Data] = []
    private var eventHandler: (@MainActor (EngineEvent) -> Void)?
    private(set) var warmUntil: Date?

    /// Exposed for tests: true when the last `start` reused a warm socket.
    private(set) var lastStartReusedWarmSocket = false

    var events: AsyncStream<EngineEvent> {
        AsyncStream { _ in
            // Events are delivered only via `setEventHandler` (sync path).
        }
    }

    init(url: URL, token: String, identity: ClientIdentity) {
        self.url = url
        self.accessToken = token
        _ = identity
    }

    func updateAccessToken(_ token: String) {
        accessToken = token
    }

    func setEventHandler(_ handler: (@MainActor (EngineEvent) -> Void)?) {
        eventHandler = handler
    }

    func start(requestId: UUID, identity: ClientIdentity, options: DictationOptions) async throws {
        warmCloseTask?.cancel()
        warmCloseTask = nil

        let reuse = canReuseWarmSocket()
        lastStartReusedWarmSocket = reuse
        if !reuse {
            await tearDownSocket()
            openSocket()
        }

        warmUntil = nil
        self.requestId = requestId
        isReady = false
        pendingAudio = []

        guard let task else {
            throw URLError(.notConnectedToInternet)
        }

        let payload = StartPayload(
            requestId: requestId.uuidString.lowercased(),
            language: options.language.apiValue,
            translateToEnglish: options.translateToEnglish,
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
        warmCloseTask?.cancel()
        warmCloseTask = nil
        warmUntil = nil
        guard let requestId else {
            await tearDownSocket()
            return
        }
        let payload = CancelPayload(requestId: requestId.uuidString.lowercased())
        await sendJSON(payload)
        await tearDownSocket()
    }

    func keepWarm(until: Date) {
        // Prefer the caller's deadline when it is still ahead of wall clock.
        // Injected SessionCoordinator clocks may pass a past absolute Date; in that
        // case hold for 60s from now so stop/final can still complete.
        let delay = until.timeIntervalSince(Date())
        let holdSeconds = delay > 0 ? delay : 60
        let deadline = Date().addingTimeInterval(holdSeconds)
        warmUntil = deadline
        warmCloseTask?.cancel()
        warmCloseTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(holdSeconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            guard self.warmUntil == deadline else { return }
            self.warmUntil = nil
            await self.tearDownSocket()
        }
    }

    private func canReuseWarmSocket() -> Bool {
        guard let warmUntil, Date() < warmUntil, task != nil else { return false }
        return true
    }

    private func openSocket() {
        var request = URLRequest(url: url)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")

        let session = URLSession(configuration: .default)
        self.session = session
        let task = session.webSocketTask(with: request)
        self.task = task
        task.resume()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop()
        }
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
              let resetAt = ISO8601Parsing.date(from: resetAtRaw)
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

}

/// Backend `Date.toISOString()` includes fractional seconds; mock fixtures often omit them.
enum ISO8601Parsing {
    static func date(from raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) {
            return date
        }
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        return basic.date(from: raw)
    }
}

struct StartPayload: Encodable {
    let type = "start"
    let requestId: String
    let codec = "opus"
    let container = "ogg"
    let sampleRate = 16_000
    let channels = 1
    let language: String?
    let translateToEnglish: Bool
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
