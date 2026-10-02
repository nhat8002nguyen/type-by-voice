// Package history is the transcript-history client: list, search, delete, and
// export over the shared HTTP API. It is pure Go, so it tests anywhere.
package history

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"

	"github.com/nhat8002nguyen/type-by-voice/linux/core/auth"
)

// Transcript is one row of history.
type Transcript struct {
	ID        string `json:"id"`
	Text      string `json:"text"`
	WordCount int    `json:"wordCount"`
	CreatedAt string `json:"createdAt"`
}

// Page is one page of history.
type Page struct {
	Items      []Transcript `json:"items"`
	NextCursor string       `json:"nextCursor"`
}

// Client talks to /v1/transcripts. It uses the shared auth.HTTPClient, which
// carries the bearer token.
type Client struct {
	http auth.HTTPClient
}

// NewClient builds a history client over the shared HTTP client.
func NewClient(http auth.HTTPClient) *Client { return &Client{http: http} }

// List returns one page of history, optionally filtered by query and cursor.
func (c *Client) List(ctx context.Context, query, cursor string) (Page, error) {
	path := "/v1/transcripts"
	q := url.Values{}
	if query != "" {
		q.Set("q", query)
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	status, body, err := c.http.Get(ctx, path)
	if err != nil {
		return Page{}, err
	}
	if status < 200 || status >= 300 {
		return Page{}, fmt.Errorf("history: list returned status %d", status)
	}
	var page Page
	if err := json.Unmarshal(body, &page); err != nil {
		return Page{}, err
	}
	return page, nil
}

// Delete removes one transcript.
func (c *Client) Delete(ctx context.Context, id string) error {
	status, _, err := c.http.Delete(ctx, "/v1/transcripts/"+url.PathEscape(id))
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("history: delete returned status %d", status)
	}
	return nil
}

// Export downloads the user's full history.
func (c *Client) Export(ctx context.Context) ([]byte, error) {
	status, body, err := c.http.Get(ctx, "/v1/transcripts/export")
	if err != nil {
		return nil, err
	}
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("history: export returned status %d", status)
	}
	return body, nil
}
