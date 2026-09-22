import AppKit
import SwiftUI

@main
struct TypeByVoiceApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var model = AppModel()

    var body: some Scene {
        // Title text keeps the extra findable when the menu bar is crowded.
        MenuBarExtra {
            MenuBarContent(model: model)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: model.isSessionActive ? "mic.fill" : "mic")
                Text("TBV")
            }
        }

        Settings {
            SettingsView(model: model)
        }

        Window("Welcome", id: "onboarding") {
            OnboardingView(model: model)
        }
        .defaultSize(width: 420, height: 320)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Accessory (LSUIElement) apps often can't present alerts; briefly go regular.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        let alert = NSAlert()
        alert.messageText = "Type by Voice is running"
        alert.informativeText =
            "Look for “TBV” (mic) in the menu bar — check the » overflow if needed.\nDefault hotkey: ⌘⇧D"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "OK")
        alert.runModal()

        NSApp.setActivationPolicy(.accessory)
    }
}

private struct MenuBarContent: View {
    @ObservedObject var model: AppModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button(model.isSessionActive ? "Stop" : "Start") {
            model.startOrStop()
        }
        if let quota = model.quotaRemainingText {
            Text(quota)
        }
        Divider()
        Button("Settings…") {
            openSettingsWindow()
        }
        Divider()
        Button("Quit") {
            model.quit()
        }
        .onAppear {
            if model.showOnboarding {
                openWindow(id: "onboarding")
            }
        }
        .onChange(of: model.showOnboarding) { show in
            if show {
                openWindow(id: "onboarding")
            }
        }
    }

    private func openSettingsWindow() {
        if #available(macOS 14.0, *) {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        } else {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
    }
}
