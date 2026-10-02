package audio

import (
	"crypto/rand"
	"encoding/binary"
)

const (
	oggPageFlagBOS = 0x02 // beginning of stream
	oggPageFlagEOS = 0x04 // end of stream
	// packetsPerPage flushes a page every 10 packets, i.e. every ~200 ms at
	// 20 ms per packet, which is what the server expects to concatenate.
	packetsPerPage = 10
)

// OggFramer turns a sequence of Opus packets into a single continuous Ogg Opus
// byte stream: one serial number, monotonic granule positions, and an OpusHead
// and OpusTags page ahead of the audio. The server concatenates what it
// receives into a valid .ogg without re-muxing, so the framing here is exact.
//
// It is pure Go so it can be unit-tested with synthetic packets, independent
// of the cgo libopus encoder that produces the real ones.
type OggFramer struct {
	samplesPerPacket uint64
	serial           uint32
	seq              uint32
	granule          uint64
	pending          [][]byte
	started          bool
}

// NewOggFramer starts a fresh logical stream. samplesPerPacket is the granule
// contribution of one packet (960 for a 20 ms Opus packet at 48 kHz).
func NewOggFramer(samplesPerPacket uint64) *OggFramer {
	return &OggFramer{samplesPerPacket: samplesPerPacket, serial: randomSerial()}
}

// Serial is this stream's bitstream serial number.
func (f *OggFramer) Serial() uint32 { return f.serial }

// WritePacket adds one Opus packet and returns any page bytes ready to send,
// or nil when no page completed.
func (f *OggFramer) WritePacket(packet []byte) []byte {
	var out []byte
	if !f.started {
		out = append(out, f.headerPages()...)
		f.started = true
	}
	f.pending = append(f.pending, packet)
	f.granule += f.samplesPerPacket
	if len(f.pending) >= packetsPerPage {
		out = append(out, f.buildPage(0, f.granule, f.pending)...)
		f.pending = nil
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// Flush emits the final page (any buffered packets, marked end-of-stream).
func (f *OggFramer) Flush() []byte {
	if !f.started {
		return nil
	}
	page := f.buildPage(oggPageFlagEOS, f.granule, f.pending)
	f.pending = nil
	return page
}

func (f *OggFramer) headerPages() []byte {
	var out []byte
	out = append(out, f.buildPage(oggPageFlagBOS, 0, [][]byte{opusHeadPacket()})...)
	out = append(out, f.buildPage(0, 0, [][]byte{opusTagsPacket()})...)
	return out
}

// buildPage assembles one Ogg page from packets, then stamps its CRC. It
// advances the page sequence number.
func (f *OggFramer) buildPage(headerType byte, granule uint64, packets [][]byte) []byte {
	var segTable []byte
	var body []byte
	for _, p := range packets {
		segTable = append(segTable, lace(len(p))...)
		body = append(body, p...)
	}

	page := make([]byte, 0, 27+len(segTable)+len(body))
	page = append(page, 'O', 'g', 'g', 'S')
	page = append(page, 0) // stream structure version
	page = append(page, headerType)
	page = appendLE64(page, granule)
	page = appendLE32(page, f.serial)
	page = appendLE32(page, f.seq)
	f.seq++
	page = appendLE32(page, 0) // CRC placeholder
	page = append(page, byte(len(segTable)))
	page = append(page, segTable...)
	page = append(page, body...)

	binary.LittleEndian.PutUint32(page[22:26], oggCRC(page))
	return page
}

// lace encodes a packet length as Ogg lacing values: 255 for each full 255
// bytes, then the remainder (a trailing 0 when the length is a multiple of 255).
func lace(n int) []byte {
	var segs []byte
	for n >= 255 {
		segs = append(segs, 255)
		n -= 255
	}
	return append(segs, byte(n))
}

func opusHeadPacket() []byte {
	p := make([]byte, 19)
	copy(p, "OpusHead")
	p[8] = 1                                       // version
	p[9] = 1                                       // channel count
	binary.LittleEndian.PutUint16(p[10:12], 312)   // pre-skip
	binary.LittleEndian.PutUint32(p[12:16], 16000) // input sample rate
	binary.LittleEndian.PutUint16(p[16:18], 0)     // output gain
	p[18] = 0                                      // channel mapping family
	return p
}

func opusTagsPacket() []byte {
	vendor := []byte("TypeByVoice")
	p := make([]byte, 0, 8+4+len(vendor)+4)
	p = append(p, "OpusTags"...)
	p = appendLE32(p, uint32(len(vendor)))
	p = append(p, vendor...)
	p = appendLE32(p, 0) // user comment list length
	return p
}

func appendLE32(b []byte, v uint32) []byte {
	var tmp [4]byte
	binary.LittleEndian.PutUint32(tmp[:], v)
	return append(b, tmp[:]...)
}

func appendLE64(b []byte, v uint64) []byte {
	var tmp [8]byte
	binary.LittleEndian.PutUint64(tmp[:], v)
	return append(b, tmp[:]...)
}

func randomSerial() uint32 {
	var b [4]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 1
	}
	return binary.LittleEndian.Uint32(b[:])
}

var oggCRCTable [256]uint32

func init() {
	for i := 0; i < 256; i++ {
		r := uint32(i) << 24
		for j := 0; j < 8; j++ {
			if r&0x80000000 != 0 {
				r = (r << 1) ^ 0x04c11db7
			} else {
				r <<= 1
			}
		}
		oggCRCTable[i] = r
	}
}

func oggCRC(data []byte) uint32 {
	var crc uint32
	for _, b := range data {
		crc = (crc << 8) ^ oggCRCTable[byte(crc>>24)^b]
	}
	return crc
}
