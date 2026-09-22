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
}
