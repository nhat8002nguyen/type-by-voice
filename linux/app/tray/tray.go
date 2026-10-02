// Package tray shows the application indicator, the Linux stand-in for the
// macOS menu-bar agent. Ubuntu's GNOME enables the AppIndicator extension by
// default, so the icon appears without extra setup. It is a thin cgo binding to
// libayatana-appindicator3 and builds only on Linux with CGO_ENABLED=1.
package tray

/*
#cgo pkg-config: ayatana-appindicator3-0.1
#include <libayatana-appindicator/app-indicator.h>
#include <gtk/gtk.h>

// Declarations only (definitions live in helper.c): a file that uses //export
// may not define C in its preamble.
GtkWidget *tbv_menu_new(void);
void tbv_menu_append(GtkWidget *menu, const char *label, int id);
AppIndicator *tbv_indicator_new(const char *icon);
void tbv_indicator_attach(AppIndicator *ind, GtkWidget *menu);
void tbv_indicator_label(AppIndicator *ind, const char *label);
*/
import "C"

import (
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
)

// Actions are the tray menu callbacks.
type Actions struct {
	OnSettings  func()
	OnDashboard func()
	OnQuit      func()
}

// Tray is the application indicator.
type Tray struct {
	indicator *C.AppIndicator
	actions   Actions
}

var active *Tray

// New builds and shows the tray icon with a Settings / Dashboard / Quit menu.
func New(actions Actions) (*Tray, error) {
	t := &Tray{actions: actions}
	active = t
	t.indicator = C.tbv_indicator_new(C.CString("audio-input-microphone"))
	menu := C.tbv_menu_new()
	C.tbv_menu_append(menu, C.CString("Settings"), 0)
	C.tbv_menu_append(menu, C.CString("Dashboard"), 1)
	C.tbv_menu_append(menu, C.CString("Quit"), 2)
	C.tbv_indicator_attach(t.indicator, menu)
	return t, nil
}

// SetStatus reflects the current pill status as a short tray label.
func (t *Tray) SetStatus(status platform.PillStatus) {
	view := platform.RenderPill(status)
	C.tbv_indicator_label(t.indicator, C.CString(view.Label))
}

//export tbvTraySettings
func tbvTraySettings(_ *C.GtkMenuItem, _ C.gpointer) {
	if active != nil && active.actions.OnSettings != nil {
		active.actions.OnSettings()
	}
}

//export tbvTrayDashboard
func tbvTrayDashboard(_ *C.GtkMenuItem, _ C.gpointer) {
	if active != nil && active.actions.OnDashboard != nil {
		active.actions.OnDashboard()
	}
}

//export tbvTrayQuit
func tbvTrayQuit(_ *C.GtkMenuItem, _ C.gpointer) {
	if active != nil && active.actions.OnQuit != nil {
		active.actions.OnQuit()
	}
}
