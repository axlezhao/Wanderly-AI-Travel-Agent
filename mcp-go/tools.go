package main

// The seven travel tools, backed by free, no-API-key services. Each returns
// (result, ui, error) with exactly the same JSON shapes as the Node server
// (src/tools/travel-apis.js), so the two servers are interchangeable:
//   result -> compact JSON the agent reasons over (the Observation)
//   ui     -> richer data for the web UI's map and trip board

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
)

// Service endpoints. Variables (not constants) so tests can point them at mock servers.
var (
	geocodeURL       = "https://geocoding-api.open-meteo.com/v1/search"
	forecastURL      = "https://api.open-meteo.com/v1/forecast"
	archiveURL       = "https://archive-api.open-meteo.com/v1/archive"
	wikivoyageBase   = "https://en.wikivoyage.org"
	wikipediaBase    = "https://en.wikipedia.org"
	wikidataAPI      = "https://www.wikidata.org/w/api.php"
	overpassPrimary  = "https://overpass-api.de/api/interpreter"
	overpassFallback = "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
	frankfurterURL   = "https://api.frankfurter.dev/v1/latest"
)

// ---------------------------------------------------------------------------
// search_destination: Open-Meteo Geocoding
// ---------------------------------------------------------------------------

type Place struct {
	Name        string  `json:"name"`
	Region      *string `json:"region"`
	Country     *string `json:"country"`
	CountryCode *string `json:"country_code"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Timezone    *string `json:"timezone"`
	Population  *int64  `json:"population"`
}

type SearchInput struct {
	Query string `json:"query"`
}

func searchDestination(ctx context.Context, in SearchInput) (any, any, error) {
	var data struct {
		Results []struct {
			Place
			Admin1 *string `json:"admin1"`
		} `json:"results"`
	}
	u := fmt.Sprintf("%s?name=%s&count=5&language=en&format=json", geocodeURL, url.QueryEscape(in.Query))
	if err := getJSON(ctx, request{url: u}, &data); err != nil {
		return nil, nil, err
	}
	if len(data.Results) == 0 {
		return nil, nil, permanent("No place found matching %q. Try a simpler name, e.g. just the city.", in.Query)
	}
	matches := make([]Place, len(data.Results))
	for i, r := range data.Results {
		matches[i] = r.Place
		matches[i].Region = r.Admin1
	}
	result := map[string]any{"best_match": matches[0], "other_matches": matches[1:]}
	ui := map[string]any{"kind": "destination", "place": matches[0]}
	return result, ui, nil
}

// ---------------------------------------------------------------------------
// get_travel_guide: Wikivoyage, falling back to Wikipedia
// ---------------------------------------------------------------------------

type GuideInput struct {
	Place string `json:"place"`
}

func getTravelGuide(ctx context.Context, in GuideInput) (any, any, error) {
	title := strings.ReplaceAll(in.Place, " ", "_")
	var lastErr error
	for _, base := range []string{wikivoyageBase, wikipediaBase} {
		var summary struct {
			Type        string                   `json:"type"`
			Title       string                   `json:"title"`
			Extract     string                   `json:"extract"`
			Thumbnail   *struct{ Source string } `json:"thumbnail"`
			ContentURLs *struct {
				Desktop struct{ Page string } `json:"desktop"`
			} `json:"content_urls"`
		}
		if err := getJSON(ctx, request{url: base + "/api/rest_v1/page/summary/" + url.PathEscape(title) + "?redirect=true"}, &summary); err != nil {
			lastErr = err
			continue
		}
		if summary.Type == "disambiguation" {
			continue
		}
		var full struct {
			Query struct {
				Pages []struct{ Extract string } `json:"pages"`
			} `json:"query"`
		}
		fullURL := base + "/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=" + url.QueryEscape(title)
		if err := getJSON(ctx, request{url: fullURL}, &full); err != nil {
			lastErr = err
			continue
		}
		text := summary.Extract
		if len(full.Query.Pages) > 0 && full.Query.Pages[0].Extract != "" {
			text = full.Query.Pages[0].Extract
		}
		// Long articles would crowd out everything else in the agent's context.
		if r := []rune(text); len(r) > 9000 {
			text = string(r[:9000]) + "\n…(article continues)"
		}

		source, site := "Wikipedia", hostOf(base)
		if strings.Contains(base, "voyage") {
			source = "Wikivoyage"
		}
		var image *string
		if summary.Thumbnail != nil {
			image = &summary.Thumbnail.Source
		}
		pageURL := base + "/wiki/" + url.PathEscape(title)
		if summary.ContentURLs != nil && summary.ContentURLs.Desktop.Page != "" {
			pageURL = summary.ContentURLs.Desktop.Page
		}
		result := map[string]any{"source": site, "title": summary.Title, "summary": summary.Extract, "guide_text": text}
		ui := map[string]any{"kind": "guide", "title": summary.Title, "summary": summary.Extract, "image": image, "url": pageURL, "source": source}
		return result, ui, nil
	}
	return nil, nil, &ToolError{Msg: fmt.Sprintf("No travel guide found for %q.", in.Place), Retryable: isRetryable(lastErr)}
}

// ---------------------------------------------------------------------------
// get_weather: Open-Meteo forecast, or last year's actuals for far-off dates
// ---------------------------------------------------------------------------

var weatherCodes = map[int][2]string{
	0: {"Clear", "☀️"}, 1: {"Mostly clear", "🌤️"}, 2: {"Partly cloudy", "⛅"}, 3: {"Overcast", "☁️"},
	45: {"Fog", "🌫️"}, 48: {"Fog", "🌫️"}, 51: {"Light drizzle", "🌦️"}, 53: {"Drizzle", "🌦️"},
	55: {"Heavy drizzle", "🌧️"}, 61: {"Light rain", "🌦️"}, 63: {"Rain", "🌧️"}, 65: {"Heavy rain", "🌧️"},
	66: {"Freezing rain", "🌧️"}, 67: {"Freezing rain", "🌧️"}, 71: {"Light snow", "🌨️"}, 73: {"Snow", "🌨️"},
	75: {"Heavy snow", "❄️"}, 77: {"Snow grains", "🌨️"}, 80: {"Showers", "🌦️"}, 81: {"Showers", "🌧️"},
	82: {"Violent showers", "⛈️"}, 85: {"Snow showers", "🌨️"}, 86: {"Snow showers", "❄️"},
	95: {"Thunderstorm", "⛈️"}, 96: {"Thunderstorm + hail", "⛈️"}, 99: {"Thunderstorm + hail", "⛈️"},
}

type WeatherInput struct {
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	StartDate string  `json:"start_date,omitempty"`
	EndDate   string  `json:"end_date,omitempty"`
}

type WeatherDay struct {
	Date            string   `json:"date"`
	Condition       string   `json:"condition"`
	Icon            string   `json:"icon"`
	HighC           *float64 `json:"high_c"`
	LowC            *float64 `json:"low_c"`
	PrecipitationMM *float64 `json:"precipitation_mm"`
	RainChancePct   *float64 `json:"rain_chance_pct"`
}

const day = 24 * time.Hour

// now is swappable so tests can pin "today".
var now = time.Now

func getWeather(ctx context.Context, in WeatherInput) (any, any, error) {
	today := now().UTC().Truncate(day)
	start := today
	if in.StartDate != "" {
		t, err := time.Parse(time.DateOnly, in.StartDate)
		if err != nil {
			return nil, nil, permanent("Invalid start_date %q, expected YYYY-MM-DD.", in.StartDate)
		}
		start = t
	}
	end := start.Add(6 * day)
	if in.EndDate != "" {
		if t, err := time.Parse(time.DateOnly, in.EndDate); err == nil && !t.Before(start) {
			end = t
		}
	}
	if end.Sub(start) > 15*day {
		end = start.Add(15 * day)
	}

	const daily = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum"
	var source, u string
	if !start.Before(today) && !end.After(today.Add(15*day)) {
		source = "forecast"
		u = fmt.Sprintf("%s?latitude=%v&longitude=%v&daily=%s,precipitation_probability_max&timezone=auto&start_date=%s&end_date=%s",
			forecastURL, in.Latitude, in.Longitude, daily, start.Format(time.DateOnly), end.Format(time.DateOnly))
	} else {
		// Beyond the forecast window: use what actually happened on those dates last year.
		source = "same_dates_last_year"
		s, e := start.AddDate(-1, 0, 0), end.AddDate(-1, 0, 0)
		for !e.Before(today) {
			s, e = s.AddDate(-1, 0, 0), e.AddDate(-1, 0, 0)
		}
		u = fmt.Sprintf("%s?latitude=%v&longitude=%v&daily=%s&timezone=auto&start_date=%s&end_date=%s",
			archiveURL, in.Latitude, in.Longitude, daily, s.Format(time.DateOnly), e.Format(time.DateOnly))
	}

	var data struct {
		Daily struct {
			Time       []string   `json:"time"`
			Code       []*int     `json:"weather_code"`
			Max        []*float64 `json:"temperature_2m_max"`
			Min        []*float64 `json:"temperature_2m_min"`
			Precip     []*float64 `json:"precipitation_sum"`
			RainChance []*float64 `json:"precipitation_probability_max"`
		} `json:"daily"`
	}
	if err := getJSON(ctx, request{url: u}, &data); err != nil {
		return nil, nil, err
	}
	d := data.Daily
	at := func(xs []*float64, i int) *float64 {
		if i < len(xs) {
			return xs[i]
		}
		return nil
	}
	days := make([]WeatherDay, len(d.Time))
	for i, date := range d.Time {
		label, icon := "Unknown", "🌡️"
		if i < len(d.Code) && d.Code[i] != nil {
			if wc, ok := weatherCodes[*d.Code[i]]; ok {
				label, icon = wc[0], wc[1]
			}
		}
		days[i] = WeatherDay{
			Date: date, Condition: label, Icon: icon,
			HighC: at(d.Max, i), LowC: at(d.Min, i), PrecipitationMM: at(d.Precip, i), RainChancePct: at(d.RainChance, i),
		}
	}
	note := "Live forecast."
	if source != "forecast" {
		note = "Dates are outside the 16-day forecast window, so these are the actual conditions on the same dates last year (a typical-weather guide)."
	}
	return map[string]any{"source": source, "note": note, "days": days},
		map[string]any{"kind": "weather", "source": source, "note": note, "days": days}, nil
}

// ---------------------------------------------------------------------------
// OpenStreetMap Overpass: at most 2 concurrent requests (the public server's
// per-IP limit), retry the fast primary, then fall back to a slower mirror.
// ---------------------------------------------------------------------------

var overpassSlots = make(chan struct{}, 2)

type osmElement struct {
	Lat    *float64                    `json:"lat"`
	Lon    *float64                    `json:"lon"`
	Center *struct{ Lat, Lon float64 } `json:"center"`
	Tags   map[string]string           `json:"tags"`
}

func (e osmElement) coords() (float64, float64, bool) {
	if e.Lat != nil && e.Lon != nil {
		return *e.Lat, *e.Lon, true
	}
	if e.Center != nil {
		return e.Center.Lat, e.Center.Lon, true
	}
	return 0, 0, false
}

func overpass(ctx context.Context, query string) ([]osmElement, error) {
	select {
	case overpassSlots <- struct{}{}:
		defer func() { <-overpassSlots }()
	case <-ctx.Done():
		return nil, permanent("Cancelled.")
	}

	form := "data=" + url.QueryEscape(query)
	var data struct {
		Elements []osmElement `json:"elements"`
	}
	// Worst case ~45 s, inside the harness's 60 s tool timeout.
	for _, wait := range []time.Duration{0, 2 * time.Second} {
		if err := sleep(ctx, wait); err != nil {
			return nil, err
		}
		err := getJSON(ctx, request{method: "POST", url: overpassPrimary, form: form, timeout: 12 * time.Second}, &data)
		if err == nil {
			return data.Elements, nil
		}
		if !isRetryable(err) {
			return nil, err
		}
	}
	if err := getJSON(ctx, request{method: "POST", url: overpassFallback, form: form, timeout: 18 * time.Second}, &data); err != nil {
		if ctx.Err() != nil {
			return nil, permanent("Cancelled.")
		}
		// Already retried here, so tell the harness not to retry again.
		return nil, permanent("OpenStreetMap (Overpass) is overloaded right now. Try a smaller radius or skip this lookup.")
	}
	return data.Elements, nil
}

// ---------------------------------------------------------------------------
// find_attractions: OSM sights that have a Wikidata entry, ranked by how many
// people read their Wikipedia article in the last 30 days.
// ---------------------------------------------------------------------------

type AttractionsInput struct {
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	RadiusKM  *float64 `json:"radius_km,omitempty"`
}

type sightInfo struct {
	lat, lon float64
	kind     string
}

type Attraction struct {
	Name        string  `json:"name"`
	Type        string  `json:"type"`
	Description string  `json:"description"`
	Views       int     `json:"monthly_wikipedia_views"`
	Latitude    float64 `json:"latitude"`
	Longitude   float64 `json:"longitude"`
	Image       *string `json:"image,omitempty"`
	URL         string  `json:"url,omitempty"`
}

func findAttractions(ctx context.Context, in AttractionsInput) (any, any, error) {
	radius := 6.0
	if in.RadiusKM != nil {
		radius = clamp(*in.RadiusKM, 1, 15)
	}
	around := fmt.Sprintf("(around:%v,%v,%v)", radius*1000, in.Latitude, in.Longitude)
	elements, err := overpass(ctx, `[out:json][timeout:25];nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["wikidata"]`+around+`;out center tags 250;`)
	if err != nil {
		if ctx.Err() != nil {
			return nil, nil, err
		}
		// Overpass is a shared public server and is sometimes overloaded.
		return findAttractionsViaWikipedia(ctx, in)
	}

	// One entry per Wikidata item (a site is often mapped as several OSM objects).
	byQID := map[string]sightInfo{}
	var qids []string
	for _, el := range elements {
		qid := strings.Split(el.Tags["wikidata"], ";")[0]
		lat, lon, ok := el.coords()
		if qid == "" || !ok {
			continue
		}
		if _, seen := byQID[qid]; seen {
			continue
		}
		kind := el.Tags["tourism"]
		if kind == "attraction" {
			kind = firstNonEmpty(el.Tags["historic"], el.Tags["amenity"], kind)
		}
		byQID[qid] = sightInfo{lat, lon, strings.ReplaceAll(kind, "_", " ")}
		qids = append(qids, qid)
	}
	if len(qids) == 0 {
		return findAttractionsViaWikipedia(ctx, in)
	}

	// Wikidata item -> English Wikipedia title.
	type entities struct {
		Entities map[string]struct {
			Sitelinks map[string]struct{ Title string } `json:"sitelinks"`
		} `json:"entities"`
	}
	batches, err := parallel(chunk(qids, 50), func(ids []string) (entities, error) {
		var e entities
		err := getJSON(ctx, request{url: wikidataAPI + "?action=wbgetentities&props=sitelinks&sitefilter=enwiki&format=json&ids=" + strings.Join(ids, "|")}, &e)
		return e, err
	})
	if err != nil {
		return nil, nil, err
	}
	info := map[string]sightInfo{}
	var titles []string
	for _, b := range batches {
		for qid, ent := range b.Entities {
			if link, ok := ent.Sitelinks["enwiki"]; ok && link.Title != "" {
				info[link.Title] = byQID[qid]
				titles = append(titles, link.Title)
			}
		}
	}
	sort.Strings(titles) // deterministic batching
	return rankAndDescribe(ctx, titles, info)
}

// Fallback: Wikipedia's own geographic index, filtered and ranked the same way.
var notSights = regexp.MustCompile(`(?i)\b(station|railway|line|school|university|college|institute|ward|district|prefecture|interchange|expressway|constituency|municipality|county|metro|subway|company|hospital|federation|bank|embassy|police|academy|agency|authority|stock|list of|secondary)\b`)

func findAttractionsViaWikipedia(ctx context.Context, in AttractionsInput) (any, any, error) {
	var data struct {
		Query struct {
			Geosearch []struct {
				Title string  `json:"title"`
				Lat   float64 `json:"lat"`
				Lon   float64 `json:"lon"`
				Type  string  `json:"type"`
			} `json:"geosearch"`
		} `json:"query"`
	}
	u := fmt.Sprintf("%s/w/api.php?action=query&list=geosearch&gscoord=%v|%v&gsradius=10000&gslimit=300&gsprop=type&format=json&formatversion=2",
		wikipediaBase, in.Latitude, in.Longitude)
	if err := getJSON(ctx, request{url: u}, &data); err != nil {
		return nil, nil, err
	}
	info := map[string]sightInfo{}
	var titles []string
	for _, g := range data.Query.Geosearch {
		if g.Type == "landmark" && !notSights.MatchString(g.Title) {
			info[g.Title] = sightInfo{g.Lat, g.Lon, "sight"}
			titles = append(titles, g.Title)
		}
	}
	if len(titles) == 0 {
		return nil, nil, permanent("No notable sights found nearby.")
	}
	return rankAndDescribe(ctx, titles, info)
}

// Rank Wikipedia articles by 30-day page views; attach photo, blurb and location.
func rankAndDescribe(ctx context.Context, titles []string, info map[string]sightInfo) (any, any, error) {
	type pages struct {
		Query struct {
			Pages []struct {
				Title     string                   `json:"title"`
				Missing   bool                     `json:"missing"`
				Pageviews map[string]*int          `json:"pageviews"`
				Thumbnail *struct{ Source string } `json:"thumbnail"`
				Extract   string                   `json:"extract"`
			} `json:"pages"`
		} `json:"query"`
	}
	batches, err := parallel(chunk(titles, 50), func(batch []string) (pages, error) {
		var p pages
		u := wikipediaBase + "/w/api.php?action=query&prop=pageviews|pageimages&pvipdays=30&piprop=thumbnail&pithumbsize=480" +
			"&format=json&formatversion=2&titles=" + url.QueryEscape(strings.Join(batch, "|"))
		err := getJSON(ctx, request{url: u}, &p)
		return p, err
	})
	if err != nil {
		return nil, nil, err
	}

	var ranked []Attraction
	for _, b := range batches {
		for _, p := range b.Query.Pages {
			si, ok := info[p.Title]
			if p.Missing || !ok {
				continue
			}
			views := 0
			for _, v := range p.Pageviews {
				if v != nil {
					views += *v
				}
			}
			a := Attraction{Name: p.Title, Type: si.kind, Views: views, Latitude: si.lat, Longitude: si.lon, URL: wikiURL(p.Title)}
			if p.Thumbnail != nil {
				img := p.Thumbnail.Source
				a.Image = &img
			}
			ranked = append(ranked, a)
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Views > ranked[j].Views })
	if len(ranked) > 12 {
		ranked = ranked[:12]
	}

	// Short descriptions for the winners.
	if len(ranked) > 0 {
		names := make([]string, len(ranked))
		for i, r := range ranked {
			names[i] = r.Name
		}
		var ex pages
		u := wikipediaBase + "/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exsentences=2&exlimit=max" +
			"&format=json&formatversion=2&titles=" + url.QueryEscape(strings.Join(names, "|"))
		if err := getJSON(ctx, request{url: u}, &ex); err != nil {
			return nil, nil, err
		}
		blurbs := map[string]string{}
		for _, p := range ex.Query.Pages {
			blurbs[p.Title] = p.Extract
		}
		for i := range ranked {
			ranked[i].Description = blurbs[ranked[i].Name]
		}
	}

	// The model gets the compact version (no image or URL).
	compact := make([]Attraction, len(ranked))
	for i, r := range ranked {
		compact[i] = r
		compact[i].Image, compact[i].URL = nil, ""
	}
	return map[string]any{"count": len(ranked), "attractions": compact},
		map[string]any{"kind": "attractions", "items": ranked}, nil
}

// ---------------------------------------------------------------------------
// find_places: restaurants, cafes, hotels… from OpenStreetMap
// ---------------------------------------------------------------------------

var placeCategories = map[string]string{
	"restaurant": `["amenity"="restaurant"]`,
	"cafe":       `["amenity"="cafe"]`,
	"bar":        `["amenity"~"^(bar|pub)$"]`,
	"hotel":      `["tourism"~"^(hotel|hostel|guest_house)$"]`,
	"museum":     `["tourism"="museum"]`,
	"park":       `["leisure"="park"]`,
	"viewpoint":  `["tourism"="viewpoint"]`,
	"shopping":   `["shop"~"^(mall|department_store|gift|souvenir)$"]`,
}

// Keep the enum order stable and identical to the Node server.
var categoryNames = []string{"restaurant", "cafe", "bar", "hotel", "museum", "park", "viewpoint", "shopping"}

type PlacesInput struct {
	Latitude  float64  `json:"latitude"`
	Longitude float64  `json:"longitude"`
	Category  string   `json:"category"`
	RadiusM   *float64 `json:"radius_m,omitempty"`
}

type PlaceResult struct {
	Name         string  `json:"name"`
	Category     string  `json:"category"`
	Cuisine      *string `json:"cuisine"`
	OpeningHours *string `json:"opening_hours"`
	Website      *string `json:"website"`
	Stars        *string `json:"stars"`
	Address      *string `json:"address"`
	Latitude     float64 `json:"latitude"`
	Longitude    float64 `json:"longitude"`
	richness     int
}

func findPlaces(ctx context.Context, in PlacesInput) (any, any, error) {
	filter, ok := placeCategories[in.Category]
	if !ok {
		return nil, nil, permanent("Unknown category %q.", in.Category)
	}
	radius := 1500.0
	if in.RadiusM != nil {
		radius = clamp(*in.RadiusM, 300, 5000)
	}
	query := fmt.Sprintf(`[out:json][timeout:20];nwr%s["name"](around:%v,%v,%v);out center tags 80;`, filter, radius, in.Latitude, in.Longitude)
	elements, err := overpass(ctx, query)
	if err != nil {
		return nil, nil, err
	}

	var items []PlaceResult
	for _, el := range elements {
		t := el.Tags
		lat, lon, ok := el.coords()
		name := firstNonEmpty(t["name:en"], t["name"])
		if name == "" || !ok {
			continue
		}
		p := PlaceResult{
			Name: name, Category: in.Category, Latitude: lat, Longitude: lon,
			OpeningHours: strPtr(t["opening_hours"]),
			Website:      strPtr(firstNonEmpty(t["website"], t["contact:website"])),
			Stars:        strPtr(t["stars"]),
			Address:      strPtr(strings.TrimSpace(t["addr:housenumber"] + " " + t["addr:street"])),
		}
		if c := t["cuisine"]; c != "" {
			p.Cuisine = strPtr(strings.ReplaceAll(strings.ReplaceAll(c, ";", ", "), "_", " "))
		}
		// Well-documented places (cuisine, hours, website…) tend to be established ones.
		for _, k := range []string{"cuisine", "opening_hours", "website", "stars", "phone", "wikidata"} {
			if t[k] != "" {
				p.richness++
			}
		}
		items = append(items, p)
	}
	sort.SliceStable(items, func(i, j int) bool { return items[i].richness > items[j].richness })
	if len(items) > 15 {
		items = items[:15]
	}
	if len(items) == 0 {
		return nil, nil, permanent("No %s found within %v m. Try a larger radius_m.", in.Category, radius)
	}
	result := map[string]any{"category": in.Category, "count": len(items), "places": items}
	return result, map[string]any{"kind": "places", "category": in.Category, "items": items}, nil
}

// ---------------------------------------------------------------------------
// get_exchange_rate: Frankfurter (European Central Bank reference rates)
// ---------------------------------------------------------------------------

type ExchangeInput struct {
	From   string   `json:"from"`
	To     string   `json:"to"`
	Amount *float64 `json:"amount,omitempty"`
}

func getExchangeRate(ctx context.Context, in ExchangeInput) (any, any, error) {
	from, to := strings.ToUpper(in.From), strings.ToUpper(in.To)
	amount := 1.0
	if in.Amount != nil {
		amount = *in.Amount
	}
	if from == to {
		return map[string]any{"from": from, "to": to, "rate": 1, "amount": amount, "converted": amount},
			map[string]any{"kind": "currency", "from": from, "to": to, "rate": 1, "amount": amount, "date": nil}, nil
	}
	var data struct {
		Date  string             `json:"date"`
		Rates map[string]float64 `json:"rates"`
	}
	u := fmt.Sprintf("%s?from=%s&to=%s", frankfurterURL, url.QueryEscape(from), url.QueryEscape(to))
	if err := getJSON(ctx, request{url: u}, &data); err != nil {
		if isRetryable(err) {
			return nil, nil, err
		}
		return nil, nil, permanent("No rate for %s → %s. Only ~30 major currencies are supported.", from, to)
	}
	rate, ok := data.Rates[to]
	if !ok {
		return nil, nil, permanent("No rate for %s → %s. Only ~30 major currencies are supported.", from, to)
	}
	converted := math.Round(amount*rate*100) / 100
	return map[string]any{"from": from, "to": to, "rate": rate, "amount": amount, "converted": converted, "date": data.Date},
		map[string]any{"kind": "currency", "from": from, "to": to, "rate": rate, "amount": amount, "date": data.Date}, nil
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func clamp(v, lo, hi float64) float64 { return math.Min(math.Max(v, lo), hi) }

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func wikiURL(title string) string {
	return "https://en.wikipedia.org/wiki/" + url.PathEscape(strings.ReplaceAll(title, " ", "_"))
}

func chunk[T any](xs []T, size int) [][]T {
	var out [][]T
	for size < len(xs) {
		xs, out = xs[size:], append(out, xs[:size])
	}
	if len(xs) > 0 {
		out = append(out, xs)
	}
	return out
}

// parallel runs fn on every input concurrently and returns results in order,
// or the first error.
func parallel[In, Out any](inputs []In, fn func(In) (Out, error)) ([]Out, error) {
	results := make([]Out, len(inputs))
	errs := make([]error, len(inputs))
	var wg sync.WaitGroup
	for i, in := range inputs {
		wg.Go(func() { results[i], errs[i] = fn(in) })
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}

// ---------------------------------------------------------------------------
// compare_routes: walking, cycling and driving (OSRM on routing.openstreetmap.de)
// and public transit (Transitous), with a recommended mode.
// ---------------------------------------------------------------------------

var (
	osrmBase      = "https://routing.openstreetmap.de"
	transitousURL = "https://api.transitous.org/api/v1/plan"
)

var routeModes = []string{"walk", "bike", "drive", "transit"}

var osrmProfiles = map[string]string{"walk": "foot", "bike": "bike", "drive": "car"}

// Beyond these straight-line distances a mode is pointless (and slow to compute).
var maxKM = map[string]float64{"walk": 25, "bike": 60, "drive": 1500, "transit": 1500}

var transitNames = map[string]string{
	"SUBWAY": "Metro", "METRO": "Metro", "BUS": "Bus", "COACH": "Coach", "TRAM": "Tram", "FERRY": "Ferry", "FUNICULAR": "Funicular",
	"RAIL": "Train", "REGIONAL_RAIL": "Train", "REGIONAL_FAST_RAIL": "Train", "HIGHSPEED_RAIL": "High-speed train",
	"LONG_DISTANCE": "Train", "NIGHT_RAIL": "Night train", "SUBURBAN": "Suburban train", "CABLE_CAR": "Cable car", "AERIAL_LIFT": "Cable car",
}

type RoutesInput struct {
	FromLatitude  float64  `json:"from_latitude"`
	FromLongitude float64  `json:"from_longitude"`
	ToLatitude    float64  `json:"to_latitude"`
	ToLongitude   float64  `json:"to_longitude"`
	FromName      *string  `json:"from_name,omitempty"`
	ToName        *string  `json:"to_name,omitempty"`
	Modes         []string `json:"modes,omitempty"`
}

type RoutePoint struct {
	Name      string  `json:"name"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type RouteOption struct {
	Mode        string       `json:"mode"`
	Minutes     *int         `json:"minutes"` // null when the mode isn't possible
	KM          *float64     `json:"km,omitempty"`
	Geometry    [][2]float64 `json:"geometry,omitempty"` // [lat, lon] pairs, UI only
	Transfers   *int         `json:"transfers,omitempty"`
	WalkMinutes *int         `json:"walk_minutes,omitempty"`
	Lines       []string     `json:"lines,omitempty"`
	Error       string       `json:"error,omitempty"`
	Note        string       `json:"note,omitempty"`
}

type Recommendation struct {
	Mode   *string `json:"mode"`
	Reason string  `json:"reason"`
}

func haversineKM(lat1, lon1, lat2, lon2 float64) float64 {
	rad := func(d float64) float64 { return d * math.Pi / 180 }
	a := math.Pow(math.Sin(rad(lat2-lat1)/2), 2) + math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Pow(math.Sin(rad(lon2-lon1)/2), 2)
	return 6371 * 2 * math.Asin(math.Sqrt(a))
}

func minutesOf(seconds float64) *int { return ptr(int(math.Round(seconds / 60))) }

func osrmRoute(ctx context.Context, mode string, from, to RoutePoint) (RouteOption, error) {
	u := fmt.Sprintf("%s/routed-%s/route/v1/driving/%v,%v;%v,%v?overview=simplified&geometries=geojson",
		osrmBase, osrmProfiles[mode], from.Longitude, from.Latitude, to.Longitude, to.Latitude)
	var data struct {
		Code   string `json:"code"`
		Routes []struct {
			Duration float64 `json:"duration"`
			Distance float64 `json:"distance"`
			Geometry struct {
				Coordinates [][2]float64 `json:"coordinates"`
			} `json:"geometry"`
		} `json:"routes"`
	}
	if err := getJSON(ctx, request{url: u}, &data); err != nil {
		return RouteOption{}, err
	}
	if data.Code != "Ok" || len(data.Routes) == 0 {
		return RouteOption{}, permanent("No %s route found.", mode)
	}
	r := data.Routes[0]
	geometry := make([][2]float64, len(r.Geometry.Coordinates))
	for i, c := range r.Geometry.Coordinates {
		geometry[i] = [2]float64{c[1], c[0]} // [lon, lat] -> [lat, lon] for the map
	}
	return RouteOption{Mode: mode, Minutes: minutesOf(r.Duration), KM: ptr(math.Round(r.Distance/100) / 10), Geometry: geometry}, nil
}

func transitRoute(ctx context.Context, from, to RoutePoint) (RouteOption, error) {
	u := fmt.Sprintf("%s?fromPlace=%v,%v&toPlace=%v,%v&numItineraries=3", transitousURL, from.Latitude, from.Longitude, to.Latitude, to.Longitude)
	type leg struct {
		Mode           string  `json:"mode"`
		Duration       float64 `json:"duration"`
		RouteShortName *string `json:"routeShortName"`
		Headsign       *string `json:"headsign"`
	}
	var data struct {
		Itineraries []struct {
			Duration  float64 `json:"duration"`
			Transfers *int    `json:"transfers"`
			Legs      []leg   `json:"legs"`
		} `json:"itineraries"`
	}
	if err := getJSON(ctx, request{url: u, timeout: 20 * time.Second}, &data); err != nil {
		return RouteOption{}, err
	}
	best := -1
	for i, it := range data.Itineraries {
		usable := false
		for _, l := range it.Legs {
			usable = usable || l.Mode != "WALK"
		}
		if usable && (best < 0 || it.Duration < data.Itineraries[best].Duration) {
			best = i
		}
	}
	if best < 0 {
		return RouteOption{}, permanent("No public transit connection found.")
	}
	it := data.Itineraries[best]
	var lines []string
	walkSeconds := 0.0
	for _, l := range it.Legs {
		if l.Mode == "WALK" {
			walkSeconds += l.Duration
			continue
		}
		name, ok := transitNames[l.Mode]
		if !ok {
			name = l.Mode[:1] + strings.ToLower(l.Mode[1:])
		}
		label := ""
		if l.RouteShortName != nil {
			label = *l.RouteShortName
		} else if l.Headsign != nil {
			label = *l.Headsign
		}
		lines = append(lines, strings.TrimSpace(name+" "+label))
	}
	transfers := it.Transfers
	if transfers == nil {
		transfers = ptr(max(0, len(lines)-1))
	}
	return RouteOption{Mode: "transit", Minutes: minutesOf(it.Duration), Transfers: transfers, WalkMinutes: minutesOf(walkSeconds), Lines: lines}, nil
}

// recommendMode is a simple, explainable rule the agent can accept or override.
func recommendMode(options []RouteOption) Recommendation {
	by := map[string]RouteOption{}
	for _, o := range options {
		if o.Minutes != nil {
			by[o.Mode] = o
		}
	}
	walk, hasWalk := by["walk"]
	transit, hasTransit := by["transit"]
	drive, hasDrive := by["drive"]
	bike, hasBike := by["bike"]
	switch {
	case hasWalk && *walk.Minutes <= 30:
		return Recommendation{ptr("walk"), fmt.Sprintf("It's a short walk (%d min).", *walk.Minutes)}
	// Transit wins unless it's much slower: driving time ignores traffic and parking.
	case hasTransit && (!hasDrive || float64(*transit.Minutes) <= math.Max(float64(*drive.Minutes)*2, float64(*drive.Minutes)+25)):
		return Recommendation{ptr("transit"), fmt.Sprintf("Public transit takes %d min (%s), no parking needed.", *transit.Minutes, strings.Join(transit.Lines, " → "))}
	case hasDrive:
		return Recommendation{ptr("drive"), fmt.Sprintf("Driving or a taxi takes %d min, much faster than the alternatives.", *drive.Minutes)}
	case hasBike:
		return Recommendation{ptr("bike"), fmt.Sprintf("Cycling takes %d min.", *bike.Minutes)}
	}
	return Recommendation{nil, "No route found for any mode."}
}

func compareRoutes(ctx context.Context, in RoutesInput) (any, any, error) {
	from := RoutePoint{"Start", in.FromLatitude, in.FromLongitude}
	to := RoutePoint{"Destination", in.ToLatitude, in.ToLongitude}
	if in.FromName != nil {
		from.Name = *in.FromName
	}
	if in.ToName != nil {
		to.Name = *in.ToName
	}
	straightKM := math.Round(haversineKM(from.Latitude, from.Longitude, to.Latitude, to.Longitude)*10) / 10

	var wanted []string
	for _, m := range routeModes {
		if len(in.Modes) == 0 || slices.Contains(in.Modes, m) {
			wanted = append(wanted, m)
		}
	}
	options, _ := parallel(wanted, func(mode string) (RouteOption, error) {
		if straightKM > maxKM[mode] {
			verb := mode
			if mode == "bike" {
				verb = "cycle"
			}
			return RouteOption{Mode: mode, Error: fmt.Sprintf("Too far to %s.", verb)}, nil
		}
		var opt RouteOption
		var err error
		if mode == "transit" {
			opt, err = transitRoute(ctx, from, to)
		} else {
			opt, err = osrmRoute(ctx, mode, from, to)
		}
		if err != nil {
			return RouteOption{Mode: mode, Error: err.Error()}, nil
		}
		return opt, nil
	})
	if ctx.Err() != nil {
		return nil, nil, permanent("Cancelled.")
	}
	found := false
	for _, o := range options {
		found = found || o.Minutes != nil
	}
	if !found {
		return nil, nil, &ToolError{Msg: fmt.Sprintf("No routes found between %s and %s.", from.Name, to.Name), Retryable: true}
	}

	recommended := recommendMode(options)
	compact := make([]RouteOption, len(options))
	for i, o := range options {
		compact[i] = o
		compact[i].Geometry = nil
		if o.Mode == "drive" && o.Minutes != nil {
			compact[i].Note = "Driving time excludes traffic and parking."
		}
	}
	result := map[string]any{"from": from.Name, "to": to.Name, "straight_line_km": straightKM, "options": compact, "recommended": recommended}
	ui := map[string]any{"kind": "routes", "from": from, "to": to, "straight_line_km": straightKM, "options": options, "recommended": recommended}
	return result, ui, nil
}
