import AVFoundation
import Foundation

@MainActor
final class AudioCaptureService: AudioCaptureStarting {
    private var engine: AVAudioEngine?
    private var ringBuffer = AudioRingBuffer(capacitySamples: 16_000 * 120)
    private var isTapInstalled = false
    private var isPrepared = false
    private let deviceManager: AudioInputDeviceManager

    var onSamples: (([Float]) -> Void)?
    private(set) var lastLevel: Double = 0
    private(set) var activeInputUID: String?

    private let targetSampleRate: Double = 16_000

    init(
        prepareImmediately: Bool = true,
        deviceManager: AudioInputDeviceManager = AudioInputDeviceManager()
    ) {
        self.deviceManager = deviceManager
        if prepareImmediately {
            prepareEngine()
        }
    }

    func prepareEngine() {
        guard !isPrepared else { return }
        // Avoid HAL / securityd hangs when the XCTest host launches the app bundle.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil {
            isPrepared = true
            return
        }
        let engine = AVAudioEngine()
        self.engine = engine
        _ = engine.inputNode
        engine.prepare()
        isPrepared = true
    }

    func resolveAndBindInput(audioUnit: AudioUnit?) throws -> AudioInputDevice {
        guard let device = deviceManager.resolveCaptureDevice() else {
            throw AudioCaptureStartError.noInputDevice
        }
        if let audioUnit {
            try deviceManager.setEngineInputDevice(device.id, on: audioUnit)
        }
        activeInputUID = device.uid
        return device
    }

    func startCapture() throws {
        prepareEngine()
        guard let engine, !isTapInstalled else { return }

        guard let audioUnit = engine.inputNode.audioUnit else {
            throw AudioCaptureStartError.noInputDevice
        }
        _ = try resolveAndBindInput(audioUnit: audioUnit)

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw AudioCaptureStartError.noInputDevice
        }

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            throw AudioCaptureStartError.noInputDevice
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw AudioCaptureStartError.noInputDevice
        }

        let bufferSize: AVAudioFrameCount = 1_024
        // Tap callback runs on AVAudioEngine's realtime queue — keep it off the MainActor.
        Self.installTap(
            on: input,
            bufferSize: bufferSize,
            format: inputFormat,
            converter: converter,
            outputFormat: outputFormat
        ) { [weak self] samples, peak in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.ringBuffer.write(samples)
                self.lastLevel = Double(min(max(peak, 0), 1))
                self.onSamples?(samples)
            }
        }
        isTapInstalled = true

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            isTapInstalled = false
            throw AudioCaptureStartError.noInputDevice
        }
    }

    private nonisolated static func installTap(
        on input: AVAudioInputNode,
        bufferSize: AVAudioFrameCount,
        format: AVAudioFormat,
        converter: AVAudioConverter,
        outputFormat: AVAudioFormat,
        onConverted: @escaping @Sendable ([Float], Float) -> Void
    ) {
        nonisolated(unsafe) let converter = converter
        nonisolated(unsafe) let outputFormat = outputFormat
        input.installTap(onBus: 0, bufferSize: bufferSize, format: format) { buffer, _ in
            guard let samplesAndPeak = convert(
                buffer: buffer,
                converter: converter,
                outputFormat: outputFormat
            ) else {
                return
            }
            onConverted(samplesAndPeak.samples, samplesAndPeak.peak)
        }
    }

    func stopCapture() {
        activeInputUID = nil
        guard let engine else {
            isTapInstalled = false
            isPrepared = false
            return
        }
        if isTapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            isTapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
        }
        // Continuity Camera keeps the AU session until the engine is released.
        // Reusing the same AVAudioEngine makes the next CurrentDevice set a no-op
        // and the iPhone never reconnects — tear down so the next start rebinds.
        self.engine = nil
        isPrepared = false
    }

    private nonisolated static func convert(
        buffer: AVAudioPCMBuffer,
        converter: AVAudioConverter,
        outputFormat: AVAudioFormat
    ) -> (samples: [Float], peak: Float)? {
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
        guard let converted = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return nil
        }

        let consumed = ConsumedFlag()
        // AVAudioConverterInputBlock is @Sendable; buffer lifetime is owned by the tap callback.
        nonisolated(unsafe) let inputBuffer = buffer
        var error: NSError?
        let inputBlock: AVAudioConverterInputBlock = { _, outStatus in
            if consumed.value {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed.value = true
            outStatus.pointee = .haveData
            return inputBuffer
        }
        converter.convert(to: converted, error: &error, withInputFrom: inputBlock)
        guard error == nil, let channel = converted.floatChannelData?[0] else { return nil }

        let frameCount = Int(converted.frameLength)
        var samples = [Float](repeating: 0, count: frameCount)
        var peak: Float = 0
        for i in 0..<frameCount {
            let sample = channel[i]
            samples[i] = sample
            peak = max(peak, abs(sample))
        }
        return (samples, peak)
    }
}

private final class ConsumedFlag: @unchecked Sendable {
    var value = false
}
