import Foundation

@MainActor
protocol TextInserter: AnyObject {
    func insert(_ text: String) async
}

enum InsertionMode {
    case paste
    case clipboardFallback
}
