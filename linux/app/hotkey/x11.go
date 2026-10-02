package hotkey

import (
	"fmt"
	"strings"
	"sync"

	"github.com/jezek/xgb"
	"github.com/jezek/xgb/xproto"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
)

type x11Hotkey struct {
	conn    *xgb.Conn
	root    xproto.Window
	keycode xproto.Keycode
	mods    uint16
	toggled chan struct{}
	stop    chan struct{}
	once    sync.Once
}

// newX11Hotkey opens an X connection and resolves the configured shortcut to a
// keycode and modifier mask.
func newX11Hotkey(hk settings.Hotkey) (platform.Hotkey, error) {
	conn, err := xgb.NewConn()
	if err != nil {
		return nil, fmt.Errorf("hotkey: x11 connect: %w", err)
	}
	setup := xproto.Setup(conn)
	root := setup.DefaultScreen(conn).Root

	keycode, err := keycodeFor(conn, hk.Key)
	if err != nil {
		conn.Close()
		return nil, err
	}
	mods, err := modifierMask(hk.Modifiers)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return &x11Hotkey{
		conn:    conn,
		root:    root,
		keycode: keycode,
		mods:    mods,
		toggled: make(chan struct{}, 1),
		stop:    make(chan struct{}),
	}, nil
}

func (h *x11Hotkey) Start() error {
	// Grab both with and without CapsLock/NumLock so the shortcut fires in any
	// lock state.
	for _, extra := range []uint16{0, xproto.ModMaskLock, xproto.ModMask2} {
		err := xproto.GrabKeyChecked(h.conn, true, h.root, h.mods|extra, h.keycode,
			xproto.GrabModeAsync, xproto.GrabModeAsync).Check()
		if err != nil {
			return fmt.Errorf("hotkey: grab: %w", err)
		}
	}
	go h.loop()
	return nil
}

func (h *x11Hotkey) loop() {
	for {
		ev, err := h.conn.WaitForEvent()
		if err != nil {
			return
		}
		if _, ok := ev.(xproto.KeyPressEvent); ok {
			select {
			case h.toggled <- struct{}{}:
			default:
			}
		}
	}
}

func (h *x11Hotkey) Stop() error {
	h.once.Do(func() {
		for _, extra := range []uint16{0, xproto.ModMaskLock, xproto.ModMask2} {
			_ = xproto.UngrabKey(h.conn, h.keycode, h.root, h.mods|extra)
		}
		h.conn.Close()
	})
	return nil
}

func (h *x11Hotkey) Toggled() <-chan struct{} { return h.toggled }

func keycodeFor(conn *xgb.Conn, key string) (xproto.Keycode, error) {
	keysym, err := keysymFor(key)
	if err != nil {
		return 0, err
	}
	setup := xproto.Setup(conn)
	min := setup.MinKeycode
	max := setup.MaxKeycode
	count := byte(int(max-min) + 1)
	reply, err := xproto.GetKeyboardMapping(conn, min, count).Reply()
	if err != nil {
		return 0, fmt.Errorf("hotkey: keyboard mapping: %w", err)
	}
	per := int(reply.KeysymsPerKeycode)
	if per == 0 {
		return 0, fmt.Errorf("hotkey: empty keyboard mapping")
	}
	for kc := int(min); kc <= int(max); kc++ {
		base := (kc - int(min)) * per
		for i := 0; i < per; i++ {
			if idx := base + i; idx < len(reply.Keysyms) && xproto.Keysym(reply.Keysyms[idx]) == keysym {
				return xproto.Keycode(kc), nil
			}
		}
	}
	return 0, fmt.Errorf("hotkey: key %q has no keycode", key)
}

func keysymFor(key string) (xproto.Keysym, error) {
	if strings.EqualFold(key, "space") {
		return xproto.Keysym(0x0020), nil
	}
	if len(key) == 1 {
		r := rune(key[0])
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			return xproto.Keysym(r), nil
		}
	}
	return 0, fmt.Errorf("hotkey: unsupported key %q", key)
}

func modifierMask(mods []string) (uint16, error) {
	var mask uint16
	for _, m := range mods {
		switch strings.ToLower(m) {
		case "ctrl":
			mask |= xproto.ModMaskControl
		case "shift":
			mask |= xproto.ModMaskShift
		case "alt":
			mask |= xproto.ModMask1
		case "super":
			mask |= xproto.ModMask4
		default:
			return 0, fmt.Errorf("hotkey: unknown modifier %q", m)
		}
	}
	return mask, nil
}
