/**
 * Resource budgets, enforced.
 *
 * config.js holds the numbers. This holds the machinery that makes them mean
 * something, which is the part that is easy to skip and expensive to skip: a body
 * limit says nothing about the response the server then fetches on the caller's
 * behalf, and a download concurrency limit says nothing about how many metadata
 * extractions a caller can have running at once. Each of these caps one way a
 * single request becomes a lot of work.
 */
import {
  RATE_WINDOW_MS, RATE_LIMIT_DEFAULT, RATE_LIMIT_PROBE,
  RATE_LIMIT_SCRAPE, RATE_LIMIT_CREATE,
  MAX_CONCURRENT_PROBES, MAX_CONCURRENT_SCRAPES,
} from './config.js';

export class BudgetError extends Error {
  constructor(message, { retryAfter } = {}) {
    super(message);
    this.name = 'BudgetError';
    this.statusCode = 429;
    this.retryAfter = retryAfter ?? null;
  }
}

/**
 * Fixed-window request counter, keyed by client.
 *
 * A fixed window rather than a sliding one: it needs no per-request bookkeeping
 * and the imprecision at a window boundary does not matter for a budget whose
 * purpose is to stop a runaway caller rather than to enforce a quota precisely.
 */
export class RateLimiter {
  #hits = new Map();
  #limit;
  #windowMs;

  constructor({ limit = RATE_LIMIT_DEFAULT, windowMs = RATE_WINDOW_MS } = {}) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  check(key, limit = this.#limit) {
    const now = Date.now();
    const entry = this.#hits.get(key);
    // Resetting an expired window lazily, on the next request, is what keeps a
    // caller that has stopped asking from holding an entry for ever.
    if (!entry || now >= entry.resetAt) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return { ok: true, remaining: limit - 1 };
    }
    if (limit > 0 && entry.count >= limit) {
      return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.count += 1;
    return { ok: true, remaining: limit > 0 ? limit - entry.count : null };
  }

  /** Forget clients that have been quiet for a whole window. */
  sweep() {
    const now = Date.now();
    for (const [key, entry] of this.#hits) {
      if (now >= entry.resetAt) this.#hits.delete(key);
    }
  }
}

/**
 * A bounded set of concurrent operations.
 *
 * Queueing rather than rejecting: a scrape is short, so a second one arriving
 * while the first is in flight is better off waiting a moment than being told no.
 * The bound still holds, which is the part that matters.
 */
export class Gate {
  #limit;
  #active = 0;
  #waiters = [];

  constructor(limit) {
    this.#limit = Math.max(1, limit);
  }

  get active() { return this.#active; }
  get waiting() { return this.#waiters.length; }
  get limit() { return this.#limit; }

  async run(fn, ...args) {
    if (this.#active >= this.#limit) await this.#acquire();
    else this.#active += 1;
    try {
      // Arguments have to be forwarded explicitly. Calling `fn()` instead would
      // silently turn every gated call into a call with no arguments, which reads
      // as a bizarre error somewhere else entirely rather than as a bug here.
      return await fn(...args);
    } finally {
      this.#release();
    }
  }

  #acquire() {
    return new Promise((resolve) => {
      this.#waiters.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release() {
    this.#active -= 1;
    const next = this.#waiters.shift();
    if (next) next();
  }
}

export const gates = {
  probe: new Gate(MAX_CONCURRENT_PROBES),
  scrape: new Gate(MAX_CONCURRENT_SCRAPES),
};

const limiter = new RateLimiter();

/**
 * Which budget a route spends.
 *
 * Reads are cheap and the UI polls, so they get a generous allowance. The three
 * expensive routes each get their own so that flooding one does not consume
 * another's.
 */
export function routeBudget(url = '') {
  if (url.startsWith('/api/probe')) return RATE_LIMIT_PROBE;
  if (url.startsWith('/api/scrape')) return RATE_LIMIT_SCRAPE;
  if (url.startsWith('/api/downloads')) return RATE_LIMIT_CREATE;
  return RATE_LIMIT_DEFAULT;
}

/**
 * Charge a client's budget for one request, or refuse it.
 *
 * The client key is the socket address. On a loopback bind that is always
 * 127.0.0.1, so this does not stop a page in the browser from driving the API --
 * the Origin check in app.js does that, because that attack arrives as ordinary
 * same-machine traffic and is indistinguishable by address. What this stops is a
 * process that loops on an endpoint by mistake, which is a real failure mode for
 * anything with a queue behind it.
 */
export function chargeRequest(clientKey, url) {
  const limit = routeBudget(url);
  const verdict = limiter.check(clientKey, limit);
  if (!verdict.ok) {
    throw new BudgetError(
      `Too many requests. Try again in ${verdict.retryAfter}s.`,
      { retryAfter: verdict.retryAfter },
    );
  }
  return verdict;
}

// Keep the limiter from growing without bound in a long-lived desktop process.
const sweeper = setInterval(() => limiter.sweep(), RATE_WINDOW_MS);
sweeper.unref?.();

export const budgets = () => ({
  probesInFlight: gates.probe.active,
  probesWaiting: gates.probe.waiting,
  scrapesInFlight: gates.scrape.active,
  scrapesWaiting: gates.scrape.waiting,
});