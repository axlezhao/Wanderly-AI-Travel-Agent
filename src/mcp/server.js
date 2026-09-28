#!/usr/bin/env node
// MCP server that exposes the travel tools over stdio.
//
// Our web app's agent talks to it through an MCP client (src/harness/toolbox.js),
// and you can also plug it into Claude Desktop or Claude Code: see README.md.
//
// Each tool result has:
//   content[0].text -> the JSON observation the model reads
//   _meta.ui        -> extra data for the web UI (images, map pins); other MCP clients ignore it
//   _meta.retryable -> on errors, whether trying again might help (used by the harness)

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchDestination,
  getTravelGuide,
  getWeather,
  findAttractions,
  findPlaces,
  getExchangeRate,
  PLACE_CATEGORIES,
} from "../tools/travel-apis.js";

const server = new McpServer({ name: "travel-tools", version: "1.0.0" });

// Every tool only reads public web data.
const annotations = { readOnlyHint: true, openWorldHint: true };
const lat = z.number().min(-90).max(90).describe("Latitude from search_destination");
const lon = z.number().min(-180).max(180).describe("Longitude from search_destination");

function register(name, config, fn) {
  server.registerTool(name, { ...config, annotations: { title: config.title, ...annotations } }, async (input, extra) => {
    try {
      // extra.signal fires if the client cancels (timeout, user pressed Stop), aborting in-flight HTTP calls.
      const { result, ui } = await fn(input, { signal: extra.signal });
      return { content: [{ type: "text", text: JSON.stringify(result) }], _meta: { ui } };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${err.message}` }],
        _meta: { retryable: Boolean(err.retryable) },
      };
    }
  });
}

register(
  "search_destination",
  {
    title: "Search destination",
    description:
      "Look up a city or place by name. Returns coordinates, country, ISO country code and timezone, plus other " +
      "places with the same name. Call this first: the other tools need latitude/longitude.",
    inputSchema: { query: z.string().min(1).describe("Place name, e.g. 'Kyoto' or 'Porto, Portugal'") },
  },
  searchDestination,
);

register(
  "get_travel_guide",
  {
    title: "Travel guide",
    description:
      "Full travel-guide article for a destination from Wikivoyage (falls back to Wikipedia): districts, getting " +
      "in and around, sights, food, nightlife, safety. Use it to ground recommendations in real local knowledge.",
    inputSchema: { place: z.string().min(1).describe("Article title, usually just the city name, e.g. 'Kyoto'") },
  },
  getTravelGuide,
);

register(
  "get_weather",
  {
    title: "Weather",
    description:
      "Daily weather: condition, high/low °C, precipitation. For dates in the next 16 days this is a live forecast; " +
      "further out it returns the actual weather on the same dates last year as a typical-weather guide. " +
      "Omit dates for the next 7 days.",
    inputSchema: {
      latitude: lat,
      longitude: lon,
      start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD"),
      end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, at most 16 days after start_date"),
    },
  },
  getWeather,
);

register(
  "find_attractions",
  {
    title: "Find attractions",
    description:
      "Top sights near a point (museums, temples, castles, viewpoints, landmarks), ranked by how many people read " +
      "about them on Wikipedia last month. Returns name, type, short description and coordinates.",
    inputSchema: {
      latitude: lat,
      longitude: lon,
      radius_km: z.number().min(1).max(15).optional().describe("Search radius in km (default 6)"),
    },
  },
  findAttractions,
);

register(
  "find_places",
  {
    title: "Find places",
    description:
      "Named places of one category near a point, from OpenStreetMap: cuisine, opening hours, website and address " +
      "when known. No prices or ratings. Use for restaurant, cafe, bar or hotel suggestions.",
    inputSchema: {
      latitude: lat,
      longitude: lon,
      category: z.enum(Object.keys(PLACE_CATEGORIES)),
      radius_m: z.number().min(300).max(5000).optional().describe("Search radius in meters (default 1500)"),
    },
  },
  findPlaces,
);

register(
  "get_exchange_rate",
  {
    title: "Exchange rate",
    description:
      "Convert money using today's European Central Bank reference rates. ISO 4217 codes (USD, EUR, JPY…); " +
      "about 30 major currencies are supported.",
    inputSchema: {
      from: z.string().length(3).describe("ISO currency code, e.g. USD"),
      to: z.string().length(3).describe("ISO currency code, e.g. JPY"),
      amount: z.number().positive().optional().describe("Amount to convert (default 1)"),
    },
  },
  getExchangeRate,
);

// A reusable prompt so MCP clients like Claude Desktop get a one-click "plan a trip".
server.registerPrompt(
  "plan_trip",
  {
    title: "Plan a trip",
    description: "Plan a day-by-day trip using the travel tools",
    argsSchema: {
      destination: z.string().describe("Where to go"),
      days: z.string().optional().describe("How many days"),
      interests: z.string().optional().describe("e.g. food, history, hiking"),
    },
  },
  ({ destination, days, interests }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Plan a ${days ?? "3"}-day trip to ${destination}${interests ? ` focused on ${interests}` : ""}. ` +
            "Use the travel tools to check the weather, top sights and places to eat, then give me a day-by-day itinerary.",
        },
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol, so log to stderr only.
console.error("travel-tools MCP server running on stdio");
