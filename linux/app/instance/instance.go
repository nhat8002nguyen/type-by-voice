// Package instance enforces a single running copy of the client with an
// advisory file lock. It is pure Go, so it builds and tests anywhere.
package instance

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// ErrAlreadyRunning is returned when another instance already holds the lock.
var ErrAlreadyRunning = errors.New("instance: already running")

// LockFileName is the lock file name inside the state directory.
const LockFileName = "instance.lock"

// Lock is a held single-instance lock.
type Lock struct {
	file *os.File
}

// Path is the lock file path inside stateDir.
func Path(stateDir string) string { return filepath.Join(stateDir, LockFileName) }

// Acquire takes the advisory lock, creating stateDir if needed. It returns
// ErrAlreadyRunning when another process holds it.
func Acquire(stateDir string) (*Lock, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(Path(stateDir), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
			return nil, ErrAlreadyRunning
		}
		return nil, fmt.Errorf("instance: flock: %w", err)
	}
	return &Lock{file: f}, nil
}

// Release drops the lock.
func (l *Lock) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	err := l.file.Close()
	l.file = nil
	return err
}
