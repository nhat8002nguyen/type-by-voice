// Package hotkey implements the global recorder shortcut. On X11 it grabs the
// key with XGrabKey (which needs no permission prompt, the same rationale as
// the macOS Carbon hotkey). Wayland has no global grab, so NewHotkey reports
// that and the app layer falls back to click-to-record (Task 18).
package hotkey

import (
	"errors"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
)

// ErrUnsupportedSession is returned when no global-hotkey mechanism exists for
// the session. On Wayland the app layer substitutes the click-to-record
// fallback instead.
var ErrUnsupportedSession = errors.New("hotkey: no global hotkey for this session")

// NewHotkey returns the global-hotkey implementation for the session.
func NewHotkey(session sessiontype.SessionType, hk settings.Hotkey) (platform.Hotkey, error) {
	if session == sessiontype.X11 {
		return newX11Hotkey(hk)
	}
	return nil, ErrUnsupportedSession
}
