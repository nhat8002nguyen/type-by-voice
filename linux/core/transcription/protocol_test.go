package transcription

import (
	"encoding/json"
	"testing"
)

const (
	testRequestID = "3f2b2b2b-0000-4000-8000-000000000000"
	testDeviceID  = "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77"
)

func TestStartSerializesToSpecShape(t *testing.T) {
	data, err := json.Marshal(NewStart(testRequestID, "1.0.0+12", testDeviceID, true))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	want := map[string]any{
		"type":          "start",
		"requestId":     testRequestID,
		"codec":         "opus",
		"container":     "ogg",
		"sampleRate":    float64(16000),
		"channels":      float64(1),
		"language":      "en",
		"platform":      "linux",
		"clientVersion": "1.0.0+12",
		"deviceId":      testDeviceID,
		"listInHistory": true,
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

func TestStopSerializesToSpecShape(t *testing.T) {
	data, err := json.Marshal(NewStop(testRequestID, 11800))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["type"] != "stop" {
		t.Errorf("type = %v, want stop", got["type"])
	}
	if got["durationMs"] != float64(11800) {
		t.Errorf("durationMs = %v, want 11800", got["durationMs"])
	}
}

func TestCancelSerializesToSpecShape(t *testing.T) {
	data, err := json.Marshal(NewCancel(testRequestID))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["type"] != "cancel" {
		t.Errorf("type = %v, want cancel", got["type"])
	}
}

func TestReadyDeserializes(t *testing.T) {
	data := []byte(`{"type":"ready","requestId":"3f2b","maxDurationMs":120000,` +
		`"quota":{"unit":"words","limit":2000,"used":312,"resetAt":"2026-09-18T04:12:00Z"}}`)
	msg, err := DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Type != "ready" || msg.Ready == nil {
		t.Fatalf("expected ready message, got %+v", msg)
	}
	if msg.Ready.MaxDurationMs != 120000 {
		t.Errorf("maxDurationMs = %d, want 120000", msg.Ready.MaxDurationMs)
	}
	if msg.Ready.Quota.Limit == nil || *msg.Ready.Quota.Limit != 2000 {
		t.Errorf("quota.limit = %v, want 2000", msg.Ready.Quota.Limit)
	}
	if msg.Ready.Quota.Used != 312 {
		t.Errorf("quota.used = %d, want 312", msg.Ready.Quota.Used)
	}
}

func TestReadyNullLimit(t *testing.T) {
	data := []byte(`{"type":"ready","requestId":"3f2b","maxDurationMs":120000,` +
		`"quota":{"unit":"words","limit":null,"used":0,"resetAt":"2026-09-18T04:12:00Z"}}`)
	msg, err := DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Ready == nil || msg.Ready.Quota.Limit != nil {
		t.Fatalf("expected nil limit, got %+v", msg.Ready)
	}
}

func TestFinalDeserializes(t *testing.T) {
	data := []byte(`{"type":"final","requestId":"3f2b","text":"the transcribed text",` +
		`"wordCount":42,"audioMs":11800,` +
		`"quota":{"unit":"words","limit":2000,"used":354,"resetAt":"2026-09-18T04:12:00Z"}}`)
	msg, err := DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Final == nil {
		t.Fatalf("expected final message, got %+v", msg)
	}
	if msg.Final.Text != "the transcribed text" {
		t.Errorf("text = %q", msg.Final.Text)
	}
	if msg.Final.WordCount != 42 {
		t.Errorf("wordCount = %d, want 42", msg.Final.WordCount)
	}
	if msg.Final.AudioMs != 11800 {
		t.Errorf("audioMs = %d, want 11800", msg.Final.AudioMs)
	}
}

func TestErrorDeserializes(t *testing.T) {
	data := []byte(`{"type":"error","requestId":"3f2b","code":"quota_exceeded",` +
		`"message":"Weekly limit reached.","retryable":false,` +
		`"details":{"limit":2000,"used":2131,"resetAt":"2026-09-18T04:12:00Z"}}`)
	msg, err := DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Error == nil {
		t.Fatalf("expected error message, got %+v", msg)
	}
	if msg.Error.Code != "quota_exceeded" {
		t.Errorf("code = %q", msg.Error.Code)
	}
	if msg.Error.Retryable {
		t.Errorf("retryable = true, want false")
	}
	if len(msg.Error.Details) == 0 {
		t.Errorf("details not preserved")
	}
}

func TestDecodeIgnoresUnknownFields(t *testing.T) {
	data := []byte(`{"type":"final","requestId":"3f2b","text":"hi","wordCount":7,` +
		`"audioMs":900,"futureField":1,` +
		`"quota":{"unit":"words","limit":2000,"used":7,"resetAt":"2026-09-18T04:12:00Z","extra":true}}`)
	msg, err := DecodeServerMessage(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if msg.Final == nil || msg.Final.WordCount != 7 {
		t.Fatalf("wordCount not read past unknown fields: %+v", msg)
	}
}
