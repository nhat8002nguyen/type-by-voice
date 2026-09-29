import CoreAudio
import Foundation

protocol AudioInputDeviceListing {
    func listedInputs() -> [AudioInputDevice]
    func listedDefaultInputID() -> AudioDeviceID?
}

final class AudioInputDeviceManager {
    private let listing: AudioInputDeviceListing

    init(listing: AudioInputDeviceListing) {
        self.listing = listing
    }

    func allInputs() -> [AudioInputDevice] {
        listing.listedInputs()
    }

    func defaultInput() -> AudioInputDevice? {
        guard let id = listing.listedDefaultInputID() else { return nil }
        return allInputs().first { $0.id == id }
    }

    func resolveCaptureDevice() -> AudioInputDevice? {
        if let defaultInput = defaultInput() {
            return defaultInput
        }
        let inputs = allInputs()
        if let continuity = inputs.first(where: \.isContinuity) {
            return continuity
        }
        return inputs.first { !$0.isBuiltIn }
    }
}
