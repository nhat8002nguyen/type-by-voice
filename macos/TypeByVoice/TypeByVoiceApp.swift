import AppKit
import SwiftUI

@main
struct TypeByVoiceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        // Dock / Cmd-Tab visible window so the app is findable even if the
        // menu-bar extra is hidden in the » overflow.
        Window("Type by Voice", id: "main") {
            Group {
                if model.showsWelcome {
                    OnboardingView(model: model)
                } else {
                    DashboardView(model: model)
                }
            }
            .frame(minWidth: 420, minHeight: 440)
        }
        .defaultSize(width: 420, height: 440)

        MenuBarExtra {
            Group {
                if model.showsWelcome {
                    OnboardingView(model: model)
                } else {
                    DashboardView(model: model)
                }
            }
            .frame(width: 420, height: 440)
        } label: {
            // Template mark (three bars) — not the full Dock AppIcon chrome.
            MenuBarAppIcon(isSessionActive: model.isSessionActive)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
    }
}

/// Compact template glyph sized like other status items; red dot while dictating.
private struct MenuBarAppIcon: View {
    var isSessionActive: Bool

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Image("MenuBarIcon")
                .renderingMode(.template)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 16, height: 16)
            if isSessionActive {
                Circle()
                    .fill(Color.red)
                    .frame(width: 5, height: 5)
                    .offset(x: 2, y: -2)
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityLabel(isSessionActive ? "Type by Voice, dictating" : "Type by Voice")
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        // Bring any already-created main window forward.
        DispatchQueue.main.async {
            for window in NSApp.windows where window.title == "Type by Voice" {
                window.makeKeyAndOrderFront(nil)
            }
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag {
            for window in NSApp.windows where window.title == "Type by Voice" {
                window.makeKeyAndOrderFront(nil)
            }
        }
        return true
    }
}
