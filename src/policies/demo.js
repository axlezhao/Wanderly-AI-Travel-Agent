// A rule-based ReAct policy so the app works with no API key.
//
// It follows the same Thought -> Action -> Observation protocol as the Claude
// policy (and runs through the same harness and MCP tools), but its "reasoning"
// is a fixed plan:
//   step 1  search_destination
//   step 2  travel guide + weather + sights + restaurants + cafés + currency, in parallel
//   step 3  compare routes between each day's sights (walk / bike / drive / transit)
//   step 4  assemble a day-by-day itinerary from the observations

import { randomUUID } from "node:crypto";

// Countries -> currency, for the ~30 currencies the exchange-rate API supports.
const EURO = "AT BE HR CY EE FI FR DE GR IE IT LV LT LU MT NL PT SK SI ES MC SM VA AD ME XK".split(" ");
const CURRENCY = {
  ...Object.fromEntries(EURO.map((c) => [c, "EUR"])),
  US: "USD", GB: "GBP", JP: "JPY", CN: "CNY", KR: "KRW", TH: "THB", AU: "AUD", CA: "CAD", CH: "CHF",
  IN: "INR", MX: "MXN", BR: "BRL", SG: "SGD", HK: "HKD", NZ: "NZD", SE: "SEK", NO: "NOK", DK: "DKK",
  PL: "PLN", CZ: "CZK", HU: "HUF", TR: "TRY", ZA: "ZAR", ID: "IDR", MY: "MYR", PH: "PHP", IL: "ILS",
  IS: "ISK", RO: "RON", LI: "CHF",
};
const HOME_CURRENCY = process.env.HOME_CURRENCY || "USD";

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, a: 1, an: 1, weekend: 2 };

// The "Getting around" picker arrives as a tagged line appended by the server.
const PREFERENCE_TAG = /\[Getting around: ([^\]]+)\]/i;
const MODE_ICON = { walk: "🚶", bike: "🚲", drive: "🚗", transit: "🚇" };
const MODE_WORD = { walk: "walk", bike: "bike", drive: "drive", transit: "transit" };

export function parseRequest(message) {
  const pref = message.match(PREFERENCE_TAG)?.[1] ?? "";
  const travelMode = /driv/i.test(pref) ? "drive" : /cycl|bik/i.test(pref) ? "bike" : /transit/i.test(pref) ? "transit" : /walk/i.test(pref) ? "walk" : null;
  const text = message.replace(PREFERENCE_TAG, "").trim();
  let days = 3;
  const m = text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|a|an)[\s-]*(day|night)s?\b/i);
  if (m) days = Number(m[1]) || NUMBER_WORDS[m[1].toLowerCase()] || 3;
  else if (/\bweekend\b/i.test(text)) days = 2;
  else if (/\b(a|one) week\b/i.test(text)) days = 7;
  days = Math.min(Math.max(days, 1), 7);

  // "trip to Lisbon", "3 days in Kyoto", "visit Mexico City"…
  const place =
    text.match(/\b(?:to|in|visit|visiting|around|explore|exploring|of)\s+([A-Z][\p{L}'’.-]*(?:[\s-]+(?:de|da|del|la|le|of)?\s*[A-Z][\p{L}'’.-]*)*)/u)?.[1] ??
    // lowercase: "things to do in new york for two days"
    titleCase(text.match(/\b(?:to|in|visit|visiting|around|explore|exploring)\s+([\p{L}'’. -]+?)(?=\s+(?:for|with|on|during|next|this|in|please|and)\b|[,.!?]|$)/iu)?.[1]) ??
    // otherwise the first capitalized phrase that isn't the start of a sentence word like "Plan"
    text.match(/(?<![.!?]\s|^)\b([A-Z][\p{L}'’.-]+(?:\s+[A-Z][\p{L}'’.-]+)*)/u)?.[1] ??
    text.replace(/\b(plan|a|an|the|trip|days?|nights?|weekend|for|me|please|to|in|\d+)\b/gi, "").trim();
  return { destination: place.replace(/[.,!?]+$/, "").trim(), days, travelMode };
}

export class DemoPolicy {
  name = "demo";

  addUserMessage(text) {
    // Each message is planned from scratch.
    this.request = parseRequest(text);
    this.obs = {};
    this.stage = "search";
  }

  async decide({ emit }) {
    const { destination, days } = this.request;

    if (this.stage === "search") {
      if (!destination) {
        return { answer: "Where would you like to go? Try something like **\"4 days in Lisbon\"**." };
      }
      this.stage = "gather";
      return {
        thought: `The traveler wants ${days} day${days > 1 ? "s" : ""} in "${destination}". I need its coordinates before anything else.`,
        actions: [action("search_destination", { query: destination })],
      };
    }

    if (this.stage === "gather") {
      const place = this.obs.search_destination?.best_match;
      if (!place) {
        return {
          thought: "The destination lookup failed, so I can't plan this trip.",
          answer: `I couldn't find a place called **${destination}**. Could you check the spelling or name a nearby city?`,
        };
      }
      this.stage = "routes";
      const { latitude, longitude } = place;
      const currency = CURRENCY[place.country_code];
      const actions = [
        action("get_travel_guide", { place: place.name }),
        action("get_weather", { latitude, longitude }),
        action("find_attractions", { latitude, longitude }),
        action("find_places", { latitude, longitude, category: "restaurant" }),
        action("find_places", { latitude, longitude, category: "cafe" }),
      ];
      if (currency && currency !== HOME_CURRENCY) actions.push(action("get_exchange_rate", { from: HOME_CURRENCY, to: currency, amount: 100 }));
      return {
        thought:
          `Found ${place.name}, ${place.country}. These lookups are independent, so I'll run them in parallel: ` +
          `travel guide, weather, top sights, restaurants, cafés${actions.length > 5 ? " and the exchange rate" : ""}.`,
        actions,
      };
    }

    if (this.stage === "routes") {
      this.stage = "answer";
      this.dayPlan = planDays(this.obs.find_attractions?.attractions ?? [], days);
      // One comparison per day (first to last sight), for up to 3 days.
      const actions = this.dayPlan
        .filter((todays) => todays.length >= 2)
        .slice(0, 3)
        .map((todays) => {
          const [a, b] = [todays[0], todays.at(-1)];
          return action("compare_routes", {
            from_latitude: a.latitude, from_longitude: a.longitude, from_name: a.name,
            to_latitude: b.latitude, to_longitude: b.longitude, to_name: b.name,
          });
        });
      if (actions.length) {
        const pref = this.request.travelMode ? ` The traveler prefers ${this.request.travelMode}.` : "";
        return {
          thought: `I've grouped nearby sights into days. Now I'll compare walking, cycling, driving and transit between each day's stops.${pref}`,
          actions,
        };
      }
    }

    const answer = this.#compose();
    // Stream the answer in small chunks so the demo feels like the real thing.
    for (const piece of answer.match(/[\s\S]{1,40}/g)) {
      emit({ type: "draft_delta", text: piece });
      await new Promise((r) => setTimeout(r, 8));
    }
    return {
      thought: "I have the weather, sights, food and guide notes. Time to lay out the days.",
      answer,
    };
  }

  observe(observations) {
    for (const o of observations) {
      if (o.isError) continue;
      let data;
      try {
        data = JSON.parse(o.content);
      } catch {
        continue; // truncated by the harness; skip it
      }
      if (o.tool === "compare_routes") {
        (this.obs.routes ??= {})[`${o.input.from_name}→${o.input.to_name}`] = data;
        continue;
      }
      const key = o.tool === "find_places" ? `places_${o.input.category}` : o.tool;
      this.obs[key] = data;
    }
  }

  #compose() {
    const { days } = this.request;
    const place = this.obs.search_destination.best_match;
    const guide = this.obs.get_travel_guide;
    const weather = this.obs.get_weather?.days ?? [];
    const sights = this.obs.find_attractions?.attractions ?? [];
    const food = this.obs.places_restaurant?.places ?? [];
    const cafes = this.obs.places_cafe?.places ?? [];
    const fx = this.obs.get_exchange_rate;

    const lines = [`# ${days} day${days > 1 ? "s" : ""} in ${place.name}, ${place.country}`, ""];
    if (guide?.summary) lines.push(`> ${firstSentences(guide.summary, 2)}`, "");

    if (weather.length) {
      const src = this.obs.get_weather.source === "forecast" ? "live forecast" : "same dates last year";
      lines.push(`**Weather** (${src}): ` + weather.slice(0, days).map((w) => `${w.icon} ${fmtDay(w.date)} ${Math.round(w.high_c)}°/${Math.round(w.low_c)}°`).join(" · "), "");
    }

    const plan = this.dayPlan ?? planDays(sights, days);
    for (let d = 0; d < days; d++) {
      const todays = plan[d] ?? [];
      const w = weather[d];
      const wet = w && (w.precipitation_mm > 3 || /rain|storm|shower/i.test(w.condition));
      lines.push(`## Day ${d + 1}${todays[0] ? ` — ${todays[0].name}` : ""}`);
      if (w) lines.push(`_${w.icon} ${w.condition}, ${Math.round(w.low_c)}–${Math.round(w.high_c)}°C${wet ? " — pack an umbrella; favor indoor sights" : ""}_`);
      const slots = ["Morning", "Afternoon", "Late afternoon"];
      todays.forEach((s, i) => lines.push(`- **${slots[i]}:** ${s.name} — ${firstSentences(s.description, 1) || s.type}`));
      if (todays.length === 0) lines.push("- **Free day:** wander a neighborhood from the travel guide, or revisit a favorite.");
      const cafe = cafes[d % Math.max(cafes.length, 1)];
      if (cafe) lines.push(`- **Coffee break:** ${cafe.name}${cafe.opening_hours ? ` (${cafe.opening_hours})` : ""}`);
      const dinner = food[d];
      if (dinner) lines.push(`- **Dinner:** ${dinner.name}${dinner.cuisine ? ` · ${dinner.cuisine}` : ""}${dinner.website ? ` · [website](${dinner.website})` : ""}`);
      const route = todays.length >= 2 && this.obs.routes?.[`${todays[0].name}→${todays.at(-1).name}`];
      if (route) lines.push(`- **Getting around:** ${describeRoute(route, this.request.travelMode)}`);
      lines.push("");
    }

    lines.push("## Good to know");
    if (fx) lines.push(`- **Money:** ${fx.amount} ${fx.from} ≈ ${fx.converted.toLocaleString()} ${fx.to} (ECB rate, ${fx.date})`);
    if (place.timezone) lines.push(`- **Time zone:** ${place.timezone}`);
    const around = guide?.guide_text && section(guide.guide_text, "Get around");
    if (around) lines.push(`- **Getting around:** ${firstSentences(around, 2)}`);
    lines.push(
      "",
      "---",
      "_Demo mode: this plan was assembled by a rule-based policy. Add an `ANTHROPIC_API_KEY` to let Claude reason over the same tools._",
    );
    return lines.join("\n");
  }
}

// Pair each day's sights by proximity: sort by longitude so neighbors share a day.
function planDays(sights, days) {
  const pool = [...sights].sort((a, b) => a.longitude - b.longitude);
  const perDay = Math.max(1, Math.min(3, Math.floor(pool.length / days) || 1));
  return Array.from({ length: days }, () => pool.splice(0, perDay));
}

// "🚇 Transit 18 min (Metro A → Bus 64) from X to Y · or 🚶 35 min walk, 🚗 9 min drive"
function describeRoute(route, preferred) {
  const ok = route.options.filter((o) => o.minutes != null);
  const walk = ok.find((o) => o.mode === "walk");
  // Even with a car, a short hop is better on foot (no parking, no restricted zones).
  const leaveTheCar = preferred === "drive" && walk && walk.minutes <= 15;
  const pick = leaveTheCar ? walk : ok.find((o) => o.mode === preferred) ?? ok.find((o) => o.mode === route.recommended.mode) ?? ok[0];
  if (!pick) return "no route found";
  const lines = pick.mode === "transit" && pick.lines?.length ? ` (${pick.lines.join(" → ")})` : "";
  const others = ok.filter((o) => o !== pick).map((o) => `${MODE_ICON[o.mode]} ${o.minutes} min ${MODE_WORD[o.mode]}`);
  const why = leaveTheCar ? " (leave the car parked, it's close)" : pick.mode === route.recommended.mode ? "" : " (your preference)";
  return `${MODE_ICON[pick.mode]} ${MODE_WORD[pick.mode]} ${pick.minutes} min${lines} from ${route.from} to ${route.to}${why}` +
    (others.length ? ` · or ${others.join(", ")}` : "");
}

function titleCase(s) {
  return s?.trim() ? s.trim().replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : undefined;
}

function action(tool, input) {
  return { id: `demo_${randomUUID().slice(0, 8)}`, tool, input };
}

function firstSentences(text = "", n = 1) {
  const sentences = text.replace(/\s+/g, " ").match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  return sentences.slice(0, n).join("").trim();
}

function section(text, heading) {
  const m = text.match(new RegExp(`==+\\s*${heading}\\s*==+\\s*\\n([\\s\\S]*?)(\\n==|$)`, "i"));
  return m?.[1]?.replace(/\n+/g, " ").trim();
}

function fmtDay(iso) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}
