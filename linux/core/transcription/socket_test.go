package transcription

import (
	"testing"

	"github.com/coder/websocket"
)

func TestMapCloseMapsProtocolCloseCodes(t *testing.T) {
	cases := []struct {
		code websocket.StatusCode
		want string
	}{
		{4401, "unauthenticated"},
		{4403, "quota_exceeded"},
		{4429, "rate_limited"},
	}
	for _, c := range cases {
		got := mapClose(websocket.CloseError{Code: c.code})
		te, ok := got.(*TranscriptionError)
		if !ok {
			t.Fatalf("close %d -> %T, want *TranscriptionError", c.code, got)
		}
		if te.Code != c.want {
			t.Errorf("close %d -> code %q, want %q", c.code, te.Code, c.want)
		}
	}
}

func TestMapCloseLeavesOtherErrorsAlone(t *testing.T) {
	err := websocket.CloseError{Code: websocket.StatusNormalClosure}
	if got := mapClose(err); got != error(err) {
		t.Errorf("normal close was rewritten: %v", got)
	}
}
