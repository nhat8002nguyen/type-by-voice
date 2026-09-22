import Foundation

struct AuthHTTPResponse {
    var status: Int
    var json: [String: Any]
}

enum AuthHTTPError: Error, Equatable {
    case status(Int)
    case invalidResponse
    case encodingFailed
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

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw AuthHTTPError.invalidResponse
        }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if http.statusCode >= 400 {
            throw AuthHTTPError.status(http.statusCode)
        }
        return AuthHTTPResponse(status: http.statusCode, json: json)
    }
}

enum AuthStoreError: Error, Equatable {
    case missingRefreshToken
    case missingAccessToken
    case invalidTokenResponse
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
        let response = try await http.post(path: "/v1/auth/register", body: body)
        try applyTokenResponse(response.json, email: email)
    }

    func login(email: String, password: String) async throws {
        let body = identityBody(extra: [
            "email": email,
            "password": password,
        ])
        let response = try await http.post(path: "/v1/auth/login", body: body)
        try applyTokenResponse(response.json, email: email)
    }

    func refreshIfNeeded() async throws {
        if let accessExpiresAt, accessExpiresAt > Date().addingTimeInterval(30), accessToken != nil {
            return
        }
        guard let refresh = keychain.refreshToken else {
            throw AuthStoreError.missingRefreshToken
        }
        // Exactly one refresh attempt per call; do not loop on failure.
        let body = identityBody(extra: [
            "refreshToken": refresh,
        ])
        let response = try await http.post(path: "/v1/auth/refresh", body: body)
        try applyTokenResponse(response.json, email: accountEmail)
    }

    func logout() async throws {
        memoryAccessToken = nil
        accessExpiresAt = nil
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
