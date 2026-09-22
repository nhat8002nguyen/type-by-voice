import SwiftUI

struct OnboardingView: View {
    enum Step: Int {
        case welcome
        case auth
        case microphone
        case accessibility
        case hotkey
        case done
    }

    @ObservedObject var model: AppModel
    @State private var step: Step = .welcome
    @State private var email = ""
    @State private var password = ""
    @State private var isRegistering = false
    @State private var authError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            switch step {
            case .welcome:
                Text("Welcome to Type by Voice")
                    .font(.title2.bold())
                Text("Dictate into any app with a global hotkey.")
                    .foregroundStyle(.secondary)
                Button("Continue") { step = .auth }
            case .auth:
                authStep
            case .microphone:
                Text("Microphone access is required.")
                    .font(.headline)
                Text("Type by Voice needs the mic to capture dictation.")
                    .foregroundStyle(.secondary)
                if model.permissions.microphone == .denied {
                    Text("Microphone permission was denied. Enable it in System Settings.")
                        .foregroundStyle(.red)
                }
                Button("Allow Microphone") {
                    Task {
                        await model.permissions.requestMicrophone()
                        model.permissions.refresh()
                        if model.permissions.microphone == .granted {
                            step = .accessibility
                        }
                    }
                }
            case .accessibility:
                Text("Accessibility (optional)")
                    .font(.headline)
                Text("Needed to paste into the frontmost app. You can skip and paste manually.")
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Enable Accessibility") {
                        model.permissions.requestAccessibility()
                        step = .hotkey
                    }
                    Button("Skip") { step = .hotkey }
                }
            case .hotkey:
                Text("Choose your hotkey")
                    .font(.headline)
                HotkeyRecorderControl(
                    currentLabel: model.settings.hotkeyDisplayLabel,
                    onRecorded: { keyCode, modifiers in
                        model.updateHotkey(keyCode: keyCode, modifiers: modifiers)
                    }
                )
                Toggle("Launch at login", isOn: Binding(
                    get: { model.settings.launchAtLogin },
                    set: { model.setLaunchAtLogin($0) }
                ))
                Button("Done") {
                    step = .done
                    model.completeOnboarding()
                }
            case .done:
                Text("You're ready.")
                    .font(.headline)
            }
        }
        .padding(24)
        .frame(minWidth: 360, minHeight: 240)
    }

    @ViewBuilder
    private var authStep: some View {
        Text(isRegistering ? "Create account" : "Sign in")
            .font(.headline)
        TextField("Email", text: $email)
            .textFieldStyle(.roundedBorder)
        SecureField("Password", text: $password)
            .textFieldStyle(.roundedBorder)
        if let authError {
            Text(authError).foregroundStyle(.red)
        }
        HStack {
            Button(isRegistering ? "Create" : "Sign in") {
                Task { await submitAuth() }
            }
            .disabled(email.isEmpty || password.isEmpty)
            Button(isRegistering ? "Have an account?" : "Create account") {
                isRegistering.toggle()
                authError = nil
            }
            .buttonStyle(.plain)
        }
    }

    private func submitAuth() async {
        authError = nil
        do {
            if isRegistering {
                try await model.authStore.register(email: email, password: password)
            } else {
                try await model.authStore.login(email: email, password: password)
            }
            model.didAuthenticate()
            step = .microphone
        } catch {
            authError = error.localizedDescription
        }
    }
}

struct SettingsView: View {
    @ObservedObject var model: AppModel

    var body: some View {
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
                    Text("Signed in")
                    Button("Sign out") {
                        Task {
                            try? await model.authStore.logout()
                            model.syncEngineCredentials()
                        }
                    }
                } else {
                    Text("Not signed in")
                    Button("Open onboarding") {
                        model.showOnboarding = true
                    }
                }
            }
        }
        .padding()
        .frame(minWidth: 320, minHeight: 240)
    }
}
