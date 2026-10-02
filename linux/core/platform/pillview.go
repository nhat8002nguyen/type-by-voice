package platform

import "fmt"

// PillView is the display model the overlay renders from. It is derived from a
// PillStatus by a pure function so the mapping can be tested without a display.
type PillView struct {
	Label     string
	ShowLevel bool
	CanRetry  bool
}

// RenderPill maps a PillStatus to its display model. Connecting must not look
// like listening, so only the listening state shows a live level.
func RenderPill(status PillStatus) PillView {
	switch status.State {
	case PillConnecting:
		return PillView{Label: "Connecting…"}
	case PillListening:
		return PillView{Label: formatElapsed(status.ElapsedSeconds), ShowLevel: true}
	case PillTranscribing:
		return PillView{Label: "Transcribing…"}
	case PillError:
		label := status.Message
		if label == "" {
			label = "Dictation failed"
		}
		return PillView{Label: label, CanRetry: status.CanRetry}
	case PillQuotaLow, PillQuotaExhausted:
		return PillView{Label: status.Message}
	default:
		return PillView{}
	}
}

func formatElapsed(seconds int) string {
	if seconds < 0 {
		seconds = 0
	}
	return fmt.Sprintf("Listening · %d:%02d", seconds/60, seconds%60)
}
