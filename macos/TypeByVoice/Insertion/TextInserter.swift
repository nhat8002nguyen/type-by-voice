import Foundation

@MainActor
protocol TextInserter: AnyObject {
    func insert(_ text: String) async
    /// Captures the frontmost app before dictation UI steals focus.
    func rememberInsertionTarget()
}

extension TextInserter {
    func rememberInsertionTarget() {}
}

enum InsertionMode {
    case paste
    case clipboardFallback
}
