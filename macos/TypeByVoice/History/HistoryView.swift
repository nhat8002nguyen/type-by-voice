import AppKit
import SwiftUI

struct HistoryView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var history: TranscriptHistoryStore
    @State private var searchText = ""
    @State private var searchTask: Task<Void, Never>?
    @State private var confirmDeleteAll = false

    init(model: AppModel) {
        self.model = model
        self.history = model.history
    }

    var body: some View {
        VStack(spacing: 0) {
            searchField
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)

            ZStack(alignment: .bottom) {
                listBody
                dictationButton
                    .padding(.bottom, 72)
            }

            bottomBar
                .padding(.horizontal, 16)
                .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .alert("Delete all transcriptions?", isPresented: $confirmDeleteAll) {
            Button("Delete", role: .destructive) {
                Task { await history.deleteAll() }
            }
            Button("Cancel", role: .cancel) {}
        }
        .onAppear {
            searchText = history.searchQuery
            Task { await history.load() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            Task { await history.load() }
        }
        .onChange(of: searchText) { newValue in
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await history.search(query: newValue)
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("Search in transcriptions", text: $searchText)
                .textFieldStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(Capsule())
        .overlay(
            Capsule()
                .stroke(Color(nsColor: .separatorColor).opacity(0.5), lineWidth: 1)
        )
    }

    private var listBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if let banner = model.historyBanner ?? history.statusMessage {
                    Text(banner)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                ForEach(history.items) { item in
                    card(item)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 120)
        }
    }

    private func card(_ item: TranscriptItem) -> some View {
        let expanded = history.expandedId == item.id
        return Button {
            history.toggleExpanded(id: item.id)
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                Text(item.text)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .lineLimit(expanded ? nil : 3)
                    .textSelection(.enabled)
                Divider()
                VStack(alignment: .leading, spacing: 2) {
                    Text(Self.dateFormatter.string(from: item.createdAt))
                    Text(Self.timeFormatter.string(from: item.createdAt))
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Color(nsColor: .separatorColor).opacity(0.6), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var dictationButton: some View {
        Button {
            model.startOrStop(destination: .history)
        } label: {
            ZStack {
                Circle()
                    .fill(Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255))
                    .frame(width: 64, height: 64)
                    .shadow(
                        color: Color(red: 59 / 255, green: 130 / 255, blue: 246 / 255).opacity(0.35),
                        radius: 12,
                        y: 4
                    )
                    .scaleEffect(model.sessionState == .recording ? 1.08 : 1.0)
                    .animation(
                        model.sessionState == .recording
                            ? .easeInOut(duration: 0.7).repeatForever(autoreverses: true)
                            : .default,
                        value: model.sessionState
                    )
                if model.sessionState == .transcribing || model.sessionState == .connecting {
                    ProgressView()
                        .controlSize(.small)
                        .tint(.white)
                }
            }
        }
        .buttonStyle(.plain)
        .help(model.isSessionActive ? "Stop dictation" : "Start dictation")
    }

    private var bottomBar: some View {
        HStack {
            Spacer()
            Button {
                confirmDeleteAll = true
            } label: {
                Image(systemName: "trash")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.bordered)
            .help("Delete all transcriptions")
            Button {
                model.openSettings()
            } label: {
                Image(systemName: "gearshape")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.bordered)
            .help("Settings")
        }
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return formatter
    }()

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()
}
