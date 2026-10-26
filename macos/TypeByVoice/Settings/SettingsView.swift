import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        TabView {
            Form {
                Section("Hotkey") {
                    HotkeyRecorderControl(
                        currentLabel: model.settings.hotkeyDisplayLabel,
                        onRecorded: { keyCode, modifiers in
                            model.updateHotkey(keyCode: keyCode, modifiers: modifiers)
                        }
                    )
                    Text("Silence duration: \(model.settings.silenceDurationMs) ms")
                    Text("Hard cap: \(model.settings.hardCapMs) ms")
                }
                Section("General") {
                    Toggle("Launch at login", isOn: Binding(
                        get: { model.settings.launchAtLogin },
                        set: { model.setLaunchAtLogin($0) }
                    ))
                }
                Section("Account") {
                    if model.authStore.accessToken != nil {
                        Text(model.authStore.accountEmail ?? "Signed in")
                        Button("Log out") {
                            Task { await model.signOut() }
                        }
                    } else {
                        Text("Not signed in")
                        Button("Open onboarding") {
                            model.showOnboarding = true
                        }
                    }
                }
                Section("Usage") {
                    Text(model.quotaRemainingText ?? "Quota updates after your next dictation.")
                        .foregroundStyle(.secondary)
                }
                Section {
                    Button("Quit") {
                        model.quit()
                    }
                }
            }
            .padding()
            .tabItem {
                Label("General", systemImage: "gearshape")
            }
        }
        .frame(minWidth: 360, minHeight: 360)
    }
}
