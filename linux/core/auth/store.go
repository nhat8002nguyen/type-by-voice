// Package auth implements account authentication and token lifecycle for the
// Linux client: register/login/refresh/logout over the shared HTTP API, with a
// stable per-install deviceId and platform identity.
package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// Code classifies an auth failure so callers (and the UI) can react.
type Code int

// Auth error codes.
const (
	MissingRefreshToken Code = iota
	MissingAccessToken
	InvalidTokenResponse
	InvalidCredentials
	EmailAlreadyRegistered
	InvalidRequest
	RateLimited
	Unreachable
	HTTPStatus
)

// Error is an auth failure carrying a Code.
type Error struct {
	Code    Code
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("auth: %s (%d)", e.Message, e.Code) }

// ClientIdentity is the per-install identity sent on every auth call.
type ClientIdentity struct {
	Platform      string
	ClientVersion string
	DeviceID      string
}

// Store owns the token lifecycle. The access token is held in memory; both
// tokens are persisted through the TokenStore.
type Store struct {
	http      HTTPClient
	tokens    TokenStore
	identity  ClientIdentity
	configDir string
	now       func() time.Time

	accessToken string
	expiresAt   time.Time
}

// NewStore builds an auth store. configDir holds the account-email hint so a
// cold start can still refresh.
func NewStore(http HTTPClient, tokens TokenStore, identity ClientIdentity, configDir string) *Store {
	return &Store{http: http, tokens: tokens, identity: identity, configDir: configDir, now: time.Now}
}

// AccessToken is the current in-memory access token, or "" if none.
func (s *Store) AccessToken() string { return s.accessToken }

// AccountEmail is the last email used to sign in, if known.
func (s *Store) AccountEmail() string {
	data, err := os.ReadFile(s.emailPath())
	if err != nil {
		return ""
	}
	return string(data)
}

func (s *Store) emailPath() string { return filepath.Join(s.configDir, "account-email") }

func (s *Store) identityBody() map[string]any {
	return map[string]any{
		"platform":      s.identity.Platform,
		"clientVersion": s.identity.ClientVersion,
		"deviceId":      s.identity.DeviceID,
	}
}

// Register creates an account and stores the returned tokens.
func (s *Store) Register(ctx context.Context, email, password string) error {
	body := s.identityBody()
	body["email"] = email
	body["password"] = password
	status, resp, err := s.http.Post(ctx, "/v1/auth/register", body)
	if err != nil {
		return &Error{Code: Unreachable, Message: err.Error()}
	}
	switch status {
	case 200, 201:
		if err := s.storeTokens(resp); err != nil {
			return err
		}
		return s.writeEmail(email)
	case 400:
		return &Error{Code: InvalidRequest, Message: serverMessage(resp)}
	case 409:
		return &Error{Code: EmailAlreadyRegistered, Message: "email already registered"}
	case 429:
		return &Error{Code: RateLimited, Message: "too many attempts"}
	default:
		return &Error{Code: HTTPStatus, Message: fmt.Sprintf("unexpected status %d", status)}
	}
}

// Login authenticates an existing account and stores the returned tokens.
func (s *Store) Login(ctx context.Context, email, password string) error {
	body := s.identityBody()
	body["email"] = email
	body["password"] = password
	status, resp, err := s.http.Post(ctx, "/v1/auth/login", body)
	if err != nil {
		return &Error{Code: Unreachable, Message: err.Error()}
	}
	switch status {
	case 200, 201:
		if err := s.storeTokens(resp); err != nil {
			return err
		}
		return s.writeEmail(email)
	case 400:
		return &Error{Code: InvalidRequest, Message: serverMessage(resp)}
	case 401:
		return &Error{Code: InvalidCredentials, Message: "email or password is incorrect"}
	case 429:
		return &Error{Code: RateLimited, Message: "too many attempts"}
	default:
		return &Error{Code: HTTPStatus, Message: fmt.Sprintf("unexpected status %d", status)}
	}
}

// RefreshIfNeeded refreshes the access token when it is missing or within 30 s
// of expiry. It performs at most one refresh attempt.
func (s *Store) RefreshIfNeeded(ctx context.Context) error {
	if s.accessToken != "" && s.now().Before(s.expiresAt.Add(-30*time.Second)) {
		return nil
	}
	return s.Refresh(ctx)
}

// Refresh forces a token refresh regardless of the client's own expiry. The
// coordinator calls it after the server rejects the access token as
// unauthenticated, where the local expiry may still look valid.
func (s *Store) Refresh(ctx context.Context) error {
	refresh, err := s.tokens.Get(true)
	if err != nil || refresh == "" {
		return &Error{Code: MissingRefreshToken, Message: "no refresh token"}
	}
	body := s.identityBody()
	body["refreshToken"] = refresh
	status, resp, err := s.http.Post(ctx, "/v1/auth/refresh", body)
	if err != nil {
		return &Error{Code: Unreachable, Message: err.Error()}
	}
	switch status {
	case 200, 201:
		return s.storeTokens(resp)
	case 401:
		return &Error{Code: MissingAccessToken, Message: "refresh token rejected"}
	case 429:
		return &Error{Code: RateLimited, Message: "too many attempts"}
	default:
		return &Error{Code: HTTPStatus, Message: fmt.Sprintf("unexpected status %d", status)}
	}
}

// Logout revokes this device's session and clears all stored tokens.
func (s *Store) Logout(ctx context.Context) error {
	if s.accessToken != "" {
		_, _, _ = s.http.Post(ctx, "/v1/auth/logout", s.identityBody())
	}
	s.accessToken = ""
	s.expiresAt = time.Time{}
	_ = s.tokens.Set(false, "")
	_ = s.tokens.Set(true, "")
	return nil
}

func (s *Store) storeTokens(resp json.RawMessage) error {
	var body struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    int    `json:"expiresIn"`
	}
	if err := json.Unmarshal(resp, &body); err != nil {
		return &Error{Code: InvalidTokenResponse, Message: "malformed token response"}
	}
	if body.AccessToken == "" || body.RefreshToken == "" {
		return &Error{Code: InvalidTokenResponse, Message: "token response missing fields"}
	}
	if err := s.tokens.Set(false, body.AccessToken); err != nil {
		return &Error{Code: InvalidTokenResponse, Message: err.Error()}
	}
	if err := s.tokens.Set(true, body.RefreshToken); err != nil {
		return &Error{Code: InvalidTokenResponse, Message: err.Error()}
	}
	s.accessToken = body.AccessToken
	s.expiresAt = s.now().Add(time.Duration(body.ExpiresIn) * time.Second)
	return nil
}

func (s *Store) writeEmail(email string) error {
	if err := os.MkdirAll(s.configDir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(s.emailPath(), []byte(email), 0o600)
}

func serverMessage(resp json.RawMessage) string {
	var body struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(resp, &body); err == nil && body.Message != "" {
		return body.Message
	}
	return "invalid request"
}
