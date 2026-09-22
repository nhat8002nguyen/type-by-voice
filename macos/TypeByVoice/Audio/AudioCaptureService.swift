import AVFoundation
import Foundation

@MainActor
final class AudioCaptureService: AudioCaptureStarting {
    private var engine: AVAudioEngine?
    private var ringBuffer = AudioRingBuffer(capacitySamples: 16_000 * 120)
    private var isTapInstalled = false
    private var isPrepared = false

    var onSamples: (([Float]) -> Void)?
    private(set) var lastLevel: Double = 0

    private let targetSampleRate: Double = 16_000

    init(prepareImmediately: Bool = true) {
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

    func startCapture() {
        prepareEngine()
        guard let engine, !isTapInstalled else { return }

        // Start first so Bluetooth headsets finish negotiating their input format
        // before we read it and install the tap.
        do {
            try engine.start()
        } catch {
            return
        }

        let input = engine.inputNode
        let inputFormat = input.inputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            engine.stop()
            return
        }

        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            engine.stop()
            return
        }

        let bufferSize: AVAudioFrameCount = 1_024
        // Tap callback runs on AVAudioEngine's realtime queue — keep it off the MainActor.
        // format: nil uses whatever the hardware delivers (important when BT switches rate).
        Self.installTap(
            on: input,
            bufferSize: bufferSize,
            outputFormat: outputFormat
        ) { [weak self] samples, peak in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.ringBuffer.write(samples)
                self.lastLevel = Double(min(max(peak, 0), 1))
                self.appendMicDiagnostic(peak: peak, sampleCount: samples.count)
                self.onSamples?(samples)
            }
        }
        isTapInstalled = true
    }

    private var lastMicLogSecond: Int64 = -1

    private func appendMicDiagnostic(peak: Float, sampleCount: Int) {
        let second = Int64(Date().timeIntervalSince1970)
        guard second != lastMicLogSecond else { return }
        lastMicLogSecond = second
        let line = String(format: "%.3f peak=%.4f samples=%d\n", Date().timeIntervalSince1970, peak, sampleCount)
        guard let data = line.data(using: .utf8) else { return }
        let url = URL(fileURLWithPath: "/tmp/tbv-mic.log")
        if FileManager.default.fileExists(atPath: url.path),
           let handle = try? FileHandle(forWritingTo: url)
        {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }

    private nonisolated static func installTap(
        on input: AVAudioInputNode,
        bufferSize: AVAudioFrameCount,
        outputFormat: AVAudioFormat,
        onConverted: @escaping @Sendable ([Float], Float) -> Void
    ) {
        let outputFormat = outputFormat
        // Rebuild the converter if the hardware format changes mid-stream (common on BT).
        final class ConverterBox: @unchecked Sendable {
            var converter: AVAudioConverter?
            var fromFormat: AVAudioFormat?
        }
        let box = ConverterBox()

        input.installTap(onBus: 0, bufferSize: bufferSize, format: nil) { buffer, _ in
            let from = buffer.format
            if box.converter == nil
                || box.fromFormat?.sampleRate != from.sampleRate
                || box.fromFormat?.channelCount != from.channelCount
            {
                box.converter = AVAudioConverter(from: from, to: outputFormat)
                box.fromFormat = from
            }
            guard let converter = box.converter else { return }
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
        guard let engine else { return }
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
        guard buffer.frameLength > 0, buffer.format.sampleRate > 0 else { return nil }
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
