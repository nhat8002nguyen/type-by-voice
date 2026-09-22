import AppKit
import SwiftUI

/// Listens for the next key-down (with optional modifiers) and reports Carbon hotkey fields.
struct HotkeyRecorderControl: View {
    let currentLabel: String
    let onRecorded: (UInt32, UInt32) -> Bool

    @State private var isRecording = false
    @State private var rejected = false
    @State private var monitor: Any?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(isRecording ? "Press a key combination…" : currentLabel)
                .monospaced()
            HStack {
                Button(isRecording ? "Listening…" : "Record hotkey") {
                    startRecording()
                }
                .disabled(isRecording)
                if isRecording {
                    Button("Cancel") { stopRecording() }
                }
            }
            if rejected {
                Text("Choose a key with modifiers (not Shift/⌘ alone).")
                    .foregroundStyle(.red)
                    .font(.caption)
            }
        }
        .onDisappear { stopRecording() }
    }

    private func startRecording() {
        stopRecording()
        rejected = false
        isRecording = true
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let keyCode = UInt32(event.keyCode)
            let modifiers = HotkeyFormatter.carbonModifiers(from: event.modifierFlags)
            if SettingsStore.isModifierOnlyKeyCode(keyCode) {
                rejected = true
                return nil
            }
            let accepted = onRecorded(keyCode, modifiers)
            rejected = !accepted
            if accepted {
                stopRecording()
            }
            return nil
        }
    }

    private func stopRecording() {
        if let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
        isRecording = false
    }
}
