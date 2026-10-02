// Package overlay renders the floating pill with GTK4. The pill must never
// steal focus, or the synthesized paste would land in the wrong window. It
// requires cgo + GTK4 and is built only on Linux.
package overlay

import (
	"github.com/diamondburned/gotk4/pkg/gtk/v4"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
)

// Pill is the overlay window.
type Pill struct {
	app     *gtk.Application
	window  *gtk.Window
	label   *gtk.Label
	level   *gtk.ProgressBar
	retry   *gtk.Button
	onRetry func()
}

// NewPill builds the overlay. onRetry runs when the user clicks Retry on a
// retryable error.
func NewPill(app *gtk.Application, onRetry func()) *Pill {
	p := &Pill{app: app, onRetry: onRetry}
	p.label = gtk.NewLabel("")
	p.level = gtk.NewProgressBar()
	p.retry = gtk.NewButtonWithLabel("Retry")
	p.retry.ConnectClicked(func() {
		if p.onRetry != nil {
			p.onRetry()
		}
	})

	box := gtk.NewBox(gtk.OrientationVertical, 6)
	box.Append(p.label)
	box.Append(p.level)
	box.Append(p.retry)

	win := gtk.NewWindow()
	win.SetDecorated(false)
	win.SetResizable(false)
	// Never take focus: this is the Linux analogue of the macOS non-activating
	// NSPanel. On X11 the window manager may still focus it; if so, an
	// override-redirect window is the fallback (verified in the VM).
	win.SetCanFocus(false)
	win.SetChild(box)
	p.window = win
	return p
}

// Show renders the pill for the status, hiding it for the hidden state so an
// empty box never lingers after a dictation.
func (p *Pill) Show(status platform.PillStatus) {
	if status.State == platform.PillHidden {
		p.window.SetVisible(false)
		return
	}
	view := platform.RenderPill(status)
	p.label.SetText(view.Label)
	p.level.SetVisible(view.ShowLevel)
	p.retry.SetVisible(view.CanRetry)
	p.window.SetDefaultSize(240, 72)
	p.window.SetVisible(true)
}

// Hide hides the pill.
func (p *Pill) Hide() { p.window.SetVisible(false) }
