import Foundation

/// Wall-clock source for session timeouts. Pass an explicit `now` to freeze time in tests.
final class Clock: @unchecked Sendable {
    private var frozen: Date?

    init(now: Date? = nil) {
        self.frozen = now
    }

    var now: Date {
        get { frozen ?? Date() }
        set { frozen = newValue }
    }
}
