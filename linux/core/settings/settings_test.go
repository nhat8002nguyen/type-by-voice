package settings

import (
	"reflect"
	"testing"
)

func TestDefaultsMatchSpec(t *testing.T) {
	d := Defaults()
	if want := (Hotkey{Modifiers: []string{"ctrl", "shift"}, Key: "space"}); !reflect.DeepEqual(d.Hotkey, want) {
		t.Errorf("hotkey = %+v, want %+v", d.Hotkey, want)
	}
	if d.SilenceDurationMs != 3000 {
		t.Errorf("silenceDurationMs = %d, want 3000", d.SilenceDurationMs)
	}
	if d.HardCapMs != 120000 {
		t.Errorf("hardCapMs = %d, want 120000", d.HardCapMs)
	}
	if d.ClipboardRestoreDelayMs != 150 {
		t.Errorf("clipboardRestoreDelayMs = %d, want 150", d.ClipboardRestoreDelayMs)
	}
	if d.InsertionMode != "paste" {
		t.Errorf("insertionMode = %q, want paste", d.InsertionMode)
	}
	if d.Microphone != "" {
		t.Errorf("microphone = %q, want empty (default)", d.Microphone)
	}
	if d.LaunchAtLogin {
		t.Errorf("launchAtLogin = true, want false")
	}
}

func TestRoundTripPreservesValues(t *testing.T) {
	s := Defaults()
	s.SilenceDurationMs = 1500
	s.HardCapMs = 60000
	s.ClipboardRestoreDelayMs = 200
	s.InsertionMode = "clipboard-only"
	s.Microphone = "USB Mic"
	s.LaunchAtLogin = true
	s.AccountEmail = "a@b.co"

	data, err := s.JSON()
	if err != nil {
		t.Fatalf("json: %v", err)
	}
	got, err := Load(data)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(got, s) {
		t.Errorf("round trip mismatch:\n got %+v\nwant %+v", got, s)
	}
}

func TestLoadMalformedJsonReturnsDefaults(t *testing.T) {
	got, err := Load([]byte("{not valid json"))
	if err == nil {
		t.Errorf("expected an error for malformed json")
	}
	if !reflect.DeepEqual(got, Defaults()) {
		t.Errorf("got %+v, want defaults", got)
	}
}

func TestSaveLoadFromDir(t *testing.T) {
	dir := t.TempDir()
	s := Defaults()
	s.AccountEmail = "a@b.co"
	s.Microphone = "Built-in"

	if err := s.SaveTo(dir); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadFrom(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !reflect.DeepEqual(got, s) {
		t.Errorf("mismatch:\n got %+v\nwant %+v", got, s)
	}
}

func TestApplyRecordedHotkeyRejectsModifierOnly(t *testing.T) {
	if _, ok := ApplyRecordedHotkey([]string{"ctrl"}, ""); ok {
		t.Errorf("expected a modifier-only shortcut (empty key) to be rejected")
	}
	if _, ok := ApplyRecordedHotkey([]string{"ctrl"}, "ctrl"); ok {
		t.Errorf("expected a modifier used as the key to be rejected")
	}
	hk, ok := ApplyRecordedHotkey([]string{"ctrl", "shift"}, "space")
	if !ok {
		t.Fatalf("expected ctrl+shift+space to be accepted")
	}
	if hk.Key != "space" {
		t.Errorf("key = %q, want space", hk.Key)
	}
}

func TestDisplayLabelCtrlShiftSpace(t *testing.T) {
	got := DisplayLabel(Hotkey{Modifiers: []string{"ctrl", "shift"}, Key: "space"})
	if got != "Ctrl+Shift+Space" {
		t.Errorf("label = %q, want Ctrl+Shift+Space", got)
	}
}
