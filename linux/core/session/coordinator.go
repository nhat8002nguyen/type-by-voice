package session

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/audio"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/platform"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/settings"
	"github.com/nhat8002nguyen/type-by-voice/linux/core/transcription"
)

const (
	pcmSampleRate       = 16000
	oggSamplesPerPacket = 960 // one 20 ms Opus packet at 48 kHz
	checkInterval       = 50 * time.Millisecond
)

type readyResult struct {
	ready transcription.ReadyMessage
	err   error
}

type finalResult struct {
	final transcription.FinalMessage
	err   error
}

// Coordinator is the only component that knows the overall dictation flow. It
// is driven by a single event loop (Run) and reports outward through callbacks,
// never calling platform components' siblings directly.
type Coordinator struct {
	capture  platform.AudioCapture
	silence  *audio.SilenceDetector
	encoder  audio.Encoder
	engine   transcription.Engine
	inserter platform.TextInserter
	cfg      *settings.Store
	auth     Refresher
	clock    Clock
	timeouts Timeouts

	mu      sync.Mutex
	state   State
	onState func(State)
	onPill  func(platform.PillStatus)

	toggleCh chan struct{}
	cancelCh chan struct{}
	readyCh  chan readyResult
	finalCh  chan finalResult
	tickCh   <-chan time.Time

	// session-scoped; touched only by the Run goroutine
	requestID     string
	framer        *audio.OggFramer
	preReady      []byte
	ready         bool
	hasFrames     bool
	pcmPending    []int16
	held          [][]byte // quiet packets awaiting a following speech packet
	speechStarted bool
	capturedMs    int
	refreshed     bool
	recordStart   time.Time

	connectingAt   time.Time
	noSpeechAt     time.Time
	hardCapAt      time.Time
	transcribingAt time.Time
	insertingAt    time.Time
}

// NewCoordinator wires the coordinator. Every dependency is injected so the
// flow can be unit-tested with fakes and a fake clock.
func NewCoordinator(
	capture platform.AudioCapture,
	silence *audio.SilenceDetector,
	encoder audio.Encoder,
	engine transcription.Engine,
	inserter platform.TextInserter,
	cfg *settings.Store,
	auth Refresher,
	clock Clock,
	timeouts Timeouts,
) *Coordinator {
	c := &Coordinator{
		capture:  capture,
		silence:  silence,
		encoder:  encoder,
		engine:   engine,
		inserter: inserter,
		cfg:      cfg,
		auth:     auth,
		clock:    clock,
		timeouts: timeouts,
		toggleCh: make(chan struct{}, 1),
		cancelCh: make(chan struct{}, 1),
		readyCh:  make(chan readyResult, 4),
		finalCh:  make(chan finalResult, 4),
	}
	silence.OnSpeechStarted(func() {
		c.speechStarted = true
		c.noSpeechAt = time.Time{}
	})
	return c
}

// OnStateChanged registers the state observer.
func (c *Coordinator) OnStateChanged(fn func(State)) {
	c.mu.Lock()
	c.onState = fn
	c.mu.Unlock()
}

// OnPillChanged registers the overlay observer.
func (c *Coordinator) OnPillChanged(fn func(platform.PillStatus)) {
	c.mu.Lock()
	c.onPill = fn
	c.mu.Unlock()
}

// State returns the current state.
func (c *Coordinator) State() State {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state
}

// Toggle starts recording from idle, stops recording while recording, and
// cancels while connecting. It is non-blocking.
func (c *Coordinator) Toggle(context.Context) error {
	select {
	case c.toggleCh <- struct{}{}:
	default:
	}
	return nil
}

// Cancel abandons the current session (the Escape key).
func (c *Coordinator) Cancel(context.Context) error {
	select {
	case c.cancelCh <- struct{}{}:
	default:
	}
	return nil
}

// Run is the coordinator's event loop; it returns when ctx is cancelled.
func (c *Coordinator) Run(ctx context.Context) {
	frames := c.capture.Frames()
	lost := c.capture.DeviceLost()
	for {
		select {
		case <-ctx.Done():
			c.abortSession(ctx)
			return
		case <-c.toggleCh:
			c.handleToggle(ctx)
		case <-c.cancelCh:
			c.handleCancel(ctx)
		case frame, ok := <-frames:
			if ok {
				c.handleFrame(ctx, frame)
			}
		case <-lost:
			c.handleDeviceLost(ctx)
		case res := <-c.readyCh:
			c.handleReady(ctx, res)
		case res := <-c.finalCh:
			c.handleFinal(ctx, res)
		case <-c.tickCh:
			c.tickCh = nil
			c.handleTick(ctx)
		}
	}
}

func (c *Coordinator) handleToggle(ctx context.Context) {
	switch c.state {
	case StateIdle:
		c.beginConnecting(ctx)
	case StateConnecting:
		c.abortSession(ctx)
	case StateRecording:
		c.stopRecording(ctx)
	}
}

func (c *Coordinator) handleCancel(ctx context.Context) {
	switch c.state {
	case StateConnecting, StateRecording, StateTranscribing:
		c.abortSession(ctx)
	}
}

func (c *Coordinator) beginConnecting(ctx context.Context) {
	c.resetSession()
	if err := c.capture.Start(ctx); err != nil {
		c.pill(platform.PillStatus{State: platform.PillError, Message: err.Error(), CanRetry: true})
		return
	}
	c.requestID = newRequestID()
	c.setState(StateConnecting)
	c.pill(platform.PillStatus{State: platform.PillConnecting, Message: "Connecting…"})
	c.connectingAt = c.clock.Now().Add(c.timeouts.Connecting)
	c.armTick()

	reqID := c.requestID
	go func() {
		ready, err := c.engine.Start(ctx, reqID)
		select {
		case c.readyCh <- readyResult{ready: ready, err: err}:
		case <-ctx.Done():
		}
	}()
}

func (c *Coordinator) handleFrame(ctx context.Context, samples []int16) {
	if c.state != StateConnecting && c.state != StateRecording {
		return
	}
	if len(samples) == 0 {
		return
	}
	c.hasFrames = true
	c.capturedMs += len(samples) * 1000 / pcmSampleRate

	c.silence.Process(samples)
	quiet := c.silence.QuietMs() > 0

	framed := c.encodeFrames(samples, quiet)

	if c.state == StateConnecting {
		c.preReady = append(c.preReady, framed...)
		c.maybeStartRecording(ctx)
		return
	}

	// Recording.
	if c.speechStarted && c.silence.QuietMs() >= int(c.silenceDuration()/time.Millisecond) {
		c.stopRecording(ctx)
		return
	}
	if len(framed) > 0 {
		_ = c.engine.SendAudio(ctx, framed)
	}
}

// encodeFrames runs pending PCM through the encoder and framer. Quiet packets
// are held and only released once a speech packet follows, so trailing silence
// is never streamed (hangover 0 ms).
func (c *Coordinator) encodeFrames(samples []int16, quiet bool) []byte {
	c.pcmPending = append(c.pcmPending, samples...)
	var out []byte
	for len(c.pcmPending) >= audio.FrameSamples {
		packet, err := c.encoder.Encode(c.pcmPending[:audio.FrameSamples])
		c.pcmPending = c.pcmPending[audio.FrameSamples:]
		if err != nil {
			continue
		}
		if quiet {
			c.held = append(c.held, packet)
			continue
		}
		for _, hp := range c.held {
			out = append(out, c.framer.WritePacket(hp)...)
		}
		c.held = c.held[:0]
		out = append(out, c.framer.WritePacket(packet)...)
	}
	return out
}

func (c *Coordinator) handleReady(ctx context.Context, res readyResult) {
	if c.state != StateConnecting {
		return
	}
	if res.err != nil {
		if c.handleUnauthenticated(ctx, res.err) {
			return
		}
		c.failSession(res.err)
		return
	}
	c.ready = true
	c.maybeStartRecording(ctx)
}

// maybeStartRecording is the Connecting -> Recording gate: both live mic frames
// and the server's ready must have arrived.
func (c *Coordinator) maybeStartRecording(ctx context.Context) {
	if c.state != StateConnecting || !c.ready || !c.hasFrames {
		return
	}
	c.setState(StateRecording)
	c.recordStart = c.clock.Now()
	c.connectingAt = time.Time{}
	c.noSpeechAt = c.recordStart.Add(c.timeouts.NoSpeechTimeout)
	c.hardCapAt = c.recordStart.Add(c.hardCap())
	c.armTick()
	c.pill(platform.PillStatus{State: platform.PillListening, ElapsedSeconds: 0})

	if len(c.preReady) > 0 {
		_ = c.engine.SendAudio(ctx, c.preReady)
		c.preReady = c.preReady[:0]
	}
}

func (c *Coordinator) stopRecording(ctx context.Context) {
	c.held = c.held[:0] // drop trailing silence
	c.noSpeechAt = time.Time{}
	c.hardCapAt = time.Time{}

	if c.capturedMs < int(c.minDuration()/time.Millisecond) {
		c.abortSession(ctx)
		return
	}

	if flush := c.framer.Flush(); len(flush) > 0 {
		_ = c.engine.SendAudio(ctx, flush)
	}

	c.setState(StateTranscribing)
	c.pill(platform.PillStatus{State: platform.PillTranscribing})
	c.transcribingAt = c.clock.Now().Add(c.timeouts.Transcribing)
	c.armTick()

	duration := int64(c.capturedMs)
	go func() {
		final, err := c.engine.Stop(ctx, duration)
		select {
		case c.finalCh <- finalResult{final: final, err: err}:
		case <-ctx.Done():
		}
	}()
}

func (c *Coordinator) handleFinal(ctx context.Context, res finalResult) {
	if c.state != StateTranscribing {
		return
	}
	if res.err != nil {
		if c.handleUnauthenticated(ctx, res.err) {
			return
		}
		c.failSession(res.err)
		return
	}

	text := strings.TrimSpace(res.final.Text)
	if text == "" {
		c.finishIdle()
		return
	}

	c.transcribingAt = time.Time{}
	c.setState(StateInserting)
	c.insertingAt = c.clock.Now().Add(c.timeouts.Inserting)
	c.armTick()
	if err := c.inserter.Insert(ctx, text); err != nil {
		c.failSession(err)
		return
	}
	c.finishIdle()
}

func (c *Coordinator) handleDeviceLost(ctx context.Context) {
	if c.state == StateConnecting || c.state == StateRecording {
		c.failSession(errors.New("audio device disappeared"))
	}
}

func (c *Coordinator) handleTick(ctx context.Context) {
	now := c.clock.Now()
	switch c.state {
	case StateConnecting:
		if !c.connectingAt.IsZero() && !now.Before(c.connectingAt) {
			c.failSession(errors.New("timed out connecting"))
			return
		}
	case StateRecording:
		if !c.noSpeechAt.IsZero() && !now.Before(c.noSpeechAt) {
			c.abortSession(ctx)
			return
		}
		if !c.hardCapAt.IsZero() && !now.Before(c.hardCapAt) {
			c.stopRecording(ctx)
			return
		}
	case StateTranscribing:
		if !c.transcribingAt.IsZero() && !now.Before(c.transcribingAt) {
			c.failSession(errors.New("timed out transcribing"))
			return
		}
	case StateInserting:
		if !c.insertingAt.IsZero() && !now.Before(c.insertingAt) {
			c.finishIdle()
			return
		}
	}
	c.armTick()
}

// handleUnauthenticated performs at most one refresh-and-reconnect attempt.
func (c *Coordinator) handleUnauthenticated(ctx context.Context, err error) bool {
	if c.refreshed || c.auth == nil {
		return false
	}
	var te *transcription.TranscriptionError
	if !errors.As(err, &te) || te.Code != "unauthenticated" {
		return false
	}
	c.refreshed = true
	if refreshErr := c.auth.Refresh(ctx); refreshErr != nil {
		return false
	}
	// Drop the warm socket so the retry reconnects with the refreshed bearer
	// instead of reusing the connection that failed authentication.
	_ = c.engine.Close()
	reqID := c.requestID
	go func() {
		ready, rerr := c.engine.Start(ctx, reqID)
		select {
		case c.readyCh <- readyResult{ready: ready, err: rerr}:
		case <-ctx.Done():
		}
	}()
	return true
}

func (c *Coordinator) abortSession(ctx context.Context) {
	switch c.state {
	case StateConnecting, StateRecording, StateTranscribing:
		_ = c.engine.Cancel(ctx)
	}
	c.finishIdle()
}

func (c *Coordinator) failSession(err error) {
	message := "Dictation failed."
	retryable := false
	var te *transcription.TranscriptionError
	if errors.As(err, &te) {
		message = te.Message
		retryable = te.Retryable
	} else if err != nil {
		message = err.Error()
	}
	c.finishIdle()
	c.pill(platform.PillStatus{State: platform.PillError, Message: message, CanRetry: retryable})
}

func (c *Coordinator) finishIdle() {
	c.clearDeadlines()
	c.tickCh = nil
	c.setState(StateIdle)
	c.pill(platform.PillStatus{State: platform.PillHidden})
}

func (c *Coordinator) resetSession() {
	c.silence.Reset()
	c.framer = audio.NewOggFramer(oggSamplesPerPacket)
	c.preReady = c.preReady[:0]
	c.pcmPending = c.pcmPending[:0]
	c.held = c.held[:0]
	c.ready = false
	c.hasFrames = false
	c.speechStarted = false
	c.capturedMs = 0
	c.refreshed = false
	c.recordStart = time.Time{}
	c.clearDeadlines()
}

func (c *Coordinator) clearDeadlines() {
	c.connectingAt = time.Time{}
	c.noSpeechAt = time.Time{}
	c.hardCapAt = time.Time{}
	c.transcribingAt = time.Time{}
	c.insertingAt = time.Time{}
}

func (c *Coordinator) armTick() {
	if c.state == StateIdle {
		c.tickCh = nil
		return
	}
	if c.tickCh == nil {
		c.tickCh = c.clock.After(checkInterval)
	}
}

func (c *Coordinator) setState(s State) {
	c.mu.Lock()
	if c.state == s {
		c.mu.Unlock()
		return
	}
	c.state = s
	fn := c.onState
	c.mu.Unlock()
	if fn != nil {
		fn(s)
	}
}

func (c *Coordinator) pill(status platform.PillStatus) {
	c.mu.Lock()
	fn := c.onPill
	c.mu.Unlock()
	if fn != nil {
		fn(status)
	}
}

func (c *Coordinator) silenceDuration() time.Duration {
	if c.cfg != nil && c.cfg.SilenceDurationMs > 0 {
		return time.Duration(c.cfg.SilenceDurationMs) * time.Millisecond
	}
	return c.timeouts.SilenceDuration
}

func (c *Coordinator) hardCap() time.Duration {
	if c.cfg != nil && c.cfg.HardCapMs > 0 {
		return time.Duration(c.cfg.HardCapMs) * time.Millisecond
	}
	return c.timeouts.RecordingHardCap
}

func (c *Coordinator) minDuration() time.Duration {
	if c.timeouts.MinDuration > 0 {
		return c.timeouts.MinDuration
	}
	return 400 * time.Millisecond
}

func newRequestID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
