// Command wanderly-mcp is the Go version of Wanderly's travel-tools MCP server.
//
// It exposes the same seven tools, schemas and result format as the Node server
// (src/mcp/server.js), so the ReAct harness can use either one:
//
//	MCP_SERVER=go npm start
//
// Each tool result has:
//
//	content[0].text -> the JSON observation the model reads
//	_meta.ui        -> extra data for the web UI (images, map pins); other MCP clients ignore it
//	_meta.retryable -> on errors, whether trying again might help (used by the harness)
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	// stdout carries the MCP protocol, so log to stderr only.
	log.SetOutput(os.Stderr)
	log.SetFlags(0)
	log.Println("travel-tools MCP server (Go) running on stdio")
	if err := newServer().Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatal(err)
	}
}

func newServer() *mcp.Server {
	s := mcp.NewServer(&mcp.Implementation{Name: "travel-tools", Version: "1.0.0"}, nil)

	register(s, "search_destination", "Search destination",
		"Look up a city or place by name. Returns coordinates, country, ISO country code and timezone, plus other "+
			"places with the same name. Call this first: the other tools need latitude/longitude.",
		object([]string{"query"}, props{
			"query": str("Place name, e.g. 'Kyoto' or 'Porto, Portugal'", 1, 0, ""),
		}),
		searchDestination)

	register(s, "get_travel_guide", "Travel guide",
		"Full travel-guide article for a destination from Wikivoyage (falls back to Wikipedia): districts, getting "+
			"in and around, sights, food, nightlife, safety. Use it to ground recommendations in real local knowledge.",
		object([]string{"place"}, props{
			"place": str("Article title, usually just the city name, e.g. 'Kyoto'", 1, 0, ""),
		}),
		getTravelGuide)

	register(s, "get_weather", "Weather",
		"Daily weather: condition, high/low °C, precipitation. For dates in the next 16 days this is a live forecast; "+
			"further out it returns the actual weather on the same dates last year as a typical-weather guide. "+
			"Omit dates for the next 7 days.",
		object([]string{"latitude", "longitude"}, props{
			"latitude":   num("Latitude from search_destination", -90, 90),
			"longitude":  num("Longitude from search_destination", -180, 180),
			"start_date": str("YYYY-MM-DD", 0, 0, `^\d{4}-\d{2}-\d{2}$`),
			"end_date":   str("YYYY-MM-DD, at most 16 days after start_date", 0, 0, `^\d{4}-\d{2}-\d{2}$`),
		}),
		getWeather)

	register(s, "find_attractions", "Find attractions",
		"Top sights near a point (museums, temples, castles, viewpoints, landmarks), ranked by how many people read "+
			"about them on Wikipedia last month. Returns name, type, short description and coordinates.",
		object([]string{"latitude", "longitude"}, props{
			"latitude":  num("Latitude from search_destination", -90, 90),
			"longitude": num("Longitude from search_destination", -180, 180),
			"radius_km": num("Search radius in km (default 6)", 1, 15),
		}),
		findAttractions)

	categories := make([]any, len(categoryNames))
	for i, c := range categoryNames {
		categories[i] = c
	}
	register(s, "find_places", "Find places",
		"Named places of one category near a point, from OpenStreetMap: cuisine, opening hours, website and address "+
			"when known. No prices or ratings. Use for restaurant, cafe, bar or hotel suggestions.",
		object([]string{"latitude", "longitude", "category"}, props{
			"latitude":  num("Latitude from search_destination", -90, 90),
			"longitude": num("Longitude from search_destination", -180, 180),
			"category":  {Type: "string", Enum: categories},
			"radius_m":  num("Search radius in meters (default 1500)", 300, 5000),
		}),
		findPlaces)

	register(s, "get_exchange_rate", "Exchange rate",
		"Convert money using today's European Central Bank reference rates. ISO 4217 codes (USD, EUR, JPY…); "+
			"about 30 major currencies are supported.",
		object([]string{"from", "to"}, props{
			"from":   str("ISO currency code, e.g. USD", 3, 3, ""),
			"to":     str("ISO currency code, e.g. JPY", 3, 3, ""),
			"amount": {Type: "number", Description: "Amount to convert (default 1)", ExclusiveMinimum: ptr(0.0)},
		}),
		getExchangeRate)

	modes := make([]any, len(routeModes))
	for i, m := range routeModes {
		modes[i] = m
	}
	register(s, "compare_routes", "Compare routes",
		"How to get between two points: travel time by walking, cycling, driving (OpenStreetMap routing) and public "+
			"transit with real line names (Transitous), plus a recommended mode. Use it to suggest how to get around each "+
			"day, between neighborhoods or sights, and between cities.",
		object([]string{"from_latitude", "from_longitude", "to_latitude", "to_longitude"}, props{
			"from_latitude":  num("Latitude from search_destination", -90, 90),
			"from_longitude": num("Longitude from search_destination", -180, 180),
			"to_latitude":    num("Latitude from search_destination", -90, 90),
			"to_longitude":   num("Longitude from search_destination", -180, 180),
			"from_name":      str("Label for the start, e.g. 'Hotel' or 'Colosseum'", 0, 0, ""),
			"to_name":        str("Label for the destination", 0, 0, ""),
			"modes": {Type: "array", Description: "Modes to compare (default: all)",
				Items: &jsonschema.Schema{Type: "string", Enum: modes}},
		}),
		compareRoutes)

	// A reusable prompt so MCP clients like Claude Desktop get a one-click "plan a trip".
	s.AddPrompt(&mcp.Prompt{
		Name:        "plan_trip",
		Title:       "Plan a trip",
		Description: "Plan a day-by-day trip using the travel tools",
		Arguments: []*mcp.PromptArgument{
			{Name: "destination", Description: "Where to go", Required: true},
			{Name: "days", Description: "How many days"},
			{Name: "interests", Description: "e.g. food, history, hiking"},
		},
	}, planTripPrompt)

	return s
}

// register adds a read-only tool whose handler returns (result, ui, error)
// and wraps it in the shared result format.
func register[In any](s *mcp.Server, name, title, description string, schema *jsonschema.Schema,
	fn func(context.Context, In) (any, any, error)) {
	tool := &mcp.Tool{
		Name:        name,
		Title:       title,
		Description: description,
		InputSchema: schema, // the SDK validates arguments against this before calling fn
		Annotations: &mcp.ToolAnnotations{Title: title, ReadOnlyHint: true, OpenWorldHint: ptr(true)},
	}
	mcp.AddTool(s, tool, func(ctx context.Context, _ *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		result, ui, err := fn(ctx, in)
		if err != nil {
			var te *ToolError
			retryable := errors.As(err, &te) && te.Retryable
			return &mcp.CallToolResult{
				IsError: true,
				Content: []mcp.Content{&mcp.TextContent{Text: "Error: " + err.Error()}},
				Meta:    mcp.Meta{"retryable": retryable},
			}, nil, nil
		}
		text, err := json.Marshal(result)
		if err != nil {
			return nil, nil, fmt.Errorf("encoding result: %w", err)
		}
		return &mcp.CallToolResult{
			Content: []mcp.Content{&mcp.TextContent{Text: string(text)}},
			Meta:    mcp.Meta{"ui": ui},
		}, nil, nil
	})
}

func planTripPrompt(_ context.Context, req *mcp.GetPromptRequest) (*mcp.GetPromptResult, error) {
	args := req.Params.Arguments
	days := args["days"]
	if days == "" {
		days = "3"
	}
	focus := ""
	if args["interests"] != "" {
		focus = " focused on " + args["interests"]
	}
	text := fmt.Sprintf("Plan a %s-day trip to %s%s. Use the travel tools to check the weather, top sights and "+
		"places to eat, then give me a day-by-day itinerary.", days, args["destination"], focus)
	return &mcp.GetPromptResult{
		Description: "Plan a day-by-day trip",
		Messages:    []*mcp.PromptMessage{{Role: "user", Content: &mcp.TextContent{Text: text}}},
	}, nil
}

// ---- tiny JSON Schema builders ----

type props = map[string]*jsonschema.Schema

func object(required []string, properties props) *jsonschema.Schema {
	return &jsonschema.Schema{Type: "object", Properties: properties, Required: required}
}

func num(description string, min, max float64) *jsonschema.Schema {
	return &jsonschema.Schema{Type: "number", Description: description, Minimum: &min, Maximum: &max}
}

func str(description string, minLen, maxLen int, pattern string) *jsonschema.Schema {
	s := &jsonschema.Schema{Type: "string", Description: description, Pattern: pattern}
	if minLen > 0 {
		s.MinLength = &minLen
	}
	if maxLen > 0 {
		s.MaxLength = &maxLen
	}
	return s
}

func ptr[T any](v T) *T { return &v }
