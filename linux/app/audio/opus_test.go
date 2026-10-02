package audio

import (
	"testing"

	coreaudio "github.com/nhat8002nguyen/type-by-voice/linux/core/audio"
)

// These tests require cgo + libopus and run only on Linux (VM / CI).

func TestLibOpusEncoderEmitsPacketPerFrame(t *testing.T) {
	enc, err := NewLibOpusEncoder()
	if err != nil {
		t.Fatalf("new encoder: %v", err)
	}
	defer func() { _ = enc.Close() }()

	frame := make([]int16, coreaudio.FrameSamples)
	packet, err := enc.Encode(frame)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if len(packet) == 0 {
		t.Errorf("empty Opus packet")
	}
}

func TestLibOpusEncoderRejectsPartialFrame(t *testing.T) {
	enc, err := NewLibOpusEncoder()
	if err != nil {
		t.Fatalf("new encoder: %v", err)
	}
	defer func() { _ = enc.Close() }()

	if _, err := enc.Encode(make([]int16, coreaudio.FrameSamples-1)); err == nil {
		t.Errorf("expected an error for a partial frame")
	}
}
