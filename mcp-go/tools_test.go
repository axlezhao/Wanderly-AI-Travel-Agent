package main

// Offline tests: every external service is replaced by an httptest server,
// and the MCP layer is exercised through an in-memory client.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// mock starts a server that answers every request with handler, points *target
// at it, and restores everything (and clears the cache) when the test ends.
func mock(t *testing.T, target *string, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(handler)
	old := *target
	*target = srv.URL
	t.Cleanup(func() {
		*target = old
		srv.Close()
		responseCache.Lock()
		responseCache.entries, responseCache.order = map[string]cacheEntry{}, nil
		responseCache.Unlock()
	})
	return srv
}

func jsonReply(body string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(body))
	}
}

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(b, &m)
	return m
}

func TestSearchDestination(t *testing.T) {
	mock(t, &geocodeURL, jsonReply(`{"results":[
		{"name":"Kyoto","admin1":"Kyoto","country":"Japan","country_code":"JP","latitude":35.02,"longitude":135.75,"timezone":"Asia/Tokyo","population":1463723},
		{"name":"Kyoto","country":"Japan","latitude":34.9,"longitude":135.7}]}`))

	result, ui, err := searchDestination(context.Background(), SearchInput{Query: "Kyoto"})
	if err != nil {
		t.Fatal(err)
	}
	best := asJSON(t, result)["best_match"].(map[string]any)
	if best["region"] != "Kyoto" || best["country_code"] != "JP" || best["latitude"] != 35.02 {
		t.Errorf("unexpected best match: %v", best)
	}
	if others := asJSON(t, result)["other_matches"].([]any); len(others) != 1 {
		t.Errorf("want 1 other match, got %d", len(others))
	}
	if asJSON(t, ui)["kind"] != "destination" {
		t.Errorf("ui kind: %v", ui)
	}
}

func TestSearchDestinationNotFoundIsPermanent(t *testing.T) {
	mock(t, &geocodeURL, jsonReply(`{}`))
	_, _, err := searchDestination(context.Background(), SearchInput{Query: "Qwxzplk"})
	if err == nil || isRetryable(err) || !strings.Contains(err.Error(), "No place found") {
		t.Fatalf("want permanent not-found error, got %v", err)
	}
}

func TestHTTPErrorsAreClassified(t *testing.T) {
	for _, tc := range []struct {
		status    int
		retryable bool
	}{{429, true}, {503, true}, {404, false}, {400, false}} {
		mock(t, &geocodeURL, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(tc.status) })
		_, _, err := searchDestination(context.Background(), SearchInput{Query: "x"})
		if isRetryable(err) != tc.retryable {
			t.Errorf("status %d: retryable=%v, want %v (%v)", tc.status, isRetryable(err), tc.retryable, err)
		}
	}
}

func TestWeatherUsesForecastOrLastYear(t *testing.T) {
	now = func() time.Time { return time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { now = time.Now })

	var hitForecast, hitArchive atomic.Value
	reply := `{"daily":{"time":["2026-10-01"],"weather_code":[61],"temperature_2m_max":[20.5],"temperature_2m_min":[12],"precipitation_sum":[4.2],"precipitation_probability_max":[70]}}`
	mock(t, &forecastURL, func(w http.ResponseWriter, r *http.Request) {
		hitForecast.Store(r.URL.RawQuery)
		jsonReply(reply)(w, r)
	})
	mock(t, &archiveURL, func(w http.ResponseWriter, r *http.Request) { hitArchive.Store(r.URL.RawQuery); jsonReply(reply)(w, r) })

	result, _, err := getWeather(context.Background(), WeatherInput{Latitude: 1, Longitude: 2, StartDate: "2026-10-01", EndDate: "2026-10-03"})
	if err != nil {
		t.Fatal(err)
	}
	r := asJSON(t, result)
	if r["source"] != "forecast" || hitForecast.Load() == nil {
		t.Errorf("near dates should use the forecast, got %v", r["source"])
	}
	d := r["days"].([]any)[0].(map[string]any)
	if d["condition"] != "Light rain" || d["high_c"] != 20.5 || d["rain_chance_pct"] != 70.0 {
		t.Errorf("unexpected day: %v", d)
	}

	result, _, err = getWeather(context.Background(), WeatherInput{Latitude: 1, Longitude: 2, StartDate: "2027-03-03", EndDate: "2027-03-06"})
	if err != nil {
		t.Fatal(err)
	}
	if asJSON(t, result)["source"] != "same_dates_last_year" {
		t.Errorf("far dates should use last year's archive")
	}
	q, _ := hitArchive.Load().(string)
	if !strings.Contains(q, "start_date=2026-03-03") || !strings.Contains(q, "end_date=2026-03-06") {
		t.Errorf("archive should be asked for the same dates last year, got %q", q)
	}
}

func TestFindPlacesRanksWellDocumentedFirst(t *testing.T) {
	var gotQuery atomic.Value
	mock(t, &overpassPrimary, func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		gotQuery.Store(r.Form.Get("data"))
		jsonReply(`{"elements":[
			{"lat":1,"lon":2,"tags":{"name":"Plain Diner"}},
			{"center":{"lat":1.1,"lon":2.1},"tags":{"name":"Casa Boa","cuisine":"seafood;portuguese","opening_hours":"Tu-Su 12:00-23:00","website":"https://x.pt","addr:street":"Rua A","addr:housenumber":"7"}},
			{"lat":1,"lon":2,"tags":{"amenity":"restaurant"}}
		]}`)(w, r)
	})

	result, _, err := findPlaces(context.Background(), PlacesInput{Latitude: 38.7, Longitude: -9.1, Category: "restaurant"})
	if err != nil {
		t.Fatal(err)
	}
	places := asJSON(t, result)["places"].([]any)
	if len(places) != 2 {
		t.Fatalf("unnamed places should be dropped; got %d", len(places))
	}
	first := places[0].(map[string]any)
	if first["name"] != "Casa Boa" || first["cuisine"] != "seafood, portuguese" || first["address"] != "7 Rua A" {
		t.Errorf("richest place should rank first with cleaned fields: %v", first)
	}
	if q, _ := gotQuery.Load().(string); !strings.Contains(q, `["amenity"="restaurant"]`) || !strings.Contains(q, "around:1500,38.7,-9.1") {
		t.Errorf("unexpected Overpass query: %s", q)
	}
}

func TestOverpassFallsBackToMirror(t *testing.T) {
	var primaryHits atomic.Int32
	mock(t, &overpassPrimary, func(w http.ResponseWriter, _ *http.Request) {
		primaryHits.Add(1)
		w.WriteHeader(http.StatusTooManyRequests)
	})
	mock(t, &overpassFallback, jsonReply(`{"elements":[{"lat":1,"lon":2,"tags":{"name":"Mirror Cafe"}}]}`))

	result, _, err := findPlaces(context.Background(), PlacesInput{Latitude: 1, Longitude: 2, Category: "cafe"})
	if err != nil {
		t.Fatal(err)
	}
	if primaryHits.Load() != 2 {
		t.Errorf("primary should be tried twice before the mirror, got %d", primaryHits.Load())
	}
	if asJSON(t, result)["count"] != 1.0 {
		t.Errorf("mirror result should be used: %v", result)
	}
}

func TestCancellationAbortsInFlightRequests(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	mock(t, &geocodeURL, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()

	start := time.Now()
	_, _, err := searchDestination(ctx, SearchInput{Query: "slow"})
	if err == nil || err.Error() != "Cancelled." || isRetryable(err) {
		t.Fatalf("want non-retryable Cancelled, got %v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Errorf("cancellation took too long: %v", time.Since(start))
	}
}

func TestResponsesAreCached(t *testing.T) {
	var hits atomic.Int32
	mock(t, &frankfurterURL, func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		jsonReply(`{"date":"2026-09-25","rates":{"JPY":157.59}}`)(w, r)
	})
	for range 3 {
		result, _, err := getExchangeRate(context.Background(), ExchangeInput{From: "usd", To: "jpy", Amount: ptr(10.0)})
		if err != nil {
			t.Fatal(err)
		}
		if asJSON(t, result)["converted"] != 1575.9 {
			t.Errorf("converted: %v", result)
		}
	}
	if hits.Load() != 1 {
		t.Errorf("want 1 upstream call thanks to the cache, got %d", hits.Load())
	}
}

func TestChunk(t *testing.T) {
	got := chunk([]int{1, 2, 3, 4, 5}, 2)
	if len(got) != 3 || len(got[2]) != 1 || got[2][0] != 5 {
		t.Errorf("chunk: %v", got)
	}
	if len(chunk([]int{}, 50)) != 0 {
		t.Error("empty input should give no chunks")
	}
}

// ---- MCP layer, via an in-memory client ----

func connect(t *testing.T) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	serverT, clientT := mcp.NewInMemoryTransports()
	if _, err := newServer().Connect(ctx, serverT, nil); err != nil {
		t.Fatal(err)
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, clientT, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func TestMCPResultFormat(t *testing.T) {
	mock(t, &geocodeURL, jsonReply(`{"results":[{"name":"Porto","country":"Portugal","latitude":41.15,"longitude":-8.61}]}`))
	cs := connect(t)

	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_destination", Arguments: map[string]any{"query": "Porto"}})
	if err != nil {
		t.Fatal(err)
	}
	if res.IsError {
		t.Fatalf("unexpected error: %v", res.Content)
	}
	var observation map[string]any
	json.Unmarshal([]byte(res.Content[0].(*mcp.TextContent).Text), &observation)
	if observation["best_match"].(map[string]any)["name"] != "Porto" {
		t.Errorf("text content should be the JSON observation: %v", observation)
	}
	if ui, ok := res.Meta["ui"].(map[string]any); !ok || ui["kind"] != "destination" {
		t.Errorf("_meta.ui should carry UI data: %v", res.Meta)
	}
}

func TestMCPErrorsCarryRetryableFlag(t *testing.T) {
	mock(t, &geocodeURL, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusServiceUnavailable) })
	cs := connect(t)

	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: "search_destination", Arguments: map[string]any{"query": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if !res.IsError || res.Meta["retryable"] != true {
		t.Errorf("a 503 should be an isError result with _meta.retryable=true: %+v", res)
	}
	if text := res.Content[0].(*mcp.TextContent).Text; !strings.HasPrefix(text, "Error: ") {
		t.Errorf("error text: %q", text)
	}
}

func TestMCPPrompt(t *testing.T) {
	cs := connect(t)
	res, err := cs.GetPrompt(context.Background(), &mcp.GetPromptParams{
		Name: "plan_trip", Arguments: map[string]string{"destination": "Oaxaca", "interests": "food"},
	})
	if err != nil {
		t.Fatal(err)
	}
	text := res.Messages[0].Content.(*mcp.TextContent).Text
	if !strings.Contains(text, "3-day trip to Oaxaca focused on food") {
		t.Errorf("prompt text: %q", text)
	}
}

func TestCompareRoutes(t *testing.T) {
	mock(t, &osrmBase, func(w http.ResponseWriter, r *http.Request) {
		// Profile decides the speed: foot is slow, car is fast.
		minutes := map[string]float64{"foot": 40, "bike": 15, "car": 10}[strings.Split(strings.TrimPrefix(r.URL.Path, "/routed-"), "/")[0]]
		jsonReply(`{"code":"Ok","routes":[{"duration":`+fmt.Sprint(minutes*60)+`,"distance":3250,"geometry":{"coordinates":[[12.49,41.89],[12.47,41.90]]}}]}`)(w, r)
	})
	mock(t, &transitousURL, jsonReply(`{"itineraries":[
		{"duration":1800,"transfers":0,"legs":[{"mode":"WALK","duration":300},{"mode":"BUS","duration":1500,"routeShortName":"64"}]},
		{"duration":1500,"transfers":1,"legs":[{"mode":"WALK","duration":240},{"mode":"SUBWAY","duration":600,"routeShortName":"A"},{"mode":"TRAM","duration":480,"routeShortName":"8"},{"mode":"WALK","duration":180}]},
		{"duration":600,"legs":[{"mode":"WALK","duration":600}]}]}`))

	result, ui, err := compareRoutes(context.Background(), RoutesInput{
		FromLatitude: 41.89, FromLongitude: 12.49, ToLatitude: 41.90, ToLongitude: 12.47,
		FromName: ptr("Colosseum"), ToName: ptr("Pantheon"),
	})
	if err != nil {
		t.Fatal(err)
	}
	r := asJSON(t, result)
	opts := r["options"].([]any)
	if len(opts) != 4 {
		t.Fatalf("want 4 modes, got %v", opts)
	}
	transit := opts[3].(map[string]any)
	// The walk-only itinerary is ignored; the fastest real one wins.
	if transit["minutes"] != 25.0 || transit["transfers"] != 1.0 || transit["walk_minutes"] != 7.0 {
		t.Errorf("transit: %v", transit)
	}
	if lines := transit["lines"].([]any); lines[0] != "Metro A" || lines[1] != "Tram 8" {
		t.Errorf("lines: %v", lines)
	}
	if _, has := opts[0].(map[string]any)["geometry"]; has {
		t.Error("geometry is for the UI only, not the model")
	}
	if opts[2].(map[string]any)["note"] == nil {
		t.Error("driving should carry the traffic/parking note")
	}
	rec := r["recommended"].(map[string]any)
	if rec["mode"] != "transit" || !strings.Contains(rec["reason"].(string), "Metro A → Tram 8") {
		t.Errorf("40 min walk vs 25 min transit vs 10 min drive should pick transit: %v", rec)
	}
	uiOpts := asJSON(t, ui)["options"].([]any)
	if g := uiOpts[0].(map[string]any)["geometry"].([]any); g[0].([]any)[0] != 41.89 {
		t.Errorf("UI geometry should be [lat, lon]: %v", g)
	}
}

func TestCompareRoutesSkipsImpossibleModes(t *testing.T) {
	mock(t, &osrmBase, jsonReply(`{"code":"Ok","routes":[{"duration":10800,"distance":273000,"geometry":{"coordinates":[]}}]}`))
	mock(t, &transitousURL, jsonReply(`{"itineraries":[]}`))
	result, _, err := compareRoutes(context.Background(), RoutesInput{FromLatitude: 41.90, FromLongitude: 12.50, ToLatitude: 43.77, ToLongitude: 11.26})
	if err != nil {
		t.Fatal(err)
	}
	r := asJSON(t, result)
	opts := r["options"].([]any)
	if opts[0].(map[string]any)["error"] != "Too far to walk." || opts[1].(map[string]any)["error"] != "Too far to cycle." {
		t.Errorf("walk/bike should be skipped for Rome→Florence: %v", opts)
	}
	if opts[3].(map[string]any)["minutes"] != nil {
		t.Error("no transit found should give minutes: null")
	}
	if r["recommended"].(map[string]any)["mode"] != "drive" {
		t.Errorf("only driving works: %v", r["recommended"])
	}
}

func TestRecommendMode(t *testing.T) {
	opt := func(mode string, minutes int) RouteOption {
		return RouteOption{Mode: mode, Minutes: &minutes, Lines: []string{"Bus 1"}}
	}
	cases := []struct {
		name    string
		options []RouteOption
		want    string
	}{
		{"short walk wins", []RouteOption{opt("walk", 12), opt("drive", 4), opt("transit", 10)}, "walk"},
		{"transit within 2x of driving", []RouteOption{opt("walk", 90), opt("drive", 12), opt("transit", 33)}, "transit"},
		{"transit far slower than driving", []RouteOption{opt("walk", 300), opt("drive", 20), opt("transit", 95)}, "drive"},
		{"bike when nothing else", []RouteOption{opt("bike", 30)}, "bike"},
	}
	for _, c := range cases {
		if got := recommendMode(c.options); got.Mode == nil || *got.Mode != c.want {
			t.Errorf("%s: got %v, want %s", c.name, got.Mode, c.want)
		}
	}
	if got := recommendMode(nil); got.Mode != nil {
		t.Error("no options should recommend nothing")
	}
}
