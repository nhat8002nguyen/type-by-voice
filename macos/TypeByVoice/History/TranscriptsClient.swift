import Foundation

struct TranscriptItem: Equatable, Identifiable {
    var id: String
    var text: String
    var wordCount: Int
    var audioMs: Int
    var createdAt: Date
    var isOptimistic: Bool = false
}

struct TranscriptListPage: Equatable {
    var items: [TranscriptItem]
    var nextCursor: String?
}

enum TranscriptsClientError: Error, Equatable {
    case unauthorized
    case unreachable
    case httpStatus(Int)
    case invalidResponse
}

struct TranscriptsHTTPResponse {
    var status: Int
    var data: Data
}

@MainActor
protocol TranscriptsTransport: AnyObject {
    func send(
        method: String,
        path: String,
        query: [String: String],
        bearer: String?
    ) async throws -> TranscriptsHTTPResponse
}

@MainActor
protocol TranscriptsServing: AnyObject {
    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage
    func deleteAll() async throws
}

@MainActor
final class TranscriptsClient: TranscriptsServing {
    private let transport: TranscriptsTransport
    private let accessToken: () -> String?

    init(transport: TranscriptsTransport, accessToken: @escaping () -> String?) {
        self.transport = transport
        self.accessToken = accessToken
    }

    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage {
        var query: [String: String] = ["limit": String(limit)]
        if let q, !q.isEmpty {
            query["q"] = q
        }
        if let cursor, !cursor.isEmpty {
            query["cursor"] = cursor
        }
        let json = try await sendJSON(method: "GET", path: "/v1/transcripts", query: query)
        return try Self.decodePage(json)
    }

    func deleteAll() async throws {
        _ = try await send(method: "DELETE", path: "/v1/transcripts", query: [:], allowEmpty: true)
    }

    private func sendJSON(
        method: String,
        path: String,
        query: [String: String]
    ) async throws -> Any {
        let response = try await send(method: method, path: path, query: query, allowEmpty: false)
        guard let json = try? JSONSerialization.jsonObject(with: response.data) else {
            throw TranscriptsClientError.invalidResponse
        }
        return json
    }

    private func send(
        method: String,
        path: String,
        query: [String: String],
        allowEmpty: Bool
    ) async throws -> TranscriptsHTTPResponse {
        guard let token = accessToken(), !token.isEmpty else {
            throw TranscriptsClientError.unauthorized
        }
        let response: TranscriptsHTTPResponse
        do {
            response = try await transport.send(
                method: method,
                path: path,
                query: query,
                bearer: token
            )
        } catch let error as TranscriptsClientError {
            throw error
        } catch {
            throw TranscriptsClientError.unreachable
        }
        if response.status == 401 {
            throw TranscriptsClientError.unauthorized
        }
        if response.status >= 400 {
            throw TranscriptsClientError.httpStatus(response.status)
        }
        if !allowEmpty, response.data.isEmpty {
            throw TranscriptsClientError.invalidResponse
        }
        return response
    }

    private static func decodePage(_ json: Any) throws -> TranscriptListPage {
        guard let object = json as? [String: Any], let rawItems = object["items"] as? [Any] else {
            throw TranscriptsClientError.invalidResponse
        }
        let items = try rawItems.map(decodeItem)
        let next = object["nextCursor"] as? String
        return TranscriptListPage(items: items, nextCursor: next)
    }

    private static func decodeItem(_ raw: Any) throws -> TranscriptItem {
        guard let object = raw as? [String: Any],
              let id = object["id"] as? String,
              let text = object["text"] as? String,
              let createdRaw = object["createdAt"] as? String,
              let createdAt = ISO8601Parsing.date(from: createdRaw)
        else {
            throw TranscriptsClientError.invalidResponse
        }
        let wordCount = (object["wordCount"] as? Int) ?? (object["wordCount"] as? NSNumber)?.intValue ?? 0
        let audioMs = (object["audioMs"] as? Int) ?? (object["audioMs"] as? NSNumber)?.intValue ?? 0
        return TranscriptItem(
            id: id,
            text: text,
            wordCount: wordCount,
            audioMs: audioMs,
            createdAt: createdAt
        )
    }
}

@MainActor
final class NullTranscriptsClient: TranscriptsServing {
    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage {
        TranscriptListPage(items: [], nextCursor: nil)
    }

    func deleteAll() async throws {}
}

@MainActor
final class URLSessionTranscriptsTransport: TranscriptsTransport {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func send(
        method: String,
        path: String,
        query: [String: String],
        bearer: String?
    ) async throws -> TranscriptsHTTPResponse {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: true)
        else {
            throw TranscriptsClientError.invalidResponse
        }
        if !query.isEmpty {
            components.queryItems = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) }
        }
        guard let finalURL = components.url else {
            throw TranscriptsClientError.invalidResponse
        }
        var request = URLRequest(url: finalURL)
        request.httpMethod = method
        if let bearer {
            request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw TranscriptsClientError.unreachable
        }
        guard let http = response as? HTTPURLResponse else {
            throw TranscriptsClientError.invalidResponse
        }
        return TranscriptsHTTPResponse(status: http.statusCode, data: data)
    }
}
