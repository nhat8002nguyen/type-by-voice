// Command typebyvoice is the Linux dictation client: a single-instance GTK4 tray
// agent that captures mic audio, streams it to the shared backend over the
// dictation v1 protocol, and pastes the transcript at the cursor. It builds
// only on Linux with CGO_ENABLED=1 (GTK4, miniaudio, libopus, X11).
package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/diamondburned/gotk4/pkg/gio/v2"
	"github.com/diamondburned/gotk4/pkg/gtk/v4"

	appaudio "github.com/nhat8002nguyen/type-by-voice/linux/app/audio"
	"github.com/nhat8002nguyen/type-by-voice/linux/app/hotkey"
	"github.com/nhat8002nguyen/type-by-voice/linux/app/insert"
	"github.com/nhat8002nguyen/type-by-voice/linux/app/instance"
	"github.com/nhat8002nguyen/type-by-voice/linux/app/overlay"
	"github.com/nhat8002nguyen/type-by-voice/linux/app/tray"
	"github.com/nhat8002nguyen/type-by-voice/linux/app/ui"
	coreaudio "github.com/nhat8002nguyen/type-by-voice/linux/core/audio"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/auth"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/history"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/session"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/transcription"
)

const version = "0.1.0+1"

func main() {
	// GTK 4 defaults to its GL renderer. On a machine with no working GL driver
	// (a VM, a remote session) GDK fails to build a GL context and libepoxy
	// aborts the process the moment a window is realised. Fall back to the
	// software renderer unless the user has chosen one themselves.
	if os.Getenv("GSK_RENDERER") == "" {
		_ = os.Setenv("GSK_RENDERER", "cairo")
	}

	cfgDir := configDir()
	state := stateDir()

	lock, err := instance.Acquire(state)
	if err != nil {
		fmt.Fprintln(os.Stderr, "typebyvoice:", err)
		os.Exit(1)
	}
	defer func() { _ = lock.Release() }()

	cfg, err := settings.LoadFrom(cfgDir)
	if err != nil {
		log.Printf("settings: %v", err)
	}

	sessionKind := sessiontype.Detect(os.Getenv)
	apiURL, dictateURL := endpoints()
	deviceID := loadOrCreateDeviceID(state)

	// Tokens live in the Secret Service (GNOME Keyring).
	tokens := auth.NewKeyringTokenStore("typebyvoice")
	var authStore *auth.Store
	httpClient := auth.NewHTTPClient(apiURL, http.DefaultClient, func() string {
		if authStore == nil {
			return ""
		}
		return authStore.AccessToken()
	})
	authStore = auth.NewStore(httpClient, tokens, auth.ClientIdentity{
		Platform:      "linux",
		ClientVersion: version,
		DeviceID:      deviceID,
	}, cfgDir)

	capture, err := appaudio.NewCapture(cfg.Microphone)
	if err != nil {
		log.Fatalf("capture: %v", err)
	}
	encoder, err := appaudio.NewLibOpusEncoder()
	if err != nil {
		log.Fatalf("encoder: %v", err)
	}
	engine := transcription.NewRemoteEngine(
		transcription.NewWebSocketSocket(),
		dictateURL,
		func() string { return authStore.AccessToken() },
		version,
		deviceID,
		true,
		time.Now,
		60*time.Second,
	)

	coordinator := session.NewCoordinator(
		capture,
		coreaudio.NewSilenceDetector(300),
		encoder,
		engine,
		insert.NewInserter(sessionKind, insert.NewClipboard(sessionKind),
			time.Duration(cfg.ClipboardRestoreDelayMs)*time.Millisecond, notifier{}),
		&cfg,
		authStore,
		realClock{},
		session.NewTimeouts(),
	)

	app := gtk.NewApplication("com.typebyvoice.TypeByVoice", gio.ApplicationFlagsNone)

	// GTK widgets and the AppIndicator must be created only after GTK is
	// initialised, which happens when the application starts. Creating any of
	// them before app.Run() segfaults inside gtk_label_new.
	app.ConnectStartup(func() {
		// Hold the application open. Without this, GtkApplication quits as soon
		// as it has no windows — and the pill is a plain GtkWindow, not an
		// ApplicationWindow — so a run that shows no onboarding window would
		// exit immediately (the tray icon appears for an instant, then goes).
		app.Hold()

		pill := overlay.NewPill(app, func() { _ = coordinator.Toggle(context.Background()) })
		coordinator.OnPillChanged(func(status platform.PillStatus) { pill.Show(status) })

		execPath, _ := os.Executable()
		historyClient := history.NewClient(httpClient)
		if _, err := tray.New(tray.Actions{
			OnRecord: func() { _ = coordinator.Toggle(context.Background()) },
			OnSettings: func() {
				ui.ShowSettings(app, ui.SettingsDeps{
					Settings:  &cfg,
					ConfigDir: cfgDir,
					ExecPath:  execPath,
					Devices:   appaudio.ListDevices,
					OnSave:    func(s settings.Store) { cfg = s },
				})
			},
			OnDashboard: func() {
				ui.ShowDashboard(app, ui.DashboardDeps{History: historyClient})
			},
			OnQuit: func() { app.Quit() },
		}); err != nil {
			log.Printf("tray: %v", err)
		}
	})

	hk, hkErr := hotkey.NewHotkey(sessionKind, cfg.Hotkey)
	if hkErr != nil {
		log.Printf("hotkey: %v (record from the tray instead)", hkErr)
	}

	app.ConnectActivate(func() {
		// First run: no account yet, so open onboarding (which also signs in).
		if authStore.AccountEmail() == "" {
			ui.ShowOnboarding(app, ui.OnboardingDeps{
				Auth:     authStore,
				Settings: &cfg,
				Devices:  appaudio.ListDevices,
				OnDone: func(s settings.Store) {
					cfg = s
					_ = s.SaveTo(cfgDir)
				},
			})
		}
		if hkErr == nil {
			if err := hk.Start(); err != nil {
				log.Printf("hotkey start: %v", err)
			}
			go func() {
				for range hk.Toggled() {
					_ = coordinator.Toggle(context.Background())
				}
			}()
		}
		go coordinator.Run(context.Background())
	})

	app.Run(os.Args)
}

type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// notifier is the desktop-notification sink (Task 16 replaces it with libnotify).
type notifier struct{}

func (notifier) Notify(title, body string) { log.Printf("%s: %s", title, body) }

func endpoints() (api, dictate string) {
	api = os.Getenv("TBV_API_URL")
	dictate = os.Getenv("TBV_DICTATE_URL")
	if api == "" {
		api = "http://127.0.0.1:3000"
	}
	if dictate == "" {
		dictate = "ws://127.0.0.1:3000/v1/dictate"
	}
	return api, dictate
}

func configDir() string {
	if dir, err := os.UserConfigDir(); err == nil {
		return filepath.Join(dir, "typebyvoice")
	}
	return filepath.Join(os.Getenv("HOME"), ".config", "typebyvoice")
}

func stateDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		base = filepath.Join(os.Getenv("HOME"), ".local", "state")
	}
	return filepath.Join(base, "typebyvoice")
}

func loadOrCreateDeviceID(dir string) string {
	path := filepath.Join(dir, "device-id")
	if data, err := os.ReadFile(path); err == nil && len(data) > 0 {
		return string(data)
	}
	id := newUUID()
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(path, []byte(id), 0o600)
	return id
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
