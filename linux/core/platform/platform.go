// Package platform defines the interfaces the session coordinator uses to reach
// the Linux shell: audio capture, the global hotkey, text insertion, the
// clipboard, the overlay pill, and notifications. Implementations live in
// linux/app and are wired in cmd/typebyvoice.
package platform

import "context"

// AudioCapture produces 16 kHz mono PCM frames.
type AudioCapture interface {
	Start(ctx context.Context) error
	Stop() error
	Frames() <-chan []int16
	DeviceLost() <-chan struct{}
}

// TextInserter puts a string into the frontmost application, falling back to
// leaving it on the clipboard when it cannot synthesize a paste.
type TextInserter interface {
	Insert(ctx context.Context, text string) error
}

// Hotkey emits a toggle event on each activation.
type Hotkey interface {
	Start() error
	Stop() error
	Toggled() <-chan struct{}
}

// Clipboard saves, sets, and restores the text clipboard around a paste.
type Clipboard interface {
	Save(ctx context.Context) error
	SetText(ctx context.Context, text string) error
	Restore(ctx context.Context) error
}

// PillState is the overlay's display state.
type PillState int

// Pill states, matching the macOS overlay.
const (
	PillHidden PillState = iota
	PillConnecting
	PillListening
	PillTranscribing
	PillError
	PillQuotaLow
	PillQuotaExhausted
)

// PillStatus is what the coordinator tells the overlay pill to show.
type PillStatus struct {
	State          PillState
	Message        string
	ElapsedSeconds int
	CanRetry       bool
}

// Pill renders the overlay pill.
type Pill interface {
	Show(status PillStatus)
	Hide()
}

// Notifier posts a desktop notification.
type Notifier interface {
	Notify(title, body string)
}
