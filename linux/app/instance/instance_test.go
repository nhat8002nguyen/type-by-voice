package instance

import (
	"errors"
	"testing"
)

func TestAcquireTwiceFails(t *testing.T) {
	dir := t.TempDir()

	lock, err := Acquire(dir)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if _, err := Acquire(dir); !errors.Is(err, ErrAlreadyRunning) {
		t.Errorf("second acquire err = %v, want ErrAlreadyRunning", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatalf("release: %v", err)
	}
	again, err := Acquire(dir)
	if err != nil {
		t.Fatalf("acquire after release: %v", err)
	}
	_ = again.Release()
}

func TestLockFilePath(t *testing.T) {
	if got := Path("/tmp/x"); got != "/tmp/x/instance.lock" {
		t.Errorf("Path = %q, want /tmp/x/instance.lock", got)
	}
}
