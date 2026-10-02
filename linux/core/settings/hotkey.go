package settings

import (
	"strings"
)

// Hotkey is a configurable global shortcut: one or more modifiers plus a
// single non-modifier key (e.g. ctrl+shift+space).
type Hotkey struct {
	Modifiers []string `json:"modifiers"`
	Key       string   `json:"key"`
}

var modifierNames = map[string]string{
	"ctrl":  "Ctrl",
	"alt":   "Alt",
	"shift": "Shift",
	"super": "Super",
}

// modifierOrder is the display order for modifiers.
var modifierOrder = []string{"ctrl", "alt", "shift", "super"}

// ApplyRecordedHotkey validates a recorded shortcut. A shortcut must have a
// non-modifier key, so a bare modifier (empty key, or a modifier as the key) is
// rejected.
func ApplyRecordedHotkey(mods []string, key string) (Hotkey, bool) {
	key = strings.ToLower(key)
	if key == "" || isModifier(key) {
		return Hotkey{}, false
	}
	norm := make([]string, 0, len(mods))
	for _, m := range mods {
		norm = append(norm, strings.ToLower(m))
	}
	return Hotkey{Modifiers: norm, Key: key}, true
}

// DisplayLabel renders a hotkey as e.g. "Ctrl+Shift+Space".
func DisplayLabel(h Hotkey) string {
	var parts []string
	for _, m := range modifierOrder {
		if containsFold(h.Modifiers, m) {
			parts = append(parts, modifierNames[m])
		}
	}
	parts = append(parts, keyLabel(h.Key))
	return strings.Join(parts, "+")
}

func isModifier(key string) bool {
	_, ok := modifierNames[strings.ToLower(key)]
	return ok
}

func containsFold(list []string, want string) bool {
	for _, s := range list {
		if strings.EqualFold(s, want) {
			return true
		}
	}
	return false
}

func keyLabel(key string) string {
	if strings.EqualFold(key, "space") {
		return "Space"
	}
	if len(key) == 1 {
		return strings.ToUpper(key)
	}
	return key
}
