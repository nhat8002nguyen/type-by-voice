package insert

import (
	"context"
	"os/exec"
	"time"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/insertion"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
)

// WtypeAvailable reports whether the wtype binary is on PATH.
func WtypeAvailable() bool {
	_, err := exec.LookPath("wtype")
	return err == nil
}

// NewWaylandInserter returns the Wayland inserter: wtype when available,
// otherwise clipboard-only. The transcript is never dropped.
func NewWaylandInserter(session sessiontype.SessionType, hasWtype bool, cb platform.Clipboard, restoreDelay time.Duration, notify platform.Notifier) platform.TextInserter {
	if insertion.ChooseInsertionStrategy(session, hasWtype) == insertion.StrategyWtype {
		return &wtypeInserter{clipboard: cb, restoreDelay: restoreDelay, notify: notify}
	}
	return &clipboardInserter{clipboard: cb, notify: notify}
}

type wtypeInserter struct {
	clipboard    platform.Clipboard
	restoreDelay time.Duration
	notify       platform.Notifier
}

func (i *wtypeInserter) Insert(ctx context.Context, text string) error {
	_ = i.clipboard.Save(ctx)
	if err := i.clipboard.SetText(ctx, text); err != nil {
		return err
	}
	if err := wtypeCtrlV(); err != nil {
		i.notify.Notify("Type by Voice", "Transcription copied — press Ctrl+V")
		return nil
	}
	time.Sleep(i.restoreDelay)
	return i.clipboard.Restore(ctx)
}

func wtypeCtrlV() error {
	return exec.Command("wtype", "-M", "ctrl", "v", "-m", "ctrl").Run()
}
