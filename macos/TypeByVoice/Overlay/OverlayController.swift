import AppKit
import Foundation
import SwiftUI

struct OverlayError: Equatable {
    var message: String
    var retryable: Bool
}

struct OverlayModel: Equatable {
    var caption: String = ""
    var showsLevel: Bool = false
    var level: Double = 0
    var elapsedText: String = ""
    var showsIndeterminateProgress: Bool = false
    var showsRetry: Bool = false
    var showsUpgrade: Bool = false
    var isVisible: Bool = false
}

@MainActor
final class OverlayController {
    private(set) var model = OverlayModel()
    var onRetry: (() -> Void)?

    private var panel: NSPanel?
    private var hostingView: NSHostingView<PillView>?

    private let panelWidth: CGFloat = 280
    private let panelHeight: CGFloat = 44

    func render(
        _ state: SessionState,
        level: Double,
        elapsed: TimeInterval,
        quota: QuotaSnapshot?,
        error: OverlayError?
    ) {
        model = Self.makeModel(state: state, level: level, elapsed: elapsed, quota: quota, error: error)
        syncPanel()
    }

    private func syncPanel() {
        if model.isVisible {
            ensurePanel()
            hostingView?.rootView = PillView(model: model, onRetry: { [weak self] in
                self?.onRetry?()
            })
            positionPanel()
            panel?.orderFrontRegardless()
        } else {
            panel?.orderOut(nil)
        }
    }

    private func ensurePanel() {
        if panel != nil { return }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: panelHeight),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isFloatingPanel = true
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.becomesKeyOnlyIfNeeded = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.ignoresMouseEvents = false

        let hosting = NSHostingView(rootView: PillView(model: model, onRetry: { [weak self] in
            self?.onRetry?()
        }))
        hosting.frame = NSRect(origin: .zero, size: NSSize(width: panelWidth, height: panelHeight))
        panel.contentView = hosting

        self.panel = panel
        self.hostingView = hosting
    }

    private func positionPanel() {
        guard let panel, let screen = NSScreen.main ?? NSScreen.screens.first else { return }
        let frame = screen.visibleFrame
        let origin = NSPoint(
            x: frame.midX - panelWidth / 2,
            y: frame.minY + 64
        )
        panel.setFrame(NSRect(origin: origin, size: NSSize(width: panelWidth, height: panelHeight)), display: true)
    }

    static func makeModel(
        state: SessionState,
        level: Double,
        elapsed: TimeInterval,
        quota: QuotaSnapshot?,
        error: OverlayError?
    ) -> OverlayModel {
        if let error {
            return OverlayModel(
                caption: error.message,
                showsRetry: error.retryable,
                isVisible: true
            )
        }

        if let quota, let limit = quota.limit, limit > 0, quota.used >= limit {
            return OverlayModel(
                caption: "Limit reached. Resets \(formatResetAt(quota.resetAt))",
                showsUpgrade: true,
                isVisible: true
            )
        }

        switch state {
        case .connecting:
            return OverlayModel(
                caption: "Connecting…",
                isVisible: true
            )
        case .recording:
            return OverlayModel(
                showsLevel: true,
                level: min(max(level, 0), 1),
                elapsedText: formatElapsed(elapsed),
                isVisible: true
            )
        case .transcribing:
            return OverlayModel(
                caption: "Transcribing…",
                showsIndeterminateProgress: true,
                isVisible: true
            )
        case .idle, .inserting:
            if let quota, let limit = quota.limit, limit > 0 {
                let ratio = Double(quota.used) / Double(limit)
                if ratio >= 0.8 {
                    let remaining = max(0, limit - quota.used)
                    return OverlayModel(
                        caption: "\(remaining) words remaining",
                        isVisible: true
                    )
                }
            }
            return OverlayModel()
        }
    }

    static func formatElapsed(_ elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed.rounded(.down)))
        let minutes = total / 60
        let seconds = total % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private static func formatResetAt(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
