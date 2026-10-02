package insertion

import (
	"testing"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/sessiontype"
)

func TestChooseInsertionStrategy(t *testing.T) {
	cases := []struct {
		name    string
		session sessiontype.SessionType
		wtype   bool
		want    Strategy
	}{
		{"x11 without wtype", sessiontype.X11, false, StrategySynthesizeX11},
		{"x11 with wtype", sessiontype.X11, true, StrategySynthesizeX11},
		{"wayland with wtype", sessiontype.Wayland, true, StrategyWtype},
		{"wayland without wtype", sessiontype.Wayland, false, StrategyClipboardOnly},
		{"unknown without wtype", sessiontype.Unknown, false, StrategyClipboardOnly},
		{"unknown with wtype", sessiontype.Unknown, true, StrategyClipboardOnly},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := ChooseInsertionStrategy(c.session, c.wtype); got != c.want {
				t.Errorf("ChooseInsertionStrategy(%v, %v) = %v, want %v", c.session, c.wtype, got, c.want)
			}
		})
	}
}
