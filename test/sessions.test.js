// Short-term memory: what the agent remembers within one browser tab.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionStore } from "../src/harness/sessions.js";

// A policy stand-in that records what it was taught.
const fakePolicy = () => ({ seeded: [], seedHistory(entries) { this.seeded.push(...entries); } });

test("memory follows the conversation across models", () => {
  const store = new SessionStore();
  const s = store.get("tab-1");
  const deepseek = store.sync(s, "deepseek", fakePolicy());
  assert.deepEqual(deepseek.seeded, [], "a fresh session has nothing to catch up on");

  store.remember(s, "deepseek", [{ role: "user", text: "5 days in Italy" }, { role: "assistant", text: "Car or trains?" }]);
  store.remember(s, "deepseek", [{ role: "user", text: "Trains" }, { role: "assistant", text: "Rome + Florence plan" }]);

  // Switching to Claude: it learns everything said so far.
  const claude = store.sync(s, "claude", fakePolicy());
  assert.deepEqual(claude.seeded.map((e) => e.text), ["5 days in Italy", "Car or trains?", "Trains", "Rome + Florence plan"]);
  store.remember(s, "claude", [{ role: "user", text: "Add a day in Venice" }, { role: "assistant", text: "Venice added" }]);

  // Back to DeepSeek: it only needs the turn Claude handled.
  store.sync(s, "deepseek", deepseek);
  assert.deepEqual(deepseek.seeded.map((e) => e.text), ["Add a day in Venice", "Venice added"]);
});

test("memory is short-term: only the most recent turns are kept", () => {
  const store = new SessionStore({ maxTurns: 2 });
  const s = store.get("tab");
  for (const n of [1, 2, 3]) store.remember(s, "m", [{ role: "user", text: `q${n}` }, { role: "assistant", text: `a${n}` }]);
  assert.deepEqual(s.transcript.map((e) => e.text), ["q2", "a2", "q3", "a3"]);
});

test("closing the tab forgets the session; reloading within the grace period keeps it", async () => {
  const store = new SessionStore({ closeGraceMs: 30 });
  store.get("reload").transcript.push({ role: "user", text: "hi" });
  store.get("closed").transcript.push({ role: "user", text: "bye" });

  store.scheduleClose("reload");
  store.scheduleClose("closed");
  await new Promise((r) => setTimeout(r, 10));
  store.peek("reload"); // the reloaded page checks in
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(store.peek("closed"), null, "a closed tab's memory is gone");
  assert.equal(store.peek("reload").transcript.length, 1, "a reload keeps the memory");
});

test("delete clears everything immediately (Forget / New trip)", () => {
  const store = new SessionStore();
  store.get("x").cache.set("k", 1);
  store.delete("x");
  assert.equal(store.peek("x"), null);
});
