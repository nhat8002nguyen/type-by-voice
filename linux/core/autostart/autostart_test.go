package autostart

import (
	"os"
	"strings"
	"testing"
)

func TestEnableWritesDesktopEntry(t *testing.T) {
	dir := t.TempDir()
	if err := Enable(dir, "/usr/bin/typebyvoice"); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if !IsEnabled(dir) {
		t.Fatalf("IsEnabled = false right after Enable")
	}
	data, err := os.ReadFile(Path(dir))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, want := range []string{
		"Type=Application",
		"Exec=/usr/bin/typebyvoice",
		"X-GNOME-Autostart-enabled=true",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("autostart entry missing %q:\n%s", want, text)
		}
	}
}

func TestDisableRemovesEntry(t *testing.T) {
	dir := t.TempDir()
	if err := Enable(dir, "/usr/bin/typebyvoice"); err != nil {
		t.Fatalf("enable: %v", err)
	}
	if err := Disable(dir); err != nil {
		t.Fatalf("disable: %v", err)
	}
	if IsEnabled(dir) {
		t.Errorf("IsEnabled = true after Disable")
	}
}
