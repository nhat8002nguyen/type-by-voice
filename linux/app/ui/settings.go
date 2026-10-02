package ui

import (
	"context"

	"log"

	"github.com/diamondburned/gotk4/pkg/gtk/v4"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/autostart"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
)

// gtkCtx is the context used for the onboarding/settings HTTP calls.
var gtkCtx = context.Background()

// SettingsDeps are what the settings window needs.
type SettingsDeps struct {
	Settings  *settings.Store
	ConfigDir string
	ExecPath  string
	Devices   func() ([]string, error)
	OnSave    func(settings.Store)
}

// ShowSettings opens the settings window: hotkey, silence threshold, hard cap,
// insertion mode, microphone picker, account, and launch-at-login.
func ShowSettings(app *gtk.Application, deps SettingsDeps) {
	win := gtk.NewApplicationWindow(app)
	win.SetTitle("Type by Voice — Settings")
	win.SetDefaultSize(460, 520)

	box := gtk.NewBox(gtk.OrientationVertical, 10)
	box.SetMarginTop(18)
	box.SetMarginBottom(18)
	box.SetMarginStart(18)
	box.SetMarginEnd(18)

	cfg := *deps.Settings

	box.Append(gtk.NewLabel("Shortcut: " + settings.DisplayLabel(cfg.Hotkey)))

	silence := gtk.NewSpinButtonWithRange(0, 10000, 250)
	silence.SetValue(float64(cfg.SilenceDurationMs))
	box.Append(labeled("Silence auto-stop (ms)", silence))

	cap := gtk.NewSpinButtonWithRange(1000, 600000, 1000)
	cap.SetValue(float64(cfg.HardCapMs))
	box.Append(labeled("Hard cap (ms)", cap))

	modes := []string{settings.InsertionPaste, settings.InsertionClipboardOnly}
	mode := gtk.NewDropDownFromStrings(modes)
	box.Append(labeled("Insertion mode", mode))

	micNames := deviceNames(OnboardingDeps{Devices: deps.Devices})
	mic := gtk.NewDropDownFromStrings(micNames)
	box.Append(labeled("Microphone", mic))

	launch := gtk.NewSwitch()
	launch.SetActive(autostart.IsEnabled(deps.ConfigDir))
	launch.ConnectStateSet(func(state bool) bool {
		var err error
		if state {
			err = autostart.Enable(deps.ConfigDir, deps.ExecPath)
		} else {
			err = autostart.Disable(deps.ConfigDir)
		}
		if err != nil {
			log.Printf("autostart: %v", err)
		}
		return false
	})
	box.Append(labeled("Launch at login", launch))

	save := gtk.NewButtonWithLabel("Save")
	save.ConnectClicked(func() {
		cfg.SilenceDurationMs = int(silence.Value())
		cfg.HardCapMs = int(cap.Value())
		if idx := int(mode.Selected()); idx >= 0 && idx < len(modes) {
			cfg.InsertionMode = modes[idx]
		}
		if idx := int(mic.Selected()); idx > 0 && idx < len(micNames) {
			cfg.Microphone = micNames[idx]
		} else {
			cfg.Microphone = ""
		}
		cfg.LaunchAtLogin = launch.Active()
		if err := cfg.SaveTo(deps.ConfigDir); err != nil {
			log.Printf("save settings: %v", err)
		}
		if deps.OnSave != nil {
			deps.OnSave(cfg)
		}
		win.Close()
	})
	box.Append(save)

	win.SetChild(box)
	win.SetVisible(true)
}

func labeled(text string, widget gtk.Widgetter) *gtk.Box {
	row := gtk.NewBox(gtk.OrientationHorizontal, 10)
	row.Append(gtk.NewLabel(text))
	row.Append(widget)
	return row
}
