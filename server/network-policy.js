/**
 * Which addresses an outbound request is allowed to reach.
 *
 * This module answers one question — given a URL, which IP addresses may this
 * process connect to — and answers it for every caller in the app. The transport
 * that honours the answer lives in `http-client.js`, which pins its connections
 * to exactly the addresses resolved here.
 *
 * Everything in this app that touches the network on a caller's behalf -- the
 * scraper, the direct downloader, the size probe, yt-dlp itself -- goes through
 * these two. Before they existed each of those owned its own idea of what a valid
 * URL was, and all of them agreed on something weaker than it looks:
 *
 *   parse succeeds, protocol is http(s), hostname contains a dot
 *
 * None of that is an SSRF defence. `http://localhost/`, `http://127.0.0.1/`,
 * `http://[::1]/` and `http://169.254.169.254/` all pass it. So does a hostname
 * that resolves to one of those, and so does a perfectly innocent-looking URL
 * that answers a GET with a 302 to one of those. The redirect case is the one
 * that quietly defeats most hand-rolled fixes, because validating the URL the user
 * pasted says nothing about where the request actually ends up.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import { NETWORK_POLICY } from './config.js';

export class NetworkPolicyError extends Error {
  constructor(message, { url, blockedRange } = {}) {
    super(message);
    this.name = 'NetworkPolicyError';
    this.blocked = true;
    this.statusCode = 400;
    // The host is kept but never the full URL: these targets routinely carry a
    // signed token, which is a live credential while it is valid.
    this.host = hostOf(url);
    this.blockedRange = blockedRange || null;
  }
}

/** Host only, for logs, errors and traces. */
export function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

/**
 * Parse and check the shape of a URL.
 *
 * Deliberately stricter than the old inline check: embedded credentials are
 * refused because they end up in process arguments and error strings, and a
 * non-default port is fine but has to be a real port number.
 */
export function parseUrl(raw) {
  // A URL instance is accepted and normalised, because callers legitimately hold
  // one after a redirect hop and passing it back in should not be a trap.
  if (raw instanceof URL) return new URL(raw.href);
  if (typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (!candidate || candidate.length > 4096) return null;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    // Bare hostnames are common enough to be worth rescuing, but only as a host:
    // "example.com/x" is a reasonable thing to paste, "javascript:alert(1)" is not.
    try { parsed = new URL(`https://${candidate}`); } catch { return null; }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // `user:pass@host` in a URL is either a mistake or an attempt to get a secret
  // into a log line. Either way it has no business being a download source.
  if (parsed.username || parsed.password) return null;
  if (parsed.port && !/^\d+$/.test(parsed.port)) return null;
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Address classification
 * ------------------------------------------------------------------ */

/** Expand any IPv6 notation to eight 16-bit groups, or null if it is not IPv6. */
export function parseIpv6(input) {
  let text = String(input).trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // A zone index is a local interface name, never part of the address.
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  if (!text.includes(':')) return null;

  // A trailing dotted quad stands in for the last two groups. `::ffff:1.2.3.4`
  // and `::ffff:0102:0304` are the same address, so both have to land in the same
  // place or the mapped-range check below misses half of them.
  let tail = [];
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = dotted[1].split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return null;
    // Drop the colon the quad was attached to, or `::ffff:` splits into a stray
    // empty group and the whole address is rejected as malformed.
    text = text.slice(0, dotted.index).replace(/:$/, '');
    // Kept as hex strings so every group is validated by the same rule below.
    // A number here would stringify to five digits and fail its own hex test.
    tail = [
      ((octets[0] << 8) | octets[1]).toString(16),
      ((octets[2] << 8) | octets[3]).toString(16),
    ];
  }

  const gap = text.indexOf('::');
  let head;
  let rear;
  if (gap === -1) {
    head = text.split(':');
    rear = [];
    if (head.length !== 8) return null;
  } else {
    // More than one `::` is not a valid address.
    if (text.indexOf('::', gap + 1) !== -1) return null;
    const before = text.slice(0, gap);
    const after = text.slice(gap + 2);
    head = before ? before.split(':') : [];
    rear = after ? after.split(':') : [];
    // `::` has to stand for at least one group, or there are more groups than
    // an address has.
    if (head.length + rear.length + tail.length > 7) return null;
  }

  const groups = [
    ...head,
    ...Array(8 - head.length - rear.length - tail.length).fill('0'),
    ...rear,
    ...tail,
  ];
  if (groups.length !== 8) return null;

  const out = new Array(8);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    out[i] = Number.parseInt(groups[i], 16);
  }
  return out;
}

const isZeroGroups = (g, from, to) => g.slice(from, to + 1).every((x) => x === 0);

/**
 * The IPv4 address inside an IPv4-mapped or IPv4-compatible address.
 *
 * Always the *last* two groups. ::ffff:a.b.c.d and ::ffff:0a00:0001 are the same
 * address, and reading the first two groups instead of the last two is what turns
 * ::ffff:127.0.0.1 into a perfectly public-looking ::ffff:0.0.0.
 */
function embeddedIpv4(groups) {
  return [
    (groups[6] >> 8) & 0xff, groups[6] & 0xff,
    (groups[7] >> 8) & 0xff, groups[7] & 0xff,
  ].join('.');
}

/** The IPv4 address a 6to4 address (2002::/16) is tunnelled to: groups 1 and 2. */
function embedded6to4(groups) {
  return [
    (groups[1] >> 8) & 0xff, groups[1] & 0xff,
    (groups[2] >> 8) & 0xff, groups[2] & 0xff,
  ].join('.');
}

export function classifyIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return 'reserved';
  }
  const [a, b] = parts;
  if (a === 0) return 'unspecified';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  // Carrier-grade NAT. Not private, and not a place a download lives either: this
  // is where several clouds put their instance metadata service.
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 192 && b === 0) return 'reserved';
  if (a === 198 && (b === 18 || b === 19)) return 'reserved';
  if (a === 198 && b === 51) return 'reserved';
  if (a === 203 && b === 0) return 'reserved';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return 'public';
}

export function classifyAddress(address) {
  const family = net.isIP(String(address));
  if (family === 4) return classifyIpv4(address);
  if (family !== 6) return 'reserved';

  const g = parseIpv6(address);
  if (!g) return 'reserved';
  if (isZeroGroups(g, 0, 7)) return 'unspecified';
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return 'loopback';
  // ff00::/8, which is the first byte rather than the first group.
  if ((g[0] & 0xff00) === 0xff00) return 'multicast';

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) reach the same
  // host as the IPv4 address inside them. Skipping these is the classic IPv6
  // bypass: ::ffff:127.0.0.1 is a loopback address wearing a hat.
  const mapped = isZeroGroups(g, 0, 4) && g[5] === 0xffff;
  const compatible = isZeroGroups(g, 0, 5);
  if (mapped || compatible) return classifyIpv4(embeddedIpv4(g));

  // 6to4 (2002::/16) carries an IPv4 address in groups 1 and 2, and is a real
  // route to that host. Classify what it points at, not just the wrapper.
  if (g[0] === 0x2002) {
    const inner = classifyIpv4(embedded6to4(g));
    return inner === 'public' ? 'public' : inner;
  }

  if ((g[0] & 0xfe00) === 0xfc00) return 'private';         // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return 'link-local';       // fe80::/10
  if (g[0] === 0x2001 && g[1] === 0x0db8) return 'reserved';  // documentation
  if (g[0] === 0x0100 && isZeroGroups(g, 1, 3)) return 'reserved'; // discard-only
  return 'public';
}

/**
 * Ranges refused under every policy.
 *
 * None of these is somewhere a legitimate download lives, and link-local and
 * CGNAT are where cloud instance-metadata services live, which is the whole
 * reason an SSRF is worth caring about in a local app.
 */
const ALWAYS_BLOCKED = new Set(['link-local', 'cgnat', 'multicast', 'reserved', 'unspecified']);

/** Ranges refused only under `strict`. */
const PRIVATE_WHEN_STRICT = new Set(['loopback', 'private']);

export function isBlockedRange(range, policy = NETWORK_POLICY) {
  if (policy === 'open') return null;
  if (ALWAYS_BLOCKED.has(range)) return range;
  if (policy === 'strict' && PRIVATE_WHEN_STRICT.has(range)) return range;
  return null;
}

/* ------------------------------------------------------------------ *
 * Name resolution
 * ------------------------------------------------------------------ */

const isIpLiteral = (host) => net.isIP(stripBrackets(host)) !== 0;
const stripBrackets = (h) => String(h).replace(/^\[/, '').replace(/\]$/, '');

/**
 * Resolve a hostname and refuse it if *any* answer is somewhere we will not go.
 *
 * The returned list is not advice, it is a pin. `http-client.js` hands it to the
 * socket layer as its resolver, so the connection is made to one of these exact
 * addresses rather than to whatever a second lookup would have returned. That is
 * what closes the rebinding window: checking a name and then letting the runtime
 * resolve it again leaves a gap between the two, and a hostile resolver only has
 * to answer differently on the second one.
 *
 * Checking every returned address rather than just the first is also deliberate.
 * A name with both a public A record and a private one is not fixed by picking
 * the public answer, so none of them may be private.
 *
 * @returns {Promise<Array<{address: string, family: number}>>} the addresses to
 *   connect to, and the only addresses the socket layer is permitted to use.
 */
export async function resolveAndCheck(hostname, { policy = NETWORK_POLICY } = {}) {
  const literal = stripBrackets(hostname);
  const addresses = net.isIP(literal)
    ? [{ address: literal, family: net.isIP(literal) }]
    : await dns.lookup(literal, { all: true, verbatim: true }).catch((err) => {
      throw new NetworkPolicyError(
        err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN'
          ? 'That host could not be resolved.'
          : `Could not resolve that host: ${err.code || err.message}`,
        { url: `http://${literal}` },
      );
    });

  if (!addresses.length) {
    throw new NetworkPolicyError('That host resolved to no addresses.', { url: `http://${literal}` });
  }
  for (const { address } of addresses) {
    const range = isBlockedRange(classifyAddress(address), policy);
    if (range) {
      throw new NetworkPolicyError(
        `${describeRange(range)} address is not allowed as a download source. `
        + 'Set BITRATE_NETWORK_POLICY to "open" to permit it.',
        { url: `http://${literal}`, blockedRange: range },
      );
    }
  }
  return addresses;
}

export function describeRange(range) {
  return {
    unspecified: 'An unspecified',
    loopback: 'A loopback',
    private: 'A private-network',
    'link-local': 'A link-local',
    cgnat: 'A carrier-grade NAT',
    multicast: 'A multicast',
    reserved: 'A reserved',
  }[range] || 'A non-public';
}

/** Convenience: parse, then resolve and check. Throws NetworkPolicyError. */
export async function assertUrlAllowed(raw, options) {
  const parsed = parseUrl(raw);
  if (!parsed) {
    throw new NetworkPolicyError('That does not look like a valid http(s) link.', { url: String(raw) });
  }
  await resolveAndCheck(parsed.hostname, options);
  return parsed;
}



/**
 * Check a URL found *inside* a page.


/**
 * Check a URL found *inside* a page.
 *
 * This is the one people forget. Once the scraper returns a list of media URLs,
 * the direct downloader will fetch whatever it is handed, so a hostile page can
 * aim the app at any host it likes by simply putting a link in its HTML. The
 * syntax check is the same one applied to a pasted URL, for the same reason.
 *
 * Returns the normalised URL, or null if it should not be offered to the user.
 * Dropping is deliberate: one bad candidate in a list of six should not fail the
 * whole scrape.
 *
 * Only literal addresses are decided here. A hostname is allowed through and
 * resolved when the download starts, so a scrape of ten candidates does not pay
 * for ten DNS lookups before the first has been served -- and it is checked there
 * anyway, on the way to the socket.
 */
export function validateExtractedMediaUrl(raw) {
  const parsed = parseUrl(raw);
  if (!parsed) return null;
  if (isIpLiteral(parsed.hostname)) {
    const range = isBlockedRange(classifyAddress(stripBrackets(parsed.hostname)));
    if (range) return null;
  }
  return parsed.toString();
}

/**
 * The synchronous half of the check, for callers that must decide before an await.
 *
 * Literal addresses only. A hostname is allowed through here and checked properly
 * by `resolveAndCheck` on the way to the socket, which is where the answer can be
 * pinned rather than merely believed.
 */
export function quickCheck(rawUrl, policy = NETWORK_POLICY) {
  const parsed = parseUrl(rawUrl);
  if (!parsed) return { ok: false, reason: 'That does not look like a valid http(s) link.' };
  if (isIpLiteral(parsed.hostname)) {
    const range = isBlockedRange(classifyAddress(stripBrackets(parsed.hostname)), policy);
    if (range) {
      return {
        ok: false,
        reason: `${describeRange(range)} address is not allowed as a download source. `
          + 'Set BITRATE_NETWORK_POLICY to "open" to permit it.',
        range,
      };
    }
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * What this build will and will not reach. Reported by /api/health so a
 * deployment never has to be asked which policy it is running.
 */
export const policy = {
  mode: NETWORK_POLICY,
  blocks: [...ALWAYS_BLOCKED],
  strictAlsoBlocks: [...PRIVATE_WHEN_STRICT],
  open: NETWORK_POLICY === 'open',
};
