import AppKit
import Combine
import Foundation
import ServiceManagement
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    @Published var settings: SettingsStore
    @Published var showOnboarding: Bool
    @Published var isSessionActive = false
    @Published var quotaRemainingText: String?
    @Published var needsLogin = false

    let authStore: AuthStore
    let permissions: PermissionService
    let overlay: OverlayController
    let hotkey: HotkeyService
    let audioCapture: AudioCaptureService

    private let engine: RemoteTranscriptionEngine
    private let coordinator: SessionCoordinator
    private var lastQuota: QuotaSnapshot?
    private var recordingStartedAt: Date?
    private var tickTask: Task<Void, Never>?
    private var unauthenticatedRefreshUsed = false

    init(
        authStore: AuthStore? = nil,
        permissions: PermissionService = PermissionService(),
        settings: SettingsStore = .load(),
        hotkey: HotkeyService = HotkeyService(),
        overlay: OverlayController = OverlayController(),
        audioCapture: AudioCaptureService = AudioCaptureService(
            prepareImmediately: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil
        ),
        engineURL: URL = URL(string: ProcessInfo.processInfo.environment["TBV_DICTATE_URL"]
            ?? "ws://127.0.0.1:8080/v1/dictate")!,
        apiBaseURL: URL = URL(string: ProcessInfo.processInfo.environment["TBV_API_URL"]
            ?? "http://127.0.0.1:8080")!
    ) {
        let runningUnderXCTest =
            ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil

        let resolvedAuth: AuthStore
        if let authStore {
            resolvedAuth = authStore
        } else if runningUnderXCTest {
            // Avoid SecItemCopyMatching during XCTest host launch (can hang waiting on securityd).
            resolvedAuth = AuthStore(
                http: URLSessionAuthHTTPClient(baseURL: apiBaseURL),
                keychain: InMemoryKeychain(),
                deviceId: UUID(uuidString: "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77")!,
                clientVersion: "1.0.0+12"
            )
        } else {
            let keychain = KeychainStore()
            let deviceId = keychain.loadOrCreateDeviceId()
            resolvedAuth = AuthStore(
                http: URLSessionAuthHTTPClient(baseURL: apiBaseURL),
                keychain: keychain,
                deviceId: deviceId,
                clientVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
                    ?? "1.0.0+12"
            )
        }
        self.authStore = resolvedAuth
        self.permissions = permissions
        self.settings = settings
        self.hotkey = hotkey
        self.overlay = overlay
        self.audioCapture = audioCapture
        self.showOnboarding = resolvedAuth.accessToken == nil
            || UserDefaults.standard.bool(forKey: "app.typebyvoice.onboardingComplete") == false

        let inserter = ClipboardPasteInserter(
            accessibilityGranted: { [permissions] in
                permissions.isAccessibilityGranted
            },
            restoreDelayMs: settings.clipboardRestoreDelayMs
        )

        let engine = RemoteTranscriptionEngine(
            url: engineURL,
            token: resolvedAuth.accessToken ?? "",
            identity: resolvedAuth.clientIdentity
        )
        self.engine = engine

        let timeouts = SessionTimeouts(
            recordingHardCap: TimeInterval(settings.hardCapMs) / 1_000,
            silenceDurationMs: settings.silenceDurationMs
        )

        self.coordinator = SessionCoordinator(
            engine: engine,
            inserter: inserter,
            audioCapture: audioCapture,
            identity: resolvedAuth.clientIdentity,
            timeouts: timeouts
        )

        audioCapture.onSamples = { [weak self] samples in
            self?.coordinator.micFrame(samples: samples)
            self?.refreshOverlay()
        }

        coordinator.onStateChange = { [weak self] state in
            self?.handleStateChange(state)
        }
        coordinator.onQuotaChange = { [weak self] quota in
            self?.applyQuota(quota)
        }

        overlay.onRetry = { [weak self] in
            self?.coordinator.hotkeyPressed()
        }

        if !runningUnderXCTest {
            applyLaunchAtLogin(settings.launchAtLogin)
            registerHotkey()
            startTickLoop()
        }
    }

    func startOrStop() {
        coordinator.hotkeyPressed()
    }

    func quit() {
        hotkey.unregister()
        audioCapture.stopCapture()
        NSApplication.shared.terminate(nil)
    }

    func completeOnboarding() {
        UserDefaults.standard.set(true, forKey: "app.typebyvoice.onboardingComplete")
        showOnboarding = false
        registerHotkey()
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        settings.launchAtLogin = enabled
        settings.save()
        applyLaunchAtLogin(enabled)
    }

    @discardableResult
    func updateHotkey(keyCode: UInt32, modifiers: UInt32) -> Bool {
        var next = settings
        guard next.applyRecordedHotkey(keyCode: keyCode, modifiers: modifiers) else {
            return false
        }
        next.save()
        settings = next
        registerHotkey()
        return true
    }

    func syncEngineCredentials() {
        engine.updateAccessToken(authStore.accessToken ?? "")
    }

    func handleUnauthenticated() async {
        guard !unauthenticatedRefreshUsed else {
            needsLogin = true
            showOnboarding = true
            return
        }
        unauthenticatedRefreshUsed = true
        do {
            try await authStore.refreshIfNeeded()
            syncEngineCredentials()
            coordinator.hotkeyPressed()
        } catch {
            needsLogin = true
            showOnboarding = true
        }
    }

    private func registerHotkey() {
        do {
            try hotkey.register(
                keyCode: settings.keyCode,
                modifiers: settings.modifiers
            ) { [weak self] in
                Task { @MainActor in
                    self?.coordinator.hotkeyPressed()
                }
            }
        } catch {
            overlay.render(
                .idle,
                level: 0,
                elapsed: 0,
                quota: lastQuota,
                error: OverlayError(message: "Hotkey unavailable", retryable: false)
            )
        }
    }

    private func applyLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            // SMAppService may fail outside a signed/notarized build; ignore for local runs.
        }
    }

    private func applyQuota(_ quota: QuotaSnapshot) {
        lastQuota = quota
        updateQuotaText()
        refreshOverlay()
    }

    private func handleStateChange(_ state: SessionState) {
        isSessionActive = state != .idle
        switch state {
        case .recording:
            if recordingStartedAt == nil {
                recordingStartedAt = Date()
            }
        case .idle:
            recordingStartedAt = nil
            if let error = coordinator.lastError {
                let message: String
                if error.code == "engine_start_failed" || error.code == "offline" {
                    message = "Dictation unavailable"
                } else if error.code == "unauthenticated" {
                    Task { await handleUnauthenticated() }
                    message = error.message
                } else {
                    message = error.message
                }
                overlay.render(
                    .idle,
                    level: 0,
                    elapsed: 0,
                    quota: lastQuota,
                    error: OverlayError(
                        message: message,
                        retryable: error.code != "unauthenticated" && error.code != "quota_exceeded"
                    )
                )
                return
            }
        default:
            break
        }
        refreshOverlay()
    }

    private func refreshOverlay() {
        let elapsed: TimeInterval
        if let recordingStartedAt {
            elapsed = Date().timeIntervalSince(recordingStartedAt)
        } else {
            elapsed = 0
        }
        updateQuotaText()
        overlay.render(
            coordinator.state,
            level: audioCapture.lastLevel,
            elapsed: elapsed,
            quota: lastQuota,
            error: nil
        )
    }

    private func updateQuotaText() {
        guard let quota = lastQuota, let limit = quota.limit else {
            quotaRemainingText = nil
            return
        }
        let remaining = max(0, limit - quota.used)
        quotaRemainingText = "\(remaining) words left"
    }

    private func startTickLoop() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 200_000_000)
                self?.coordinator.tick(now: Date())
                self?.refreshOverlay()
            }
        }
    }
}
