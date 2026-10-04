import AppKit
import SwiftUI

struct DashboardView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Type by Voice")
                .font(.title2.bold())

            GroupBox("Account") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.authStore.accountEmail ?? "Signed in")
                        .font(.body)
                    Button("Log out") {
                        Task { await model.signOut() }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            GroupBox("Usage") {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.quotaRemainingText ?? "Quota updates after your next dictation.")
                        .foregroundStyle(.secondary)
                    Button("Upgrade") {}
                        .disabled(true)
                        .help("Billing comes later")
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            GroupBox("Recording") {
                VStack(alignment: .leading, spacing: 12) {
                    LabeledContent("Hotkey", value: model.settings.hotkeyDisplayLabel)
                    Button(model.isSessionActive ? "Stop dictation" : "Start dictation") {
                        model.startOrStop()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(4)
            }

            GroupBox("Dictation") {
                DictationOptionsControl(model: model)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(4)
            }

            HStack {
                Button("Settings…") {
                    openSettingsWindow()
                }
                Spacer()
                Button("Quit") {
                    model.quit()
                }
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func openSettingsWindow() {
        if #available(macOS 14.0, *) {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
        } else {
            NSApp.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
        }
        NSApp.activate(ignoringOtherApps: true)
    }
}
