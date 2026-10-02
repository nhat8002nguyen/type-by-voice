package insertion

import "testing"

func TestModifierMask(t *testing.T) {
	cases := map[string]uint16{
		"ctrl":  ModControl,
		"shift": ModShift,
		"alt":   Mod1,
		"super": Mod4,
	}
	for name, want := range cases {
		got, ok := ModifierMask(name)
		if !ok || got != want {
			t.Errorf("ModifierMask(%q) = %d,%v; want %d,true", name, got, ok, want)
		}
	}
	if _, ok := ModifierMask("hyper"); ok {
		t.Errorf("expected an unknown modifier to be rejected")
	}
}

func TestModifierMasksCombines(t *testing.T) {
	got, ok := ModifierMasks([]string{"ctrl", "shift"})
	if !ok || got != ModControl|ModShift {
		t.Errorf("ModifierMasks(ctrl,shift) = %d,%v; want %d,true", got, ok, ModControl|ModShift)
	}
	if _, ok := ModifierMasks([]string{"ctrl", "bogus"}); ok {
		t.Errorf("expected a bad modifier list to be rejected")
	}
}
