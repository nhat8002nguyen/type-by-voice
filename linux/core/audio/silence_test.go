package audio

import (
	"math"
	"testing"
)

const testSampleRate = 16000

func msToSamples(ms int) int { return testSampleRate * ms / 1000 }

// feed delivers samples the way capture would: in 20 ms frames of 320 samples.
func feed(d *SilenceDetector, samples []int16) {
	const frame = testSampleRate / 50 // 20 ms
	for i := 0; i < len(samples); i += frame {
		end := i + frame
		if end > len(samples) {
			end = len(samples)
		}
		d.Process(samples[i:end])
	}
}

func quiet(ms int) []int16 { return make([]int16, msToSamples(ms)) }

func tone(ms int, amp float64) []int16 {
	out := make([]int16, msToSamples(ms))
	for i := range out {
		out[i] = int16(amp * math.Sin(2*math.Pi*500*float64(i)/testSampleRate))
	}
	return out
}

func noise(ms int, amp float64) []int16 {
	out := make([]int16, msToSamples(ms))
	seed := uint32(0x9e3779b9)
	for i := range out {
		seed = seed*1664525 + 1013904223
		out[i] = int16(float64(int16(seed>>16)) / 32768.0 * amp)
	}
	return out
}

func TestLoudAfterQuietRaisesSpeechStarted(t *testing.T) {
	d := NewSilenceDetector(300)
	var speech, silence int
	d.OnSpeechStarted(func() { speech++ })
	d.OnSilenceStarted(func() { silence++ })

	feed(d, quiet(300))
	feed(d, tone(500, 10000))

	if speech != 1 {
		t.Errorf("speech started %d times, want 1", speech)
	}
	if silence != 0 {
		t.Errorf("silence started %d times, want 0", silence)
	}
}

func TestQuietAfterSpeechRaisesSilenceStarted(t *testing.T) {
	d := NewSilenceDetector(300)
	var speech, silence int
	d.OnSpeechStarted(func() { speech++ })
	d.OnSilenceStarted(func() { silence++ })

	feed(d, quiet(300))
	feed(d, tone(500, 10000))
	feed(d, quiet(500))

	if speech != 1 {
		t.Errorf("speech started %d times, want 1", speech)
	}
	if silence != 1 {
		t.Errorf("silence started %d times, want 1", silence)
	}
}

func TestBriefPauseDoesNotRaiseSilenceStarted(t *testing.T) {
	d := NewSilenceDetector(300)
	var speech, silence int
	d.OnSpeechStarted(func() { speech++ })
	d.OnSilenceStarted(func() { silence++ })

	feed(d, quiet(300))
	feed(d, tone(300, 10000))
	feed(d, quiet(150))
	feed(d, tone(300, 10000))

	if speech != 1 {
		t.Errorf("speech started %d times, want 1", speech)
	}
	if silence != 0 {
		t.Errorf("silence started %d times, want 0 (brief pause must not trip)", silence)
	}
}

func TestNoisyRoomCalibrationPreventsFalseSpeech(t *testing.T) {
	d := NewSilenceDetector(300)
	var speech int
	d.OnSpeechStarted(func() { speech++ })

	feed(d, noise(300, 1000))
	feed(d, noise(300, 1150))

	if speech != 0 {
		t.Errorf("speech started %d times, want 0 (calibration floor accounts for room noise)", speech)
	}
}

func TestResetClearsState(t *testing.T) {
	d := NewSilenceDetector(300)
	var speech, silence int
	d.OnSpeechStarted(func() { speech++ })
	d.OnSilenceStarted(func() { silence++ })

	feed(d, quiet(300))
	feed(d, tone(300, 10000))
	if speech != 1 {
		t.Fatalf("precondition: speech started %d times, want 1", speech)
	}

	d.Reset()
	feed(d, quiet(500))

	if silence != 0 {
		t.Errorf("silence started %d times after Reset, want 0", silence)
	}
}
