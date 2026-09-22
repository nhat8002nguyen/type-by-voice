import Foundation

struct SilenceDetector {
    var silenceDurationMs: Int
    var noSpeechTimeoutMs: Int

    private var pending: [Float] = []
    private var calibrationRMSs: [Float] = []
    private var noiseFloor: Float?
    private var hasSeenSpeech = false
    private var consecutiveSilentMs = 0
    private var elapsedMs = 0
    private var terminalEventEmitted = false

    enum Event: Equatable {
        case speechStarted
        case silenceReached
        case noSpeech
    }

    init(silenceDurationMs: Int = 3000, noSpeechTimeoutMs: Int = 10_000) {
        self.silenceDurationMs = silenceDurationMs
        self.noSpeechTimeoutMs = noSpeechTimeoutMs
    }

    mutating func reset() {
        pending = []
        calibrationRMSs = []
        noiseFloor = nil
        hasSeenSpeech = false
        consecutiveSilentMs = 0
        elapsedMs = 0
        terminalEventEmitted = false
    }

    mutating func process(samples: [Float], sampleRate: Int) -> Event? {
        guard !terminalEventEmitted, sampleRate > 0 else { return nil }

        pending.append(contentsOf: samples)
        let windowSamples = max(1, sampleRate * 20 / 1000)
        let windowMs = 20

        while pending.count >= windowSamples {
            let window = Array(pending.prefix(windowSamples))
            pending.removeFirst(windowSamples)
            let rms = Self.rms(of: window)
            elapsedMs += windowMs

            if noiseFloor == nil {
                calibrationRMSs.append(rms)
                if calibrationRMSs.count >= 15 {
                    let mean = calibrationRMSs.reduce(0, +) / Float(calibrationRMSs.count)
                    noiseFloor = max(mean, 1e-5)
                }
                if !hasSeenSpeech, elapsedMs >= noSpeechTimeoutMs {
                    terminalEventEmitted = true
                    return .noSpeech
                }
                continue
            }

            let floor = noiseFloor!
            let isSpeech = rms > floor * 2.5

            if isSpeech {
                consecutiveSilentMs = 0
                if !hasSeenSpeech {
                    hasSeenSpeech = true
                    return .speechStarted
                }
            } else {
                consecutiveSilentMs += windowMs
                if hasSeenSpeech, consecutiveSilentMs >= silenceDurationMs {
                    terminalEventEmitted = true
                    return .silenceReached
                }
                if !hasSeenSpeech, elapsedMs >= noSpeechTimeoutMs {
                    terminalEventEmitted = true
                    return .noSpeech
                }
            }
        }

        return nil
    }

    private static func rms(of samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        var sumSquares: Float = 0
        for sample in samples {
            sumSquares += sample * sample
        }
        return sqrt(sumSquares / Float(samples.count))
    }
}
