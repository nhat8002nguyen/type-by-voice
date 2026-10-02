package transcription

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

// Engine drives one dictation session. RemoteEngine is the only implementation;
// a fake is used in tests.
type Engine interface {
	Start(ctx context.Context, requestID string) (ReadyMessage, error)
	SendAudio(ctx context.Context, oggBytes []byte) error
	Stop(ctx context.Context, durationMs int64) (FinalMessage, error)
	Cancel(ctx context.Context) error
	Close() error
}

// TranscriptionError is a protocol error frame surfaced as a Go error, carrying
// the server's code and whether retrying the same request could succeed.
type TranscriptionError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *TranscriptionError) Error() string {
	return "transcription: " + e.Code + ": " + e.Message
}

// RemoteEngine speaks the dictation v1 protocol over a Socket and keeps the
// connection warm between sessions so consecutive dictations skip the TLS and
// upgrade handshake.
type RemoteEngine struct {
	sock          Socket
	url           string
	accessToken   func() string
	clientVersion string
	deviceID      string
	listInHistory bool
	now           func() time.Time
	warmSocket    time.Duration

	connected bool
	lastUsed  time.Time
	requestID string
}

// NewRemoteEngine builds an engine over sock. accessToken and now are injected
// so the caller controls the bearer token and the warm-socket clock.
func NewRemoteEngine(
	sock Socket,
	url string,
	accessToken func() string,
	clientVersion, deviceID string,
	listInHistory bool,
	now func() time.Time,
	warmSocket time.Duration,
) *RemoteEngine {
	if now == nil {
		now = time.Now
	}
	return &RemoteEngine{
		sock:          sock,
		url:           url,
		accessToken:   accessToken,
		clientVersion: clientVersion,
		deviceID:      deviceID,
		listInHistory: listInHistory,
		now:           now,
		warmSocket:    warmSocket,
	}
}

// Start opens a session and returns the server's ready message.
func (e *RemoteEngine) Start(ctx context.Context, requestID string) (ReadyMessage, error) {
	if err := e.ensureConnected(ctx); err != nil {
		return ReadyMessage{}, err
	}
	e.requestID = requestID

	data, err := json.Marshal(NewStart(requestID, e.clientVersion, e.deviceID, e.listInHistory))
	if err != nil {
		return ReadyMessage{}, wrapErr(err)
	}
	if err := e.sock.SendText(ctx, string(data)); err != nil {
		return ReadyMessage{}, wrapErr(err)
	}
	for {
		msg, err := e.sock.Receive(ctx)
		if err != nil {
			return ReadyMessage{}, wrapErr(err)
		}
		if !msg.IsText {
			continue
		}
		decoded, err := DecodeServerMessage([]byte(msg.Text))
		if err != nil {
			continue
		}
		if decoded.Ready != nil {
			return *decoded.Ready, nil
		}
		if decoded.Error != nil {
			return ReadyMessage{}, errorFromMessage(decoded.Error)
		}
	}
}

// SendAudio streams encoded Ogg Opus bytes for the current session.
func (e *RemoteEngine) SendAudio(ctx context.Context, oggBytes []byte) error {
	if err := e.sock.SendBinary(ctx, oggBytes); err != nil {
		return wrapErr(err)
	}
	return nil
}

// Stop ends speech and returns the final transcription.
func (e *RemoteEngine) Stop(ctx context.Context, durationMs int64) (FinalMessage, error) {
	data, err := json.Marshal(NewStop(e.requestID, durationMs))
	if err != nil {
		return FinalMessage{}, wrapErr(err)
	}
	if err := e.sock.SendText(ctx, string(data)); err != nil {
		return FinalMessage{}, wrapErr(err)
	}
	for {
		msg, err := e.sock.Receive(ctx)
		if err != nil {
			return FinalMessage{}, wrapErr(err)
		}
		if !msg.IsText {
			continue
		}
		decoded, err := DecodeServerMessage([]byte(msg.Text))
		if err != nil {
			continue
		}
		if decoded.Final != nil {
			e.lastUsed = e.now()
			return *decoded.Final, nil
		}
		if decoded.Error != nil {
			return FinalMessage{}, errorFromMessage(decoded.Error)
		}
	}
}

// Cancel abandons the current session.
func (e *RemoteEngine) Cancel(ctx context.Context) error {
	data, err := json.Marshal(NewCancel(e.requestID))
	if err != nil {
		return wrapErr(err)
	}
	if err := e.sock.SendText(ctx, string(data)); err != nil {
		return wrapErr(err)
	}
	return nil
}

// Close tears down the socket.
func (e *RemoteEngine) Close() error {
	e.connected = false
	return e.sock.Close()
}

func (e *RemoteEngine) ensureConnected(ctx context.Context) error {
	if e.connected {
		if e.warmSocket > 0 && e.now().Sub(e.lastUsed) < e.warmSocket {
			return nil
		}
		_ = e.sock.Close()
		e.connected = false
	}
	token := ""
	if e.accessToken != nil {
		token = e.accessToken()
	}
	if err := e.sock.Connect(ctx, e.url, token); err != nil {
		return wrapErr(err)
	}
	e.connected = true
	e.lastUsed = e.now()
	return nil
}

func errorFromMessage(m *ErrorMessage) *TranscriptionError {
	return &TranscriptionError{Code: m.Code, Message: m.Message, Retryable: m.Retryable}
}

func wrapErr(err error) *TranscriptionError {
	// Preserve an already-classified protocol error (for example a close code
	// mapped by the socket) instead of flattening it to "internal".
	var te *TranscriptionError
	if errors.As(err, &te) {
		return te
	}
	return &TranscriptionError{Code: "internal", Message: err.Error(), Retryable: true}
}
