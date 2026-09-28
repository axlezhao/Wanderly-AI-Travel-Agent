// Decides whether a failed LLM request is worth sending again, the same way
// for every provider (Anthropic SDK errors, OpenAI-compatible HTTP errors,
// network failures).

// Busy, overloaded or temporarily broken: trying again later can succeed.
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

const STATUS_REASON = {
  408: "request timed out",
  409: "conflict",
  425: "too early",
  429: "rate limited",
  500: "server error",
  502: "bad gateway",
  503: "service unavailable",
  504: "gateway timeout",
  529: "overloaded",
};

/** An error from a model provider, with enough detail for the harness to decide on a retry. */
export class ModelError extends Error {
  constructor(message, { status, retryable, retryAfterMs } = {}) {
    super(message);
    this.name = "ModelError";
    this.status = status;
    this.retryable = retryable ?? (status ? RETRYABLE_STATUS.has(status) : true);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value) {
  if (value == null || value === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** @returns {{ retryable: boolean, retryAfterMs?: number, reason: string }} */
export function classifyModelError(err) {
  if (err instanceof ModelError) {
    return { retryable: err.retryable, retryAfterMs: err.retryAfterMs, reason: describe(err.status, err.message) };
  }
  // Anthropic SDK errors (and most HTTP client errors) carry a numeric status and response headers.
  if (typeof err?.status === "number") {
    const header = err.headers?.get?.("retry-after") ?? err.headers?.["retry-after"];
    return { retryable: RETRYABLE_STATUS.has(err.status), retryAfterMs: parseRetryAfter(header), reason: describe(err.status, err.message) };
  }
  // No HTTP status: retry only if the connection failed, dropped or timed out.
  // Anything else (for example a bug) fails fast.
  const text = `${err?.name ?? ""} ${err?.message ?? ""} ${err?.cause?.code ?? ""} ${err?.cause?.message ?? ""}`;
  if (NETWORK.test(text)) return { retryable: true, reason: `network error (${String(err?.message ?? err).slice(0, 80)})` };
  return { retryable: false, reason: String(err?.message ?? err).slice(0, 100) };
}

const NETWORK = /fetch failed|network|socket|ECONN|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR|terminated|TimeoutError|timed? ?out|Connection ?error|APIConnection|other side closed|premature close|stream ended/i;

function describe(status, message) {
  if (!status) return String(message ?? "network error").slice(0, 100);
  return `${status} ${STATUS_REASON[status] ?? String(message ?? "").slice(0, 80)}`.trim();
}
