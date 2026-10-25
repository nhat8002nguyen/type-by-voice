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
                    HistoryView(model: model)
                }
            }
            .frame(minWidth: 420, minHeight: 520)
        }
        .defaultSize(width: 420, height: 620)

        MenuBarExtra {
            Group {
                if model.showsWelcome {
                    OnboardingView(model: model)
                } else {
                    HistoryView(model: model)
                }
            }
            .frame(width: 420, height: 620)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.isSessionActive ? "mic.fill" : "mic")
                Text("TBV")
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: model)
        }
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
