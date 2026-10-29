import Foundation

struct AuthHTTPResponse {
    var status: Int
    var json: [String: Any]
}

enum AuthHTTPError: Error, Equatable {
    case status(Int, serverMessage: String? = nil)
    case invalidResponse
    case encodingFailed
    case unreachable
}

@MainActor
protocol AuthHTTPClient: AnyObject {
    func post(path: String, body: [String: Any]) async throws -> AuthHTTPResponse
}

@MainActor
final class URLSessionAuthHTTPClient: AuthHTTPClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func post(path: String, body: [String: Any]) async throws -> AuthHTTPResponse {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw AuthHTTPError.invalidResponse
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard JSONSerialization.isValidJSONObject(body),
              let httpBody = try? JSONSerialization.data(withJSONObject: body, options: []) else {
            throw AuthHTTPError.encodingFailed
        }
        request.httpBody = httpBody

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw AuthHTTPError.unreachable
        }
        guard let http = response as? HTTPURLResponse else {
            throw AuthHTTPError.invalidResponse
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if http.statusCode >= 400 {
            throw AuthHTTPError.status(http.statusCode, serverMessage: Self.serverMessage(from: json))
        }
        return AuthHTTPResponse(status: http.statusCode, json: json)
    }

    private static func serverMessage(from json: [String: Any]) -> String? {
        if let message = json["message"] as? String, !message.isEmpty {
            return message
        }
        if let messages = json["message"] as? [String], !messages.isEmpty {
            return messages.joined(separator: " ")
        }
        return nil
    }
}

enum AuthStoreError: Error, Equatable, LocalizedError {
    case missingRefreshToken
    case missingAccessToken
    case invalidTokenResponse
    /// Login 401 — API uses the same status for unknown email and bad password.
    case invalidCredentials
    case emailAlreadyRegistered
    case invalidRequest(String?)
    case rateLimited
    case unreachable
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .missingRefreshToken, .missingAccessToken:
            return "Your session expired. Please sign in again."
        case .invalidTokenResponse:
            return "Sign-in failed. Please try again."
        case .invalidCredentials:
            return "Email or password is incorrect, or no account exists with that email."
        case .emailAlreadyRegistered:
            return "An account with this email already exists. Sign in instead."
        case let .invalidRequest(message):
            return message ?? "Check your email and password and try again."
        case .rateLimited:
            return "Too many attempts. Please wait and try again."
        case .unreachable:
            return "Could not connect to the server. Is it running?"
        case let .httpStatus(code):
            return "Request failed (HTTP \(code))."
        }
    }

    static func fromHTTP(_ error: AuthHTTPError, registering: Bool) -> AuthStoreError {
        switch error {
        case .unreachable:
            return .unreachable
        case .invalidResponse, .encodingFailed:
            return .invalidTokenResponse
        case let .status(401, _) where !registering:
            return .invalidCredentials
        case let .status(409, _):
            return .emailAlreadyRegistered
        case let .status(400, message):
            return .invalidRequest(message)
        case .status(429, _):
            return .rateLimited
        case let .status(code, _):
            return .httpStatus(code)
        }
    }
}

@MainActor
final class AuthStore {
    private let http: AuthHTTPClient
    private let keychain: KeychainStoring
    let deviceId: UUID
    let clientVersion: String
    private let platform = "macos"

    private var memoryAccessToken: String?
    private var accessExpiresAt: Date?
    private var inFlightRefresh: Task<Void, Error>?
    private let defaults: UserDefaults
    private static let emailDefaultsKey = "app.typebyvoice.accountEmail"

    var accessToken: String? {
        memoryAccessToken ?? keychain.accessToken
    }

    var accountEmail: String? {
        defaults.string(forKey: Self.emailDefaultsKey)
    }

    init(
        http: AuthHTTPClient,
        keychain: KeychainStoring,
        deviceId: UUID,
        clientVersion: String = ClientVersion.fromBundle(),
        defaults: UserDefaults = .standard
    ) {
        self.http = http
        self.keychain = keychain
        self.deviceId = deviceId
        self.clientVersion = clientVersion
        self.defaults = defaults
        self.memoryAccessToken = keychain.accessToken
    }

    func register(email: String, password: String) async throws {
        let body = identityBody(extra: [
            "email": email,
            "password": password,
        ])
        do {
            let response = try await http.post(path: "/v1/auth/register", body: body)
            try applyTokenResponse(response.json, email: email)
        } catch let error as AuthHTTPError {
            throw AuthStoreError.fromHTTP(error, registering: true)
        }
    }

    func login(email: String, password: String) async throws {
        let body = identityBody(extra: [
            "email": email,
            "password": password,
        ])
        do {
            let response = try await http.post(path: "/v1/auth/login", body: body)
            try applyTokenResponse(response.json, email: email)
        } catch let error as AuthHTTPError {
            throw AuthStoreError.fromHTTP(error, registering: false)
        }
    }

    func refreshIfNeeded() async throws {
        if hasFreshAccessToken {
            return
        }
        // Refresh tokens rotate; overlapping POSTs 401 the loser and wipe the new session.
        if let inFlightRefresh {
            try await inFlightRefresh.value
            return
        }
        let task = Task { @MainActor in
            try await self.performRefresh()
        }
        inFlightRefresh = task
        defer { inFlightRefresh = nil }
        try await task.value
    }

    func logout() async throws {
        memoryAccessToken = nil
        accessExpiresAt = nil
        inFlightRefresh = nil
        keychain.accessToken = nil
        keychain.refreshToken = nil
        defaults.removeObject(forKey: Self.emailDefaultsKey)
    }

    func forceAccessToken(_ token: String) {
        memoryAccessToken = token
        accessExpiresAt = Date.distantPast
        keychain.accessToken = token
    }

    var clientIdentity: ClientIdentity {
        ClientIdentity(platform: platform, clientVersion: clientVersion, deviceId: deviceId)
    }

    private var hasFreshAccessToken: Bool {
        guard let accessExpiresAt, accessToken != nil else { return false }
        return accessExpiresAt > Date().addingTimeInterval(30)
    }

    private func performRefresh() async throws {
        guard let refresh = keychain.refreshToken else {
            throw AuthStoreError.missingRefreshToken
        }
        let body = identityBody(extra: [
            "refreshToken": refresh,
        ])
        let response = try await http.post(path: "/v1/auth/refresh", body: body)
        try applyTokenResponse(response.json, email: accountEmail)
    }

    private func identityBody(extra: [String: Any] = [:]) -> [String: Any] {
        var body = extra
        body["platform"] = platform
        body["clientVersion"] = clientVersion
        body["deviceId"] = deviceId.uuidString.lowercased()
        return body
    }

    private func applyTokenResponse(_ json: [String: Any], email: String?) throws {
        guard let access = json["accessToken"] as? String,
              let refresh = json["refreshToken"] as? String else {
            throw AuthStoreError.invalidTokenResponse
        }
        memoryAccessToken = access
        keychain.accessToken = access
        keychain.refreshToken = refresh
        if let email, !email.isEmpty {
            defaults.set(email, forKey: Self.emailDefaultsKey)
        }
        if let expiresIn = json["expiresIn"] as? Int {
            accessExpiresAt = Date().addingTimeInterval(TimeInterval(expiresIn))
        } else if let expiresIn = json["expiresIn"] as? Double {
            accessExpiresAt = Date().addingTimeInterval(expiresIn)
        } else {
            accessExpiresAt = Date().addingTimeInterval(900)
        }
    }
}
