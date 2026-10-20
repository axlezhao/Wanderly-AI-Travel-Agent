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

// Retry tells the harness whether and how trying a failed call again could help
// (sent as _meta.retry; the same values as the Node server).
type Retry string

const (
	RetryTransient Retry = "transient" // a temporary failure (timeout, 429, 5xx): retry with backoff
	RetryOnce      Retry = "once"      // an unexpected failure: one more try might work
	RetryNever     Retry = "never"     // the same call fails the same way (nothing found, bad input, already retried here)
)

// ToolError is a failure the agent should see as an Observation.
type ToolError struct {
	Msg   string
	Retry Retry // empty means RetryNever
}

func (e *ToolError) Error() string { return e.Msg }

func permanent(format string, args ...any) error {
	return &ToolError{Msg: fmt.Sprintf(format, args...), Retry: RetryNever}
}

// retryOf says how to retry err. Anything that isn't a ToolError is a bug or a
// malformed response: worth one more try.
func retryOf(err error) Retry {
	var te *ToolError
	if !errors.As(err, &te) {
		return RetryOnce
	}
	if te.Retry == "" {
		return RetryNever
	}
	return te.Retry
}

func transientStatus(code int) bool {
	return code == http.StatusRequestTimeout || code == http.StatusTooEarly || code == http.StatusTooManyRequests || code >= 500
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
		retry := RetryNever
		if transientStatus(resp.StatusCode) {
			retry = RetryTransient
		}
		return &ToolError{Msg: fmt.Sprintf("%s responded %d", host, resp.StatusCode), Retry: retry}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &ToolError{Msg: fmt.Sprintf("%s returned invalid JSON", host), Retry: RetryOnce}
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
	return &ToolError{Msg: fmt.Sprintf("%s unreachable (%s)", host, reason), Retry: RetryTransient}
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
