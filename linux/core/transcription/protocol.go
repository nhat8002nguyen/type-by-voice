// Package transcription implements the client side of the dictation v1
// protocol: the JSON control messages and the types shared with the engine.
package transcription

import (
	"encoding/json"
	"fmt"
)

// QuotaSnapshot mirrors the dictation v1 quota object. Limit is nullable: a
// null limit means an unlimited word allowance.
type QuotaSnapshot struct {
	Unit    string `json:"unit"`
	Limit   *int   `json:"limit"`
	Used    int    `json:"used"`
	ResetAt string `json:"resetAt"`
}

// StartMessage opens a session and must precede any binary frame.
type StartMessage struct {
	Type          string `json:"type"`
	RequestID     string `json:"requestId"`
	Codec         string `json:"codec"`
	Container     string `json:"container"`
	SampleRate    int    `json:"sampleRate"`
	Channels      int    `json:"channels"`
	Language      string `json:"language"`
	Platform      string `json:"platform"`
	ClientVersion string `json:"clientVersion"`
	DeviceID      string `json:"deviceId"`
	ListInHistory bool   `json:"listInHistory"`
}

// NewStart builds a start message with the fixed audio parameters and the
// Linux platform identity; the caller supplies the per-session and
// per-install fields.
func NewStart(requestID, clientVersion, deviceID string, listInHistory bool) StartMessage {
	return StartMessage{
		Type:          "start",
		RequestID:     requestID,
		Codec:         "opus",
		Container:     "ogg",
		SampleRate:    16000,
		Channels:      1,
		Language:      "en",
		Platform:      "linux",
		ClientVersion: clientVersion,
		DeviceID:      deviceID,
		ListInHistory: listInHistory,
	}
}

// StopMessage signals the end of speech for a session.
type StopMessage struct {
	Type       string `json:"type"`
	RequestID  string `json:"requestId"`
	DurationMs int64  `json:"durationMs"`
}

// NewStop builds a stop message; durationMs is advisory only.
func NewStop(requestID string, durationMs int64) StopMessage {
	return StopMessage{Type: "stop", RequestID: requestID, DurationMs: durationMs}
}

// CancelMessage abandons a session without transcribing.
type CancelMessage struct {
	Type      string `json:"type"`
	RequestID string `json:"requestId"`
}

// NewCancel builds a cancel message.
func NewCancel(requestID string) CancelMessage {
	return CancelMessage{Type: "cancel", RequestID: requestID}
}

// ReadyMessage is sent after a valid start; audio upload may begin only after.
type ReadyMessage struct {
	Type          string        `json:"type"`
	RequestID     string        `json:"requestId"`
	MaxDurationMs int64         `json:"maxDurationMs"`
	Quota         QuotaSnapshot `json:"quota"`
}

// FinalMessage is the transcription result and is terminal for the session.
type FinalMessage struct {
	Type      string        `json:"type"`
	RequestID string        `json:"requestId"`
	Text      string        `json:"text"`
	WordCount int           `json:"wordCount"`
	AudioMs   int64         `json:"audioMs"`
	Quota     QuotaSnapshot `json:"quota"`
}

// ErrorMessage is terminal for the session. Details keeps the raw JSON so an
// unknown or extended shape does not fail decoding.
type ErrorMessage struct {
	Type      string          `json:"type"`
	RequestID string          `json:"requestId"`
	Code      string          `json:"code"`
	Message   string          `json:"message"`
	Retryable bool            `json:"retryable"`
	Details   json.RawMessage `json:"details,omitempty"`
}

// ServerMessage is a decoded server frame. Exactly one of Ready, Final, or
// Error is non-nil, selected by Type.
type ServerMessage struct {
	Type  string
	Ready *ReadyMessage
	Final *FinalMessage
	Error *ErrorMessage
}

// DecodeServerMessage parses a JSON text frame from the server. Unknown fields
// are ignored, so an additive protocol change does not break the client.
func DecodeServerMessage(data []byte) (ServerMessage, error) {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return ServerMessage{}, fmt.Errorf("decode server message: %w", err)
	}
	switch envelope.Type {
	case "ready":
		var m ReadyMessage
		if err := json.Unmarshal(data, &m); err != nil {
			return ServerMessage{}, fmt.Errorf("decode ready: %w", err)
		}
		return ServerMessage{Type: "ready", Ready: &m}, nil
	case "final":
		var m FinalMessage
		if err := json.Unmarshal(data, &m); err != nil {
			return ServerMessage{}, fmt.Errorf("decode final: %w", err)
		}
		return ServerMessage{Type: "final", Final: &m}, nil
	case "error":
		var m ErrorMessage
		if err := json.Unmarshal(data, &m); err != nil {
			return ServerMessage{}, fmt.Errorf("decode error: %w", err)
		}
		return ServerMessage{Type: "error", Error: &m}, nil
	default:
		return ServerMessage{}, fmt.Errorf("unknown server message type %q", envelope.Type)
	}
}
