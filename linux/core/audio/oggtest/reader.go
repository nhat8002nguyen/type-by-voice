// Package oggtest parses Ogg pages for tests. It is an independent
// implementation of the Ogg page layout and CRC, so it does not share code
// with the framer it verifies.
package oggtest

import (
	"encoding/binary"
	"errors"
)

// Page is one parsed Ogg page.
type Page struct {
	HeaderType byte
	Granule    uint64
	Serial     uint32
	Sequence   uint32
	CRC        uint32
	Segments   []byte
	Body       []byte
	Raw        []byte
}

// Pages parses every Ogg page in data.
func Pages(data []byte) ([]Page, error) {
	var pages []Page
	for len(data) > 0 {
		if len(data) < 27 || string(data[0:4]) != "OggS" {
			return nil, errors.New("oggtest: missing OggS capture pattern")
		}
		nseg := int(data[26])
		if len(data) < 27+nseg {
			return nil, errors.New("oggtest: truncated segment table")
		}
		segs := data[27 : 27+nseg]
		bodyLen := 0
		for _, s := range segs {
			bodyLen += int(s)
		}
		total := 27 + nseg + bodyLen
		if len(data) < total {
			return nil, errors.New("oggtest: truncated page body")
		}
		raw := data[:total]
		pages = append(pages, Page{
			HeaderType: raw[5],
			Granule:    binary.LittleEndian.Uint64(raw[6:14]),
			Serial:     binary.LittleEndian.Uint32(raw[14:18]),
			Sequence:   binary.LittleEndian.Uint32(raw[18:22]),
			CRC:        binary.LittleEndian.Uint32(raw[22:26]),
			Segments:   append([]byte(nil), segs...),
			Body:       append([]byte(nil), raw[27+nseg:]...),
			Raw:        append([]byte(nil), raw...),
		})
		data = data[total:]
	}
	return pages, nil
}

// PacketCount is the number of packets whose lacing ends on this page.
func (p Page) PacketCount() int {
	n := 0
	for _, s := range p.Segments {
		if s < 255 {
			n++
		}
	}
	return n
}

// CRCValid recomputes the Ogg CRC over Raw with the CRC field zeroed.
func (p Page) CRCValid() bool {
	buf := append([]byte(nil), p.Raw...)
	if len(buf) < 26 {
		return false
	}
	binary.LittleEndian.PutUint32(buf[22:26], 0)
	return crc32Ogg(buf) == p.CRC
}

var crcTable [256]uint32

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
		crcTable[i] = r
	}
}

func crc32Ogg(data []byte) uint32 {
	var crc uint32
	for _, b := range data {
		crc = (crc << 8) ^ crcTable[byte(crc>>24)^b]
	}
	return crc
}
