package audio

import (
	"errors"
	"fmt"
)

// FrameSamples is one 20 ms frame of 16 kHz mono PCM.
const FrameSamples = 320

// FrameMs is the frame duration in milliseconds.
const FrameMs = 20

// Encoder converts one frame of 16 kHz mono PCM into one Opus packet. The real
// implementation wraps libopus and lives in the cgo app layer
// (linux/app/audio); tests use FakeEncoder so the pipeline can be exercised
// without libopus.
type Encoder interface {
	Encode(pcm []int16) ([]byte, error)
	Close() error
}

// FakeEncoder is a deterministic Encoder for tests: each frame produces a
// one-byte packet carrying the frame index.
type FakeEncoder struct {
	frames int
	closed bool
}

// NewFakeEncoder returns a ready fake encoder.
func NewFakeEncoder() *FakeEncoder { return &FakeEncoder{} }

// Encode returns a packet derived from the frame index.
func (e *FakeEncoder) Encode(pcm []int16) ([]byte, error) {
	if e.closed {
		return nil, errors.New("encoder closed")
	}
	if len(pcm) != FrameSamples {
		return nil, fmt.Errorf("encoder: want %d samples, got %d", FrameSamples, len(pcm))
	}
	packet := []byte{byte(e.frames)}
	e.frames++
	return packet, nil
}

// Close marks the encoder closed; later Encode calls fail.
func (e *FakeEncoder) Close() error {
	e.closed = true
	return nil
}

// FramesEncoded is the number of frames encoded so far.
func (e *FakeEncoder) FramesEncoded() int { return e.frames }
