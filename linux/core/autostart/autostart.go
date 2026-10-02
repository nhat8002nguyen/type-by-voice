// Package autostart manages the XDG autostart entry that launches the client at
// login. It is pure Go, so it tests anywhere.
package autostart

import (
	"fmt"
	"os"
	"path/filepath"
)

// DesktopFileName is the autostart entry file name.
const DesktopFileName = "typebyvoice.desktop"

// Path is the autostart entry path inside configDir (the XDG config dir).
func Path(configDir string) string {
	return filepath.Join(configDir, "autostart", DesktopFileName)
}

// Enable writes an autostart entry that runs exec at login.
func Enable(configDir, exec string) error {
	if err := os.MkdirAll(filepath.Join(configDir, "autostart"), 0o755); err != nil {
		return err
	}
	entry := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Type by Voice
Comment=Dictate into any application
Exec=%s
Terminal=false
X-GNOME-Autostart-enabled=true
`, exec)
	return os.WriteFile(Path(configDir), []byte(entry), 0o644)
}

// Disable removes the autostart entry, if present.
func Disable(configDir string) error {
	err := os.Remove(Path(configDir))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// IsEnabled reports whether the autostart entry exists.
func IsEnabled(configDir string) bool {
	_, err := os.Stat(Path(configDir))
	return err == nil
}
