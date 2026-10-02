package audio

import "testing"

func TestFakeEncoderEmitsOnePacketPerFrame(t *testing.T) {
	e := NewFakeEncoder()
	frame := make([]int16, FrameSamples)

	var packets [][]byte
	for i := 0; i < 2; i++ {
		p, err := e.Encode(frame)
		if err != nil {
			t.Fatalf("encode frame %d: %v", i, err)
		}
		packets = append(packets, p)
	}
	if len(packets) != 2 {
		t.Fatalf("got %d packets, want 2", len(packets))
	}
	if len(packets[0]) != 1 || len(packets[1]) != 1 {
		t.Fatalf("packets are not one byte each")
	}
	if packets[0][0] == packets[1][0] {
		t.Errorf("expected a distinct packet per frame")
	}
	if e.FramesEncoded() != 2 {
		t.Errorf("frames encoded = %d, want 2", e.FramesEncoded())
	}
}

func TestFakeEncoderRejectsPartialFrame(t *testing.T) {
	e := NewFakeEncoder()
	if _, err := e.Encode(make([]int16, FrameSamples-1)); err == nil {
		t.Errorf("expected an error for a partial frame")
	}
	if e.FramesEncoded() != 0 {
		t.Errorf("frames encoded = %d, want 0 after a rejected frame", e.FramesEncoded())
	}
}
