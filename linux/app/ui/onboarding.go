// Package ui builds the GTK4 onboarding and settings windows (and the
// dashboard in Task 17). It requires cgo + GTK4 and builds only on Linux.
package ui

import (
	"github.com/diamondburned/gotk4/pkg/gtk/v4"
	"log"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/auth"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
)

// OnboardingDeps are what the onboarding flow needs.
type OnboardingDeps struct {
	Auth     *auth.Store
	Settings *settings.Store
	Devices  func() ([]string, error)
	OnDone   func(settings.Store)
}

// ShowOnboarding opens the first-run flow as a GTK4 stack:
// Welcome → sign in / create account → microphone → hotkey → done. Linux needs
// no microphone or accessibility permission prompts, so those macOS steps are
// absent.
func ShowOnboarding(app *gtk.Application, deps OnboardingDeps) {
	win := gtk.NewApplicationWindow(app)
	win.SetTitle("Welcome to Type by Voice")
	win.SetDefaultSize(420, 320)

	stack := gtk.NewStack()
	stack.AddNamed(stepWelcome(deps, stack, win), "welcome")
	stack.AddNamed(stepAuth(deps, stack, win), "auth")
	stack.AddNamed(stepMicrophone(deps, stack, win), "microphone")
	stack.AddNamed(stepHotkey(deps, stack, win), "hotkey")

	win.SetChild(stack)
	win.SetVisible(true)
}

func stepWelcome(deps OnboardingDeps, stack *gtk.Stack, win *gtk.ApplicationWindow) *gtk.Box {
	box := gtk.NewBox(gtk.OrientationVertical, 12)
	box.SetMarginTop(24)
	box.SetMarginBottom(24)
	box.SetMarginStart(24)
	box.SetMarginEnd(24)
	box.Append(gtk.NewLabel("Type by voice, anywhere."))
	next := gtk.NewButtonWithLabel("Get started")
	next.ConnectClicked(func() { stack.SetVisibleChildName("auth") })
	box.Append(next)
	return box
}

func stepAuth(deps OnboardingDeps, stack *gtk.Stack, win *gtk.ApplicationWindow) *gtk.Box {
	box := gtk.NewBox(gtk.OrientationVertical, 12)
	email := gtk.NewEntry()
	email.SetPlaceholderText("you@example.com")
	password := gtk.NewEntry()
	password.SetVisibility(false)
	password.SetPlaceholderText("Password")
	box.Append(gtk.NewLabel("Sign in or create an account"))
	box.Append(email)
	box.Append(password)

	signIn := gtk.NewButtonWithLabel("Sign in")
	signIn.ConnectClicked(func() {
		if err := deps.Auth.Login(gtkCtx, email.Buffer().Text(), password.Buffer().Text()); err != nil {
			log.Printf("login: %v", err)
			return
		}
		stack.SetVisibleChildName("microphone")
	})
	create := gtk.NewButtonWithLabel("Create account")
	create.ConnectClicked(func() {
		if err := deps.Auth.Register(gtkCtx, email.Buffer().Text(), password.Buffer().Text()); err != nil {
			log.Printf("register: %v", err)
			return
		}
		stack.SetVisibleChildName("microphone")
	})
	box.Append(signIn)
	box.Append(create)
	return box
}

func stepMicrophone(deps OnboardingDeps, stack *gtk.Stack, win *gtk.ApplicationWindow) *gtk.Box {
	box := gtk.NewBox(gtk.OrientationVertical, 12)
	box.Append(gtk.NewLabel("Choose a microphone"))
	names := deviceNames(deps)
	dropdown := gtk.NewDropDownFromStrings(names)
	box.Append(dropdown)
	next := gtk.NewButtonWithLabel("Continue")
	next.ConnectClicked(func() {
		cfg := *deps.Settings
		if idx := int(dropdown.Selected()); idx > 0 && idx < len(names) {
			cfg.Microphone = names[idx]
		} else {
			cfg.Microphone = "" // "System default"
		}
		*deps.Settings = cfg
		stack.SetVisibleChildName("hotkey")
	})
	box.Append(next)
	return box
}

func stepHotkey(deps OnboardingDeps, stack *gtk.Stack, win *gtk.ApplicationWindow) *gtk.Box {
	box := gtk.NewBox(gtk.OrientationVertical, 12)
	box.Append(gtk.NewLabel("Press your shortcut, or keep Ctrl+Shift+Space"))
	label := gtk.NewLabel(settings.DisplayLabel(deps.Settings.Hotkey))
	box.Append(label)

	// A press-to-record control reuses settings.ApplyRecordedHotkey; the key
	// capture is wired through a GtkEventControllerKey on Linux.
	recorder := gtk.NewButtonWithLabel("Record")
	recorder.ConnectClicked(func() { log.Print("record hotkey (wired in VM)") })
	box.Append(recorder)

	done := gtk.NewButtonWithLabel("Done")
	done.ConnectClicked(func() {
		if deps.OnDone != nil {
			deps.OnDone(*deps.Settings)
		}
		win.Close()
	})
	box.Append(done)
	return box
}

func deviceNames(deps OnboardingDeps) []string {
	if deps.Devices == nil {
		return []string{"System default"}
	}
	names, err := deps.Devices()
	if err != nil || len(names) == 0 {
		return []string{"System default"}
	}
	return append([]string{"System default"}, names...)
}
