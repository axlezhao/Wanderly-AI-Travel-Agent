package main

// HTTP plumbing shared by every tool: JSON fetching, error classification,
// cancellation, and a small response cache.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const userAgent = "Wanderly/1.0 (https://github.com/axlezhao/Wanderly-AI-Travel-Agent)"

// ToolError is a failure the agent should see as an Observation.
// Retryable tells the harness whether trying again might help (429, 5xx, timeouts).
type ToolError struct {
	Msg       string
	Retryable bool
}

func (e *ToolError) Error() string { return e.Msg }

func permanent(format string, args ...any) error {
	return &ToolError{Msg: fmt.Sprintf(format, args...)}
}

func isRetryable(err error) bool {
	var te *ToolError
	return errors.As(err, &te) && te.Retryable
}

var httpClient = &http.Client{}

// Small in-memory response cache shared by all sessions: free APIs appreciate
// not being asked the same question twice, and repeat trips load instantly.
const (
	cacheTTL = 15 * time.Minute
	cacheMax = 300
)

type cacheEntry struct {
	at   time.Time
	body []byte
}

var responseCache = struct {
	sync.Mutex
	entries map[string]cacheEntry
	order   []string // insertion order, for evicting the oldest entry
}{entries: map[string]cacheEntry{}}

func cacheGet(key string) ([]byte, bool) {
	responseCache.Lock()
	defer responseCache.Unlock()
	e, ok := responseCache.entries[key]
	if !ok || time.Since(e.at) > cacheTTL {
		return nil, false
	}
	return e.body, true
}

func cachePut(key string, body []byte) {
	responseCache.Lock()
	defer responseCache.Unlock()
	if _, exists := responseCache.entries[key]; !exists {
		responseCache.order = append(responseCache.order, key)
	}
	responseCache.entries[key] = cacheEntry{at: time.Now(), body: body}
	for len(responseCache.order) > cacheMax {
		delete(responseCache.entries, responseCache.order[0])
		responseCache.order = responseCache.order[1:]
	}
}

type request struct {
	method  string // defaults to GET
	url     string
	form    string // POST body (application/x-www-form-urlencoded)
	timeout time.Duration
}

// getJSON fetches req.url and decodes the JSON response into out.
// ctx is the MCP request's context: it is cancelled when the client cancels
// (harness timeout, user pressed Stop), which aborts the HTTP call.
func getJSON(ctx context.Context, req request, out any) error {
	if req.method == "" {
		req.method = http.MethodGet
	}
	if req.timeout == 0 {
		req.timeout = 15 * time.Second
	}
	key := req.method + " " + req.url + " " + req.form
	if body, ok := cacheGet(key); ok {
		return json.Unmarshal(body, out)
	}

	host := hostOf(req.url)
	reqCtx, cancel := context.WithTimeout(ctx, req.timeout)
	defer cancel()

	var body io.Reader
	if req.form != "" {
		body = strings.NewReader(req.form)
	}
	httpReq, err := http.NewRequestWithContext(reqCtx, req.method, req.url, body)
	if err != nil {
		return permanent("bad request to %s: %v", host, err)
	}
	httpReq.Header.Set("User-Agent", userAgent)
	httpReq.Header.Set("Accept", "application/json")
	if req.form != "" {
		httpReq.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}

	resp, err := httpClient.Do(httpReq)
	if err != nil {
		return networkError(ctx, reqCtx, host, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 20<<20))
	if err != nil {
		return networkError(ctx, reqCtx, host, err)
	}
	if resp.StatusCode >= 300 {
		return &ToolError{
			Msg:       fmt.Sprintf("%s responded %d", host, resp.StatusCode),
			Retryable: resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500,
		}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &ToolError{Msg: fmt.Sprintf("%s returned invalid JSON", host), Retryable: true}
	}
	cachePut(key, data)
	return nil
}

func networkError(parent, reqCtx context.Context, host string, err error) error {
	if parent.Err() != nil {
		return permanent("Cancelled.")
	}
	reason := err.Error()
	if errors.Is(reqCtx.Err(), context.DeadlineExceeded) {
		reason = "timed out"
	}
	return &ToolError{Msg: fmt.Sprintf("%s unreachable (%s)", host, reason), Retryable: true}
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	return u.Hostname()
}

// sleep waits for d, or returns early with an error if ctx is cancelled.
func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return permanent("Cancelled.")
	}
}
