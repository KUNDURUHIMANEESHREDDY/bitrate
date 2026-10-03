/**
 * Counters for the things that actually go wrong.
 *
 * The reason this exists: the honest answer to "why did my download fail?" used to
 * require reading a log, and the logs here are written for a human at a terminal
 * rather than for a question. A counter that separates "the link expired" from
 * "the origin sent a wrong Content-Range" from "we refused the address" turns
 * that from an archaeology exercise into a lookup.
 *
 * Deliberately not a dependency. A metrics library would be the largest thing in
 * this server and would need an exporter to be worth anything, and this is a
 * desktop app whose whole debugging story has to work on a machine with no
 * network. Everything here is in memory and is gone on restart, which is the right
 * trade for a process that can be relaunched.
 */

/** Known series. Declared rather than inferred so a typo is a no-op, not a leak. */
const SERIES = new Map([
  ['download_started', 'A download job began transferring.'],
  ['download_completed', 'A download finished and reached the library.'],
  ['download_failed', 'A download ended in an error.'],
  ['download_cancelled', 'A download was cancelled by the user.'],
  ['download_refreshed', 'An expired link was replaced with a fresh one mid-transfer.'],
  ['download_restarted', 'The origin changed the file, so the transfer restarted cleanly.'],
  ['bytes_transferred', 'Bytes written to disk, labelled by source.'],
  ['probe_failed', 'A metadata extraction failed.'],
  ['scrape_failed', 'A page scrape failed.'],
  ['request_refused', 'A request was refused before it did any work.'],
  ['ssrf_blocked', 'An outbound request was refused because of its destination address.'],
  ['range_rejected', 'A 206 response did not match the window that was asked for.'],
]);

const counters = new Map();
const gauges = new Map();

const key = (name, labels) => {
  if (!labels || !Object.keys(labels).length) return name;
  const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(',')}}`;
};

export function increment(name, labels, amount = 1) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + amount);
}

export function setGauge(name, value) {
  gauges.set(name, value);
}

export function get(name, labels) {
  return counters.get(key(name, labels)) || 0;
}

/** Total across every label combination of a series. */
export function total(name) {
  let sum = 0;
  for (const [k, v] of counters) if (k === name || k.startsWith(`${name}{`)) sum += v;
  return sum;
}

/**
 * Record a failure, choosing the most specific label available.
 *
 * The reason this is one function rather than a call at each site: picking the
 * right bucket is the whole value, and doing it by hand at twenty call sites
 * guarantees they disagree. SecurityPolicyError is checked before the generic
 * failure so a blocked address is not counted as "something went wrong".
 */
export function recordFailure(err, fallback = 'download_failed') {
  if (!err) { increment(fallback); return null; }

  if (err.blocked || err.blockedRange) {
    increment('ssrf_blocked', { range: err.blockedRange || 'invalid' });
    return 'ssrf_blocked';
  }
  if (err.statusCode === 429) {
    increment('request_refused', { kind: 'budget' });
    return 'request_refused';
  }
  increment(fallback, { reason: classify(err) });
  return fallback;
}

/** A short, bounded set of reasons. Free text would make every failure unique. */
function classify(err) {
  const message = String(err.message || '');
  if (/expired|invalid token|forbidden|HTTP (401|403|410)/i.test(message)) return 'link_expired';
  if (/range|content-range|window|segment/i.test(message)) return 'range_mismatch';
  if (/fetch failed|socket hang up|terminated|ECONNRESET|ETIMEDOUT|stalled/i.test(message)) return 'network';
  if (/refused the download|determine file size/i.test(message)) return 'no_size';
  if (/timeout|timed out|too long/i.test(message)) return 'timeout';
  if (/no file was written/i.test(message)) return 'no_output';
  if (err.code === 'ENOENT') return 'missing';
  return 'other';
}

/**
 * A flat snapshot for /api/metrics.
 *
 * `described` carries the meaning of each series, because a JSON blob of
 * increasing numbers tells nobody why any of them is going up.
 */
export function snapshot() {
  const series = {};
  for (const [name, help] of SERIES) series[name] = { help, value: total(name) };
  const labels = {};
  for (const [k, v] of counters) {
    if (!k.includes('{')) continue;
    labels[k] = v;
  }
  return { series, labelled: labels, gauges: Object.fromEntries(gauges) };
}

export const help = () => Object.fromEntries(SERIES);