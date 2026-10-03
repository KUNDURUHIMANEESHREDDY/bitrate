/**
 * A local HTTP proxy that puts yt-dlp inside the same network policy as
 * everything else.
 *
 * The problem this exists to solve: yt-dlp is a child process with its own HTTP
 * client, its own DNS, and its own redirect handling. Checking the URL in the API
 * handler before spawning it looks like a policy and is not one. The check
 * describes the request the caller asked for; the requests yt-dlp actually makes
 * include every redirect hop, every media segment, and every API endpoint the
 * site decides to call. A perfectly innocent pasted URL that answers with a 302 to
 * 169.254.169.254 reaches the metadata service exactly as surely as asking for it
 * directly would, and no amount of validating the entry URL changes that.
 *
 * So yt-dlp is given `--proxy` pointing here, and this proxy is the only route out.
 * Each request it forwards has its destination resolved, classified, and pinned to
 * the very addresses that were approved, using the same code the rest of the app
 * uses. A hop to a refused address fails there and then, mid-chain, which is the
 * only place a redirect-aware check can act.
 *
 * Two properties matter beyond the per-request check, and both are why a plain
 * `--proxy` with a hand-written allowlist would not be enough:
 *
 *   - CONNECT is forwarded only after the target has been approved, so TLS
 *     destinations get the same treatment as plaintext ones.
 *   - The policy decision is returned to the child as a normal proxy error. yt-dlp
 *     surfaces that as a download failure naming the reason, rather than as a hang
 *     or a silent success.
 *
 * This is a filter, not a cache or a fetcher: it holds no response bodies, adds no
 * latency beyond one extra loopback hop, and streams in both directions.
 */
import http from 'node:http';
import net from 'node:net';
import { NETWORK_POLICY } from './config.js';
import { resolveAndCheck, classifyAddress, isBlockedRange, describeRange, parseUrl, NetworkPolicyError } from './network-policy.js';

/**
 * Headers that describe the client's relationship to this hop rather than the
 * request itself.
 *
 * Hop-by-hop headers are stripped because they describe a single transport
 * connection, and this one is not the connection the origin will see. `Proxy-*`
 * goes for the same reason plus to stop a caller smuggling its own proxy
 * configuration through.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function forwardable(headers) {
  // A Connection field nominates headers that are hop-by-hop for this transport
  // only, so its value has to be read: `Connection: x-smuggled` with `x-smuggled:`
  // carrying a whole request is the standard way to smuggle a second request
  // through a proxy. Dropping the nominator and forwarding the nominated header
  // would defeat the stripping entirely.
  const nominated = new Set(
    String(headers.connection || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );

  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower.startsWith('proxy-')) continue;
    if (nominated.has(lower)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Turn a policy refusal into something the child process will report usefully.
 *
 * 403 with a body is the useful answer: yt-dlp prints the proxy's response body
 * into its own error output, so the operator sees why the fetch was stopped rather
 * than a bare connection failure. A bare socket reset would be indistinguishable
 * from a broken network.
 */
function refuse(res, reason, code = 403) {
  const body = Buffer.from(reason, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(body.length),
    'Proxy-Connection': 'close',
  });
  res.end(body);
}

/**
 * Check one destination, returning the addresses to connect to.
 *
 * Throws NetworkPolicyError rather than returning a verdict, so every caller has to
 * deal with the refusal instead of quietly proceeding on a falsy value.
 */
async function approve(hostname, port, policy) {
  // A port the caller asked for explicitly is part of the destination decision, so
  // it is resolved and checked here rather than being passed through unexamined.
  const parsed = parseUrl(`http://${/^\[.*\]$/.test(hostname) ? hostname : hostname}:${port}`);
  if (!parsed) {
    throw new NetworkPolicyError('That destination is not a usable host.', { url: `http://${hostname}:${port}` });
  }
  // Literal addresses are decided without a lookup, which also means an IP in a
  // refused range never becomes a name to resolve.
  if (/^\[.*\]$/.test(hostname) || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    const bare = hostname.replace(/^\[|\]$/g, '');
    const range = isBlockedRange(classifyAddress(bare), policy);
    if (range) {
      throw new NetworkPolicyError(
        `${describeRange(range)} address is not allowed as a download source. `
        + 'Set BITRATE_NETWORK_POLICY to "open" to permit it.',
        { url: `http://${hostname}:${port}`, blockedRange: range },
      );
    }
    return [{ address: bare, family: bare.includes(':') ? 6 : 4 }];
  }
  const addresses = await resolveAndCheck(hostname, { policy });
  // The port is not part of the address, but a policy that stops private and
  // link-local destinations is aimed at services, and an unusual port is worth
  // refusing rather than guessing about.
  if (port !== 80 && port !== 443 && port < 1024) {
    throw new NetworkPolicyError(
      `Port ${port} is not allowed as a download destination.`,
      { url: `http://${hostname}:${port}`, blockedRange: 'reserved-port' },
    );
  }
  return addresses;
}

/** Split `host:port`, honouring the bracketed form an IPv6 literal requires. */
function splitHostPort(value, defaultPort) {
  const raw = String(value || '').trim();
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close === -1) return null;
    const host = raw.slice(1, close);
    const tail = raw.slice(close + 1);
    return { host, port: tail.startsWith(':') ? Number(tail.slice(1)) : defaultPort };
  }
  const idx = raw.lastIndexOf(':');
  if (idx === -1) return { host: raw, port: defaultPort };
  const port = Number(raw.slice(idx + 1));
  return { host: raw.slice(0, idx), port: Number.isFinite(port) && port > 0 ? port : defaultPort };
}

/**
 * Open a TCP connection to one of the already-approved addresses, trying each in
 * turn until one answers.
 *
 * Every candidate here is a literal that `approve` has already classified, and this
 * function never asks for a name to be resolved. That is the point of it. A
 * hostname that resolved public during the check and private a moment later is
 * only dangerous if something resolves it a second time, and nothing here can.
 * Each address gets a timeout as well, so an approved host that has gone dark
 * costs a fixed number of seconds rather than the caller's entire budget.
 *
 * Resolves to the connected socket, or null if none of the addresses answered.
 */
function connectApproved(addresses, port, timeoutMs = 15_000) {
  return new Promise((resolve) => {
    // `resolveAndCheck` refuses to hand back an empty list, so this is unreachable
    // today. It stays because the alternative failure is worse than a wrong
    // answer: with no socket there is no error event and no timeout, so an empty
    // list would leave the caller's socket open for ever.
    if (!addresses.length) { resolve(null); return; }

    let remaining = addresses.length;
    let settled = false;
    const giveUp = () => { if (!settled) { settled = true; resolve(null); } };

    for (const { address, family } of addresses) {
      const socket = net.connect({ host: address, family, port });
      const fail = () => {
        socket.destroy();
        remaining -= 1;
        if (remaining <= 0) giveUp();
      };
      const timer = setTimeout(fail, timeoutMs);
      socket.setNoDelay(true);
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', fail);
        if (settled) { socket.destroy(); return; }
        settled = true;
        resolve(socket);
      });
    }
  });
}

/**
 * Start the proxy. Returns the URL to hand yt-dlp and a handle to close it.
 *
 * Bound to loopback on an OS-assigned port so nothing off the machine can reach
 * it, and so nothing has to be configured to agree on a port number. The port is
 * still a secret of sorts — a local process could connect — so it is only ever
 * passed to a child we spawn ourselves.
 */
export async function startEgressProxy({ policy = NETWORK_POLICY, host = '127.0.0.1', port = 0 } = {}) {
  const open = new Set();

  const server = http.createServer(async (req, res) => {
    // Plaintext HTTP through the proxy: absolute-form request line.
    let target;
    try {
      target = new URL(req.url);
    } catch {
      refuse(res, 'That request had no usable destination.', 400);
      return;
    }
    try {
      const addresses = await approve(target.hostname, Number(target.port) || 80, policy);
      const upstream = http.request({
        protocol: target.protocol,
        hostname: target.hostname.replace(/^\[|\]$/g, ''),
        port: Number(target.port) || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...forwardable(req.headers), host: target.host },
        // The pin. The address was approved above; this is what stops the socket
        // performing its own lookup and reaching somewhere else.
        lookup: (_h, opts, cb) => {
          const want = opts?.family;
          const usable = (want === 4 || want === 6)
            ? addresses.filter((a) => a.family === want)
            : addresses;
          if (!usable.length) {
            cb(Object.assign(new Error(`No approved address for ${target.hostname}`), { code: 'ENOTFOUND' }));
            return;
          }
          if (opts?.all) cb(null, usable);
          else cb(null, usable[0].address, usable[0].family);
        },
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, forwardable(upstreamRes.headers));
        upstreamRes.pipe(res);
      });
      upstream.on('error', (err) => {
        if (!res.headersSent) refuse(res, `Upstream request failed: ${err.code || err.message}`, 502);
        else res.destroy();
      });
      req.pipe(upstream);
    } catch (err) {
      if (err instanceof NetworkPolicyError) refuse(res, err.message, 403);
      else refuse(res, `Proxy error: ${err.message}`, 502);
    }
  });

  // CONNECT, which is how every https:// destination reaches the proxy. The target
  // is approved before a single byte is tunnelled, so TLS is not a way around the
  // policy: by the time the tunnel exists, the destination has already been checked.
  server.on('connect', async (req, clientSocket, head) => {
    const parts = splitHostPort(req.url, 443);
    if (!parts || !parts.host) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let addresses;
    try {
      addresses = await approve(parts.host, parts.port, policy);
    } catch (err) {
      const reason = err instanceof NetworkPolicyError ? err.message : `Proxy error: ${err.message}`;
      clientSocket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
      );
      return;
    }

    // A raw TCP connection to one of the approved addresses, and nothing else.
    //
    // Deliberately not `http.request({ method: 'CONNECT' })`. That sends a CONNECT
    // request to the origin, and CONNECT is the proxy protocol: a real origin has
    // no handler for it and treats the bytes as garbage. Only another proxy answers
    // 200. Since everything behind https:// is an ordinary TLS endpoint, the tunnel
    // has to open the socket and stay out of the conversation.
    const upstream = await connectApproved(addresses, parts.port);
    if (!upstream) {
      const reason = `Could not reach ${parts.host}:${parts.port}.`;
      clientSocket.end(
        `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
      );
      return;
    }

    // Past this point the two sockets are opaque bytes to each other. Nothing in
    // between parses anything, which is what lets the client's TLS work and what
    // stops this from being a place a request could be reinterpreted.
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    open.add(upstream);
    const drop = () => {
      open.delete(upstream);
      clientSocket.destroy();
      upstream.destroy();
    };
    const release = () => open.delete(upstream);
    upstream.on('close', release);
    upstream.on('error', release);
    clientSocket.on('close', drop);
  });

  await new Promise((r) => server.listen(port, host, r));
  const actual = server.address().port;

  return {
    url: `http://${host}:${actual}`,
    port: actual,
    /** Tunnelled sockets, so shutdown does not wait on a live TLS session. */
    openConnections: () => open.size,
    async close() {
      for (const s of open) s.destroy();
      open.clear();
      await new Promise((r) => server.close(r));
    },
  };
}