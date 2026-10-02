package insert

import (
	"context"
	"fmt"
	"time"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"
	"github.com/jezek/xgb/xtest"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/insertion"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
)

// NewInserter returns the text inserter for the session.
func NewInserter(session sessiontype.SessionType, cb platform.Clipboard, restoreDelay time.Duration, notify platform.Notifier) platform.TextInserter {
	if session == sessiontype.X11 {
		return &x11Inserter{clipboard: cb, restoreDelay: restoreDelay, notify: notify}
	}
	return &clipboardInserter{clipboard: cb, notify: notify}
}

type x11Inserter struct {
	clipboard    platform.Clipboard
	restoreDelay time.Duration
	notify       platform.Notifier
}

// Insert saves the clipboard, writes the transcript, synthesizes Ctrl+V, then
// restores the clipboard after the configured delay. If the paste cannot be
// synthesized the transcript stays on the clipboard and the user is notified.
func (i *x11Inserter) Insert(ctx context.Context, text string) error {
	_ = i.clipboard.Save(ctx)
	if err := i.clipboard.SetText(ctx, text); err != nil {
		return err
	}
	if err := synthesizeCtrlV(); err != nil {
		i.notify.Notify("Type by Voice", "Transcription copied — press Ctrl+V")
		return nil
	}
	time.Sleep(i.restoreDelay)
	return i.clipboard.Restore(ctx)
}

type clipboardInserter struct {
	clipboard platform.Clipboard
	notify    platform.Notifier
}

// Insert leaves the transcript on the clipboard (Wayland without a virtual
// keyboard) and tells the user to paste.
func (i *clipboardInserter) Insert(ctx context.Context, text string) error {
	if err := i.clipboard.SetText(ctx, text); err != nil {
		return err
	}
	i.notify.Notify("Type by Voice", "Transcription copied — press Ctrl+V")
	return nil
}

func synthesizeCtrlV() error {
	conn, err := xgb.NewConn()
	if err != nil {
		return fmt.Errorf("insert: x11 connect: %w", err)
	}
	defer conn.Close()
	if err := xtest.Init(conn); err != nil {
		return fmt.Errorf("insert: xtest init: %w", err)
	}
	ctrl, err := keycodeForKeysym(conn, insertion.KeysymControlL)
	if err != nil {
		return err
	}
	v, err := keycodeForKeysym(conn, insertion.KeysymV)
	if err != nil {
		return err
	}
	press := func(kc xproto.Keycode, release bool) {
		typ := byte(xproto.KeyPress)
		if release {
			typ = byte(xproto.KeyRelease)
		}
		_ = xtest.FakeInput(conn, typ, byte(kc), 0, 0, 0, 0)
	}
	press(ctrl, false)
	press(v, false)
	press(v, true)
	press(ctrl, true)
	return nil
}

func keycodeForKeysym(conn *xgb.Conn, keysym uint32) (xproto.Keycode, error) {
	setup := xproto.Setup(conn)
	min := setup.MinKeycode
	max := setup.MaxKeycode
	reply, err := xproto.GetKeyboardMapping(conn, min, byte(int(max-min)+1)).Reply()
	if err != nil {
		return 0, fmt.Errorf("insert: keyboard mapping: %w", err)
	}
	per := int(reply.KeysymsPerKeycode)
	for kc := int(min); kc <= int(max); kc++ {
		base := (kc - int(min)) * per
		for i := 0; i < per; i++ {
			if idx := base + i; idx < len(reply.Keysyms) && uint32(reply.Keysyms[idx]) == keysym {
				return xproto.Keycode(kc), nil
			}
		}
	}
	return 0, fmt.Errorf("insert: keysym %#x has no keycode", keysym)
}
