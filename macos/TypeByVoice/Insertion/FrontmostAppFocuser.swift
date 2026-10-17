import AppKit
import Foundation

@MainActor
protocol InsertionFocusing: AnyObject {
    func rememberFrontmostApp()
    func restoreFrontmostApp() async
}

/// Tracks the last non–Type-by-Voice frontmost app so paste lands in the right place
/// even when the menu-bar panel or accessory activation stole focus.
@MainActor
final class FrontmostAppFocuser: InsertionFocusing {
    private var targetPID: pid_t?
    private var targetBundleId: String?

    init() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
            else { return }
            Task { @MainActor in
                self?.noteActivated(app)
            }
        }
        if let front = NSWorkspace.shared.frontmostApplication {
            noteActivated(front)
        }
    }

    func rememberFrontmostApp() {
        if let front = NSWorkspace.shared.frontmostApplication {
            noteActivated(front)
        }
    }

    func restoreFrontmostApp() async {
        let apps = NSWorkspace.shared.runningApplications
        let match =
            apps.first(where: { $0.processIdentifier == targetPID })
            ?? apps.first(where: { $0.bundleIdentifier == targetBundleId && targetBundleId != nil })
        guard let match, !match.isTerminated else { return }
        match.activate(options: [.activateIgnoringOtherApps])
        // Settle after activation so ⌘V lands in the restored app (macOS focus can lag).
        try? await Task.sleep(nanoseconds: 150_000_000)
    }

    private func noteActivated(_ app: NSRunningApplication) {
        guard app.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
        targetPID = app.processIdentifier
        targetBundleId = app.bundleIdentifier
    }
}
