package transcription

import (
	"context"
	"errors"
	"net/http"

	"github.com/coder/websocket"
)

// Message is one received frame: text (a JSON control message) or binary
// (Ogg Opus bytes, never expected from the server).
type Message struct {
	IsText bool
	Text   string
	Data   []byte
}

// Socket is the WebSocket transport the engine sends and receives on. It is an
// interface so the engine can be unit-tested with a fake.
type Socket interface {
	Connect(ctx context.Context, url, accessToken string) error
	SendText(ctx context.Context, text string) error
	SendBinary(ctx context.Context, data []byte) error
	Receive(ctx context.Context) (Message, error)
	Close() error
}

type webSocketSocket struct {
	conn *websocket.Conn
}

// NewWebSocketSocket returns a Socket backed by a real WebSocket connection.
func NewWebSocketSocket() Socket { return &webSocketSocket{} }

func (s *webSocketSocket) Connect(ctx context.Context, url, accessToken string) error {
	opts := &websocket.DialOptions{HTTPHeader: http.Header{}}
	if accessToken != "" {
		opts.HTTPHeader.Set("Authorization", "Bearer "+accessToken)
	}
	conn, _, err := websocket.Dial(ctx, url, opts)
	if err != nil {
		return err
	}
	conn.SetReadLimit(1 << 20)
	s.conn = conn
	return nil
}

func (s *webSocketSocket) SendText(ctx context.Context, text string) error {
	return s.conn.Write(ctx, websocket.MessageText, []byte(text))
}

func (s *webSocketSocket) SendBinary(ctx context.Context, data []byte) error {
	return s.conn.Write(ctx, websocket.MessageBinary, data)
}

func (s *webSocketSocket) Receive(ctx context.Context) (Message, error) {
	typ, data, err := s.conn.Read(ctx)
	if err != nil {
		return Message{}, mapClose(err)
	}
	return Message{IsText: typ == websocket.MessageText, Text: string(data), Data: data}, nil
}

// mapClose turns a server close carrying a protocol close code into the
// matching protocol error, so the coordinator's one-refresh-and-reconnect path
// runs on an authentication close as well as on an `error` frame.
func mapClose(err error) error {
	var closeErr websocket.CloseError
	if !errors.As(err, &closeErr) {
		return err
	}
	switch closeErr.Code {
	case 4401:
		return &TranscriptionError{Code: "unauthenticated", Message: "authentication failed at upgrade"}
	case 4403:
		return &TranscriptionError{Code: "quota_exceeded", Message: "quota exhausted"}
	case 4429:
		return &TranscriptionError{Code: "rate_limited", Message: "rate limited"}
	}
	return err
}

func (s *webSocketSocket) Close() error {
	if s.conn == nil {
		return nil
	}
	return s.conn.Close(websocket.StatusNormalClosure, "")
}
