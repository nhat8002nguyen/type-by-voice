import Foundation
@testable import TypeByVoice

@MainActor
final class FakeTranscriptsClient: TranscriptsServing {
    var pages: [Result<TranscriptListPage, Error>] = []
    var deleteResults: [Result<Void, Error>] = []
    private(set) var listQueries: [String?] = []
    private(set) var deleteCount = 0

    func enqueue(items: [TranscriptItem], nextCursor: String? = nil) {
        pages.append(.success(TranscriptListPage(items: items, nextCursor: nextCursor)))
    }

    func enqueueListError(_ error: Error) {
        pages.append(.failure(error))
    }

    func list(q: String?, limit: Int, cursor: String?) async throws -> TranscriptListPage {
        listQueries.append(q)
        _ = limit
        _ = cursor
        guard !pages.isEmpty else {
            return TranscriptListPage(items: [], nextCursor: nil)
        }
        return try pages.removeFirst().get()
    }

    func deleteAll() async throws {
        deleteCount += 1
        if !deleteResults.isEmpty {
            try deleteResults.removeFirst().get()
        }
    }
}

enum FakeTranscripts {
    static func item(
        id: String,
        text: String,
        createdAt: Date = Date(timeIntervalSince1970: 1_772_000_000)
    ) -> TranscriptItem {
        TranscriptItem(id: id, text: text, wordCount: 1, audioMs: 800, createdAt: createdAt)
    }
}
