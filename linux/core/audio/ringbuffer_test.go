package audio

import "testing"

func TestWriteThenReadRoundTrips(t *testing.T) {
	b := NewRingBuffer(8)
	b.Write([]int16{1, 2, 3, 4})
	if b.Len() != 4 {
		t.Fatalf("len = %d, want 4", b.Len())
	}
	dst := make([]int16, 4)
	n := b.Read(dst)
	if n != 4 {
		t.Fatalf("read %d, want 4", n)
	}
	for i, want := range []int16{1, 2, 3, 4} {
		if dst[i] != want {
			t.Errorf("dst[%d] = %d, want %d", i, dst[i], want)
		}
	}
	if b.Len() != 0 {
		t.Errorf("len = %d, want 0 after drain", b.Len())
	}
}

func TestOverflowOverwritesOldest(t *testing.T) {
	b := NewRingBuffer(4)
	if b.Capacity() != 4 {
		t.Fatalf("capacity = %d, want 4", b.Capacity())
	}
	b.Write([]int16{1, 2, 3, 4, 5, 6, 7, 8})
	if b.Len() != 4 {
		t.Fatalf("len = %d, want 4", b.Len())
	}
	dst := make([]int16, 4)
	n := b.Read(dst)
	if n != 4 {
		t.Fatalf("read %d, want 4", n)
	}
	for i, want := range []int16{5, 6, 7, 8} {
		if dst[i] != want {
			t.Errorf("dst[%d] = %d, want %d", i, dst[i], want)
		}
	}
}

func TestClearEmptiesBuffer(t *testing.T) {
	b := NewRingBuffer(4)
	b.Write([]int16{1, 2, 3})
	b.Clear()
	if b.Len() != 0 {
		t.Errorf("len = %d, want 0", b.Len())
	}
	dst := make([]int16, 4)
	if n := b.Read(dst); n != 0 {
		t.Errorf("read %d, want 0", n)
	}
}

func TestReadDrainsReadSamples(t *testing.T) {
	b := NewRingBuffer(8)
	b.Write([]int16{1, 2, 3, 4})
	dst := make([]int16, 2)
	if n := b.Read(dst); n != 2 {
		t.Fatalf("read %d, want 2", n)
	}
	if b.Len() != 2 {
		t.Errorf("len = %d, want 2", b.Len())
	}
	rest := make([]int16, 2)
	if n := b.Read(rest); n != 2 {
		t.Fatalf("read %d, want 2", n)
	}
	if rest[0] != 3 || rest[1] != 4 {
		t.Errorf("rest = %v, want [3 4]", rest)
	}
}
