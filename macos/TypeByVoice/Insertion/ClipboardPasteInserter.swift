import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import UserNotifications

struct PasteboardSnapshot: Equatable {
    var items: [[String: Data]]
}

protocol PasteboardSnapshotting: AnyObject {
    var string: String? { get set }
    func snapshot() -> PasteboardSnapshot
    func restore(_ snapshot: PasteboardSnapshot)
}

protocol KeyEventPosting: AnyObject {
    func postKey(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags)
}

protocol UserNotifying: AnyObject {
    func notify(body: String)
}

@MainActor
final class ClipboardPasteInserter: TextInserter {
    private let pasteboard: PasteboardSnapshotting
    private let poster: KeyEventPosting
    private let notifications: UserNotifying
    private let accessibilityGranted: () -> Bool
    private let restoreDelayMs: Int

    private(set) var lastMode: InsertionMode?

    init(
        pasteboard: PasteboardSnapshotting = SystemPasteboard(),
        poster: KeyEventPosting = SystemKeyEventPoster(),
        notifications: UserNotifying = SystemUserNotifier(),
        accessibilityGranted: @escaping () -> Bool,
        restoreDelayMs: Int = 150
    ) {
        self.pasteboard = pasteboard
        self.poster = poster
        self.notifications = notifications
        self.accessibilityGranted = accessibilityGranted
        self.restoreDelayMs = restoreDelayMs
    }

    func insert(_ text: String) async {
        if accessibilityGranted() {
            lastMode = .paste
            let saved = pasteboard.snapshot()
            pasteboard.string = text
            postCommandV()
            if restoreDelayMs > 0 {
                try? await Task.sleep(nanoseconds: UInt64(restoreDelayMs) * 1_000_000)
            }
            pasteboard.restore(saved)
        } else {
            lastMode = .clipboardFallback
            pasteboard.string = text
            notifications.notify(body: "Transcript copied. Press ⌘V to paste.")
        }
    }

    private func postCommandV() {
        let keyCode = CGKeyCode(kVK_ANSI_V)
        let flags: CGEventFlags = .maskCommand
        poster.postKey(keyCode: keyCode, keyDown: true, flags: flags)
        poster.postKey(keyCode: keyCode, keyDown: false, flags: flags)
    }
}

final class SystemPasteboard: PasteboardSnapshotting {
    var string: String? {
        get { NSPasteboard.general.string(forType: .string) }
        set {
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            if let newValue {
                pasteboard.setString(newValue, forType: .string)
            }
        }
    }

    func snapshot() -> PasteboardSnapshot {
        let pasteboard = NSPasteboard.general
        guard let items = pasteboard.pasteboardItems else {
            return PasteboardSnapshot(items: [])
        }
        let captured: [[String: Data]] = items.map { item in
            var dataByType: [String: Data] = [:]
            for type in item.types {
                if let data = item.data(forType: type) {
                    dataByType[type.rawValue] = data
                }
            }
            return dataByType
        }
        return PasteboardSnapshot(items: captured)
    }

    func restore(_ snapshot: PasteboardSnapshot) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let objects: [NSPasteboardItem] = snapshot.items.map { dataByType in
            let item = NSPasteboardItem()
            for (type, data) in dataByType {
                item.setData(data, forType: NSPasteboard.PasteboardType(type))
            }
            return item
        }
        if !objects.isEmpty {
            pasteboard.writeObjects(objects)
        }
    }
}

final class SystemKeyEventPoster: KeyEventPosting {
    func postKey(keyCode: CGKeyCode, keyDown: Bool, flags: CGEventFlags) {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let event = CGEvent(
            keyboardEventSource: source,
            virtualKey: keyCode,
            keyDown: keyDown
        ) else {
            return
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
}

final class SystemUserNotifier: UserNotifying {
    func notify(body: String) {
        let content = UNMutableNotificationContent()
        content.title = "Type by Voice"
        content.body = body
        let request = UNNotificationRequest(
            identifier: UUID().uuidString,
            content: content,
            trigger: nil
        )
        UNUserNotificationCenter.current().add(request)
    }
}
