// Package hotkey implements the global recorder shortcut. On X11 it grabs the
// key with XGrabKey (which needs no permission prompt, the same rationale as the
// macOS Carbon hotkey). Wayland has no global grab, so it falls back to a
// click-to-record hotkey driven by the tray/pill.
package hotkey

import (
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
)

// NewHotkey returns the global-hotkey implementation for the session: an X11
// grab on X11, and the click-to-record fallback on Wayland.
func NewHotkey(session sessiontype.SessionType, hk settings.Hotkey) (platform.Hotkey, error) {
	if session == sessiontype.X11 {
		return newX11Hotkey(hk)
	}
	return NewFallbackHotkey(), nil
}
