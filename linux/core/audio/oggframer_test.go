package audio

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/audio/oggtest"
)

func writePackets(f *OggFramer, n, size int) []byte {
	var out []byte
	for i := 0; i < n; i++ {
		out = append(out, f.WritePacket(bytes.Repeat([]byte{byte(i + 1)}, size))...)
	}
	return out
}

func isHeaderPage(p oggtest.Page) bool {
	return bytes.HasPrefix(p.Body, []byte("OpusHead")) || bytes.HasPrefix(p.Body, []byte("OpusTags"))
}

func TestFirstPageIsOpusHead(t *testing.T) {
	f := NewOggFramer(960)
	out := f.WritePacket(bytes.Repeat([]byte{0xAB}, 40))
	if !bytes.HasPrefix(out, []byte("OggS")) {
		t.Fatalf("stream does not start with OggS")
	}
	pages, err := oggtest.Pages(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) < 1 {
		t.Fatal("no pages emitted")
	}
	body := pages[0].Body
	if !bytes.HasPrefix(body, []byte("OpusHead")) {
		t.Fatalf("first page body = %q, want OpusHead", body)
	}
	if body[9] != 1 {
		t.Errorf("channel count = %d, want 1", body[9])
	}
	if rate := binary.LittleEndian.Uint32(body[12:16]); rate != 16000 {
		t.Errorf("input sample rate = %d, want 16000", rate)
	}
	if pages[0].HeaderType&0x02 == 0 {
		t.Errorf("first page is missing the BOS flag")
	}
}

func TestSecondPageIsOpusTags(t *testing.T) {
	f := NewOggFramer(960)
	out := f.WritePacket(bytes.Repeat([]byte{0xAB}, 40))
	pages, err := oggtest.Pages(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) < 2 {
		t.Fatalf("want 2 header pages, got %d", len(pages))
	}
	if !bytes.HasPrefix(pages[1].Body, []byte("OpusTags")) {
		t.Fatalf("second page body = %q, want OpusTags", pages[1].Body)
	}
}

func TestSingleSerialAcrossStream(t *testing.T) {
	f := NewOggFramer(960)
	out := writePackets(f, 25, 40)
	out = append(out, f.Flush()...)
	pages, err := oggtest.Pages(out)
	if err != nil {
		t.Fatal(err)
	}
	for i, p := range pages {
		if p.Serial != f.Serial() {
			t.Errorf("page %d serial = %d, want %d", i, p.Serial, f.Serial())
		}
	}
	if other := NewOggFramer(960); other.Serial() == f.Serial() {
		t.Errorf("two framers share serial %d", f.Serial())
	}
}

func TestGranulePositionsMonotonic(t *testing.T) {
	f := NewOggFramer(960)
	out := writePackets(f, 50, 40)
	out = append(out, f.Flush()...)
	pages, err := oggtest.Pages(out)
	if err != nil {
		t.Fatal(err)
	}
	var last uint64
	seen := false
	for _, p := range pages {
		if p.PacketCount() == 0 || isHeaderPage(p) {
			continue
		}
		if seen && p.Granule <= last {
			t.Errorf("granule %d did not increase past %d", p.Granule, last)
		}
		last = p.Granule
		seen = true
	}
}

func TestPageFlushEvery200ms(t *testing.T) {
	f := NewOggFramer(960)
	out := writePackets(f, 50, 40)
	pages, err := oggtest.Pages(out)
	if err != nil {
		t.Fatal(err)
	}
	var dataPages []oggtest.Page
	for _, p := range pages {
		if isHeaderPage(p) || p.PacketCount() == 0 {
			continue
		}
		dataPages = append(dataPages, p)
	}
	if len(dataPages) != 5 {
		t.Fatalf("got %d data pages, want 5 (one per 10 packets)", len(dataPages))
	}
	for i, p := range dataPages {
		if p.PacketCount() < 8 || p.PacketCount() > 12 {
			t.Errorf("data page %d has %d packets, want ~10", i, p.PacketCount())
		}
	}
}

func TestPagesHaveValidCRC(t *testing.T) {
	f := NewOggFramer(960)
	out := writePackets(f, 50, 40)
	out = append(out, f.Flush()...)
	pages, err := oggtest.Pages(out)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) == 0 {
		t.Fatal("no pages emitted")
	}
	for i, p := range pages {
		if !p.CRCValid() {
			t.Errorf("page %d has an invalid CRC", i)
		}
	}
}
