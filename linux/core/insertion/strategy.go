package insertion

import "github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"

// Strategy decides how a transcript reaches the frontmost application.
type Strategy int

// Insertion strategies.
const (
	// StrategySynthesizeX11 synthesizes Ctrl+V through XTest (X11).
	StrategySynthesizeX11 Strategy = iota
	// StrategyWtype synthesizes Ctrl+V through wtype (Wayland with a wlr
	// virtual keyboard).
	StrategyWtype
	// StrategyClipboardOnly leaves the transcript on the clipboard; Wayland
	// without a virtual keyboard cannot insert automatically.
	StrategyClipboardOnly
)

// ChooseInsertionStrategy picks the insertion path. X11 always synthesizes;
// Wayland uses wtype only when it is available, and otherwise degrades to
// clipboard-only so the transcript is never lost.
func ChooseInsertionStrategy(session sessiontype.SessionType, wtypeAvailable bool) Strategy {
	switch session {
	case sessiontype.X11:
		return StrategySynthesizeX11
	case sessiontype.Wayland:
		if wtypeAvailable {
			return StrategyWtype
		}
		return StrategyClipboardOnly
	default:
		return StrategyClipboardOnly
	}
}
