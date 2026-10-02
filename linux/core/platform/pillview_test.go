package platform

import "testing"

func TestRenderPillConnecting(t *testing.T) {
	v := RenderPill(PillStatus{State: PillConnecting})
	if v.Label == "" {
		t.Errorf("connecting label is empty")
	}
	if v.ShowLevel {
		t.Errorf("connecting must not show a live level (speak only after it leaves)")
	}
}

func TestRenderPillListening(t *testing.T) {
	v := RenderPill(PillStatus{State: PillListening, ElapsedSeconds: 65})
	if !v.ShowLevel {
		t.Errorf("listening must show a live level")
	}
	if v.Label != "Listening · 1:05" {
		t.Errorf("label = %q, want Listening · 1:05", v.Label)
	}
}

func TestRenderPillTranscribing(t *testing.T) {
	v := RenderPill(PillStatus{State: PillTranscribing})
	if v.ShowLevel {
		t.Errorf("transcribing must not show a level")
	}
	if v.Label == "" {
		t.Errorf("transcribing label is empty")
	}
}

func TestRenderPillErrorCanRetry(t *testing.T) {
	v := RenderPill(PillStatus{State: PillError, Message: "boom", CanRetry: true})
	if !v.CanRetry {
		t.Errorf("CanRetry = false, want true")
	}
	if v.Label != "boom" {
		t.Errorf("label = %q, want boom", v.Label)
	}
}

func TestRenderPillQuota(t *testing.T) {
	low := RenderPill(PillStatus{State: PillQuotaLow, Message: "200 words left"})
	if low.Label != "200 words left" {
		t.Errorf("quota low label = %q", low.Label)
	}
	exhausted := RenderPill(PillStatus{State: PillQuotaExhausted, Message: "Limit reached · resets Mon"})
	if exhausted.Label != "Limit reached · resets Mon" {
		t.Errorf("quota exhausted label = %q", exhausted.Label)
	}
}

func TestRenderPillHidden(t *testing.T) {
	if v := RenderPill(PillStatus{State: PillHidden}); v.Label != "" || v.ShowLevel || v.CanRetry {
		t.Errorf("hidden pill should render nothing, got %+v", v)
	}
}
