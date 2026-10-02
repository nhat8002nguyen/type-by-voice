package history

import (
	"context"
	"encoding/json"
	"testing"
)

type fakeHTTP struct {
	lastPath string
	status   int
	body     json.RawMessage
}

func (f *fakeHTTP) Post(context.Context, string, any) (int, json.RawMessage, error) {
	return f.status, f.body, nil
}

func (f *fakeHTTP) Get(_ context.Context, path string) (int, json.RawMessage, error) {
	f.lastPath = path
	return f.status, f.body, nil
}

func (f *fakeHTTP) Delete(_ context.Context, path string) (int, json.RawMessage, error) {
	f.lastPath = path
	return f.status, f.body, nil
}

func TestListSendsQueryAndCursor(t *testing.T) {
	f := &fakeHTTP{
		status: 200,
		body:   json.RawMessage(`{"items":[{"id":"a","text":"hi","wordCount":1,"createdAt":"2026-10-02T00:00:00Z"}],"nextCursor":"c2"}`),
	}
	c := NewClient(f)

	page, err := c.List(context.Background(), "hello world", "c1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if f.lastPath != "/v1/transcripts?cursor=c1&q=hello+world" {
		t.Errorf("path = %q, want /v1/transcripts?cursor=c1&q=hello+world", f.lastPath)
	}
	if len(page.Items) != 1 || page.Items[0].Text != "hi" {
		t.Errorf("items = %+v, want one with text hi", page.Items)
	}
	if page.NextCursor != "c2" {
		t.Errorf("nextCursor = %q, want c2", page.NextCursor)
	}
}

func TestDeleteSendsID(t *testing.T) {
	f := &fakeHTTP{status: 204}
	c := NewClient(f)
	if err := c.Delete(context.Background(), "abc"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if f.lastPath != "/v1/transcripts/abc" {
		t.Errorf("path = %q, want /v1/transcripts/abc", f.lastPath)
	}
}

func TestExportReturnsBody(t *testing.T) {
	f := &fakeHTTP{status: 200, body: json.RawMessage(`{"exported":true}`)}
	c := NewClient(f)
	body, err := c.Export(context.Background())
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	if string(body) != `{"exported":true}` {
		t.Errorf("body = %s", body)
	}
}

func TestListNon2xxIsAnError(t *testing.T) {
	f := &fakeHTTP{status: 500}
	c := NewClient(f)
	if _, err := c.List(context.Background(), "", ""); err == nil {
		t.Errorf("expected an error for a 500 response")
	}
}
