package audio

import "math"

const (
	silenceSampleRate = 16000
	// speechFactor is how far above the calibrated floor a frame must rise to
	// count as speech, and how far below it must fall to count as silence.
	speechFactor = 3.0
	// minFloorRMS keeps near-silent calibration (a dead-quiet room) from
	// producing a zero threshold that numerical noise would trip.
	minFloorRMS = 100.0
	// silenceHoldMs is how long quiet must persist before SilenceStarted
	// fires, so a pause between words does not read as the end of speech.
	silenceHoldMs = 250
)

// SilenceDetector reports speech/silence transitions from a stream of 16 kHz
// mono PCM frames. It calibrates a noise floor from the first calibrationMs of
// audio, then compares each frame's loudness against the floor with hysteresis.
type SilenceDetector struct {
	calibrationSamples int
	holdSamples        int

	elapsed    int
	floorSum   float64
	calFrames  int
	threshold  float64
	calibrated bool

	speaking bool
	quiet    int

	onSpeech  func()
	onSilence func()
}

// NewSilenceDetector builds a detector that calibrates over calibrationMs
// (typically 300). A non-positive calibration marks it calibrated immediately.
func NewSilenceDetector(calibrationMs int) *SilenceDetector {
	if calibrationMs < 0 {
		calibrationMs = 0
	}
	d := &SilenceDetector{
		calibrationSamples: silenceSampleRate * calibrationMs / 1000,
		holdSamples:        silenceSampleRate * silenceHoldMs / 1000,
	}
	if d.calibrationSamples == 0 {
		d.calibrated = true
		d.threshold = minFloorRMS * speechFactor
	}
	return d
}

// OnSpeechStarted registers the callback fired once when speech begins.
func (d *SilenceDetector) OnSpeechStarted(fn func()) { d.onSpeech = fn }

// OnSilenceStarted registers the callback fired once when speech ends.
func (d *SilenceDetector) OnSilenceStarted(fn func()) { d.onSilence = fn }

// Process consumes one PCM frame (any length; 20 ms is typical).
func (d *SilenceDetector) Process(samples []int16) {
	if len(samples) == 0 {
		return
	}
	rms := frameRMS(samples)

	if !d.calibrated {
		// The floor is the mean loudness of the calibration window, not its
		// peak: a word spoken while connecting must not raise the floor enough
		// to hide the rest of the utterance.
		d.floorSum += rms
		d.calFrames++
		d.elapsed += len(samples)
		if d.elapsed >= d.calibrationSamples {
			d.calibrated = true
			mean := d.floorSum / float64(d.calFrames)
			d.threshold = math.Max(mean, minFloorRMS) * speechFactor
		}
		return
	}

	// A loud frame is speech: mark it and reset the quiet run.
	if rms > d.threshold {
		if !d.speaking {
			d.speaking = true
			if d.onSpeech != nil {
				d.onSpeech()
			}
		}
		d.quiet = 0
		return
	}

	// A quiet frame accumulates; once the hold elapses, speech has ended.
	// d.quiet keeps growing while quiet, so QuietMs reports the whole run.
	d.quiet += len(samples)
	if d.speaking && d.quiet >= d.holdSamples {
		d.speaking = false
		if d.onSilence != nil {
			d.onSilence()
		}
	}
}

// QuietMs is the current quiet run's length in milliseconds, since the last
// speech frame. The coordinator uses it for the silence auto-stop.
func (d *SilenceDetector) QuietMs() int { return d.quiet * 1000 / silenceSampleRate }

// Reset returns the detector to its pre-calibration state.
func (d *SilenceDetector) Reset() {
	d.elapsed = 0
	d.floorSum = 0
	d.calFrames = 0
	d.threshold = 0
	d.calibrated = false
	d.speaking = false
	d.quiet = 0
}

func frameRMS(samples []int16) float64 {
	var sum float64
	for _, s := range samples {
		v := float64(s)
		sum += v * v
	}
	return math.Sqrt(sum / float64(len(samples)))
}
