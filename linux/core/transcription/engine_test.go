package transcription

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
)

type fakeSocket struct {
	connectCalls   int
	connectedURL   string
	connectedToken string
	sentText       []string
	sentBinary     [][]byte
	incoming       []Message
}

func (f *fakeSocket) Connect(_ context.Context, url, accessToken string) error {
	f.connectCalls++
	f.connectedURL = url
	f.connectedToken = accessToken
	return nil
}

func (f *fakeSocket) SendText(_ context.Context, text string) error {
	f.sentText = append(f.sentText, text)
	return nil
}

func (f *fakeSocket) SendBinary(_ context.Context, b []byte) error {
	f.sentBinary = append(f.sentBinary, append([]byte(nil), b...))
	return nil
}

func (f *fakeSocket) Receive(_ context.Context) (Message, error) {
	if len(f.incoming) == 0 {
		return Message{}, errors.New("fakeSocket: no more messages")
	}
	m := f.incoming[0]
	f.incoming = f.incoming[1:]
	return m, nil
}

func (f *fakeSocket) Close() error { return nil }

func text(t string) Message { return Message{IsText: true, Text: t} }

const (
	readyJSON = `{"type":"ready","requestId":"3f2b","maxDurationMs":120000,` +
		`"quota":{"unit":"words","limit":2000,"used":312,"resetAt":"2026-09-18T04:12:00Z"}}`
	finalJSON = `{"type":"final","requestId":"3f2b","text":"hello","wordCount":1,"audioMs":900,` +
		`"quota":{"unit":"words","limit":2000,"used":313,"resetAt":"2026-09-18T04:12:00Z"}}`
	errorJSON = `{"type":"error","requestId":"3f2b","code":"quota_exceeded",` +
		`"message":"Weekly limit reached.","retryable":false}`
)

var fixedNow = time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)

func newTestEngine(sock Socket, token string) *RemoteEngine {
	return NewRemoteEngine(
		sock,
		"ws://127.0.0.1:3000/v1/dictate",
		func() string { return token },
		"1.0.0+12",
		"9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77",
		true,
		func() time.Time { return fixedNow },
		60*time.Second,
	)
}

func TestStartSendsStartAndAwaitsReady(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON)}}
	eng := newTestEngine(sock, "tok")

	ready, err := eng.Start(context.Background(), "3f2b")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if ready.MaxDurationMs != 120000 {
		t.Errorf("maxDurationMs = %d, want 120000", ready.MaxDurationMs)
	}
	if len(sock.sentText) != 1 {
		t.Fatalf("sent %d text frames, want 1", len(sock.sentText))
	}
	var start StartMessage
	if err := json.Unmarshal([]byte(sock.sentText[0]), &start); err != nil {
		t.Fatalf("start frame is not JSON: %v", err)
	}
	if start.Type != "start" {
		t.Errorf("type = %q, want start", start.Type)
	}
	if start.RequestID != "3f2b" {
		t.Errorf("requestId = %q, want 3f2b", start.RequestID)
	}
	if start.Platform != "linux" {
		t.Errorf("platform = %q, want linux", start.Platform)
	}
}

func TestBearerTokenOnConnect(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON)}}
	eng := newTestEngine(sock, "secret-token")

	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("start: %v", err)
	}
	if sock.connectedToken != "secret-token" {
		t.Errorf("connect token = %q, want secret-token", sock.connectedToken)
	}
}

func TestSendAudioSendsBinaryFrames(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON)}}
	eng := newTestEngine(sock, "tok")
	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("start: %v", err)
	}

	payload := []byte{0x4f, 0x67, 0x67, 0x53}
	if err := eng.SendAudio(context.Background(), payload); err != nil {
		t.Fatalf("send audio: %v", err)
	}
	if len(sock.sentBinary) != 1 || !bytes.Equal(sock.sentBinary[0], payload) {
		t.Errorf("binary frames = %v, want one frame %v", sock.sentBinary, payload)
	}
}

func TestStopSendsStopAndReturnsFinal(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON), text(finalJSON)}}
	eng := newTestEngine(sock, "tok")
	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("start: %v", err)
	}

	final, err := eng.Stop(context.Background(), 900)
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if final.Text != "hello" {
		t.Errorf("text = %q, want hello", final.Text)
	}
	var stop StopMessage
	if err := json.Unmarshal([]byte(sock.sentText[len(sock.sentText)-1]), &stop); err != nil {
		t.Fatalf("last frame is not JSON: %v", err)
	}
	if stop.Type != "stop" {
		t.Errorf("last frame type = %q, want stop", stop.Type)
	}
}

func TestErrorThrowsWithCodeAndRetryable(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON), text(errorJSON)}}
	eng := newTestEngine(sock, "tok")
	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("start: %v", err)
	}

	_, err := eng.Stop(context.Background(), 900)
	var te *TranscriptionError
	if !errors.As(err, &te) {
		t.Fatalf("err = %v, want *TranscriptionError", err)
	}
	if te.Code != "quota_exceeded" {
		t.Errorf("code = %q, want quota_exceeded", te.Code)
	}
	if te.Retryable {
		t.Errorf("retryable = true, want false")
	}
}

func TestWarmSocketReused(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON), text(finalJSON), text(readyJSON)}}
	eng := newTestEngine(sock, "tok")
	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("first start: %v", err)
	}
	if _, err := eng.Stop(context.Background(), 900); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("second start: %v", err)
	}
	if sock.connectCalls != 1 {
		t.Errorf("connect calls = %d, want 1 (warm socket reused)", sock.connectCalls)
	}
}

func TestCancelSendsCancel(t *testing.T) {
	sock := &fakeSocket{incoming: []Message{text(readyJSON)}}
	eng := newTestEngine(sock, "tok")
	if _, err := eng.Start(context.Background(), "3f2b"); err != nil {
		t.Fatalf("start: %v", err)
	}

	if err := eng.Cancel(context.Background()); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	var cancel CancelMessage
	if err := json.Unmarshal([]byte(sock.sentText[len(sock.sentText)-1]), &cancel); err != nil {
		t.Fatalf("last frame is not JSON: %v", err)
	}
	if cancel.Type != "cancel" {
		t.Errorf("last frame type = %q, want cancel", cancel.Type)
	}
}
