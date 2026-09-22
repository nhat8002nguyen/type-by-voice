import AppKit
import SwiftUI

@main
struct TypeByVoiceApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(model: model)
        } label: {
            Image(systemName: model.isSessionActive ? "mic.fill" : "mic")
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
