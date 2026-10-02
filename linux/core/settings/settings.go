// Package settings holds the client's user preferences and their on-disk
// representation. It is pure Go so it builds and tests anywhere.
package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const (
	// FileName is the settings file inside the config directory.
	FileName = "settings.json"

	defaultSilenceDurationMs       = 3000
	defaultHardCapMs               = 120000
	defaultClipboardRestoreDelayMs = 150
)

// Valid insertion modes.
const (
	InsertionPaste         = "paste"
	InsertionClipboardOnly = "clipboard-only"
)

// Store is the full set of persisted preferences.
type Store struct {
	Hotkey                  Hotkey `json:"hotkey"`
	SilenceDurationMs       int    `json:"silenceDurationMs"`
	HardCapMs               int    `json:"hardCapMs"`
	ClipboardRestoreDelayMs int    `json:"clipboardRestoreDelayMs"`
	InsertionMode           string `json:"insertionMode"`
	Microphone              string `json:"microphone"`
	LaunchAtLogin           bool   `json:"launchAtLogin"`
	AccountEmail            string `json:"accountEmail"`
}

// Defaults returns a fresh store with the spec's default values.
func Defaults() Store {
	return Store{
		Hotkey:                  Hotkey{Modifiers: []string{"ctrl", "shift"}, Key: "space"},
		SilenceDurationMs:       defaultSilenceDurationMs,
		HardCapMs:               defaultHardCapMs,
		ClipboardRestoreDelayMs: defaultClipboardRestoreDelayMs,
		InsertionMode:           InsertionPaste,
	}
}

// Load parses settings JSON. Missing fields keep their defaults; malformed
// JSON returns the defaults together with the error.
func Load(data []byte) (Store, error) {
	if len(data) == 0 {
		return Defaults(), nil
	}
	s := Defaults()
	if err := json.Unmarshal(data, &s); err != nil {
		return Defaults(), err
	}
	return s, nil
}

// JSON renders the store as indented JSON.
func (s Store) JSON() ([]byte, error) {
	return json.MarshalIndent(s, "", "  ")
}

// Path is the settings file path inside configDir.
func Path(configDir string) string { return filepath.Join(configDir, FileName) }

// SaveTo writes the store to configDir, creating it if needed.
func (s Store) SaveTo(configDir string) error {
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	data, err := s.JSON()
	if err != nil {
		return err
	}
	return os.WriteFile(Path(configDir), data, 0o600)
}

// LoadFrom reads settings from configDir, returning defaults if none exist.
func LoadFrom(configDir string) (Store, error) {
	data, err := os.ReadFile(Path(configDir))
	if err != nil {
		if os.IsNotExist(err) {
			return Defaults(), nil
		}
		return Defaults(), err
	}
	return Load(data)
}
