package session

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/audio"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/transcription"
)

// ---- fakes -----------------------------------------------------------------

type fakeClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*fakeTimer
}

type fakeTimer struct {
	at    time.Time
	ch    chan time.Time
	fired bool
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 10, 2, 12, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	c.timers = append(c.timers, &fakeTimer{at: c.now.Add(d), ch: ch})
	return ch
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	now := c.now
	var fire []*fakeTimer
	for _, t := range c.timers {
		if !t.fired && !t.at.After(now) {
			t.fired = true
			fire = append(fire, t)
		}
	}
	c.mu.Unlock()
	for _, t := range fire {
		t.ch <- now
	}
}

type fakeCapture struct {
	mu         sync.Mutex
	frames     chan []int16
	lost       chan struct{}
	started    int
	startedErr error
}

func newFakeCapture() *fakeCapture {
	return &fakeCapture{frames: make(chan []int16, 512), lost: make(chan struct{}, 1)}
}

func (f *fakeCapture) Start(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.started++
	return f.startedErr
}
func (f *fakeCapture) Stop() error                 { return nil }
func (f *fakeCapture) Frames() <-chan []int16      { return f.frames }
func (f *fakeCapture) DeviceLost() <-chan struct{} { return f.lost }
func (f *fakeCapture) push(s []int16)              { f.frames <- s }
func (f *fakeCapture) loseDevice()                 { f.lost <- struct{}{} }

type fakeEngine struct {
	mu            sync.Mutex
	ready         transcription.ReadyMessage
	final         transcription.FinalMessage
	startErrQueue []error
	releaseReady  chan struct{}
	startCalls    int
	stopCalls     int
	cancelCalls   int
	closeCalls    int
	sentAudio     [][]byte
}

func newFakeEngine() *fakeEngine {
	return &fakeEngine{
		final:        transcription.FinalMessage{Text: "hello world", WordCount: 2},
		releaseReady: make(chan struct{}),
	}
}

func (f *fakeEngine) Start(context.Context, string) (transcription.ReadyMessage, error) {
	f.mu.Lock()
	f.startCalls++
	gate := f.releaseReady
	f.mu.Unlock()
	if gate != nil {
		<-gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.startErrQueue) > 0 {
		err := f.startErrQueue[0]
		f.startErrQueue = f.startErrQueue[1:]
		if err != nil {
			return transcription.ReadyMessage{}, err
		}
	}
	return f.ready, nil
}

func (f *fakeEngine) SendAudio(_ context.Context, b []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sentAudio = append(f.sentAudio, append([]byte(nil), b...))
	return nil
}

func (f *fakeEngine) Stop(context.Context, int64) (transcription.FinalMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stopCalls++
	return f.final, nil
}

func (f *fakeEngine) Cancel(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cancelCalls++
	return nil
}

func (f *fakeEngine) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closeCalls++
	return nil
}

func (f *fakeEngine) closeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closeCalls
}

func (f *fakeEngine) release() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.releaseReady != nil {
		close(f.releaseReady)
		f.releaseReady = nil
	}
}

func (f *fakeEngine) sentCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sentAudio)
}

func (f *fakeEngine) firstSent() []byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.sentAudio) == 0 {
		return nil
	}
	return f.sentAudio[0]
}

func (f *fakeEngine) counts() (start, stop, cancel int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.startCalls, f.stopCalls, f.cancelCalls
}

type fakeInserter struct {
	mu       sync.Mutex
	inserted []string
}

func (f *fakeInserter) Insert(_ context.Context, text string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.inserted = append(f.inserted, text)
	return nil
}

func (f *fakeInserter) all() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.inserted...)
}

type fakeRefresher struct {
	mu    sync.Mutex
	calls int
	err   error
}

func (f *fakeRefresher) Refresh(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.err
}

func (f *fakeRefresher) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// ---- harness ---------------------------------------------------------------

type harness struct {
	t         *testing.T
	c         *Coordinator
	capture   *fakeCapture
	engine    *fakeEngine
	inserter  *fakeInserter
	refresher *fakeRefresher
	clock     *fakeClock
	cfg       settings.Store

	mu     sync.Mutex
	pills  []platform.PillStatus
	states []State

	ctx    context.Context
	cancel context.CancelFunc
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	h := &harness{
		t:         t,
		clock:     newFakeClock(),
		capture:   newFakeCapture(),
		engine:    newFakeEngine(),
		inserter:  &fakeInserter{},
		refresher: &fakeRefresher{},
		cfg:       settings.Defaults(),
	}
	h.c = NewCoordinator(
		h.capture,
		audio.NewSilenceDetector(300),
		audio.NewFakeEncoder(),
		h.engine,
		h.inserter,
		&h.cfg,
		h.refresher,
		h.clock,
		NewTimeouts(),
	)
	h.c.OnStateChanged(func(s State) {
		h.mu.Lock()
		h.states = append(h.states, s)
		h.mu.Unlock()
	})
	h.c.OnPillChanged(func(p platform.PillStatus) {
		h.mu.Lock()
		h.pills = append(h.pills, p)
		h.mu.Unlock()
	})
	h.ctx, h.cancel = context.WithCancel(context.Background())
	go h.c.Run(h.ctx)
	return h
}

func (h *harness) stop() { h.cancel() }

func (h *harness) toggle() { _ = h.c.Toggle(h.ctx) }
func (h *harness) escape() { _ = h.c.Cancel(h.ctx) }
func (h *harness) feed(n int, make func() []int16) {
	for i := 0; i < n; i++ {
		h.capture.push(make())
	}
}

func (h *harness) lastPill() platform.PillStatus {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.pills) == 0 {
		return platform.PillStatus{}
	}
	return h.pills[len(h.pills)-1]
}

func (h *harness) sawPill(state platform.PillState) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.pills {
		if p.State == state {
			return true
		}
	}
	return false
}

func (h *harness) sawState(want State) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, s := range h.states {
		if s == want {
			return true
		}
	}
	return false
}

func (h *harness) waitState(want State) {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if h.c.State() == want {
			return
		}
		time.Sleep(200 * time.Microsecond)
	}
	h.t.Fatalf("state = %v, want %v", h.c.State(), want)
}

func loudFrame() []int16 {
	f := make([]int16, audio.FrameSamples)
	for i := range f {
		f[i] = int16(8000 * math.Sin(2*math.Pi*500*float64(i)/16000))
	}
	return f
}

func quietFrame() []int16 { return make([]int16, audio.FrameSamples) }

func (h *harness) toRecording() {
	h.t.Helper()
	h.toggle()
	h.waitState(StateConnecting)
	h.feed(20, quietFrame) // complete the 300 ms detector calibration
	h.engine.release()
	h.waitState(StateRecording)
}

// ---- tests -----------------------------------------------------------------

func TestToggleIdleToConnectingThenRecording(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toggle()
	h.waitState(StateConnecting)

	h.feed(3, quietFrame)
	h.engine.release()
	h.waitState(StateRecording)

	if got := h.lastPill().State; got != platform.PillListening {
		t.Errorf("last pill = %v, want Listening", got)
	}
}

func TestConnectingGateHoldsPillUntilFramesAndReady(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toggle()
	h.waitState(StateConnecting)

	// Frames but no ready yet: must stay Connecting, never Listening.
	h.feed(5, quietFrame)
	time.Sleep(20 * time.Millisecond)
	if h.c.State() != StateConnecting {
		t.Fatalf("state = %v, want Connecting (no ready yet)", h.c.State())
	}
	if h.sawPill(platform.PillListening) {
		t.Errorf("Listening pill shown before ready")
	}
}

func TestPreReadyBufferFlushedAsFirstBinaryFrames(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toggle()
	h.waitState(StateConnecting)
	h.feed(25, loudFrame) // pre-ready audio
	h.engine.release()
	h.waitState(StateRecording)

	got := h.engine.firstSent()
	if len(got) == 0 {
		t.Fatal("no audio sent after ready")
	}
	if string(got[:4]) != "OggS" {
		t.Errorf("first sent bytes do not start with OggS: %q", got[:4])
	}
}

func TestConnectingTimeoutAbortsToIdle(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toggle()
	h.waitState(StateConnecting)
	h.clock.Advance(5 * time.Second)
	h.waitState(StateIdle)

	if got := h.lastPill().State; got != platform.PillError {
		t.Errorf("last pill = %v, want Error", got)
	}
}

func TestToggleDuringRecordingTranscribes(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.feed(40, loudFrame)
	time.Sleep(20 * time.Millisecond)

	h.toggle()
	h.waitState(StateIdle)

	if got := h.inserter.all(); len(got) != 1 || got[0] != "hello world" {
		t.Errorf("inserted = %v, want [hello world]", got)
	}
}

func TestSilence3sAutoStops(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.feed(40, loudFrame) // speech
	time.Sleep(20 * time.Millisecond)
	h.feed(160, quietFrame) // > 3 s of quiet
	h.waitState(StateIdle)

	// Transcribing is transient (the fake engine returns instantly), so assert
	// on the recorded transition rather than catching it live.
	if !h.sawState(StateTranscribing) {
		t.Errorf("never entered Transcribing; states = %v", h.states)
	}
	if _, stop, _ := h.engine.counts(); stop == 0 {
		t.Errorf("engine.stop was not called")
	}
}

func TestHardCap120sStops(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.feed(40, loudFrame)
	time.Sleep(30 * time.Millisecond) // let the coordinator register speech
	h.clock.Advance(120 * time.Second)
	h.waitState(StateIdle)

	if !h.sawState(StateTranscribing) {
		t.Errorf("never entered Transcribing; states = %v", h.states)
	}
}

func TestNoSpeechWithin10sDiscards(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.clock.Advance(10 * time.Second)
	h.waitState(StateIdle)

	_, stop, _ := h.engine.counts()
	if stop != 0 {
		t.Errorf("engine.stop called %d times, want 0", stop)
	}
}

func TestSub400msIsDiscarded(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toggle()
	h.waitState(StateConnecting)
	h.feed(3, quietFrame)
	h.engine.release()
	h.waitState(StateRecording)
	h.feed(10, loudFrame) // ~200 ms total
	time.Sleep(20 * time.Millisecond)

	h.toggle()
	h.waitState(StateIdle)

	_, stop, _ := h.engine.counts()
	if stop != 0 {
		t.Errorf("engine.stop called %d times, want 0 for a <400 ms recording", stop)
	}
	if got := h.inserter.all(); len(got) != 0 {
		t.Errorf("inserted = %v, want nothing", got)
	}
}

func TestTrailingSilenceTrimmedBeforeFinalFlush(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.feed(60, loudFrame)
	time.Sleep(30 * time.Millisecond)

	before := h.engine.sentCount()
	h.feed(30, quietFrame) // trailing silence must not be streamed
	time.Sleep(30 * time.Millisecond)
	if after := h.engine.sentCount(); after != before {
		t.Errorf("trailing silence streamed: %d -> %d sends", before, after)
	}
}

func TestEmptyTranscriptSkipsInsertion(t *testing.T) {
	h := newHarness(t)
	defer h.stop()
	h.engine.final = transcription.FinalMessage{Text: "   "}

	h.toRecording()
	h.feed(40, loudFrame)
	time.Sleep(20 * time.Millisecond)

	h.toggle()
	h.waitState(StateIdle)

	if got := h.inserter.all(); len(got) != 0 {
		t.Errorf("inserted %v, want nothing for a whitespace transcript", got)
	}
}

func TestNonRetryableErrorNoRetry(t *testing.T) {
	h := newHarness(t)
	defer h.stop()
	h.engine.startErrQueue = []error{
		&transcription.TranscriptionError{Code: "quota_exceeded", Message: "limit", Retryable: false},
	}

	h.toggle()
	h.waitState(StateConnecting)
	h.feed(3, quietFrame)
	h.engine.release()
	h.waitState(StateIdle)

	pill := h.lastPill()
	if pill.State != platform.PillError {
		t.Errorf("last pill = %v, want Error", pill.State)
	}
	if pill.CanRetry {
		t.Errorf("CanRetry = true, want false for a non-retryable error")
	}
	start, _, _ := h.engine.counts()
	if start != 1 {
		t.Errorf("engine.start called %d times, want 1 (no retry)", start)
	}
}

func TestEscapeCancels(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.feed(20, loudFrame)
	h.escape()
	h.waitState(StateIdle)

	_, _, cancel := h.engine.counts()
	if cancel == 0 {
		t.Errorf("engine.cancel not called")
	}
	if got := h.inserter.all(); len(got) != 0 {
		t.Errorf("inserted %v, want nothing after cancel", got)
	}
}

func TestAudioDeviceDisappearsAbortsToIdle(t *testing.T) {
	h := newHarness(t)
	defer h.stop()

	h.toRecording()
	h.capture.loseDevice()
	h.waitState(StateIdle)

	if got := h.lastPill().State; got != platform.PillError {
		t.Errorf("last pill = %v, want Error", got)
	}
}

func TestUnauthenticatedRefreshesOnceAndReconnects(t *testing.T) {
	h := newHarness(t)
	defer h.stop()
	h.engine.startErrQueue = []error{
		&transcription.TranscriptionError{Code: "unauthenticated", Message: "expired", Retryable: false},
		nil, // the reconnect succeeds
	}

	h.toggle()
	h.waitState(StateConnecting)
	h.feed(3, quietFrame)
	h.engine.release()
	h.waitState(StateRecording)

	if h.refresher.count() != 1 {
		t.Errorf("refresh calls = %d, want exactly 1", h.refresher.count())
	}
	start, _, _ := h.engine.counts()
	if start != 2 {
		t.Errorf("engine.start called %d times, want 2 (one retry)", start)
	}
	// The warm socket must be dropped so the reconnect carries the new bearer.
	if closed := h.engine.closeCount(); closed != 1 {
		t.Errorf("engine.close called %d times, want 1 (force a reconnect)", closed)
	}
}
