// Package insertion holds what text insertion shares across platforms: the X11
// modifier masks and the keysyms the paste keystroke needs, plus (Task 18) the
// strategy decision for X11 vs Wayland. It is pure Go so it tests anywhere.
package insertion

import "strings"

// X11 modifier mask bits (from X.h).
const (
	ModShift   uint16 = 1 << 0
	ModLock    uint16 = 1 << 1
	ModControl uint16 = 1 << 2
	Mod1       uint16 = 1 << 3
	Mod4       uint16 = 1 << 6
)

// Keysyms the paste keystroke uses (from X11/keysymdef.h).
const (
	KeysymV        uint32 = 0x0076 // 'v'
	KeysymControlL uint32 = 0xffe3 // Control_L
)

// ModifierMask maps a modifier name to its X11 modifier mask bit.
func ModifierMask(name string) (uint16, bool) {
	switch strings.ToLower(name) {
	case "shift":
		return ModShift, true
	case "ctrl", "control":
		return ModControl, true
	case "alt":
		return Mod1, true
	case "super", "win", "meta":
		return Mod4, true
	default:
		return 0, false
	}
}

// ModifierMasks combines a list of modifier names; false if any is unknown.
func ModifierMasks(names []string) (uint16, bool) {
	var mask uint16
	for _, n := range names {
		m, ok := ModifierMask(n)
		if !ok {
			return 0, false
		}
		mask |= m
	}
	return mask, true
}
