package sessiontype

import "testing"

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestDetectX11(t *testing.T) {
	if got := Detect(env(map[string]string{"XDG_SESSION_TYPE": "x11"})); got != X11 {
		t.Errorf("detect = %v, want X11", got)
	}
}

func TestDetectWayland(t *testing.T) {
	if got := Detect(env(map[string]string{"XDG_SESSION_TYPE": "wayland"})); got != Wayland {
		t.Errorf("detect = %v, want Wayland", got)
	}
}

func TestDetectUnknown(t *testing.T) {
	if got := Detect(env(map[string]string{})); got != Unknown {
		t.Errorf("detect = %v, want Unknown", got)
	}
	if got := Detect(env(map[string]string{"XDG_SESSION_TYPE": "tty"})); got != Unknown {
		t.Errorf("detect = %v, want Unknown", got)
	}
}

func TestDetectCaseInsensitive(t *testing.T) {
	if got := Detect(env(map[string]string{"XDG_SESSION_TYPE": "X11"})); got != X11 {
		t.Errorf("detect = %v, want X11", got)
	}
}
