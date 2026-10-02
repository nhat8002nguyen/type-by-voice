package auth

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/zalando/go-keyring"
)

// ErrNoToken is returned when a requested token is not stored.
var ErrNoToken = errors.New("auth: no token")

// TokenStore persists the access and refresh tokens. Implementations differ in
// where they live: the Secret Service (GNOME Keyring) by default, or a file as
// a fallback on systems without one.
type TokenStore interface {
	Get(refresh bool) (string, error)
	Set(refresh bool, value string) error
}

func tokenName(refresh bool) string {
	if refresh {
		return "refreshToken"
	}
	return "accessToken"
}

// KeyringTokenStore stores tokens in the freedesktop Secret Service.
type KeyringTokenStore struct {
	service string
}

// NewKeyringTokenStore returns a store backed by the Secret Service under the
// given service name.
func NewKeyringTokenStore(service string) TokenStore { return &KeyringTokenStore{service: service} }

// Get reads a token from the Secret Service.
func (s *KeyringTokenStore) Get(refresh bool) (string, error) {
	v, err := keyring.Get(s.service, tokenName(refresh))
	if errors.Is(err, keyring.ErrNotFound) {
		return "", ErrNoToken
	}
	return v, err
}

// Set writes a token to the Secret Service.
func (s *KeyringTokenStore) Set(refresh bool, value string) error {
	return keyring.Set(s.service, tokenName(refresh), value)
}

// FileTokenStore keeps both tokens in a single 0600 JSON file.
type FileTokenStore struct {
	path string
}

// NewFileTokenStore returns a store backed by a file at path.
func NewFileTokenStore(path string) TokenStore { return &FileTokenStore{path: path} }

type fileTokens struct {
	Access  string `json:"accessToken"`
	Refresh string `json:"refreshToken"`
}

func (s *FileTokenStore) load() fileTokens {
	var t fileTokens
	if data, err := os.ReadFile(s.path); err == nil {
		_ = json.Unmarshal(data, &t)
	}
	return t
}

// Get reads a token from the file.
func (s *FileTokenStore) Get(refresh bool) (string, error) {
	t := s.load()
	v := t.Access
	if refresh {
		v = t.Refresh
	}
	if v == "" {
		return "", ErrNoToken
	}
	return v, nil
}

// Set writes a token to the file, creating its directory if needed.
func (s *FileTokenStore) Set(refresh bool, value string) error {
	t := s.load()
	if refresh {
		t.Refresh = value
	} else {
		t.Access = value
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(t)
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, data, 0o600)
}
