// Package insert implements text insertion for Linux: on X11 by writing the
// transcript to the clipboard and synthesizing Ctrl+V through XTest; on Wayland
// as best-effort (a clipboard-only fallback here, wtype added in Task 18). It
// must be built with CGO_ENABLED=1 on Linux.
package insert

import (
	"context"
	"os/exec"
	"strings"
	"sync"

	"golang.design/x/clipboard"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
)

// NewClipboard returns the clipboard implementation for the session: X11 via
// libX11, Wayland via wl-clipboard.
func NewClipboard(session sessiontype.SessionType) platform.Clipboard {
	if session == sessiontype.X11 {
		return &x11Clipboard{}
	}
	return &wlClipboard{}
}

var (
	clipboardOnce sync.Once
	clipboardErr  error
)

func ensureClipboard() error {
	clipboardOnce.Do(func() { clipboardErr = clipboard.Init() })
	return clipboardErr
}

type x11Clipboard struct {
	saved []byte
}

func (c *x11Clipboard) Save(context.Context) error {
	if err := ensureClipboard(); err != nil {
		return err
	}
	c.saved = clipboard.Read(clipboard.FmtText)
	return nil
}

func (c *x11Clipboard) SetText(_ context.Context, text string) error {
	if err := ensureClipboard(); err != nil {
		return err
	}
	clipboard.Write(clipboard.FmtText, []byte(text))
	return nil
}

func (c *x11Clipboard) Restore(context.Context) error {
	if err := ensureClipboard(); err != nil {
		return err
	}
	if c.saved != nil {
		clipboard.Write(clipboard.FmtText, c.saved)
	}
	return nil
}

type wlClipboard struct {
	saved []byte
	had   bool
}

func (c *wlClipboard) Save(context.Context) error {
	if out, err := exec.Command("wl-paste", "--no-newline").Output(); err == nil {
		c.saved = out
		c.had = true
	}
	return nil
}

func (c *wlClipboard) SetText(_ context.Context, text string) error {
	cmd := exec.Command("wl-copy")
	cmd.Stdin = strings.NewReader(text)
	return cmd.Run()
}

func (c *wlClipboard) Restore(context.Context) error {
	if !c.had {
		return nil
	}
	cmd := exec.Command("wl-copy")
	cmd.Stdin = strings.NewReader(string(c.saved))
	return cmd.Run()
}
