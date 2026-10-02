package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
)

// HTTPClient is the client's single HTTP surface: auth calls, transcript
// history, and anything else in the shared API. The token provider supplies
// the access token attached as a bearer on every request (empty means none).
type HTTPClient interface {
	Post(ctx context.Context, path string, body any) (int, json.RawMessage, error)
	Get(ctx context.Context, path string) (int, json.RawMessage, error)
	Delete(ctx context.Context, path string) (int, json.RawMessage, error)
}

type httpClient struct {
	baseURL string
	hc      *http.Client
	token   func() string
}

// NewHTTPClient returns an HTTPClient rooted at baseURL. token is read on each
// request, so the caller can wire it to an AuthStore that is built later.
func NewHTTPClient(baseURL string, hc *http.Client, token func() string) HTTPClient {
	if hc == nil {
		hc = http.DefaultClient
	}
	if token == nil {
		token = func() string { return "" }
	}
	return &httpClient{baseURL: baseURL, hc: hc, token: token}
}

// Post sends a JSON body and returns the status and raw response body.
func (c *httpClient) Post(ctx context.Context, path string, body any) (int, json.RawMessage, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req)
}

// Get issues an authenticated GET.
func (c *httpClient) Get(ctx context.Context, path string) (int, json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return 0, nil, err
	}
	return c.do(req)
}

// Delete issues an authenticated DELETE.
func (c *httpClient) Delete(ctx context.Context, path string) (int, json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, c.baseURL+path, nil)
	if err != nil {
		return 0, nil, err
	}
	return c.do(req)
}

func (c *httpClient) do(req *http.Request) (int, json.RawMessage, error) {
	if token := c.token(); token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, json.RawMessage(data), nil
}
