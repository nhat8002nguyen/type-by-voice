import Foundation
import COgg
import COpus

protocol OpusEncoding {
    mutating func encode(samples: [Float]) -> [Data]
    mutating func finish() -> Data
    mutating func reset()
}

final class OpusEncoder: OpusEncoding {
    static let sampleRate: Int32 = 16_000
    static let channels: Int32 = 1
    static let frameSize = 320
    static let bitrate: Int32 = 24_000
    /// Granule positions are always in 48 kHz units for Ogg Opus.
    private static let granuleRate: Int64 = 48_000
    private static let captureRate: Int64 = 16_000

    private var encoder: OpaquePointer?
    private var stream = ogg_stream_state()
    private var streamInitialized = false
    private var headersWritten = false
    private var pending: [Float] = []
    private var packetNo: Int64 = 0
    private var granulePos: Int64 = 0
    private var preSkip: Int64 = 0
    private var serialNumber: Int32

    init(serialNumber: Int32 = Int32.random(in: 1...Int32.max)) {
        self.serialNumber = serialNumber
        startStream()
    }

    deinit {
        tearDown()
    }

    func startStream() {
        tearDown()
        serialNumber = serialNumber == 0 ? Int32.random(in: 1...Int32.max) : serialNumber
        var err: Int32 = 0
        encoder = opus_encoder_create(
            Self.sampleRate,
            Self.channels,
            OPUS_APPLICATION_VOIP,
            &err
        )
        precondition(err == OPUS_OK && encoder != nil, "opus_encoder_create failed: \(err)")
        tbv_opus_set_bitrate(encoder!, Self.bitrate)

        var lookahead: Int32 = 0
        tbv_opus_get_lookahead(encoder!, &lookahead)
        preSkip = Int64(lookahead) * Self.granuleRate / Self.captureRate

        let initResult = withUnsafeMutablePointer(to: &stream) { ogg_stream_init($0, serialNumber) }
        precondition(initResult == 0, "ogg_stream_init failed")
        streamInitialized = true
        headersWritten = false
        pending = []
        packetNo = 0
        granulePos = 0
    }

    func encode(samples: [Float]) -> [Data] {
        ensureStarted()
        var pages: [Data] = []
        if !headersWritten {
            pages.append(contentsOf: writeHeaderPages())
            headersWritten = true
        }

        pending.append(contentsOf: samples)
        while pending.count >= Self.frameSize {
            let frame = Array(pending.prefix(Self.frameSize))
            pending.removeFirst(Self.frameSize)
            if let page = encodeFrame(frame, endOfStream: false) {
                pages.append(page)
            }
        }
        return pages
    }

    func finish() -> Data {
        ensureStarted()
        var out = Data()
        if !headersWritten {
            for page in writeHeaderPages() {
                out.append(page)
            }
            headersWritten = true
        }

        if !pending.isEmpty {
            var frame = pending
            frame.append(contentsOf: [Float](repeating: 0, count: Self.frameSize - frame.count))
            pending = []
            if let page = encodeFrame(frame, endOfStream: true) {
                out.append(page)
            }
        } else if let page = flushEOS() {
            out.append(page)
        }

        return out
    }

    func reset() {
        startStream()
    }

    private func ensureStarted() {
        if encoder == nil || !streamInitialized {
            startStream()
        }
    }

    private func writeHeaderPages() -> [Data] {
        var pages: [Data] = []

        let head = opusHeadPacket()
        pages.append(contentsOf: packetInAndFlush(head, bos: true, eos: false, granule: 0))

        let tags = opusTagsPacket()
        pages.append(contentsOf: packetInAndFlush(tags, bos: false, eos: false, granule: 0))

        return pages
    }

    private func encodeFrame(_ frame: [Float], endOfStream: Bool) -> Data? {
        var pcm = frame
        var compressed = [UInt8](repeating: 0, count: 4_000)
        let encodedBytes = pcm.withUnsafeMutableBufferPointer { buf in
            opus_encode_float(
                encoder!,
                buf.baseAddress!,
                Int32(Self.frameSize),
                &compressed,
                Int32(compressed.count)
            )
        }
        precondition(encodedBytes >= 0, "opus_encode_float failed: \(encodedBytes)")

        granulePos += Int64(Self.frameSize) * Self.granuleRate / Self.captureRate
        let packetData = Data(compressed.prefix(Int(encodedBytes)))
        let pages = packetInAndFlush(packetData, bos: false, eos: endOfStream, granule: granulePos)
        guard !pages.isEmpty else { return nil }
        return pages.reduce(into: Data()) { $0.append($1) }
    }

    private func flushEOS() -> Data? {
        // Empty EOS packet when no trailing samples remain.
        let pages = packetInAndFlush(Data(), bos: false, eos: true, granule: granulePos)
        guard !pages.isEmpty else { return nil }
        return pages.reduce(into: Data()) { $0.append($1) }
    }

    private func packetInAndFlush(
        _ payload: Data,
        bos: Bool,
        eos: Bool,
        granule: Int64
    ) -> [Data] {
        var pages: [Data] = []
        payload.withUnsafeBytes { raw in
            let base = UnsafeMutablePointer<UInt8>.allocate(capacity: max(payload.count, 1))
            defer { base.deallocate() }
            if payload.count > 0, let src = raw.bindMemory(to: UInt8.self).baseAddress {
                base.assign(from: src, count: payload.count)
            }

            var packet = ogg_packet()
            packet.packet = base
            packet.bytes = payload.count
            packet.b_o_s = bos ? 1 : 0
            packet.e_o_s = eos ? 1 : 0
            packet.granulepos = granule
            packet.packetno = packetNo
            packetNo += 1

            withUnsafeMutablePointer(to: &stream) { os in
                ogg_stream_packetin(os, &packet)
                var page = ogg_page()
                while ogg_stream_flush(os, &page) != 0 {
                    pages.append(Self.pageData(page))
                }
            }
        }
        return pages
    }

    private static func pageData(_ page: ogg_page) -> Data {
        var data = Data()
        if page.header_len > 0, let header = page.header {
            data.append(Data(bytes: header, count: Int(page.header_len)))
        }
        if page.body_len > 0, let body = page.body {
            data.append(Data(bytes: body, count: Int(page.body_len)))
        }
        return data
    }

    private func opusHeadPacket() -> Data {
        var data = Data()
        data.append(contentsOf: Array("OpusHead".utf8))
        data.append(1) // version
        data.append(UInt8(Self.channels))
        var preSkipLE = UInt16(clamping: preSkip).littleEndian
        withUnsafeBytes(of: &preSkipLE) { data.append(contentsOf: $0) }
        var rateLE = UInt32(Self.sampleRate).littleEndian
        withUnsafeBytes(of: &rateLE) { data.append(contentsOf: $0) }
        var gain: Int16 = 0
        withUnsafeBytes(of: &gain) { data.append(contentsOf: $0) }
        data.append(0) // channel mapping family 0
        return data
    }

    private func opusTagsPacket() -> Data {
        let vendor = Array("TypeByVoice".utf8)
        var data = Data()
        data.append(contentsOf: Array("OpusTags".utf8))
        var vendorLen = UInt32(vendor.count).littleEndian
        withUnsafeBytes(of: &vendorLen) { data.append(contentsOf: $0) }
        data.append(contentsOf: vendor)
        var commentCount: UInt32 = 0
        withUnsafeBytes(of: &commentCount) { data.append(contentsOf: $0) }
        return data
    }

    private func tearDown() {
        if let encoder {
            opus_encoder_destroy(encoder)
            self.encoder = nil
        }
        if streamInitialized {
            withUnsafeMutablePointer(to: &stream) { ogg_stream_clear($0) }
            streamInitialized = false
        }
    }
}
