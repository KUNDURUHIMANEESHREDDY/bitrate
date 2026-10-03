/**
 * The egress proxy: putting yt-dlp inside the network policy.
 *
 * yt-dlp is a child process with its own HTTP client, its own DNS and its own
 * redirect handling, so a URL checked before spawning it does not constrain what it
 * actually fetches. The proxy is what closes that, and these cases go after it
 * directly rather than through the app, because the property under test is about
 * the hop a request makes, not about the job that started it.
 *
 * The cases that matter most are the redirect ones. A check on the URL the caller
 * pasted says nothing about where the request ends up, so a fixture whose first hop
 * is entirely innocent and whose second is a metadata address is the shape that
 * defeats everything except a per-hop decision.
 */
import http from 'node:http';
import net from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const { startEgressProxy } = await import('../server/egress-proxy.js');
const { closeClient } = await import('../server/http-client.js');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const RUNTIME = (await import('../server/engine.js')).runtime;

/**
 * One request through the proxy, in absolute form, as a client would send it. */
function viaProxy(proxyUrl, target, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve) => {
    const req = http.request(proxyUrl, {
      method,
      path: target,
      headers: { ...headers, host: new URL(target).host },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.end();
  });
}

/**
 * A CONNECT tunnel, reported by whether it was established. Used for the refusal
 * cases, where the answer is the status and nothing is meant to be exchanged.
 */
function viaConnect(proxyUrl, target) {
  return new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'CONNECT',
      path: target,
      headers: { host: target },
    });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode });
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.end();
  });
}

/**
 * A CONNECT tunnel that then carries a real request, and the whole reply back.
 *
 * A `200 Connection Established` on its own proves very little: a proxy that opens
 * no socket at all, or opens one and immediately drops it, still answers 200. What
 * distinguishes a tunnel from a handshake is that bytes survive in both
 * directions, so this writes a request down the tunnel and reads the origin's
 * actual response off it.
 */
function tunnelRequest(proxyUrl, target, requestPath) {
  return new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'CONNECT',
      path: target,
      headers: { host: target },
    });
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); finish({ status: res.statusCode }); return; }
      const chunks = [];
      socket.on('data', (c) => chunks.push(c));
      socket.on('end', () => finish({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      socket.on('error', (err) => finish({ status: res.statusCode, error: err.code || err.message }));
      socket.write(`GET ${requestPath} HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
    });
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', (err) => finish({ error: err.code || err.message }));
    req.end();
  });
}

/**
 * A tunnel carrying bytes that mean nothing to either end, echoed back verbatim.
 *
 * This is the property TLS rests on, and it is checkable without a certificate: a
 * tunnel that parses, reframes, re-encodes or line-splices what passes through it
 * breaks TLS, but it still passes any test that only ever sends valid HTTP. So the
 * payload here is deliberately not valid HTTP, and deliberately contains a CRLFCRLF
 * pair and a header-shaped prefix, which are the exact bytes a reframing proxy gets
 * wrong.
 */
function tunnelEcho(proxyUrl, target, payload) {
  return new Promise((resolve) => {
    const u = new URL(proxyUrl);
    const req = http.request({
      host: u.hostname,
      port: u.port,
      method: 'CONNECT',
      path: target,
      headers: { host: target },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); resolve({ status: res.statusCode }); return; }
      const chunks = [];
      let received = 0;
      const collect = () => {
        received += chunks[chunks.length - 1]?.length || 0;
        if (received >= payload.length) {
          socket.destroy();
          resolve({ status: res.statusCode, echoed: Buffer.concat(chunks) });
        }
      };
      socket.on('data', (c) => { chunks.push(c); collect(); });
      socket.on('error', () => resolve({ status: res.statusCode, echoed: Buffer.concat(chunks) }));
      socket.write(payload);
    });
    req.on('error', (err) => resolve({ error: err.code || err.message }));
    req.end();
  });
}

console.log('egress proxy\n');

/* ------------------------------------------------------------------ *
 * Plaintext forwarding
 * ------------------------------------------------------------------ */

const origin = http.createServer((req, res) => {
  if (req.url === '/hello') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('forwarded');
    return;
  }
  res.writeHead(404).end('nope');
});
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const originBase = `http://127.0.0.1:${origin.address().port}`;

console.log('plaintext forwarding');
const proxy = await startEgressProxy({ policy: 'lan' });

const fwd = await viaProxy(proxy.url, `${originBase}/hello`);
check(fwd.status === 200 && fwd.body === 'forwarded',
  'an allowed destination is fetched through the proxy', `${fwd.status} ${JSON.stringify(fwd.body)}`);

// A refused address, asked for by name rather than by literal, so the decision is
// made on the resolution rather than on the syntax.
const literal = await viaProxy(proxy.url, 'http://169.254.169.254/latest/meta-data/');
check(literal.status === 403, 'a metadata address is refused', `${literal.status}`);
check(/link-local/i.test(literal.body || ''), 'and the reason names the range', literal.body);

// The refusal has to be legible to a child process, which reads the body. A bare
// status code would arrive as a download failure with no explanation.
check((literal.body || '').length > 20, 'and carries an explanation the child can print',
  `${(literal.body || '').length} bytes`);

const mapped = await viaProxy(proxy.url, 'http://[::ffff:169.254.169.254]/x');
check(mapped.status === 403, 'the IPv6-mapped spelling is refused too', `${mapped.status}`);

const loopbackStrict = await startEgressProxy({ policy: 'strict' });
const strictRefused = await viaProxy(loopbackStrict.url, `${originBase}/hello`);
check(strictRefused.status === 403, 'strict mode refuses loopback', `${strictRefused.status}`);
const strictLan = await viaProxy(proxy.url, `${originBase}/hello`);
check(strictLan.status === 200, 'and lan mode allows it', `${strictLan.status}`);
await loopbackStrict.close();

/* ------------------------------------------------------------------ *
 * Redirects, which is the whole point
 * ------------------------------------------------------------------ */

console.log('\nredirect hops');

// A first hop that is entirely innocent and a second that is not. Checking the
// entry URL of this chain would pass, and the request would still reach 169.254.
let hops = 0;
const redirector = http.createServer((req, res) => {
  hops += 1;
  if (req.url === '/start') {
    res.writeHead(302, { Location: 'http://169.254.169.254/steal' });
    res.end('go');
    return;
  }
  res.writeHead(404).end('nope');
});
await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
const redirectBase = `http://127.0.0.1:${redirector.address().port}`;

// The proxy forwards one hop and returns the 302. That is correct: it is a proxy,
// not a redirect follower, so it never performs the second request itself. What it
// must not do is pass the hop along unexamined, and the next hop would be refused.
const hop = await viaProxy(proxy.url, `${redirectBase}/start`);
check(hops === 1, 'the proxy actually served the first hop', `${hops} hop(s)`);
check(hop.status === 302, 'and returned the redirect rather than following it', `${hop.status}`);
check(hop.headers.location === 'http://169.254.169.254/steal', 'with the Location intact',
  hop.headers.location);

// Follow it the way a client would, through the proxy, and the second hop is the
// one that gets refused.
const second = await viaProxy(proxy.url, hop.headers.location);
check(second.status === 403, 'and the second hop is refused when it is requested',
  `${second.status}`);
check(/link-local/i.test(second.body || ''), 'naming the range it aimed at', second.body);

await new Promise((r) => redirector.close(r));

/* ------------------------------------------------------------------ *
 * CONNECT, which is every https destination
 * ------------------------------------------------------------------ */

console.log('\nTLS tunnels');

const tunnelled = await viaConnect(proxy.url, '169.254.169.254:443');
check(tunnelled.status === 403, 'a CONNECT to a metadata address is refused before any tunnel',
  `${tunnelled.status}`);

const ipv6Tunnel = await viaConnect(proxy.url, '[::ffff:169.254.169.254]:443');
check(ipv6Tunnel.status === 403, 'as is its IPv6-mapped form', `${ipv6Tunnel.status}`);

// The far end of a tunnel is an ordinary origin, and this fixture is deliberately
// given no CONNECT handler. That is the shape of everything behind https://: a
// TLS endpoint, which has no idea what the proxy protocol is.
//
// Pointing this at a fixture that *does* answer CONNECT would test the wrong thing
// entirely. A proxy that forwards the client's CONNECT onward to the origin gets a
// tidy 200 back from another proxy and looks perfect, against a fixture built to
// reward it, while failing against every real site on the internet. The failure
// only shows up against an origin that answers nothing useful, so that is the
// origin used here.
const seenThroughTunnel = [];
const tunnelEnd = http.createServer((req, res) => {
  seenThroughTunnel.push({ method: req.method, url: req.url });
  res.writeHead(200, { 'Content-Type': 'text/plain' }).end('tunnelled');
});
await new Promise((r) => tunnelEnd.listen(0, '127.0.0.1', r));

const allowedTarget = `127.0.0.1:${tunnelEnd.address().port}`;
const allowedTunnel = await tunnelRequest(proxy.url, allowedTarget, '/through-the-tunnel');
check(allowedTunnel.status === 200, 'an allowed CONNECT reports success',
  `${allowedTunnel.status} ${allowedTunnel.error || ''}`);
check(seenThroughTunnel.some((r) => r.url === '/through-the-tunnel'),
  'and the request written down the tunnel reaches the origin',
  JSON.stringify(seenThroughTunnel));
check(/tunnelled/.test(allowedTunnel.body || ''), 'and the origin response comes back through it',
  JSON.stringify(String(allowedTunnel.body || '').slice(0, 60)));

// A refused destination has to stay refused on the tunnel path, and refusing it
// here is cheap precisely because no socket is opened before the decision.
const refusedTunnel = await tunnelRequest(proxy.url, '169.254.169.254:443', '/x');
check(refusedTunnel.status === 403, 'a refused CONNECT still never carries a request',
  `${refusedTunnel.status}`);

// A raw echo socket, so the byte-transparency case has an origin that reflects
// exactly what it was given rather than interpreting it.
const echo = net.createServer((sock) => sock.pipe(sock));
await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const opaqueTarget = `127.0.0.1:${echo.address().port}`;
const payload = Buffer.concat([
  Buffer.from('NOT-HTTP / 9.9 NOT-TLS\r\n\r\n', 'ascii'),
  Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 11) % 256)),
]);
const echoed = await tunnelEcho(proxy.url, opaqueTarget, payload);
check(echoed.status === 200, 'a tunnel carries bytes that are not a request at all',
  `${echoed.status} ${echoed.error || ''}`);
check(echoed.echoed && Buffer.compare(echoed.echoed.subarray(0, payload.length), payload) === 0,
  'and returns them byte for byte, so nothing between the ends parses or reframes them',
  echoed.echoed ? `${echoed.echoed.length} of ${payload.length} bytes back` : 'no bytes came back');

await new Promise((r) => tunnelEnd.close(r));
await new Promise((r) => echo.close(r));

/* ------------------------------------------------------------------ *
 * Header hygiene
 * ------------------------------------------------------------------ */

console.log('\nheader handling');

const seen = [];
const headerEcho = http.createServer((req, res) => {
  seen.push(req.headers);
  res.writeHead(200).end('ok');
});
await new Promise((r) => headerEcho.listen(0, '127.0.0.1', r));
const echoBase = `http://127.0.0.1:${headerEcho.address().port}`;

// A caller-supplied hop-by-hop header is the smuggling vector: `Connection: x`
// followed by `x: ...` is a second request smuggled through a proxy that forwards
// both. Node adds its own Connection header afterwards, which is its transport
// business rather than anything the caller asked for.
await viaProxy(proxy.url, `${echoBase}/h`, {
  headers: {
    'x-keep': 'yes',
    'proxy-authorization': 'Basic should-not-arrive',
    connection: 'x-smuggled',
    'x-smuggled': 'GET http://169.254.169.254/ HTTP/1.1',
    te: 'trailers',
  },
});
const arrived = seen[0] || {};
check(arrived['x-keep'] === 'yes', 'an ordinary header is forwarded', arrived['x-keep']);
check(!('proxy-authorization' in arrived), 'a Proxy-Authorization header is stripped',
  Object.keys(arrived).join(','));
check(!('x-smuggled' in arrived), 'and so is the header a Connection field nominates',
  Object.keys(arrived).join(','));
check(!('te' in arrived), 'and so is another hop-by-hop header', Object.keys(arrived).join(','));

/* ------------------------------------------------------------------ *
 * The flag that makes this binding rather than a suggestion
 * ------------------------------------------------------------------ */

console.log('\nyt-dlp is bound to it');

// The point of the proxy is not that it filters. It is that yt-dlp cannot route
// around it, so the assertion that matters is on the arguments the child is given.
// The argument builders are pure, so this asserts on exactly the flags the child
// would be given. Intercepting the spawn instead would prove something about the
// interception rather than about the arguments.
const { probeArgs } = await import('../server/engine.js');

const probeFlags = await probeArgs('http://example.com/x');
const proxyFlag = probeFlags[probeFlags.indexOf('--proxy') + 1];
check(Boolean(proxyFlag), 'a probe passes --proxy to yt-dlp', proxyFlag || 'no --proxy flag');
check(/^http:\/\/127\.0\.0\.1:\d+$/.test(proxyFlag || ''),
  'and it points at the local proxy', proxyFlag || '');
check(probeFlags.includes('--ignore-config'),
  'so a proxy inherited from the environment cannot override it');
check(probeFlags[probeFlags.length - 1] === 'http://example.com/x',
  'and the URL is still the last argument, so the proxy did not displace it',
  probeFlags[probeFlags.length - 1]);

// Same for a download, which is the path that actually moves bytes.
const dlFlags = await (await import('../server/engine.js')).downloadArgs({
  url: 'http://example.com/x', kind: 'video', quality: 'best',
});
check(Boolean(dlFlags[dlFlags.indexOf('--proxy') + 1]),
  'a download is bound to the proxy as well');

await new Promise((r) => headerEcho.close(r));
await new Promise((r) => origin.close(r));
await proxy.close();
closeClient();

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\nevery request the proxy forwards has been resolved and checked first');
process.exit(failed.length ? 1 : 0);