// Human-readable labels for the live ReAct trace in the UI.

const PLURAL = {
  restaurant: "restaurants", cafe: "cafés", bar: "bars", hotel: "hotels",
  museum: "museums", park: "parks", viewpoint: "viewpoints", shopping: "shops",
};

export function describeAction(tool, input = {}) {
  switch (tool) {
    case "search_destination": return `Look up "${input.query}"`;
    case "get_travel_guide": return `Read the travel guide for ${input.place}`;
    case "get_weather":
      return input.start_date ? `Check weather ${input.start_date} → ${input.end_date ?? "+7 days"}` : "Check the 7-day forecast";
    case "find_attractions": return "Find top sights nearby";
    case "find_places": return `Find ${PLURAL[input.category] ?? input.category} nearby`;
    case "get_exchange_rate": return `Convert ${input.amount ?? 1} ${input.from} → ${input.to}`;
    default: return tool;
  }
}

export function summarizeObservation(tool, { text, ui, isError }) {
  if (isError) return text.replace(/^Error:\s*/, "").slice(0, 160);
  switch (ui?.kind) {
    case "destination": return `${ui.place.name}, ${ui.place.country} (${ui.place.latitude.toFixed(2)}, ${ui.place.longitude.toFixed(2)})`;
    case "guide": return `${ui.source}: "${ui.title}" (${Math.round(text.length / 1000)}k chars)`;
    case "weather": return `${ui.days.length} days${ui.source === "forecast" ? " of forecast" : " (last year's weather, same dates)"}`;
    case "attractions": return `${ui.items.length} sights: ${ui.items.slice(0, 3).map((i) => i.name).join(", ")}…`;
    case "places": return `${ui.items.length} ${PLURAL[ui.category] ?? ui.category}`;
    case "currency": return `1 ${ui.from} = ${ui.rate} ${ui.to}`;
    default: return `${text.length} chars`;
  }
}
