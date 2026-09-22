import XCTest
@testable import TypeByVoice

final class OpusEncoderTests: XCTestCase {
    func testFirstBytesAreOggS() {
        var encoder = OpusEncoder()
        let frame = [Float](repeating: 0, count: 320)
        let pages = encoder.encode(samples: frame)
        let blob = pages.reduce(into: Data()) { $0.append($1) }
        XCTAssertEqual(Array(blob.prefix(4)), [0x4F, 0x67, 0x67, 0x53]) // "OggS"
    }

    func testTwentyMsFrameProducesBoundedPayload() {
        var encoder = OpusEncoder()
        let frame = [Float](repeating: 0.1, count: 320)
        let pages = encoder.encode(samples: frame)
        let size = pages.reduce(0) { $0 + $1.count }
        XCTAssertGreaterThan(size, 0)
        XCTAssertLessThan(size, 400) // 20 ms at 24 kbps is ~60 bytes plus page overhead
    }

    func testFinishEmitsEOSFlag() {
        var encoder = OpusEncoder()
        _ = encoder.encode(samples: [Float](repeating: 0.1, count: 320))
        let eos = encoder.finish()
        XCTAssertFalse(eos.isEmpty)
        XCTAssertTrue(Self.containsEOSPage(eos), "finish() must emit an Ogg page with the EOS flag")
    }

    private static func containsEOSPage(_ data: Data) -> Bool {
        var index = 0
        let bytes = [UInt8](data)
        while index + 6 < bytes.count {
            guard bytes[index] == 0x4F,
                  bytes[index + 1] == 0x67,
                  bytes[index + 2] == 0x67,
                  bytes[index + 3] == 0x53
            else {
                index += 1
                continue
            }
            let headerType = bytes[index + 5]
            if headerType & 0x04 != 0 {
                return true
            }
            index += 1
        }
        return false
    }
}
