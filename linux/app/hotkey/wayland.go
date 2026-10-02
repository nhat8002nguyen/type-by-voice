package hotkey

import "github.com/nhat8002nguyen/type-by-voice/linux/core/platform"

// FallbackHotkey is the Wayland hotkey. Wayland has no global key grab, so the
// toggle is driven by a click on the tray or the pill instead of a key. This is
// the Linux analogue of "use Ubuntu on Xorg for full hotkey parity".
type FallbackHotkey struct {
	toggled chan struct{}
}

// NewFallbackHotkey returns a hotkey whose toggles come from clicks.
func NewFallbackHotkey() platform.Hotkey {
	return &FallbackHotkey{toggled: make(chan struct{}, 1)}
}

func (h *FallbackHotkey) Start() error             { return nil }
func (h *FallbackHotkey) Stop() error              { return nil }
func (h *FallbackHotkey) Toggled() <-chan struct{} { return h.toggled }

// Trigger fires a toggle; the tray/pill click handler calls it.
func (h *FallbackHotkey) Trigger() {
	select {
	case h.toggled <- struct{}{}:
	default:
	}
}
