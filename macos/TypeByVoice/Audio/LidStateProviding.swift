import Foundation
import IOKit

protocol LidStateProviding {
    var isLidClosed: Bool { get }
}

/// Reads `AppleClamshellState` from IOPM — true when the MacBook lid is closed.
struct IOPMClamshellStateProvider: LidStateProviding {
    var isLidClosed: Bool {
        let service = IOServiceGetMatchingService(
            kIOMainPortDefault,
            IOServiceMatching("IOPMrootDomain")
        )
        guard service != 0 else { return false }
        defer { IOObjectRelease(service) }

        guard let raw = IORegistryEntryCreateCFProperty(
            service,
            "AppleClamshellState" as CFString,
            kCFAllocatorDefault,
            0
        )?.takeRetainedValue() else {
            return false
        }

        if let number = raw as? NSNumber {
            return number.boolValue
        }
        return (raw as? Bool) ?? false
    }
}
