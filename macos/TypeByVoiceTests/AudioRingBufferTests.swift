import XCTest
@testable import TypeByVoice

final class AudioRingBufferTests: XCTestCase {
    func testWriteReadRoundTrip() {
        var buffer = AudioRingBuffer(capacitySamples: 8)
        buffer.write([1, 2, 3])
        XCTAssertEqual(buffer.read(count: 3), [1, 2, 3])
        XCTAssertEqual(buffer.available, 0)
    }

    func testOverflowDropsOldest() {
        var buffer = AudioRingBuffer(capacitySamples: 4)
        buffer.write([1, 2, 3, 4, 5])
        XCTAssertEqual(buffer.read(count: 4), [2, 3, 4, 5])
    }
}
