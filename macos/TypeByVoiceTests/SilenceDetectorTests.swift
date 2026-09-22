import XCTest
@testable import TypeByVoice

final class SilenceDetectorTests: XCTestCase {
    func testNoisyThenQuietEmitsSilenceReached() {
        var detector = SilenceDetector(silenceDurationMs: 300, noSpeechTimeoutMs: 10_000)
        let noise = [Float](repeating: 0.005, count: 1600 * 3) // 300 ms calibrate at 16 kHz
        XCTAssertNil(detector.process(samples: noise, sampleRate: 16_000))
        let speech = (0..<3200).map { Float(sin(Float($0) / 8)) * 0.4 }
        XCTAssertEqual(detector.process(samples: speech, sampleRate: 16_000), .speechStarted)
        let quiet = [Float](repeating: 0.005, count: 1600 * 4)
        XCTAssertEqual(detector.process(samples: quiet, sampleRate: 16_000), .silenceReached)
    }

    func testQuietOnlyEmitsNoSpeech() {
        var detector = SilenceDetector(silenceDurationMs: 3000, noSpeechTimeoutMs: 400)
        let quiet = [Float](repeating: 0.001, count: 16_000)
        XCTAssertEqual(detector.process(samples: quiet, sampleRate: 16_000), .noSpeech)
    }

    func testCalibrationIgnoresSpeechSpikesForNoiseFloor() {
        var detector = SilenceDetector(silenceDurationMs: 300, noSpeechTimeoutMs: 10_000)
        // 300 ms calibration: mostly quiet with a loud spike that must not set the floor.
        var calib = [Float](repeating: 0.001, count: 1600 * 3)
        for i in 0..<320 {
            calib[800 + i] = 0.5
        }
        XCTAssertNil(detector.process(samples: calib, sampleRate: 16_000))
        // Soft speech above quiet floor, well below the spike.
        let softSpeech = [Float](repeating: 0.01, count: 3200)
        XCTAssertEqual(detector.process(samples: softSpeech, sampleRate: 16_000), .speechStarted)
    }
}
