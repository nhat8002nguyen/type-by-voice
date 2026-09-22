import Foundation

final class Clock: @unchecked Sendable {
    var now: Date

    init(now: Date = Date()) {
        self.now = now
    }
}
