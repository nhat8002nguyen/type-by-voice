// Package audio holds the pure-Go audio pipeline: the ring buffer, the
// silence detector, the Ogg Opus framer, and the encoder seam. Nothing here
// depends on cgo, GTK, or X11, so it builds and unit-tests on any platform.
package audio

// RingBuffer is a fixed-capacity circular buffer of 16-bit PCM samples. A
// write that would exceed the capacity overwrites the oldest unread samples
// rather than growing, so memory stays bounded by the recording hard cap.
type RingBuffer struct {
	buf  []int16
	head int // index of the next sample to read
	size int // number of valid, unread samples
}

// NewRingBuffer returns a buffer holding at most capacity samples. A negative
// capacity is treated as zero.
func NewRingBuffer(capacity int) *RingBuffer {
	if capacity < 0 {
		capacity = 0
	}
	return &RingBuffer{buf: make([]int16, capacity)}
}

// Capacity is the maximum number of samples the buffer can hold.
func (b *RingBuffer) Capacity() int { return len(b.buf) }

// Len is the number of unread samples currently buffered.
func (b *RingBuffer) Len() int { return b.size }

// Write appends samples, overwriting the oldest unread samples once full.
func (b *RingBuffer) Write(samples []int16) {
	n := len(b.buf)
	if n == 0 {
		return
	}
	for _, s := range samples {
		if b.size == n {
			b.buf[b.head] = s
			b.head = (b.head + 1) % n
			continue
		}
		b.buf[(b.head+b.size)%n] = s
		b.size++
	}
}

// Read copies up to len(dst) samples out in order and returns the count. Read
// samples are drained.
func (b *RingBuffer) Read(dst []int16) int {
	n := len(b.buf)
	if n == 0 {
		return 0
	}
	count := len(dst)
	if count > b.size {
		count = b.size
	}
	for i := 0; i < count; i++ {
		dst[i] = b.buf[b.head]
		b.head = (b.head + 1) % n
	}
	b.size -= count
	return count
}

// Clear discards every buffered sample.
func (b *RingBuffer) Clear() {
	b.head = 0
	b.size = 0
}
