// Package session owns the client's state machine: the coordinator that turns a
// hotkey toggle into record -> transcribe -> insert, with a timeout that
// returns every non-idle state to idle.
package session

import (
	"context"
	"fmt"
	"time"
)

// State is the session state machine's state.
type State int

// Session states.
const (
	StateIdle State = iota
	StateConnecting
	StateRecording
	StateTranscribing
	StateInserting
)

func (s State) String() string {
	switch s {
	case StateIdle:
		return "idle"
	case StateConnecting:
		return "connecting"
	case StateRecording:
		return "recording"
	case StateTranscribing:
		return "transcribing"
	case StateInserting:
		return "inserting"
	default:
		return fmt.Sprintf("state(%d)", int(s))
	}
}

// Clock is the coordinator's time source. After is what lets a fake clock drive
// the timeouts deterministically in tests.
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}

// Timeouts are the per-state deadlines. Every non-idle state has one, so a
// dictation that can hang is impossible.
type Timeouts struct {
	Connecting       time.Duration
	Transcribing     time.Duration
	Inserting        time.Duration
	RecordingHardCap time.Duration
	WarmSocket       time.Duration
	SilenceDuration  time.Duration
	NoSpeechTimeout  time.Duration
	MinDuration      time.Duration
	TrailingHangover time.Duration
}

// NewTimeouts returns the spec's timeout values.
func NewTimeouts() Timeouts {
	return Timeouts{
		Connecting:       5 * time.Second,
		Transcribing:     15 * time.Second,
		Inserting:        2 * time.Second,
		RecordingHardCap: 120 * time.Second,
		WarmSocket:       60 * time.Second,
		SilenceDuration:  3000 * time.Millisecond,
		NoSpeechTimeout:  10 * time.Second,
		MinDuration:      400 * time.Millisecond,
		TrailingHangover: 0,
	}
}

// Refresher is the piece of auth the coordinator needs: a single refresh
// attempt after an unauthenticated protocol error. *auth.Store satisfies it.
type Refresher interface {
	RefreshIfNeeded(ctx context.Context) error
}
