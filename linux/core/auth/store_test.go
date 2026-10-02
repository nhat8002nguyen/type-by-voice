package auth

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
)

func tokenKey(refresh bool) string {
	if refresh {
		return "refresh"
	}
	return "access"
}

type fakeTokenStore struct {
	values map[string]string
}

func newFakeTokenStore() *fakeTokenStore { return &fakeTokenStore{values: map[string]string{}} }

func (f *fakeTokenStore) Get(refresh bool) (string, error) {
	v := f.values[tokenKey(refresh)]
	if v == "" {
		return "", ErrNoToken
	}
	return v, nil
}

func (f *fakeTokenStore) Set(refresh bool, value string) error {
	f.values[tokenKey(refresh)] = value
	return nil
}

type fakeResponse struct {
	status int
	body   json.RawMessage
	err    error
}

type fakeHTTPClient struct {
	responses map[string]fakeResponse
	calls     []string
	lastBody  map[string]any
}

func (f *fakeHTTPClient) record(path string, body any) {
	f.calls = append(f.calls, path)
	if m, ok := body.(map[string]any); ok {
		f.lastBody = m
	}
}

func (f *fakeHTTPClient) respond(path string) (int, json.RawMessage, error) {
	if r, ok := f.responses[path]; ok {
		return r.status, r.body, r.err
	}
	return 200, nil, nil
}

func (f *fakeHTTPClient) Post(_ context.Context, path string, body any) (int, json.RawMessage, error) {
	f.record(path, body)
	return f.respond(path)
}

func (f *fakeHTTPClient) Get(_ context.Context, path string) (int, json.RawMessage, error) {
	f.record(path, nil)
	return f.respond(path)
}

func (f *fakeHTTPClient) Delete(_ context.Context, path string) (int, json.RawMessage, error) {
	f.record(path, nil)
	return f.respond(path)
}

func (f *fakeHTTPClient) count(path string) int {
	n := 0
	for _, c := range f.calls {
		if c == path {
			n++
		}
	}
	return n
}

func newTestStore(t *testing.T, http HTTPClient, tokens TokenStore) *Store {
	t.Helper()
	return NewStore(http, tokens, ClientIdentity{
		Platform:      "linux",
		ClientVersion: "1.0.0+12",
		DeviceID:      "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77",
	}, t.TempDir())
}

func assertCode(t *testing.T, err error, want Code) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("error = %v, want *auth.Error", err)
	}
	if e.Code != want {
		t.Errorf("code = %v, want %v", e.Code, want)
	}
}

func TestRegisterSendsIdentityAndStoresTokens(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{
		"/v1/auth/register": {status: 201, body: json.RawMessage(`{"accessToken":"at","refreshToken":"rt","expiresIn":900}`)},
	}}
	tokens := newFakeTokenStore()
	s := newTestStore(t, http, tokens)

	if err := s.Register(context.Background(), "a@b.co", "pw"); err != nil {
		t.Fatalf("register: %v", err)
	}
	if len(http.calls) == 0 || http.calls[0] != "/v1/auth/register" {
		t.Fatalf("calls = %v, want first /v1/auth/register", http.calls)
	}
	want := map[string]any{
		"email":         "a@b.co",
		"password":      "pw",
		"platform":      "linux",
		"clientVersion": "1.0.0+12",
		"deviceId":      "9c1e4a2b-7d55-4f3a-9e10-2b8c0d1a4f77",
	}
	for k, v := range want {
		if http.lastBody[k] != v {
			t.Errorf("body[%s] = %v, want %v", k, http.lastBody[k], v)
		}
	}
	if s.AccessToken() != "at" {
		t.Errorf("access token = %q, want at", s.AccessToken())
	}
	if got, _ := tokens.Get(false); got != "at" {
		t.Errorf("stored access = %q, want at", got)
	}
	if got, _ := tokens.Get(true); got != "rt" {
		t.Errorf("stored refresh = %q, want rt", got)
	}
}

func TestLogin401MapsToInvalidCredentials(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{"/v1/auth/login": {status: 401}}}
	s := newTestStore(t, http, newFakeTokenStore())
	assertCode(t, s.Login(context.Background(), "a@b.co", "bad"), InvalidCredentials)
}

func TestRegister409MapsToEmailAlreadyRegistered(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{"/v1/auth/register": {status: 409}}}
	s := newTestStore(t, http, newFakeTokenStore())
	assertCode(t, s.Register(context.Background(), "a@b.co", "pw"), EmailAlreadyRegistered)
}

func TestLogin429MapsToRateLimited(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{"/v1/auth/login": {status: 429}}}
	s := newTestStore(t, http, newFakeTokenStore())
	assertCode(t, s.Login(context.Background(), "a@b.co", "pw"), RateLimited)
}

func TestUnreachableMapsToUnreachable(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{
		"/v1/auth/login": {err: errors.New("dial tcp: connection refused")},
	}}
	s := newTestStore(t, http, newFakeTokenStore())
	assertCode(t, s.Login(context.Background(), "a@b.co", "pw"), Unreachable)
}

func TestRefreshIfNeededSkipsWhenFresh(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{
		"/v1/auth/login": {status: 200, body: json.RawMessage(`{"accessToken":"at","refreshToken":"rt","expiresIn":900}`)},
	}}
	s := newTestStore(t, http, newFakeTokenStore())
	if err := s.Login(context.Background(), "a@b.co", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := s.RefreshIfNeeded(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if n := http.count("/v1/auth/refresh"); n != 0 {
		t.Errorf("refresh calls = %d, want 0", n)
	}
}

func TestRefreshIfNeededOneAttemptWhenStale(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{
		"/v1/auth/login":   {status: 200, body: json.RawMessage(`{"accessToken":"old","refreshToken":"rt","expiresIn":-60}`)},
		"/v1/auth/refresh": {status: 200, body: json.RawMessage(`{"accessToken":"new","refreshToken":"rt2","expiresIn":900}`)},
	}}
	s := newTestStore(t, http, newFakeTokenStore())
	if err := s.Login(context.Background(), "a@b.co", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := s.RefreshIfNeeded(context.Background()); err != nil {
		t.Fatalf("refresh: %v", err)
	}
	if n := http.count("/v1/auth/refresh"); n != 1 {
		t.Errorf("refresh calls = %d, want exactly 1", n)
	}
	if s.AccessToken() != "new" {
		t.Errorf("access token = %q, want new", s.AccessToken())
	}
}

func TestLogoutClearsTokens(t *testing.T) {
	http := &fakeHTTPClient{responses: map[string]fakeResponse{
		"/v1/auth/login": {status: 200, body: json.RawMessage(`{"accessToken":"at","refreshToken":"rt","expiresIn":900}`)},
	}}
	tokens := newFakeTokenStore()
	s := newTestStore(t, http, tokens)
	if err := s.Login(context.Background(), "a@b.co", "pw"); err != nil {
		t.Fatalf("login: %v", err)
	}
	if err := s.Logout(context.Background()); err != nil {
		t.Fatalf("logout: %v", err)
	}
	if s.AccessToken() != "" {
		t.Errorf("access token = %q, want empty", s.AccessToken())
	}
	if got, _ := tokens.Get(false); got != "" {
		t.Errorf("stored access = %q, want empty", got)
	}
	if got, _ := tokens.Get(true); got != "" {
		t.Errorf("stored refresh = %q, want empty", got)
	}
}
