// Package audio implements the core audio interfaces over Linux audio: capture
// through miniaudio (ALSA + PulseAudio, and PipeWire via its pulse-server) and
// Opus packet encoding through libopus. It must be built with CGO_ENABLED=1 on
// Linux.
package audio

import (
	"context"
	"encoding/binary"
	"fmt"
	"sync"
	"unsafe"

	"github.com/gen2brain/malgo"

	coreaudio "github.com/nhat8002nguyen/type-by-voice/linux/core/audio"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
)

// captureSampleRate is the rate the whole pipeline runs at (16 kHz mono).
const captureSampleRate = 16000

type capture struct {
	ctx        *malgo.AllocatedContext
	device     *malgo.Device
	deviceName string
	frames     chan []int16
	lost       chan struct{}
	closeOnce  sync.Once
}

// NewCapture opens a miniaudio capture context. deviceName selects an input by
// name; an empty name uses the system default.
func NewCapture(deviceName string) (platform.AudioCapture, error) {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, fmt.Errorf("audio: init context: %w", err)
	}
	return &capture{
		ctx:        ctx,
		deviceName: deviceName,
		frames:     make(chan []int16, 64),
		lost:       make(chan struct{}, 1),
	}, nil
}

// ListDevices returns the names of available capture devices.
func ListDevices() ([]string, error) {
	ctx, err := malgo.InitContext(nil, malgo.ContextConfig{}, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = ctx.Uninit() }()
	infos, err := ctx.Devices(malgo.Capture)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(infos))
	for i := range infos {
		names = append(names, infos[i].Name())
	}
	return names, nil
}

func (c *capture) Start(context.Context) error {
	// Release any device from a previous session so streams do not leak.
	if c.device != nil {
		c.device.Uninit()
		c.device = nil
	}
	cfg := malgo.DefaultDeviceConfig(malgo.Capture)
	cfg.Capture.Format = malgo.FormatS16
	cfg.Capture.Channels = 1
	cfg.Capture.SampleRate = captureSampleRate
	if c.deviceName != "" {
		if dev, err := c.findDevice(c.deviceName); err == nil {
			cfg.Capture.DeviceID = unsafe.Pointer(&dev.ID[0])
		}
	}
	callbacks := malgo.DeviceCallbacks{
		Data: func(_, in []byte, _ uint32) {
			if len(in) == 0 {
				return
			}
			n := len(in) / 2
			samples := make([]int16, n)
			for i := 0; i < n; i++ {
				samples[i] = int16(binary.LittleEndian.Uint16(in[i*2:]))
			}
			select {
			case c.frames <- samples:
			default: // drop a frame rather than stall the audio callback
			}
		},
		Stop: func() {
			select {
			case c.lost <- struct{}{}:
			default:
			}
		},
	}
	dev, err := malgo.InitDevice(c.ctx.Context, cfg, callbacks)
	if err != nil {
		return fmt.Errorf("audio: init device: %w", err)
	}
	if err := dev.Start(); err != nil {
		dev.Uninit()
		return fmt.Errorf("audio: start device: %w", err)
	}
	c.device = dev
	return nil
}

func (c *capture) Stop() error {
	if c.device != nil {
		c.device.Uninit()
		c.device = nil
	}
	return nil
}

func (c *capture) Frames() <-chan []int16      { return c.frames }
func (c *capture) DeviceLost() <-chan struct{} { return c.lost }

// Close releases the capture device and the miniaudio context.
func (c *capture) Close() {
	_ = c.Stop()
	c.closeOnce.Do(func() { _ = c.ctx.Uninit() })
}

func (c *capture) findDevice(name string) (*malgo.DeviceInfo, error) {
	infos, err := c.ctx.Devices(malgo.Capture)
	if err != nil {
		return nil, err
	}
	for i := range infos {
		if infos[i].Name() == name {
			return &infos[i], nil
		}
	}
	return nil, fmt.Errorf("audio: device %q not found", name)
}

// Ensure capture satisfies coreaudio's frame expectations.
var _ = coreaudio.FrameSamples
