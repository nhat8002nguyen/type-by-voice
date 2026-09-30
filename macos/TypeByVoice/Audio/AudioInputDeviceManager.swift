import AudioToolbox
import CoreAudio
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

protocol AudioInputDeviceListing {
    func listedInputs() -> [AudioInputDevice]
    func listedDefaultInputID() -> AudioDeviceID?
}

struct LiveCoreAudioListing: AudioInputDeviceListing {
    func listedInputs() -> [AudioInputDevice] {
        deviceIDs().compactMap { id -> AudioInputDevice? in
            guard inputChannelCount(id) > 0 else { return nil }
            return AudioInputDevice(
                id: id,
                uid: stringProperty(id, kAudioDevicePropertyDeviceUID) ?? "\(id)",
                name: stringProperty(id, kAudioDevicePropertyDeviceNameCFString) ?? "Input \(id)",
                transportType: transportType(id)
            )
        }
    }

    func listedDefaultInputID() -> AudioDeviceID? {
        var id = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &id
        )
        guard status == noErr, id != kAudioObjectUnknown else { return nil }
        return id
    }

    private func deviceIDs() -> [AudioDeviceID] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &dataSize
        ) == noErr else {
            return []
        }
        let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var ids = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &dataSize,
            &ids
        ) == noErr else {
            return []
        }
        return ids
    }

    private func inputChannelCount(_ id: AudioDeviceID) -> Int {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &dataSize) == noErr,
              dataSize > 0 else {
            return 0
        }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(dataSize),
            alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, raw) == noErr else {
            return 0
        }
        let list = raw.assumingMemoryBound(to: AudioBufferList.self)
        var channels = 0
        let buffers = UnsafeMutableAudioBufferListPointer(list)
        for buffer in buffers {
            channels += Int(buffer.mNumberChannels)
        }
        return channels
    }

    private func transportType(_ id: AudioDeviceID) -> UInt32 {
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyTransportType,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value) == noErr else {
            return 0
        }
        return value
    }

    private func stringProperty(_ id: AudioDeviceID, _ selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<CFString?>.size)
        var cfString: CFString?
        let status = withUnsafeMutablePointer(to: &cfString) { ptr in
            AudioObjectGetPropertyData(id, &address, 0, nil, &size, ptr)
        }
        guard status == noErr, let cfString else { return nil }
        return cfString as String
    }
}

final class AudioInputDeviceManager {
    private let listing: AudioInputDeviceListing
    private let lidState: LidStateProviding

    init(
        listing: AudioInputDeviceListing = LiveCoreAudioListing(),
        lidState: LidStateProviding = IOPMClamshellStateProvider()
    ) {
        self.listing = listing
        self.lidState = lidState
    }

    func allInputs() -> [AudioInputDevice] {
        listing.listedInputs()
    }

    func defaultInput() -> AudioInputDevice? {
        guard let id = listing.listedDefaultInputID() else { return nil }
        return allInputs().first { $0.id == id }
    }

    func resolveCaptureDevice() -> AudioInputDevice? {
        let inputs = allInputs()
        let defaultInput = defaultInput()
        let continuity = inputs.first(where: \.isContinuity)
        let physicalExternals = inputs.filter(\.isPhysicalExternal)

        // Bluetooth / USB headphones always win over Continuity (either lid state).
        if let defaultInput, defaultInput.isPhysicalExternal {
            return defaultInput
        }
        if let physical = physicalExternals.first {
            return physical
        }

        // No headset: lid closed → Continuity; lid open → system default (built-in).
        if lidState.isLidClosed, let continuity {
            return continuity
        }

        if let defaultInput {
            return defaultInput
        }

        if let continuity {
            return continuity
        }

        return inputs.first { !$0.isBuiltIn && !$0.isContinuity }
    }

    func setEngineInputDevice(_ deviceID: AudioDeviceID, on audioUnit: AudioUnit) throws {
        var deviceID = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        guard status == noErr else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "Failed to set input device (\(status))"]
            )
        }
    }
}
