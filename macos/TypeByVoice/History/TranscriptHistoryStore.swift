import Foundation

@MainActor
final class TranscriptHistoryStore: ObservableObject {
    @Published var items: [TranscriptItem] = []
    @Published var searchQuery = ""
    @Published var expandedId: String?
    @Published var statusMessage: String?
    @Published var isLoading = false

    private let client: TranscriptsServing
    private let refresh: () async throws -> Void
    var onUnauthenticated: () async -> Void = {}
    private let retryDelayNanoseconds: UInt64
    private var loadGeneration = 0
    private var optimistic: TranscriptItem?

    init(
        client: TranscriptsServing,
        refresh: @escaping () async throws -> Void = {},
        retryDelayNanoseconds: UInt64 = 500_000_000
    ) {
        self.client = client
        self.refresh = refresh
        self.retryDelayNanoseconds = retryDelayNanoseconds
    }

    func load() async {
        searchQuery = ""
        await fetch(q: nil, droppingOptimisticIfMissing: true)
    }

    func search(query: String) async {
        searchQuery = query
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        await fetch(q: q.isEmpty ? nil : q, droppingOptimisticIfMissing: true)
    }

    func deleteAll() async {
        do {
            try await perform { try await self.client.deleteAll() }
            optimistic = nil
            items = []
            statusMessage = nil
        } catch {
            statusMessage = "Could not load transcriptions."
        }
    }

    func didReceiveFinal(_ text: String) async {
        searchQuery = ""
        let placeholder = TranscriptItem(
            id: UUID().uuidString,
            text: text,
            wordCount: text.split { $0.isWhitespace || $0.isNewline }.count,
            audioMs: 0,
            createdAt: Date(),
            isOptimistic: true
        )
        optimistic = placeholder
        items.insert(placeholder, at: 0)
        await refreshUntilServerHasOptimistic()
    }

    func toggleExpanded(id: String) {
        expandedId = expandedId == id ? nil : id
    }

    private func refreshUntilServerHasOptimistic() async {
        for attempt in 0..<3 {
            await fetch(q: nil, droppingOptimisticIfMissing: false)
            if optimistic == nil { return }
            if attempt < 2, retryDelayNanoseconds > 0 {
                try? await Task.sleep(nanoseconds: retryDelayNanoseconds)
            }
        }
    }

    private func fetch(q: String?, droppingOptimisticIfMissing: Bool) async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        do {
            let page = try await perform {
                try await self.client.list(q: q, limit: 50, cursor: nil)
            }
            guard generation == loadGeneration else { return }
            apply(page, droppingOptimisticIfMissing: droppingOptimisticIfMissing)
            statusMessage = nil
        } catch {
            guard generation == loadGeneration else { return }
            statusMessage = "Could not load transcriptions."
        }
        isLoading = false
    }

    private func apply(_ page: TranscriptListPage, droppingOptimisticIfMissing: Bool) {
        if let optimistic {
            if page.items.contains(where: { $0.text == optimistic.text }) {
                self.optimistic = nil
                items = page.items
                return
            }
            if droppingOptimisticIfMissing {
                self.optimistic = nil
                items = page.items
                return
            }
            items = [optimistic] + page.items
            return
        }
        items = page.items
    }

    private func perform<T>(_ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch TranscriptsClientError.unauthorized {
            do {
                try await refresh()
                return try await work()
            } catch TranscriptsClientError.unauthorized {
                await onUnauthenticated()
                throw TranscriptsClientError.unauthorized
            } catch {
                await onUnauthenticated()
                throw error
            }
        }
    }
}
