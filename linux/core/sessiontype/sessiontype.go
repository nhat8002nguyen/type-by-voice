// Package sessiontype detects whether the client runs under X11 or Wayland.
// This decides how the global hotkey and text insertion work: X11 allows a
// global key grab and synthesized keystrokes; Wayland does not, so those
// degrade to a click-to-record fallback and clipboard-only insertion.
package sessiontype

import "strings"

// SessionType is the display session the client runs under.
type SessionType int

// Session types.
const (
	Unknown SessionType = iota
	X11
	Wayland
)

// Detect reads XDG_SESSION_TYPE through getenv.
func Detect(getenv func(string) string) SessionType {
	switch strings.ToLower(getenv("XDG_SESSION_TYPE")) {
	case "x11":
		return X11
	case "wayland":
		return Wayland
	default:
		return Unknown
	}
}

func (s SessionType) String() string {
	switch s {
	case X11:
		return "x11"
	case Wayland:
		return "wayland"
	default:
		return "unknown"
	}
}
