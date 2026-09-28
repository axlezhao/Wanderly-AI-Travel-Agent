// Front end: sends messages, reads the NDJSON event stream from the harness,
// and renders the ReAct trace, the streamed answer, and the trip board.

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

const state = {
  sessionId: loadSessionId(),
  modelId: null,
  status: null,
  busy: false,
  controller: null,
};

function loadSessionId() {
  let id;
  try { id = sessionStorage.getItem("wanderly-session"); } catch {}
  if (!id) {
    id = crypto.randomUUID();
    try { sessionStorage.setItem("wanderly-session", id); } catch {}
  }
  return id;
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------
const map = L.map("map", { zoomControl: true, attributionControl: true }).setView([25, 10], 2);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const layers = {
  home: L.layerGroup().addTo(map),
  sights: L.layerGroup().addTo(map),
  food: L.layerGroup().addTo(map),
  routes: L.layerGroup().addTo(map),
};
const pin = (cls, label) => L.divIcon({ className: "", html: `<div class="pin ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
const popup = (title, body = "") => {
  const div = el("div");
  div.append(el("strong", "", title));
  if (body) div.append(el("div", "", body));
  return div;
};

// Leaflet can't animate a hidden (zero-size) map, e.g. on the Chat tab on phones.
// Remember the latest move and replay it when the map becomes visible.
let pendingMove = null;
function moveMap(fn) {
  const el = map.getContainer();
  if (el.offsetWidth && el.offsetHeight) {
    pendingMove = null;
    fn(true);
  } else {
    pendingMove = fn;
  }
}
function showMap() {
  map.invalidateSize();
  if (pendingMove) {
    const fn = pendingMove;
    pendingMove = null;
    fn(false);
  }
}
const flyTo = (latlng, zoom) => moveMap((animate) => (animate ? map.flyTo(latlng, zoom, { duration: 0.8 }) : map.setView(latlng, zoom)));

function fitToMarkers() {
  const pts = [...layers.home.getLayers(), ...layers.sights.getLayers()].map((m) => m.getLatLng());
  if (pts.length < 2) return;
  const bounds = L.latLngBounds(pts).pad(0.15);
  moveMap((animate) => (animate ? map.flyToBounds(bounds, { duration: 0.8, maxZoom: 14 }) : map.fitBounds(bounds, { maxZoom: 14 })));
}

// ---------------------------------------------------------------------------
// Trip board: each observation's `ui` payload updates one card
// ---------------------------------------------------------------------------
const board = {
  destination({ place }) {
    Object.values(layers).forEach((l) => l.clearLayers());
    ["guide", "weather", "sights", "food", "routes", "money"].forEach((id) => ($(`#${id}`).hidden = true));
    $("#place-list").replaceChildren();
    $("#route-list").replaceChildren();
    $("#board-empty").hidden = true;
    L.marker([place.latitude, place.longitude], { icon: pin("home", "★") })
      .bindPopup(popup(place.name, [place.region, place.country].filter(Boolean).join(", ")))
      .addTo(layers.home);
    flyTo([place.latitude, place.longitude], 12);
  },

  guide(g) {
    const card = $("#guide");
    card.replaceChildren();
    const wrap = el("div", "guide");
    if (g.image) {
      const img = el("img");
      img.src = g.image;
      img.alt = g.title;
      img.loading = "lazy";
      wrap.append(img);
    } else {
      wrap.style.gridTemplateColumns = "1fr";
    }
    const text = el("div");
    const link = el("a", "", `Read more on ${g.source} ↗`);
    link.href = g.url;
    link.target = "_blank";
    link.rel = "noopener";
    text.append(el("h2", "", g.title), el("p", "", g.summary), link);
    wrap.append(text);
    card.append(wrap);
    card.hidden = false;
  },

  weather(w) {
    $("#weather-src").textContent = w.source === "forecast" ? "live forecast" : "same dates last year";
    $("#weather-days").replaceChildren(
      ...w.days.map((d) => {
        const day = el("div", "wday");
        const date = new Date(d.date + "T12:00:00Z");
        day.title = `${d.condition} · ${d.precipitation_mm} mm`;
        day.append(
          el("div", "dow", date.toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" })),
          el("div", "rain", date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })),
          el("div", "icon", d.icon),
        );
        const temps = el("div", "temps", `${Math.round(d.high_c)}° `);
        temps.append(el("span", "lo", `${Math.round(d.low_c)}°`));
        day.append(temps, el("div", "rain", d.rain_chance_pct != null ? `💧 ${d.rain_chance_pct}%` : `${d.precipitation_mm} mm`));
        return day;
      }),
    );
    $("#weather").hidden = false;
  },

  attractions({ items }) {
    layers.sights.clearLayers();
    $("#sight-grid").replaceChildren(
      ...items.map((s, i) => {
        const marker = L.marker([s.latitude, s.longitude], { icon: pin("sight", i + 1) })
          .bindPopup(popup(`${i + 1}. ${s.name}`, s.type))
          .addTo(layers.sights);
        const card = el("button", "sight");
        card.type = "button";
        if (s.image) {
          const img = el("img");
          img.src = s.image;
          img.alt = s.name;
          img.loading = "lazy";
          card.append(img);
        } else {
          card.append(el("div", "noimg", "🏛️"));
        }
        const meta = el("div", "meta");
        meta.append(el("div", "rank", `#${i + 1}`), el("div", "name", s.name), el("div", "kind", s.type));
        card.append(meta);
        card.title = s.description;
        card.addEventListener("click", () => {
          flyTo([s.latitude, s.longitude], 16);
          marker.openPopup();
          if (innerWidth <= 900) window.scrollTo({ top: 0, behavior: "smooth" });
        });
        return card;
      }),
    );
    $("#sights").hidden = false;
    fitToMarkers();
  },

  places({ category, items }) {
    const emoji = { restaurant: "🍽️", cafe: "☕", bar: "🍸", hotel: "🛏️", museum: "🏛️", park: "🌳", viewpoint: "🔭", shopping: "🛍️" }[category] ?? "📍";
    const list = $("#place-list");
    // Replace this category's rows, keep the others.
    list.querySelectorAll(`[data-cat="${category}"]`).forEach((n) => n.remove());
    layers.food.eachLayer((m) => m.options.category === category && layers.food.removeLayer(m));
    for (const p of items.slice(0, 8)) {
      const marker = L.marker([p.latitude, p.longitude], { icon: pin("food", emoji), category })
        .bindPopup(popup(p.name, [p.cuisine, p.opening_hours].filter(Boolean).join(" · ")))
        .addTo(layers.food);
      const li = el("li");
      li.dataset.cat = category;
      const info = el("div");
      info.append(el("div", "pname", p.name), el("div", "pmeta", [p.cuisine ?? category, p.opening_hours].filter(Boolean).join(" · ")));
      li.append(el("span", "pemoji", emoji), info);
      li.addEventListener("click", () => {
        flyTo([p.latitude, p.longitude], 17);
        marker.openPopup();
      });
      list.append(li);
    }
    $("#food").hidden = false;
  },

  routes(r) {
    const icon = { walk: "🚶", bike: "🚲", drive: "🚗", transit: "🚇" };
    const li = el("li", "route");
    li.append(el("div", "leg", `${r.from.name} → ${r.to.name}`));
    const modes = el("div", "modes");
    for (const o of r.options) {
      if (o.minutes == null) continue;
      const chip = el("span", `mode${o.mode === r.recommended.mode ? " best" : ""}`, `${icon[o.mode]} ${o.minutes} min`);
      chip.title = o.mode === "transit" ? o.lines.join(" → ") : `${o.km} km`;
      modes.append(chip);
    }
    li.append(modes, el("div", "why", r.recommended.reason));
    // Show the recommended route on the map (transit has no geometry: draw the walking line, or a straight dashed one).
    const show = () => {
      layers.routes.clearLayers();
      document.querySelectorAll(".route.active").forEach((n) => n.classList.remove("active"));
      li.classList.add("active");
      const withLine = r.options.find((o) => o.mode === r.recommended.mode && o.geometry) ?? r.options.find((o) => o.geometry);
      const pts = withLine?.geometry ?? [[r.from.latitude, r.from.longitude], [r.to.latitude, r.to.longitude]];
      const line = L.polyline(pts, { color: "#0e7a6f", weight: 5, opacity: 0.85, dashArray: withLine ? null : "8 8" }).addTo(layers.routes);
      const bounds = line.getBounds().pad(0.2);
      moveMap((animate) => (animate ? map.flyToBounds(bounds, { duration: 0.8, maxZoom: 16 }) : map.fitBounds(bounds, { maxZoom: 16 })));
    };
    li.addEventListener("click", show);
    $("#route-list").append(li);
    $("#routes").hidden = false;
    if ($("#route-list").children.length === 1) show();
  },

  currency(c) {
    const card = $("#money");
    card.replaceChildren(el("h2", "", "Money"));
    const row = el("div", "money");
    const amount = c.amount ?? 1;
    row.append(
      el("span", "big", `${amount} ${c.from} ≈ ${(amount * c.rate).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${c.to}`),
      el("span", "sub", c.date ? `ECB reference rate, ${c.date}` : ""),
    );
    card.append(row);
    card.hidden = false;
  },
};

// ---------------------------------------------------------------------------
// Chat turn rendering
// ---------------------------------------------------------------------------
function renderMarkdown(target, text) {
  target.innerHTML = DOMPurify.sanitize(marked.parse(text));
  target.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener";
  });
}

function createTurn() {
  const node = $("#turn-template").content.firstElementChild.cloneNode(true);
  $("#messages").append(node);
  const steps = {}; // step number -> { li, actions }
  const actions = {}; // action id -> element
  let draft = "";
  let frame = 0; // pending requestAnimationFrame for the streamed draft
  const answerEl = $(".answer", node);

  const stepFor = (n) => {
    if (!steps[n]) {
      const li = el("li", "step");
      const thought = el("div", "thought");
      li.append(el("span", "step-num", n), thought);
      const acts = el("div", "actions");
      li.append(acts);
      $(".steps", node).append(li);
      steps[n] = { li, thought, acts };
    }
    return steps[n];
  };

  const flushDraft = () => {
    frame = 0;
    renderMarkdown(answerEl, draft);
    scrollDown();
  };
  // Drop a pending draft render so it can't overwrite what we're about to show.
  const cancelDraft = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    draft = "";
  };

  return {
    handle(e) {
      switch (e.type) {
        case "step_start":
          cancelDraft();
          $(".trace-meta", node).textContent = `step ${e.step}${e.forceAnswer ? " (final)" : ""}…`;
          break;

        case "draft_delta":
          // Text streams before we know whether it's a Thought or the Answer; show it live.
          draft += e.text;
          answerEl.classList.add("streaming");
          frame ||= requestAnimationFrame(flushDraft);
          break;

        case "draft_reset":
          cancelDraft();
          answerEl.replaceChildren();
          break;

        case "thought": {
          if (!e.text) break;
          const s = stepFor(e.step);
          s.thought.replaceChildren(el("span", "label", "Thought"), document.createTextNode(e.text.replace(/^Thought:\s*/i, "")));
          // The streamed text was a thought, not the answer.
          cancelDraft();
          answerEl.replaceChildren();
          answerEl.classList.remove("streaming");
          break;
        }

        case "action": {
          const s = stepFor(e.step);
          const row = el("div", "action");
          const icon = el("div", "status-icon");
          icon.append(el("div", "spinner"));
          const body = el("div");
          const title = el("div", "", e.label);
          const call = el("span", "tool", `${e.tool}(${JSON.stringify(e.input)})`);
          call.title = call.textContent;
          title.append(call);
          const obs = el("div", "obs");
          body.append(title, obs);
          const tags = el("div", "tags");
          row.append(icon, body, tags);
          s.acts.append(row);
          actions[e.id] = { row, icon, obs, tags };
          scrollDown();
          break;
        }

        case "retry": {
          const a = actions[e.id];
          if (a) a.obs.textContent = `Retrying (attempt ${e.attempt})… ${e.reason.replace(/^Error:\s*/, "")}`;
          break;
        }

        case "observation": {
          const a = actions[e.id];
          if (!a) break;
          a.icon.replaceChildren(document.createTextNode(e.ok ? "✅" : "⚠️"));
          a.obs.replaceChildren(el("span", "obs-label", "Observation"), document.createTextNode(e.summary));
          if (!e.ok) a.row.classList.add("error");
          if (e.cached) a.tags.append(el("span", "tag", "cached"));
          if (e.skipped) a.tags.append(el("span", "tag warn", "skipped"));
          if (e.fallback) {
            const t = el("span", "tag warn", "→ AI knowledge");
            t.title = "The lookup failed twice, so the agent fills this part from its own knowledge.";
            a.tags.append(t);
          }
          if (e.attempts > 1) a.tags.append(el("span", "tag warn", `${e.attempts} tries`));
          a.tags.append(el("span", "tag", e.durationMs < 1000 ? `${e.durationMs} ms` : `${(e.durationMs / 1000).toFixed(1)} s`));
          if (e.ok && e.ui && board[e.ui.kind]) {
            // A display glitch on the board must never break the agent run.
            try {
              board[e.ui.kind](e.ui);
            } catch (err) {
              console.error(`Trip board failed to render ${e.ui.kind}:`, err);
            }
          }
          break;
        }

        case "answer":
          cancelDraft();
          answerEl.classList.remove("streaming");
          renderMarkdown(answerEl, e.text);
          $(".trace", node).open = false;
          scrollDown();
          break;

        case "error":
          cancelDraft();
          answerEl.classList.remove("streaming");
          node.append(el("div", "run-error", e.message));
          break;

        case "run_end": {
          const bits = [
            `${e.steps} step${e.steps === 1 ? "" : "s"}`,
            `${e.toolCalls} tool call${e.toolCalls === 1 ? "" : "s"}`,
            `${(e.durationMs / 1000).toFixed(1)} s`,
          ];
          if (e.retries) bits.push(`${e.retries} retr${e.retries === 1 ? "y" : "ies"}`);
          if (e.cacheHits) bits.push(`${e.cacheHits} cached`);
          if (e.fallbacks) bits.push(`${e.fallbacks} filled from AI knowledge`);
          if (e.usage) bits.push(`${e.usage.input_tokens.toLocaleString()} in / ${e.usage.output_tokens.toLocaleString()} out tokens`);
          $(".trace-meta", node).textContent = bits.slice(0, 3).join(" · ");
          $(".run-stats", node).textContent = `${e.status === "ok" ? "" : e.status + " · "}${bits.join(" · ")} · ${e.runId}`;
          break;
        }
      }
    },
  };
}

function scrollDown() {
  const box = $("#messages");
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 240) box.scrollTop = box.scrollHeight;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Chat history, for this tab only. sessionStorage survives reloads and is wiped
// by the browser when the tab closes: the same lifetime as the agent's
// short-term memory on the server.
// ---------------------------------------------------------------------------
const HISTORY_KEY = "wanderly-history";
const chatHistory = {
  load() {
    try {
      return JSON.parse(sessionStorage.getItem(HISTORY_KEY)) ?? [];
    } catch {
      return [];
    }
  },
  save(turns) {
    // If the storage quota is hit, drop the oldest turns until it fits.
    for (let kept = turns; kept.length; kept = kept.slice(1)) {
      try {
        sessionStorage.setItem(HISTORY_KEY, JSON.stringify(kept));
        return;
      } catch {}
    }
  },
  clear() {
    try {
      sessionStorage.removeItem(HISTORY_KEY);
    } catch {}
  },
};
state.turns = chatHistory.load();

// Replay saved turns: the same events rebuild the chat, the reasoning trace, the map and the trip board.
function restoreHistory() {
  if (!state.turns.length) return;
  $("#empty")?.remove();
  for (const t of state.turns) {
    $("#messages").append(el("div", "user-msg", t.message));
    const turn = createTurn();
    for (const e of t.events) turn.handle(e);
  }
  $("#travel-mode").value = state.turns.at(-1).travelMode ?? "";
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function updateMemory(turns) {
  const box = $("#memory");
  box.hidden = turns === 0;
  $("#memory-text").textContent = `🧠 Remembers ${turns} message${turns === 1 ? "" : "s"} · cleared when you close this tab`;
}

async function syncMemory() {
  try {
    let { turns } = await (await fetch(`/api/session/${state.sessionId}`)).json();
    // The server restarted but this tab still has the chat: hand the conversation back.
    if (turns === 0 && state.turns.length) {
      const body = { turns: state.turns.map(({ message, travelMode, answer }) => ({ message, travelMode, answer })) };
      ({ turns } = await (await fetch(`/api/session/${state.sessionId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })).json());
    }
    updateMemory(turns);
  } catch {}
}

async function forget() {
  state.controller?.abort();
  chatHistory.clear();
  await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: state.sessionId }) });
  location.reload();
}

// Closing the tab: tell the server to forget this session (a reload cancels it).
addEventListener("pagehide", () => navigator.sendBeacon?.(`/api/session/${state.sessionId}/close`));

async function send(text) {
  if (state.busy || !text.trim()) return;
  $("#empty")?.remove();
  $("#messages").append(el("div", "user-msg", text));
  const turn = createTurn();
  const record = { message: text, travelMode: $("#travel-mode").value, model: $("#model-select").selectedOptions[0]?.textContent, events: [] };
  state.turns.push(record);
  const handle = (e) => {
    turn.handle(e);
    if (e.type === "draft_delta") return; // the final answer event carries the full text
    record.events.push(e);
    if (e.type === "answer") record.answer = e.text;
  };
  $("#messages").scrollTop = $("#messages").scrollHeight;
  setBusy(true);

  state.controller = new AbortController();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, message: text, modelId: state.modelId, travelMode: record.travelMode }),
      signal: state.controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Server error ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) handle(JSON.parse(line));
    }
  } catch (err) {
    handle({ type: "error", message: err.name === "AbortError" ? "Stopped." : err.message });
  } finally {
    setBusy(false);
    chatHistory.save(state.turns);
    syncMemory();
  }
}

function setBusy(busy) {
  state.busy = busy;
  const btn = $("#send");
  btn.classList.toggle("stop", busy);
  btn.setAttribute("aria-label", busy ? "Stop" : "Send");
  btn.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3.4 10l12.6 2-12.6 2z"/></svg>';
  $("#model-select").disabled = busy;
}

const input = $("#input");
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if (state.busy) {
    state.controller?.abort();
    return;
  }
  const text = input.value;
  input.value = "";
  input.style.height = "auto";
  send(text);
});
document.querySelectorAll(".suggestions button").forEach((b) => b.addEventListener("click", () => send(b.textContent)));

$("#new-trip").addEventListener("click", forget);
$("#forget").addEventListener("click", forget);

addEventListener("resize", () => {
  if (map.getContainer().offsetWidth) showMap();
});

// Mobile tabs
document.querySelectorAll(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    $(".layout").dataset.view = b.dataset.view;
    if (b.dataset.view === "board") setTimeout(showMap, 50);
  }),
);

// ---------------------------------------------------------------------------
// Models: picker in the top bar + the "Models" dialog
// ---------------------------------------------------------------------------
const api = async (url, body, method = "POST") => {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
};

function renderModels() {
  const { models } = state.status;
  const select = $("#model-select");
  select.replaceChildren(...models.map((m) => {
    const opt = el("option", "", m.label);
    opt.value = m.id;
    return opt;
  }));
  if (!models.some((m) => m.id === state.modelId)) state.modelId = state.status.defaultModel;
  select.value = state.modelId;

  $("#model-list").replaceChildren(...models.map((m) => {
    const li = el("li");
    const info = el("div");
    const name = el("div", "mname", m.label);
    name.append(el("span", "src", { env: ".env", user: "added here", builtin: "built-in" }[m.source]));
    info.append(name, el("div", "mmeta", m.provider === "demo" ? "no LLM: fixed plan, same tools" : [m.provider, m.model, m.baseUrl, m.keyHint && `key ${m.keyHint}`].filter(Boolean).join(" · ")));
    li.append(info);
    if (m.source === "user") {
      const del = el("button", "ghost", "Remove");
      del.addEventListener("click", async () => {
        await api(`/api/models/${encodeURIComponent(m.id)}`, null, "DELETE");
        await refreshStatus();
      });
      li.append(del);
    }
    return li;
  }));
}

async function refreshStatus() {
  const status = await (await fetch("/api/status")).json();
  if (status.error) throw new Error(status.error);
  state.status = status;
  renderModels();
  return status;
}

$("#model-select").addEventListener("change", (e) => (state.modelId = e.target.value));
$("#open-models").addEventListener("click", () => $("#models-dialog").showModal());

const form = $("#add-model");
const formStatus = (text, cls = "") => {
  $("#form-status").textContent = text;
  $("#form-status").className = `form-status ${cls}`;
};
const formValues = () => Object.fromEntries(new FormData(form));

function applyPreset(id) {
  const p = state.status.presets.find((x) => x.id === id);
  if (!p) return;
  $("#provider").value = p.provider;
  $("#baseUrl").value = p.baseUrl;
  $("#model").value = p.model;
  $("#label").value = "";
  $("#model-options").replaceChildren();
  const link = $("#key-link");
  link.hidden = !p.keyUrl;
  if (p.keyUrl) link.href = p.keyUrl;
  $("#baseUrl").placeholder = p.provider === "anthropic" ? "leave empty for api.anthropic.com" : "https://api.example.com/v1";
  formStatus("");
}
$("#preset").addEventListener("change", (e) => applyPreset(e.target.value));

$("#discover").addEventListener("click", async () => {
  formStatus("Asking the provider which models this key can use…");
  try {
    const { models } = await api("/api/models/discover", formValues());
    $("#model-options").replaceChildren(...models.map((id) => {
      const o = el("option");
      o.value = id;
      return o;
    }));
    formStatus(models.length ? `Found ${models.length} models. Click the Model field to pick one.` : "No models listed.", "ok");
    if (models.length && !$("#model").value) $("#model").value = models[0];
    $("#model").focus();
  } catch (err) {
    formStatus(err.message, "bad");
  }
});

$("#test").addEventListener("click", async () => {
  formStatus("Testing…");
  try {
    const { latencyMs } = await api("/api/models/test", formValues());
    formStatus(`✓ Connected (${latencyMs} ms)`, "ok");
  } catch (err) {
    formStatus(err.message, "bad");
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formStatus("Saving…");
  try {
    const { model } = await api("/api/models", formValues());
    $("#apiKey").value = "";
    state.modelId = model.id;
    await refreshStatus();
    formStatus(`Saved "${model.label}" and selected it.`, "ok");
  } catch (err) {
    formStatus(err.message, "bad");
  }
});

// ---------------------------------------------------------------------------
// Startup: which models are available, which MCP tools are connected
// ---------------------------------------------------------------------------
(async function init() {
  try {
    const status = await refreshStatus();
    $("#preset").replaceChildren(...status.presets.map((p) => {
      const o = el("option", "", p.label);
      o.value = p.id;
      return o;
    }));
    applyPreset(status.presets[0].id);
    restoreHistory();
    syncMemory();
    const serverName = { go: "Go", node: "Node.js" }[status.mcpServer] ?? status.mcpServer;
    $("#tools").append(el("span", "tools-label", `MCP tools connected (${serverName} server):`), ...status.tools.map((t) => {
      const chip = el("span", "", t.name);
      chip.title = t.description;
      return chip;
    }));
  } catch (err) {
    $("#tools").append(el("span", "", `⚠️ ${err.message}`));
  }
})();
