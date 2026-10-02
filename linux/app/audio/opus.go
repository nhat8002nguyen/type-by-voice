package audio

import (
	"fmt"

	"gopkg.in/hraban/opus.v2"

	coreaudio "github.com/nhat8002nguyen/type-by-voice/linux/core/audio"
)

// libOpusEncoder adapts libopus to coreaudio.Encoder: 16 kHz, mono, VOIP, one
// 20 ms frame per packet at ~24 kbps.
type libOpusEncoder struct {
	enc *opus.Encoder
	buf []byte
}

// NewLibOpusEncoder builds a libopus encoder. It requires cgo and libopus.
func NewLibOpusEncoder() (coreaudio.Encoder, error) {
	enc, err := opus.NewEncoder(captureSampleRate, 1, opus.AppVoIP)
	if err != nil {
		return nil, fmt.Errorf("opus: new encoder: %w", err)
	}
	if err := enc.SetBitrate(24000); err != nil {
		return nil, fmt.Errorf("opus: set bitrate: %w", err)
	}
	return &libOpusEncoder{enc: enc, buf: make([]byte, 4000)}, nil
}

// Encode turns exactly one 20 ms frame (coreaudio.FrameSamples samples) into one
// Opus packet.
func (e *libOpusEncoder) Encode(pcm []int16) ([]byte, error) {
	if len(pcm) != coreaudio.FrameSamples {
		return nil, fmt.Errorf("opus: want %d samples, got %d", coreaudio.FrameSamples, len(pcm))
	}
	n, err := e.enc.Encode(pcm, e.buf)
	if err != nil {
		return nil, err
	}
	packet := make([]byte, n)
	copy(packet, e.buf[:n])
	return packet, nil
}

// Close releases the encoder.
func (e *libOpusEncoder) Close() error { return nil }
