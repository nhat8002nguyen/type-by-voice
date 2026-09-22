import AVFoundation
import Foundation

@MainActor
final class AudioCaptureService: AudioCaptureStarting {
    private let engine = AVAudioEngine()
    private var ringBuffer = AudioRingBuffer(capacitySamples: 16_000 * 120)
    private var isTapInstalled = false
    private var isPrepared = false

    var onSamples: (([Float]) -> Void)?
    private(set) var lastLevel: Double = 0

    private let targetSampleRate: Double = 16_000

    init() {
        prepareEngine()
    }

    func prepareEngine() {
        guard !isPrepared else { return }
        _ = engine.inputNode
        engine.prepare()
        isPrepared = true
    }

    func startCapture() {
        prepareEngine()
        guard !isTapInstalled else { return }

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return }

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            return
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else { return }

        let bufferSize: AVAudioFrameCount = 1_024
        input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, _ in
            let samplesAndPeak = Self.convert(buffer: buffer, converter: converter, outputFormat: outputFormat)
            guard let samplesAndPeak else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.ringBuffer.write(samplesAndPeak.samples)
                self.lastLevel = Double(min(max(samplesAndPeak.peak, 0), 1))
                self.onSamples?(samplesAndPeak.samples)
            }
        }
        isTapInstalled = true

        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            isTapInstalled = false
        }
    }

    func stopCapture() {
        if isTapInstalled {
            engine.inputNode.removeTap(onBus: 0)
            isTapInstalled = false
        }
        if engine.isRunning {
            engine.stop()
            engine.prepare()
        }
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
