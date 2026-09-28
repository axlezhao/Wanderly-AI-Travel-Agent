// Travel data from free, no-API-key services. This module knows nothing about
// MCP or LLMs; src/mcp/server.js exposes these functions as MCP tools.
//
// Every function returns { result, ui }:
//   result -> compact JSON for the agent to reason over (the "Observation")
//   ui     -> richer data the browser uses to draw the map and trip panel
// and throws ToolError on failure (retryable=true for transient network errors).

const USER_AGENT = "Wanderly/1.0 (https://github.com/axlezhao/Wanderly-AI-Travel-Agent)";

export class ToolError extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

// Small in-memory response cache shared by all sessions: free APIs appreciate
// not being asked the same question twice, and repeat trips load instantly.
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 300;
const responseCache = new Map();

async function getJSON(url, options = {}) {
  const key = `${options.method ?? "GET"} ${url} ${options.body ?? ""}`;
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  const data = await fetchJSON(url, options);
  responseCache.set(key, { at: Date.now(), data });
  if (responseCache.size > CACHE_MAX) responseCache.delete(responseCache.keys().next().value);
  return data;
}

async function fetchJSON(url, { timeoutMs = 15000, signal, ...options } = {}) {
  const host = new URL(url).hostname;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...options.headers },
      // Stop on our own timeout, or when the caller cancels (MCP request cancelled).
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (signal?.aborted) throw new ToolError("Cancelled.");
    throw new ToolError(`${host} unreachable (${err.name === "TimeoutError" ? "timed out" : err.message})`, { retryable: true });
  }
  if (!res.ok) {
    throw new ToolError(`${host} responded ${res.status}`, { retryable: res.status === 429 || res.status >= 500 });
  }
  return res.json();
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
const chunk = (arr, size) => Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));
const wikiUrl = (title) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

// ---------------------------------------------------------------------------
// search_destination: Open-Meteo Geocoding
// ---------------------------------------------------------------------------
export async function searchDestination({ query }, { signal } = {}) {
  const data = await getJSON(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`,
    { signal },
  );
  const matches = (data.results ?? []).map((r) => ({
    name: r.name,
    region: r.admin1 ?? null,
    country: r.country ?? null,
    country_code: r.country_code ?? null,
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone ?? null,
    population: r.population ?? null,
  }));
  if (matches.length === 0) throw new ToolError(`No place found matching "${query}". Try a simpler name, e.g. just the city.`);
  return {
    result: { best_match: matches[0], other_matches: matches.slice(1) },
    ui: { kind: "destination", place: matches[0] },
  };
}

// ---------------------------------------------------------------------------
// get_travel_guide: Wikivoyage, falling back to Wikipedia
// ---------------------------------------------------------------------------
export async function getTravelGuide({ place }, { signal } = {}) {
  const title = encodeURIComponent(place.replace(/ /g, "_"));
  let lastError;
  for (const site of ["en.wikivoyage.org", "en.wikipedia.org"]) {
    try {
      const summary = await getJSON(`https://${site}/api/rest_v1/page/summary/${title}?redirect=true`, { signal });
      if (summary.type === "disambiguation") continue;
      const full = await getJSON(
        `https://${site}/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&formatversion=2&titles=${title}`,
        { signal },
      );
      let text = full?.query?.pages?.[0]?.extract ?? summary.extract ?? "";
      // Long articles would crowd out everything else in the agent's context.
      if (text.length > 9000) text = text.slice(0, 9000) + "\n…(article continues)";
      return {
        result: { source: site, title: summary.title, summary: summary.extract, guide_text: text },
        ui: {
          kind: "guide",
          title: summary.title,
          summary: summary.extract,
          image: summary.thumbnail?.source ?? summary.originalimage?.source ?? null,
          url: summary.content_urls?.desktop?.page ?? `https://${site}/wiki/${title}`,
          source: site.includes("voyage") ? "Wikivoyage" : "Wikipedia",
        },
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new ToolError(`No travel guide found for "${place}".`, { retryable: lastError?.retryable ?? false });
}

// ---------------------------------------------------------------------------
// get_weather: Open-Meteo forecast, or last year's actuals for far-off dates
// ---------------------------------------------------------------------------
const WEATHER_CODES = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤️"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"], 48: ["Fog", "🌫️"], 51: ["Light drizzle", "🌦️"], 53: ["Drizzle", "🌦️"],
  55: ["Heavy drizzle", "🌧️"], 61: ["Light rain", "🌦️"], 63: ["Rain", "🌧️"], 65: ["Heavy rain", "🌧️"],
  66: ["Freezing rain", "🌧️"], 67: ["Freezing rain", "🌧️"], 71: ["Light snow", "🌨️"], 73: ["Snow", "🌨️"],
  75: ["Heavy snow", "❄️"], 77: ["Snow grains", "🌨️"], 80: ["Showers", "🌦️"], 81: ["Showers", "🌧️"],
  82: ["Violent showers", "⛈️"], 85: ["Snow showers", "🌨️"], 86: ["Snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"], 96: ["Thunderstorm + hail", "⛈️"], 99: ["Thunderstorm + hail", "⛈️"],
};
const isoDate = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const minusYear = (d) => { const c = new Date(d); c.setUTCFullYear(c.getUTCFullYear() - 1); return c; };

export async function getWeather({ latitude, longitude, start_date, end_date }, { signal } = {}) {
  const today = new Date(isoDate(new Date()));
  const start = start_date ? new Date(start_date) : today;
  if (Number.isNaN(start.getTime())) throw new ToolError(`Invalid start_date "${start_date}", expected YYYY-MM-DD.`);
  let end = end_date ? new Date(end_date) : addDays(start, 6);
  if (Number.isNaN(end.getTime()) || end < start) end = addDays(start, 6);
  if ((end - start) / 86400000 > 15) end = addDays(start, 15);

  const daily = "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum";
  let source, url;
  if (start >= today && end <= addDays(today, 15)) {
    source = "forecast";
    url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&daily=${daily},precipitation_probability_max&timezone=auto&start_date=${isoDate(start)}&end_date=${isoDate(end)}`;
  } else {
    // Beyond the forecast window: use what actually happened on those dates last year.
    source = "same_dates_last_year";
    let s = minusYear(start), e = minusYear(end);
    while (e >= today) { s = minusYear(s); e = minusYear(e); }
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${latitude}&longitude=${longitude}&daily=${daily}&timezone=auto&start_date=${isoDate(s)}&end_date=${isoDate(e)}`;
  }

  const d = (await getJSON(url, { signal })).daily;
  const days = d.time.map((date, i) => {
    const [condition, icon] = WEATHER_CODES[d.weather_code[i]] ?? ["Unknown", "🌡️"];
    return {
      date,
      condition,
      icon,
      high_c: d.temperature_2m_max[i],
      low_c: d.temperature_2m_min[i],
      precipitation_mm: d.precipitation_sum[i],
      rain_chance_pct: d.precipitation_probability_max?.[i] ?? null,
    };
  });
  const note = source === "forecast"
    ? "Live forecast."
    : "Dates are outside the 16-day forecast window, so these are the actual conditions on the same dates last year (a typical-weather guide).";
  return { result: { source, note, days }, ui: { kind: "weather", source, note, days } };
}

// ---------------------------------------------------------------------------
// OpenStreetMap Overpass helper (two public mirrors)
// ---------------------------------------------------------------------------
// overpass-api.de is fast but returns 429/504 when busy; the mail.ru mirror is slower but a useful last resort.
const OVERPASS_PRIMARY = "https://overpass-api.de/api/interpreter";
const OVERPASS_FALLBACK = "https://maps.mail.ru/osm/tools/overpass/api/interpreter";

// The public Overpass server allows about 2 concurrent requests per IP, and the
// agent often asks for sights + restaurants + cafés at once, so queue them.
const OVERPASS_SLOTS = 2;
let overpassActive = 0;
const overpassQueue = [];

async function overpass(query, signal) {
  if (overpassActive >= OVERPASS_SLOTS) {
    await new Promise((resolve, reject) => {
      overpassQueue.push(resolve);
      signal?.addEventListener("abort", () => {
        overpassQueue.splice(overpassQueue.indexOf(resolve), 1);
        reject(new ToolError("Cancelled."));
      }, { once: true });
    });
  }
  overpassActive++;
  try {
    return await overpassRequest(query, signal);
  } finally {
    overpassActive--;
    overpassQueue.shift()?.();
  }
}

async function overpassRequest(query, signal) {
  const post = (url, timeoutMs) =>
    getJSON(url, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(query),
      timeoutMs,
    });
  // Worst case ~45 s, inside the harness's 60 s tool timeout.
  for (const waitMs of [0, 2000]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    try {
      return await post(OVERPASS_PRIMARY, 12000);
    } catch (err) {
      if (!err.retryable) throw err;
    }
  }
  try {
    return await post(OVERPASS_FALLBACK, 18000);
  } catch (err) {
    if (signal?.aborted) throw err;
    // Already retried here, so tell the harness not to retry again.
    throw new ToolError("OpenStreetMap (Overpass) is overloaded right now. Try a smaller radius or skip this lookup.");
  }
}

// ---------------------------------------------------------------------------
// find_attractions: OSM sights that have a Wikidata entry, ranked by how many
// people read their Wikipedia article in the last 30 days.
// ---------------------------------------------------------------------------
export async function findAttractions({ latitude, longitude, radius_km = 6 }, { signal } = {}) {
  const around = `(around:${clamp(radius_km, 1, 15) * 1000},${latitude},${longitude})`;
  let osm;
  try {
    osm = await overpass(
      `[out:json][timeout:25];nwr["tourism"~"^(attraction|museum|viewpoint|gallery|zoo|theme_park|aquarium)$"]["wikidata"]${around};out center tags 250;`,
      signal,
    );
  } catch {
    // Overpass is a shared public server and is sometimes overloaded.
    return findAttractionsViaWikipedia({ latitude, longitude }, { signal });
  }

  // One entry per Wikidata item (a site is often mapped as several OSM objects).
  const byQid = new Map();
  for (const el of osm.elements) {
    const t = el.tags ?? {};
    const qid = t.wikidata?.split(";")[0];
    if (!qid || byQid.has(qid)) continue;
    byQid.set(qid, {
      latitude: el.lat ?? el.center?.lat,
      longitude: el.lon ?? el.center?.lon,
      type: (t.tourism === "attraction" ? t.historic ?? t.amenity ?? t.tourism : t.tourism).replace(/_/g, " "),
    });
  }
  if (byQid.size === 0) return findAttractionsViaWikipedia({ latitude, longitude }, { signal });

  // Wikidata item -> English Wikipedia title.
  const entityBatches = await Promise.all(
    chunk([...byQid.keys()], 50).map((ids) =>
      getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&sitefilter=enwiki&format=json&ids=${ids.join("|")}`, { signal }),
    ),
  );
  const titleToQid = new Map();
  for (const batch of entityBatches) {
    for (const [qid, entity] of Object.entries(batch.entities ?? {})) {
      const title = entity.sitelinks?.enwiki?.title;
      if (title) titleToQid.set(title, qid);
    }
  }

  return rankAndDescribe([...titleToQid.keys()], (title) => byQid.get(titleToQid.get(title)), signal);
}

// Fallback: Wikipedia's own geographic index, filtered and ranked the same way.
const NOT_SIGHTS = /\b(station|railway|line|school|university|college|institute|ward|district|prefecture|interchange|expressway|constituency|municipality|county|metro|subway|company|hospital|federation|bank|embassy|police|academy|agency|authority|embassy|stock|list of|secondary)\b/i;

async function findAttractionsViaWikipedia({ latitude, longitude }, { signal } = {}) {
  const data = await getJSON(
    `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${latitude}|${longitude}&gsradius=10000&gslimit=300&gsprop=type&format=json&formatversion=2`,
    { signal },
  );
  const coords = new Map();
  for (const g of data.query?.geosearch ?? []) {
    if (g.type === "landmark" && !NOT_SIGHTS.test(g.title)) coords.set(g.title, { latitude: g.lat, longitude: g.lon, type: "sight" });
  }
  if (coords.size === 0) throw new ToolError("No notable sights found nearby.");
  return rankAndDescribe([...coords.keys()], (title) => coords.get(title), signal);
}

// Rank Wikipedia articles by 30-day page views; attach photo, blurb and location.
async function rankAndDescribe(titles, infoFor, signal) {
  const pageBatches = await Promise.all(
    chunk(titles, 50).map((batch) =>
      getJSON(
        `https://en.wikipedia.org/w/api.php?action=query&prop=pageviews|pageimages&pvipdays=30&piprop=thumbnail&pithumbsize=480` +
          `&format=json&formatversion=2&titles=${encodeURIComponent(batch.join("|"))}`,
        { signal },
      ),
    ),
  );
  const ranked = pageBatches
    .flatMap((b) => b.query?.pages ?? [])
    .filter((p) => !p.missing)
    .map((p) => ({
      title: p.title,
      views: Object.values(p.pageviews ?? {}).reduce((sum, v) => sum + (v ?? 0), 0),
      image: p.thumbnail?.source ?? null,
      ...infoFor(p.title),
    }))
    .filter((p) => p.latitude)
    .sort((a, b) => b.views - a.views)
    .slice(0, 12);

  // Short descriptions for the winners.
  const extracts = ranked.length
    ? await getJSON(
        `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&exsentences=2&exlimit=max` +
          `&format=json&formatversion=2&titles=${encodeURIComponent(ranked.map((r) => r.title).join("|"))}`,
        { signal },
      )
    : { query: { pages: [] } };
  const extractFor = new Map((extracts.query?.pages ?? []).map((p) => [p.title, p.extract]));

  const items = ranked.map((r) => ({
    name: r.title,
    type: r.type,
    description: extractFor.get(r.title) ?? "",
    monthly_wikipedia_views: r.views,
    latitude: r.latitude,
    longitude: r.longitude,
    image: r.image,
    url: wikiUrl(r.title),
  }));
  return {
    result: { count: items.length, attractions: items.map(({ image, url, ...rest }) => rest) },
    ui: { kind: "attractions", items },
  };
}

// ---------------------------------------------------------------------------
// find_places: restaurants, cafes, hotels… from OpenStreetMap
// ---------------------------------------------------------------------------
export const PLACE_CATEGORIES = {
  restaurant: '["amenity"="restaurant"]',
  cafe: '["amenity"="cafe"]',
  bar: '["amenity"~"^(bar|pub)$"]',
  hotel: '["tourism"~"^(hotel|hostel|guest_house)$"]',
  museum: '["tourism"="museum"]',
  park: '["leisure"="park"]',
  viewpoint: '["tourism"="viewpoint"]',
  shopping: '["shop"~"^(mall|department_store|gift|souvenir)$"]',
};

export async function findPlaces({ latitude, longitude, category, radius_m = 1500 }, { signal } = {}) {
  const filter = PLACE_CATEGORIES[category];
  if (!filter) throw new ToolError(`Unknown category "${category}".`);
  const radius = clamp(radius_m, 300, 5000);
  const data = await overpass(`[out:json][timeout:20];nwr${filter}["name"](around:${radius},${latitude},${longitude});out center tags 80;`, signal);

  const items = data.elements
    .map((el) => {
      const t = el.tags ?? {};
      return {
        name: t["name:en"] ?? t.name,
        category,
        cuisine: t.cuisine?.replace(/;/g, ", ").replace(/_/g, " ") ?? null,
        opening_hours: t.opening_hours ?? null,
        website: t.website ?? t["contact:website"] ?? null,
        stars: t.stars ?? null,
        address: [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ") || null,
        latitude: el.lat ?? el.center?.lat,
        longitude: el.lon ?? el.center?.lon,
        // Well-documented places (cuisine, hours, website…) tend to be established ones.
        _richness: ["cuisine", "opening_hours", "website", "stars", "phone", "wikidata"].filter((k) => t[k]).length,
      };
    })
    .filter((p) => p.name && p.latitude)
    .sort((a, b) => b._richness - a._richness)
    .slice(0, 15)
    .map(({ _richness, ...p }) => p);

  if (items.length === 0) throw new ToolError(`No ${category} found within ${radius} m. Try a larger radius_m.`);
  return { result: { category, count: items.length, places: items }, ui: { kind: "places", category, items } };
}

// ---------------------------------------------------------------------------
// compare_routes: walking, cycling and driving (OSRM on routing.openstreetmap.de)
// and public transit (Transitous), with a recommended mode.
// ---------------------------------------------------------------------------
export const ROUTE_MODES = ["walk", "bike", "drive", "transit"];
const OSRM_PROFILES = { walk: "foot", bike: "bike", drive: "car" };
// Beyond these straight-line distances a mode is pointless (and slow to compute).
const MAX_KM = { walk: 25, bike: 60, drive: 1500, transit: 1500 };
const TRANSIT_NAMES = {
  SUBWAY: "Metro", METRO: "Metro", BUS: "Bus", COACH: "Coach", TRAM: "Tram", FERRY: "Ferry", FUNICULAR: "Funicular",
  RAIL: "Train", REGIONAL_RAIL: "Train", REGIONAL_FAST_RAIL: "Train", HIGHSPEED_RAIL: "High-speed train",
  LONG_DISTANCE: "Train", NIGHT_RAIL: "Night train", SUBURBAN: "Suburban train", CABLE_CAR: "Cable car", AERIAL_LIFT: "Cable car",
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const rad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

async function osrmRoute(mode, from, to, signal) {
  const url =
    `https://routing.openstreetmap.de/routed-${OSRM_PROFILES[mode]}/route/v1/driving/` +
    `${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=simplified&geometries=geojson`;
  const data = await getJSON(url, { signal, timeoutMs: 15000 });
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route) throw new ToolError(`No ${mode} route found.`);
  return {
    mode,
    minutes: Math.round(route.duration / 60),
    km: Math.round(route.distance / 100) / 10,
    // [lon, lat] -> [lat, lon] for the map
    geometry: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
  };
}

async function transitRoute(from, to, signal) {
  const url =
    `https://api.transitous.org/api/v1/plan?fromPlace=${from.latitude},${from.longitude}` +
    `&toPlace=${to.latitude},${to.longitude}&numItineraries=3`;
  const data = await getJSON(url, { signal, timeoutMs: 20000 });
  const usable = (data.itineraries ?? []).filter((it) => it.legs.some((l) => l.mode !== "WALK"));
  if (usable.length === 0) throw new ToolError("No public transit connection found.");
  const best = usable.reduce((a, b) => (b.duration < a.duration ? b : a));
  const rides = best.legs.filter((l) => l.mode !== "WALK");
  return {
    mode: "transit",
    minutes: Math.round(best.duration / 60),
    transfers: best.transfers ?? Math.max(0, rides.length - 1),
    walk_minutes: Math.round(best.legs.filter((l) => l.mode === "WALK").reduce((sum, l) => sum + l.duration, 0) / 60),
    lines: rides.map((l) => `${TRANSIT_NAMES[l.mode] ?? l.mode.charAt(0) + l.mode.slice(1).toLowerCase()} ${l.routeShortName ?? l.headsign ?? ""}`.trim()),
  };
}

// A simple, explainable rule the agent can accept or override.
export function recommendMode(options) {
  const by = Object.fromEntries(options.filter((o) => o.minutes != null).map((o) => [o.mode, o]));
  if (by.walk && by.walk.minutes <= 30) return { mode: "walk", reason: `It's a short walk (${by.walk.minutes} min).` };
  // Transit wins unless it's much slower: driving time ignores traffic and parking.
  if (by.transit && (!by.drive || by.transit.minutes <= Math.max(by.drive.minutes * 2, by.drive.minutes + 25))) {
    return { mode: "transit", reason: `Public transit takes ${by.transit.minutes} min (${by.transit.lines.join(" → ")}), no parking needed.` };
  }
  if (by.drive) return { mode: "drive", reason: `Driving or a taxi takes ${by.drive.minutes} min, much faster than the alternatives.` };
  if (by.bike) return { mode: "bike", reason: `Cycling takes ${by.bike.minutes} min.` };
  return { mode: null, reason: "No route found for any mode." };
}

export async function compareRoutes(
  { from_latitude, from_longitude, to_latitude, to_longitude, from_name, to_name, modes = ROUTE_MODES },
  { signal } = {},
) {
  const from = { name: from_name ?? "Start", latitude: from_latitude, longitude: from_longitude };
  const to = { name: to_name ?? "Destination", latitude: to_latitude, longitude: to_longitude };
  const straightKm = Math.round(haversineKm(from_latitude, from_longitude, to_latitude, to_longitude) * 10) / 10;
  const wanted = ROUTE_MODES.filter((m) => modes.includes(m));

  const options = await Promise.all(
    wanted.map(async (mode) => {
      if (straightKm > MAX_KM[mode]) return { mode, minutes: null, error: `Too far to ${mode === "bike" ? "cycle" : mode}.` };
      try {
        return await (mode === "transit" ? transitRoute(from, to, signal) : osrmRoute(mode, from, to, signal));
      } catch (err) {
        if (signal?.aborted) throw err;
        return { mode, minutes: null, error: err.message };
      }
    }),
  );
  if (options.every((o) => o.minutes == null)) {
    throw new ToolError(`No routes found between ${from.name} and ${to.name}.`, { retryable: true });
  }

  const recommended = recommendMode(options);
  const compact = options.map(({ geometry, ...o }) => o);
  if (options.some((o) => o.mode === "drive" && o.minutes != null)) {
    compact.find((o) => o.mode === "drive").note = "Driving time excludes traffic and parking.";
  }
  return {
    result: { from: from.name, to: to.name, straight_line_km: straightKm, options: compact, recommended },
    ui: { kind: "routes", from, to, straight_line_km: straightKm, options, recommended },
  };
}

// ---------------------------------------------------------------------------
// get_exchange_rate: Frankfurter (European Central Bank reference rates)
// ---------------------------------------------------------------------------
export async function getExchangeRate({ from, to, amount = 1 }, { signal } = {}) {
  const f = from.toUpperCase(), t = to.toUpperCase();
  if (f === t) {
    return { result: { from: f, to: t, rate: 1, amount, converted: amount }, ui: { kind: "currency", from: f, to: t, rate: 1, amount, date: null } };
  }
  let data;
  try {
    data = await getJSON(`https://api.frankfurter.dev/v1/latest?from=${f}&to=${t}`, { signal });
  } catch (err) {
    if (err.retryable) throw err;
    throw new ToolError(`No rate for ${f} → ${t}. Only ~30 major currencies are supported.`);
  }
  const rate = data.rates[t];
  return {
    result: { from: f, to: t, rate, amount, converted: +(amount * rate).toFixed(2), date: data.date },
    ui: { kind: "currency", from: f, to: t, rate, amount, date: data.date },
  };
}
