/**
 * The outbound HTTP transport.
 *
 * Every request goes to an address that `network-policy.js` already resolved and
 * approved, and to no other. That is enforced at the socket layer rather than
 * hoped for: the addresses are handed to `http.request` as its resolver, so the
 * socket connects to one of them and never performs a second lookup of its own.
 *
 * Why not `fetch`, which would have been far less code:
 *
 *   - `fetch` resolves the hostname itself, and offers no way to supply a custom
 *     lookup, so validating a name and then letting fetch connect to it leaves a
 *     gap between the check and the connect. A name that resolves public once and
 *     private a moment later walks straight through it.
 *   - `fetch` has no dispatcher that we can construct, because undici is not a
 *     resolvable module here. There is no undici Agent to pin with.
 *
 * `node:http` does take a `lookup`, and `Readable.toWeb` gives back a standard
 * ReadableStream, so the body is still consumable with `getReader()` exactly as
 * it was under fetch.
 *
 * Redirects are never followed by the runtime either. They are walked here, one
 * hop at a time, each hop resolved and approved on its own terms. Handing the
 * chain to the HTTP client and checking only the entry URL is the same as not
 * checking it: an innocent-looking URL that answers 302 to 169.254.169.254
 * reaches the metadata service just as surely as asking for it directly would.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import { MAX_SCRAPE_REDIRECTS, NETWORK_POLICY } from './config.js';
import { parseUrl, resolveAndCheck, NetworkPolicyError } from './network-policy.js';
import { startEgressProxy } from './egress-proxy.js';

/**
 * Keep-alive agents.
 *
 * Reuse is worth having here: a segmented download opens eight windows against
 * one host, and re-handshaking each one is pure waste. It is safe to reuse a
 * socket because the socket was established to an address this module already
 * approved, and Node keys idle sockets by host and port.
 */
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
};

/**
 * The proxy yt-dlp is forced through, started on first use.
 *
 * Held here because this module already owns the address-pinning logic the proxy
 * reuses, and because both need closing on the same shutdown path. Started lazily
 * so a process that never spawns yt-dlp never opens a listening socket.
 */
let proxyPromise = null;

export function egressProxy() {
  proxyPromise ??= startEgressProxy({ policy: NETWORK_POLICY });
  return proxyPromise;
}

const stripBrackets = (h) => String(h || '').replace(/^\[/, '').replace(/\]$/, '');

/** Compose the caller's cancellation with a wall-clock deadline. `0` means none. */
function withTimeout(timeoutMs, signal) {
  if (!timeoutMs) return signal || undefined;
  const deadline = AbortSignal.timeout(timeoutMs);
  if (!signal) return deadline;
  return AbortSignal.any([signal, deadline]);
}

/**
 * A resolver that answers only from the approved list.
 *
 * It never touches DNS. That is the entire point: the addresses were resolved and
 * checked once, and this function is what makes "once" mean something. A resolver
 * that re-resolved here would reintroduce exactly the gap this module exists to
 * close, so it takes the addresses as data and hands them back.
 *
 * Node calls a lookup either per-address or in `all` mode when it wants to try
 * several address families at once, so both callback shapes are handled.
 */
export function pinnedLookup(addresses) {
  if (!Array.isArray(addresses) || !addresses.length) {
    throw new NetworkPolicyError('No approved address to connect to.');
  }
  return function lookup(hostname, options, callback) {
    // `family` may be pinned to 4 or 6 when Node is walking one family at a time.
    // Filtering stays inside the approved set, so a constraint can narrow the
    // choice but can never introduce an address that was not approved.
    const wanted = options?.family;
    const usable = (wanted === 4 || wanted === 6)
      ? addresses.filter((a) => a.family === wanted)
      : addresses;

    if (!usable.length) {
      callback(Object.assign(new Error(`No approved ${wanted === 6 ? 'IPv6' : 'IPv4'} address for ${hostname}`), { code: 'ENOTFOUND' }));
      return;
    }
    if (options?.all) {
      callback(null, usable);
      return;
    }
    callback(null, usable[0].address, usable[0].family);
  };
}

/**
 * The parts of a `fetch` Response that this codebase actually uses.
 *
 * A full Response is not implemented because nothing needs one: the callers want
 * a status, a header lookup, and a stream. Anything that starts reaching for more
 * than that is a signal to use a real Response rather than to grow this.
 */
class PinnedResponse {
  constructor(incoming, url) {
    this.status = incoming.statusCode;
    this.ok = this.status >= 200 && this.status < 300;
    this.url = url;
    /** The last hop of a manually walked redirect chain, which `url` cannot know. */
    this.finalUrl = url;
    this.headers = {
      get: (name) => {
        const v = incoming.headers[String(name).toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : (v ?? null);
      },
    };
    this._incoming = incoming;
    this._body = null;
  }

  /** The web stream, created once. Reading it consumes the socket, as it should. */
  get body() {
    if (!this._body) this._body = Readable.toWeb(this._incoming);
    return this._body;
  }

  /**
   * Give the socket up.
   *
   * This is not optional bookkeeping. A response that is not read to the end
   * cannot go back into the keep-alive pool: the pool would hand the half-read
   * socket to the next request, and that request would be parsed out of the
   * leftovers of this one. So any path that decides not to read a body must say
   * so here, and the socket is destroyed rather than reused.
   *
   * Node takes a socket back into the pool by itself once the body has been
   * consumed, so a response that *was* read fully never needs this.
   */
  destroy() {
    this._incoming.destroy();
  }

  async arrayBuffer() {
    return Buffer.from(await this.text());
  }

  async text() {
    const chunks = [];
    const reader = this.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
      }
    } finally {
      // Cancelling rather than destroying: the body was read to the end, so the
      // socket is clean and may be reused.
      try { await reader.cancel(); } catch { /* already finished */ }
    }
    return Buffer.concat(chunks).toString('utf8');
  }
}

/**
 * Make one request, to one of `addresses`.
 *
 * Takes the approved addresses rather than resolving them itself. Keeping those
 * two steps separate is what lets a caller resolve once, decide something from the
 * answer, and then connect to the very same answer.
 */
export function pinnedRequest(rawUrl, {
  method = 'GET',
  headers = {},
  signal,
  addresses,
} = {}) {
  const url = parseUrl(rawUrl);
  if (!url) {
    throw new NetworkPolicyError('That does not look like a valid http(s) link.', { url: String(rawUrl) });
  }

  const host = stripBrackets(url.hostname);
  const isTls = url.protocol === 'https:';
  // SNI and certificate verification must use the real name. Connecting to an
  // approved IP is the whole trick, and it is only safe because the name is still
  // what gets verified -- so it is set explicitly rather than inferred.
  const servername = (isTls && net.isIP(host) === 0) ? { servername: host } : {};
  // An explicit Host header would be wrong here: it has to be the name that was
  // asked for, and Node computes it from `hostname` plus the port.
  const sent = { ...headers };
  if (!Object.keys(sent).some((k) => k.toLowerCase() === 'host')) {
    sent.Host = url.host;
  }

  return new Promise((resolve, reject) => {
    const req = (isTls ? https : http).request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || (isTls ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers: sent,
      lookup: pinnedLookup(addresses),
      agent: agents[url.protocol],
      signal,
      ...servername,
    }, (res) => resolve(new PinnedResponse(res, url.toString())));

    req.on('error', (err) => reject(translate(err, url)));
    req.end();
  });
}

/**
 * Errors as they will be read by a user.
 *
 * The socket layer reports "getaddrinfo failed" for a name that has since been
 * blocked by policy, which would be both confusing and a small disclosure.
 */
function translate(err, url) {
  if (err.blocked) return err;
  if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    return new NetworkPolicyError('That host could not be resolved.', { url });
  }
  return err;
}

/**
 * Read a body, refusing to buffer more than `maxBytes`.
 *
 * The ceiling holds on the bytes actually received, not on what the origin claims
 * in a header, so a lying Content-Length cannot get past it.
 */
export async function readCapped(res, maxBytes, label = 'response') {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NetworkPolicyError(`That ${label} is larger than the ${maxBytes} byte limit.`);
  }
  if (!res.body) return '';

  const chunks = [];
  let total = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        throw new NetworkPolicyError(`That ${label} is larger than the ${maxBytes} byte limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch { /* already finished */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Request a URL, walking redirects one hop at a time.
 *
 * `timeoutMs: 0` disables the deadline. A segmented transfer passes that, because
 * a 4 GB file legitimately takes longer than any whole-request budget; the stall
 * guard in the transfer path is what catches a connection that has stopped moving
 * without ending a transfer that is still making progress.
 *
 * The deadline covers the whole chain rather than each hop, so a redirect loop
 * cannot hold a request open by being short on every individual hop.
 */
export async function safeFetch(rawUrl, {
  method = 'GET',
  headers = {},
  signal,
  timeoutMs = 30_000,
  maxRedirects = MAX_SCRAPE_REDIRECTS,
  policy,
} = {}) {
  let current = parseUrl(rawUrl);
  if (!current) {
    throw new NetworkPolicyError('That does not look like a valid http(s) link.', { url: String(rawUrl) });
  }

  const deadline = withTimeout(timeoutMs, signal);

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // Resolve and approve *this* hop, then connect to exactly what came back.
    // A redirect to a new host therefore gets its own lookup and its own check.
    const addresses = await resolveAndCheck(current.hostname, { policy });
    const res = await pinnedRequest(current, { method, headers, signal: deadline, addresses });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) {
      // Nothing else will be read from a response nobody wants, so the socket is
      // released rather than left to time out.
      if (!res.ok) res.destroy();
      return res;
    }

    // A redirect body is not going to be read either.
    res.destroy();

    let next;
    try {
      next = new URL(location, current);
    } catch {
      throw new NetworkPolicyError('That link redirected somewhere unreadable.', { url: current });
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new NetworkPolicyError('That link redirected to an unsupported scheme.', { url: current });
    }
    if (next.username || next.password) {
      throw new NetworkPolicyError('That link redirected somewhere carrying credentials.', { url: current });
    }
    current = next;
  }

  throw new NetworkPolicyError(`That link redirected more than ${maxRedirects} times.`, { url: rawUrl });
}

/**
 * Close the shared egress proxy.
 *
 * Defined here rather than re-exported, because the lifecycle belongs with the
 * sockets the proxy exists to constrain: it is the same concern as the agents
 * below, and shutdown should have one outbound boundary to close rather than two.
 */
export async function closeEgressProxy() {
  const pending = proxyPromise;
  proxyPromise = null;
  if (pending) {
    const proxy = await pending.catch(() => null);
    await proxy?.close();
  }
}

/** Release idle sockets. Called on shutdown so a test process can exit promptly. */
export function closeClient() {
  for (const agent of Object.values(agents)) agent.destroy();
}