import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelError, classifyModelError, parseRetryAfter } from "../src/harness/model-errors.js";

test("classifies provider errors for retrying", () => {
  const cases = [
    [new ModelError("x", { status: 503 }), true],
    [new ModelError("x", { status: 401 }), false],
    [Object.assign(new Error("Overloaded"), { status: 529 }), true], // Anthropic-style APIError
    [Object.assign(new Error("invalid x-api-key"), { status: 401 }), false],
    [new TypeError("fetch failed"), true],
    [Object.assign(new Error("Connection error."), { name: "APIConnectionError" }), true],
    [new TypeError("Cannot read properties of undefined"), false], // a bug: fail fast
  ];
  for (const [err, retryable] of cases) assert.equal(classifyModelError(err).retryable, retryable, err.message);
});

test("parses Retry-After in seconds or as a date", () => {
  assert.equal(parseRetryAfter("2"), 2000);
  assert.equal(parseRetryAfter(undefined), undefined);
  const inFive = new Date(Date.now() + 5000).toUTCString();
  assert.ok(parseRetryAfter(inFive) > 3000 && parseRetryAfter(inFive) <= 5000);
});
