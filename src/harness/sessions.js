// Short-term memory: one session per browser tab, kept only in this server's
// memory (never written to disk).
//
// A session holds:
//   transcript  what was said (user messages + final answers). This is the
//               agent's memory, shared by every model: switch from DeepSeek to
//               Claude mid-chat and Claude still knows the earlier trips.
//   policies    each model's own full conversation (with tool calls)
//   cache       tool results, so repeated lookups are instant
//
// It is forgotten when the tab closes (the page sends a beacon; a short grace
// period lets a simple reload keep it), on "New trip", or after being idle.

export class SessionStore {
  constructor({ idleTtlMs = 30 * 60 * 1000, closeGraceMs = 15 * 1000, maxTurns = 40 } = {}) {
    this.sessions = new Map();
    this.idleTtlMs = idleTtlMs;
    this.closeGraceMs = closeGraceMs;
    this.maxTurns = maxTurns;
    this.sweeper = setInterval(() => this.#sweep(), 60 * 1000);
    this.sweeper.unref?.();
  }

  get(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, transcript: [], policies: {}, synced: {}, cache: new Map(), busy: false, closeTimer: null };
      this.sessions.set(id, s);
    }
    this.#touch(s);
    return s;
  }

  peek(id) {
    const s = this.sessions.get(id);
    if (s) this.#touch(s);
    return s ?? null;
  }

  // Bring a model's own history up to date with turns other models handled,
  // then return it.
  sync(session, modelId, policy) {
    const from = session.synced[modelId] ?? 0;
    const missed = session.transcript.slice(from);
    if (missed.length) policy.seedHistory?.(missed);
    session.synced[modelId] = session.transcript.length;
    return policy;
  }

  remember(session, modelId, entries) {
    session.transcript.push(...entries);
    // Keep memory short-term: drop the oldest turns beyond the limit.
    const overflow = session.transcript.length - this.maxTurns * 2;
    if (overflow > 0) {
      session.transcript.splice(0, overflow);
      for (const k of Object.keys(session.synced)) session.synced[k] = Math.max(0, session.synced[k] - overflow);
    }
    // The model that produced these turns already has them in its own history.
    session.synced[modelId] = session.transcript.length;
  }

  // The tab went away: forget the session unless it comes back (reload) soon.
  scheduleClose(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    clearTimeout(s.closeTimer);
    s.closeTimer = setTimeout(() => this.sessions.delete(id), this.closeGraceMs);
    s.closeTimer.unref?.();
  }

  delete(id) {
    const s = this.sessions.get(id);
    if (s) clearTimeout(s.closeTimer);
    this.sessions.delete(id);
  }

  #touch(s) {
    s.lastUsed = Date.now();
    clearTimeout(s.closeTimer);
    s.closeTimer = null;
  }

  #sweep() {
    for (const [id, s] of this.sessions) {
      if (!s.busy && Date.now() - s.lastUsed > this.idleTtlMs) this.delete(id);
    }
  }
}
