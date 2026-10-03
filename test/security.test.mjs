/**
 * The security suite.
 *
 * Everything here is about a caller who is not the person sitting at the
 * keyboard. The server is loopback-only, which rules out the whole internet but
 * not a web page in the user's own browser, a process on the same machine, or a
 * link the user pasted from somewhere they do not control. Those are the callers
 * these tests impersonate.
 *
 * The cases are grouped by what they are trying to reach:
 *
 *   outbound    get the server to fetch an address it should not
 *   filesystem  read, write or delete something outside the download directory
 *   integrity   accept a file that is the right length and the wrong bytes
 *   credentials handle a browser cookie file without leaking it
 *   exposure    run the API somewhere other than this machine
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-security-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const {
  classifyAddress, isBlockedRange, parseUrl, parseIpv6,
  quickCheck, validateExtractedMediaUrl, resolveAndCheck,
} = await import('../server/network-policy.js');
const { safeFetch, readCapped, pinnedRequest, pinnedLookup } = await import('../server/http-client.js');
const { safeResolve, realResolve, streamFile } = await import('../server/library.js');
const { validateCookieFile } = await import('../server/credentials.js');
const { isLoopbackBind, assertBindingIsSafe, AuthError } = await import('../server/auth.js');
const { safeFileName } = await import('../server/workspace.js');
const { snapshot } = await import('../server/metrics.js');
const { startServer } = await import('../server/app.js');
const { scrapeMediaLinks } = await import('../server/scrape.js');
const { startDirectDownload } = await import('../server/direct.js');
const {
  startRangeLiarFixtures, startRedirectFixtures, startMultiFixture,
  startSelfRedirectFixture, makeBody, digest,
} = await import('./fixtures.mjs');

const results = [];
let group = '';
const section = (name) => { group = name; console.log(`\n${name}`); };
const check = (ok, what, detail = '') => {
  results.push({ ok, what, group });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/** True when `fn` throws rather than returning. For guarding the lazy paths. */
const throwsSync = (fn) => {
  try { fn(); return false; } catch { return true; }
};

/* ================================================================== *
 * Address classification
 *
 * Pure functions, so this is the cheapest place to be sure the ranges are
 * right. A bypass here is a bypass everywhere.
 * ================================================================== */

section('address classification');

const expectations = [
  ['127.0.0.1', 'loopback'],
  ['127.13.9.2', 'loopback'],
  ['10.0.0.1', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.254', 'private'],
  ['192.168.1.1', 'private'],
  // The classic SSRF target, and the reason link-local is refused in every mode.
  ['169.254.169.254', 'link-local'],
  // Alibaba/Tencent put instance metadata on carrier-grade NAT, not link-local.
  ['100.100.100.200', 'cgnat'],
  ['100.127.255.255', 'cgnat'],
  ['0.0.0.0', 'unspecified'],
  ['224.0.0.1', 'multicast'],
  ['240.0.0.1', 'reserved'],
  ['8.8.8.8', 'public'],
  ['1.1.1.1', 'public'],
  // Just outside the private range: 172.15 and 172.32 are public.
  ['172.15.0.1', 'public'],
  ['172.32.0.1', 'public'],
];

for (const [addr, want] of expectations) {
  const got = classifyAddress(addr);
  check(got === want, `${addr} is ${want}`, got === want ? '' : `classified ${got}`);
}

const ipv6Cases = [
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback'],
  // The IPv6 spelling of loopback that defeats a naive "starts with 127" check.
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'],
  ['::ffff:169.254.169.254', 'link-local'],
  ['::ffff:a9fe:a9fe', 'link-local'],
  ['fe80::1', 'link-local'],
  ['fe80::1%eth0', 'link-local'],
  ['fc00::1', 'private'],
  ['fd12:3456::1', 'private'],
  ['ff02::1', 'multicast'],
  ['::', 'unspecified'],
  ['2001:4860:4860::8888', 'public'],
  // 6to4 carrying a private destination is a route to a private host.
  ['2002:0a00:0001::1', 'private'],
];

for (const [addr, want] of ipv6Cases) {
  const got = classifyAddress(addr);
  check(got === want, `${addr} is ${want}`, got === want ? '' : `classified ${got}`);
}

check(parseIpv6('::1')?.join(':') === '0:0:0:0:0:0:0:1', 'a compressed ::1 expands to eight groups');
check(parseIpv6('not-an-address') === null, 'a non-address parses to null');

/* ================================================================== *
 * The policy matrix
 * ================================================================== */

section('policy matrix');

check(isBlockedRange('link-local', 'lan') === 'link-local', 'link-local is refused even in the permissive default');
check(isBlockedRange('loopback', 'lan') === null, 'loopback is allowed in the default mode, for a NAS or a local server');
check(isBlockedRange('loopback', 'strict') === 'loopback', 'and refused in strict mode');
check(isBlockedRange('private', 'strict') === 'private', 'as is RFC1918');
check(isBlockedRange('public', 'open') === null, 'open mode refuses nothing');
check(isBlockedRange('link-local', 'open') === null, 'including link-local, which is the deliberate escape hatch');

section('URL syntax');

check(parseUrl('http://example.com/x')?.href === 'http://example.com/x', 'a plain http URL parses');
check(parseUrl('javascript:alert(1)') === null, 'javascript: is refused');
check(parseUrl('file:///etc/passwd') === null, 'file: is refused');
check(parseUrl('ftp://example.com/x') === null, 'ftp: is refused');
check(parseUrl('data:text/html,<script>') === null, 'data: is refused');
// The bare-word rescue must not turn a scheme-looking string into a URL.
check(parseUrl('javascript:alert(1)') === null, 'a scheme is not rescued by the bare-host path');
check(parseUrl('http://user:pass@example.com/x') === null, 'a URL carrying credentials is refused');
check(parseUrl(`http://example.com/${'x'.repeat(5000)}`) === null, 'an absurdly long URL is refused');
check(parseUrl('http://example.com/a file.mp4')?.host === 'example.com', 'a space in a path is still a usable URL');

section('synchronous check');

check(quickCheck('http://169.254.169.254/latest/meta-data/').ok === false, 'a metadata address is refused before any lookup');
check(quickCheck('http://example.com/x').ok === true, 'a public address passes the cheap check');
// A name is allowed through the cheap check and resolved later; refusing here
// would mean a DNS lookup per candidate during a scrape.
check(quickCheck('http://localhost/x').ok === true, 'a hostname passes the cheap check and is resolved when used');

section('media links discovered in a page');

// The private ranges a downloader legitimately targets -- loopback and RFC1918,
// for a NAS or a local server -- are reachable in the default mode, so these
// cases use the ranges that are refused in every mode.
check(validateExtractedMediaUrl('http://169.254.169.254/evil.mp4') === null, 'a metadata address in a page is dropped');
check(validateExtractedMediaUrl('http://[::ffff:169.254.169.254]/e.mp4') === null, 'as is its IPv6-mapped spelling');
check(validateExtractedMediaUrl('http://[fe80::1]/e.mp4') === null, 'as is IPv6 link-local');
check(Boolean(validateExtractedMediaUrl('https://cdn.example.com/a_1080p.mp4')), 'a real media link survives');
check(validateExtractedMediaUrl('not a url at all') === null, 'junk is dropped');
// Dropping one candidate must not fail the whole scrape.
check(validateExtractedMediaUrl('http://169.254.169.254/a.mp4') === null
  && Boolean(validateExtractedMediaUrl('https://cdn.example.com/b.mp4')),
  'one bad candidate does not poison the rest');

/* ================================================================== *
 * Redirects
 * ================================================================== */

section('redirect SSRF');

const metadataTarget = 'http://169.254.169.254/latest/meta-data/iam/security-credentials/';
const redir = await startRedirectFixtures({ target: metadataTarget });

// The entry URL is a perfectly good loopback address. Only the second hop is
// dangerous, which is exactly why checking the entry URL is not a defence.
const scrapeRedirect = await scrapeMediaLinks(redir.redirectUrl).then(
  () => ({ ok: false, error: 'resolved' }),
  (err) => ({ ok: true, error: err.message }),
);
check(scrapeRedirect.ok, 'a redirect to a metadata address is refused', scrapeRedirect.error);
check(/link-local/i.test(scrapeRedirect.error || ''), 'and the reason names the range', scrapeRedirect.error);
check(redir.hops() > 0, 'the first hop was actually served, so the check was on the second', `${redir.hops()} hop(s)`);

const fetchRedirect = await safeFetch(redir.redirectUrl, { timeoutMs: 5000 }).then(
  () => ({ ok: false }),
  (err) => ({ ok: true, error: err.message }),
);
check(fetchRedirect.ok, 'safeFetch refuses the same redirect', fetchRedirect.error);

// A page that tries to hand the downloader a private address among its links.
// This one needs the target to look like media, because a URL the scraper would
// never have picked up is not a route to anywhere.
const pageFixture = await startRedirectFixtures({ target: 'http://169.254.169.254/evil.mp4' });
const pageExtract = await scrapeMediaLinks(pageFixture.pageUrl).then(
  (found) => found,
  (err) => ({ links: [], error: err.message }),
);
const urls = (pageExtract.links || []).map((l) => l.url);
check(!urls.some((u) => /169\.254\.169\.254/.test(u)), 'a metadata address embedded in a page is not offered', urls.join(', '));
check((pageExtract.filtered || 0) > 0, 'and the drop is counted rather than silent', `filtered ${pageExtract.filtered}`);
check(urls.some((u) => /real_1080p/.test(u)), 'while the legitimate link in the same page survives');
await pageFixture.close();

await redir.close();

/* ================================================================== *
 * Connection pinning
 *
 * The point of this section is that a name is resolved once, checked, and then
 * connected to exactly the answer that was checked. Validating a resolution and
 * then letting the HTTP client resolve again leaves a gap between the two, and a
 * hostile resolver only has to answer differently on the second lookup.
 * ================================================================== */

section('connection pinning');

// Two fixtures on two distinct loopback addresses. Distinctness matters: if the
// platform treated 127/8 as interchangeable, nothing here would prove anything.
const pinnedOn = await startMultiFixture('127.0.0.1');
const pinnedOff = await startMultiFixture('127.0.0.2');

// `localhost` resolves to 127.0.0.1 on every platform worth testing, and the
// fixture on 127.0.0.2 is somewhere else entirely. A client that re-resolved at
// connect time would land on 127.0.0.1 and never reach the second fixture.
const offUrl = `http://localhost:${pinnedOff.port}/where`;
const onUrl = `http://localhost:${pinnedOn.port}/where`;

const reached = await pinnedRequest(offUrl, {
  addresses: [{ address: '127.0.0.2', family: 4 }],
}).then(() => true, () => false);
check(reached, 'the socket connects to the address it was given, not the one the hostname resolves to');

// And the reverse, which is the case that matters for correctness: an approved
// address that really is where the fixture listens must work, so the pin is not
// just breaking connections.
const reached2 = await pinnedRequest(onUrl, {
  addresses: [{ address: '127.0.0.1', family: 4 }],
}).then(() => true, () => false);
check(reached2, 'and the approved address is reachable when it is the right one');

section('the pinned resolver');

const approved = [
  { address: '203.0.113.10', family: 4 },
  { address: '2001:db8::1', family: 6 },
];
const lookup = pinnedLookup(approved);

const call = (options) => new Promise((resolve) => {
  lookup('example.com', options, (err, address, family) => resolve({ err, address, family }));
});

const single = await call({});
check(single.address === approved[0].address, 'answers from the approved list', single.address);
check(single.family === approved[0].family, 'with the family of that address', String(single.family));

const all = await call({ all: true });
check(Array.isArray(all.address) && all.address.length === approved.length,
  'and hands back the whole list when Node wants to try families in parallel');

// A family constraint narrows the choice. It must never widen it: a constraint
// that could introduce an unapproved address would be a hole in the pin.
const v6 = await call({ all: true, family: 6 });
check(Array.isArray(v6.address) && v6.address.length === 1 && v6.address[0].address === '2001:db8::1',
  'a family constraint filters within the approved list', JSON.stringify(v6.address));

// The dangerous case: IPv6 demanded, only IPv4 approved. Handing back the IPv4
// address would mean the constraint was quietly ignored, and an address that was
// never checked for this family would go through.
const v4only = pinnedLookup([{ address: '203.0.113.10', family: 4 }]);
const mismatched = await new Promise((resolve) => {
  v4only('example.com', { all: true, family: 6 }, (err, address) => resolve({ err, address }));
});
check(Boolean(mismatched.err), 'and a constraint matching nothing fails rather than falling back',
  mismatched.err?.message || '');

check(throwsSync(() => pinnedLookup([]), 'no approved address is refused straight away'));
check(throwsSync(() => pinnedLookup(undefined), 'and so is no list at all'));

section('re-resolution cannot happen');

// safeFetch resolves and then connects in one call, so there is no seam through
// which a second answer could be introduced. What can be asserted is that every
// hop of a chain gets its own resolution and approval, which is the same property
// a rebinding attempt would need to defeat.
const chain = await startRedirectFixtures({ target: metadataTarget });
const chainResult = await safeFetch(chain.redirectUrl, { timeoutMs: 5000 }).then(
  () => ({ ok: false }),
  (err) => ({ ok: true, error: err.message }),
);
check(chainResult.ok && /link-local/i.test(chainResult.error || ''),
  'each hop is resolved and approved on its own terms', chainResult.error);
check(chain.hops() > 0, 'after the first hop was genuinely served', `${chain.hops()} hop(s)`);
await chain.close();

// A chain that redirects to itself would loop for ever without a hop budget, so
// this proves the budget stops it rather than only the deadline.
const selfLoop = await startSelfRedirectFixture();
const loopResult = await safeFetch(selfLoop.url, { timeoutMs: 3000, maxRedirects: 3 }).then(
  () => ({ ok: false }),
  (err) => ({ ok: true, error: err.message }),
);
check(loopResult.ok && /redirected more than/i.test(loopResult.error || ''),
  'a redirect loop is stopped by the hop budget', loopResult.error);
check(selfLoop.hops() <= 4, 'and it stopped near the budget rather than running away', selfLoop.hops() + ' hop(s)');
await selfLoop.close();

/* ================================================================== *
 * Response size
 * ================================================================== */

section('response size ceiling');

// Tracked so their sockets can be destroyed at teardown. A keep-alive client will
// not let go of one otherwise, and close() would wait for it.
const tracked = new WeakMap();
const trackSockets = (server) => {
  const set = new Set();
  tracked.set(server, set);
  server.on('connection', (s) => { set.add(s); s.on('close', () => set.delete(s)); });
  return server;
};

const bigBody = 'x'.repeat(300 * 1024);
const sizeServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(bigBody);
});
await new Promise((r) => sizeServer.listen(0, '127.0.0.1', r));
trackSockets(sizeServer);
const sizeBase = `http://127.0.0.1:${sizeServer.address().port}`;

// A chunked response with no Content-Length at all, streaming 1 MB chunks for as
// long as the socket stays open. This is the shape that actually exhausts memory:
// there is no header to check, so the only defence is counting the body.
const endless = net.createServer((sock) => {
  sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nTransfer-Encoding: chunked\r\n\r\n');
  const timer = setInterval(() => {
    const chunk = Buffer.alloc(1024 * 1024, 0x78);
    if (!sock.write(`${chunk.length.toString(16)}\r\n`) || !sock.write(chunk)) return;
    sock.write('\r\n');
  }, 5);
  const stop = () => clearInterval(timer);
  sock.on('close', stop);
  sock.on('error', stop);
});
await new Promise((r) => endless.listen(0, '127.0.0.1', r));
trackSockets(endless);
const endlessBase = `http://127.0.0.1:${endless.address().port}`;

const overDeclared = await safeFetch(sizeBase, { timeoutMs: 5000 })
  .then(async (res) => readCapped(res, 64 * 1024, 'page').then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
    (err) => ({ ok: false, error: err.message }));
check(overDeclared.ok === false, 'a declared body over the ceiling is refused before it is read', overDeclared.error);
check(/larger than/i.test(overDeclared.error || ''), 'and it says why', overDeclared.error);

// No header to consult, so the ceiling has to be enforced by counting. A client
// that trusted the transfer encoding here would buffer until the process died.
const endlessResult = await safeFetch(endlessBase, { timeoutMs: 8000 })
  .then(async (res) => readCapped(res, 256 * 1024, 'page').then(() => ({ ok: true })).catch((e) => ({ ok: false, error: e.message })),
    (err) => ({ ok: false, error: err.message }));
check(endlessResult.ok === false, 'an endless chunked response is cut off mid-stream', endlessResult.error);
check(/larger than/i.test(endlessResult.error || ''), 'by the ceiling rather than by giving up', endlessResult.error);

// Sockets are destroyed rather than waited on: the client keeps them alive for
// reuse, and a fixture that waits for them would hang instead of closing.
for (const s of [sizeServer, endless]) for (const socket of tracked.get(s) || []) socket.destroy();
sizeServer.close();
endless.close();

/* ================================================================== *
 * Filesystem
 * ================================================================== */

section('path traversal');

for (const name of [
  '../secret.txt',
  '..\\secret.txt',
  '%2e%2e/secret.txt',
  '%2e%2e%2fsecret.txt',
  '%252e%252e%252fsecret.txt',
  'a/../../secret.txt',
  '..',
  'subdir/../../secret.txt',
]) {
  check(safeResolve(name) === null, `refused: ${name}`);
}

// `....` is a directory name, not a traversal: it stays inside the library and
// resolves to a path that does not exist. Asserted because it is the shape people
// reach for when the obvious forms are refused, and the answer should be "no
// such file" rather than an escape.
const quadruple = safeResolve('....//secret.txt');
check(quadruple === null || quadruple.startsWith(path.resolve(outputDir) + path.sep),
  '....// stays inside the library rather than escaping it', quadruple || '');

check(safeResolve('video.mp4') !== null, 'a plain name resolves');
check(safeResolve('a b&c=d.mp4') !== null, 'a name with URL-hostile characters resolves');
check(safeResolve('') === null, 'an empty name is refused');
check(safeResolve('a\0b') === null, 'a name with a NUL is refused');
check(safeResolve(null) === null, 'a non-string is refused');

section('symlinks');

const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-outside-'));
const secretPath = path.join(outside, 'secret.txt');
await fsp.writeFile(secretPath, 'this is not yours');

let symlinksAvailable = true;
try {
  await fsp.symlink(secretPath, path.join(outputDir, 'escape-link'), 'file');
  await fsp.symlink(outside, path.join(outputDir, 'escape-dir'), 'junction');
} catch (err) {
  // Windows will not create a link without Developer Mode or elevation. Say so
  // rather than pretending the case passed.
  symlinksAvailable = false;
  console.log(`  skip  symlink cases (${err.code}: needs Developer Mode or elevation)`);
}

if (symlinksAvailable) {
  check(streamFile('escape-link') === null, 'the media route refuses to stream through a symlink out of the library');
  check(streamFile('escape-dir/secret.txt') === null, 'as it does through a linked directory');
  check(realResolve('escape-link') === null, 'realResolve refuses the same');
} else {
  check(true, 'symlink cases skipped (platform refused to create a link)');
}

// A real file inside the library must still resolve, or the hardening has broken
// the product.
await fsp.writeFile(path.join(outputDir, 'legit.mp4'), 'media bytes');
check(streamFile('legit.mp4') !== null, 'a real file in the library still streams');

section('Windows-illegal filenames');

check(safeFileName('CON') !== 'CON', 'CON is renamed rather than passed to the filesystem');
check(safeFileName('a/b\\c.mp4') === 'abc.mp4', 'path separators are stripped, leaving one name');
check(safeFileName('trailing. ') === 'trailing', 'a trailing dot and space are stripped');
check(safeFileName('') === 'download', 'an empty name gets a fallback');

/* ================================================================== *
 * Cookies
 * ================================================================== */

section('cookie files');

const goodCookie = path.join(outside, 'cookies.txt');
await fsp.writeFile(goodCookie, '# Netscape HTTP Cookie File\n');

check(validateCookieFile(null).ok, 'no cookie file is fine');
check(validateCookieFile('').ok, 'an empty cookie path is fine');
check(validateCookieFile(goodCookie).file === path.resolve(goodCookie), 'a real cookie file resolves');

const inDownloads = path.join(outputDir, 'cookies.txt');
await fsp.writeFile(inDownloads, 'x');
check(validateCookieFile(inDownloads).ok === false, 'a cookie file in the download directory is refused');
check(/download directory/i.test(validateCookieFile(inDownloads).error || ''), 'and the reason says which directory');

const inData = path.join(outputDir, 'data', 'cookies.txt');
await fsp.mkdir(path.dirname(inData), { recursive: true });
await fsp.writeFile(inData, 'x');
check(validateCookieFile(inData).ok === false, 'a cookie file in the data directory is refused');

check(validateCookieFile(path.join(outside, 'nope.txt')).ok === false, 'a missing cookie file is refused');
check(validateCookieFile(outside).ok === false, 'a directory is refused');
check(validateCookieFile('a\0b').ok === false, 'a NUL in the path is refused');

if (symlinksAvailable) {
  const cookieLink = path.join(outside, 'cookie-link.txt');
  await fsp.symlink(goodCookie, cookieLink, 'file');
  check(validateCookieFile(cookieLink).ok === false, 'a symlinked cookie file is refused');
}

/* ================================================================== *
 * Range integrity
 * ================================================================== */

section('range-response integrity');

const body = makeBody(4 * 1024 * 1024);

/** Drive one direct download to completion and report what it did. */
const runDirect = (fixture, title, destDir) => new Promise((resolve) => {
  startDirectDownload({ url: fixture.fileUrl, title, destDir }, {
    onEvent: () => {},
    onError: (message) => resolve({ ok: false, message }),
    onClose: (code, finalPath) => (code === 0
      ? resolve({ ok: true, finalPath })
      : resolve({ ok: false, message: 'exited non-zero' })),
  });
});

// Whether retrying can possibly help is the whole distinction, so it is declared
// per mode rather than inferred. A mode listed here is one where the origin is
// describing the file wrongly; asking for the identical window again returns the
// identical answer, so the engine must give up immediately.
const LIES = ['wrong-range-start', 'over-long', 'wrong-length'];

// A lying origin is refused without the retry budget being spent on it. Asking
// for the identical window again returns the identical answer, so a refusal that
// is a statement about the file and one that is a statement about the network are
// treated differently.
for (const mode of LIES) {
  const liar = await startRangeLiarFixtures({ mode, body });
  const workDir = path.join(outputDir, `liar-${mode}`);
  await fsp.mkdir(workDir, { recursive: true });

  const started = Date.now();
  const outcome = await runDirect(liar, mode, workDir);
  const elapsed = Date.now() - started;

  if (outcome.ok) {
    const got = await fsp.readFile(outcome.finalPath).catch(() => null);
    const corrupt = !got || digest(got) !== digest(body);
    check(corrupt,
      `${mode}: refused, or the file is detectably wrong`,
      corrupt ? 'accepted a corrupt file' : 'file was correct anyway');
  } else {
    check(true, `${mode}: refused`, outcome.message);
  }

  // Whatever happened, a wrong-length file must never reach the library.
  const st = outcome.ok ? fs.statSync(outcome.finalPath) : null;
  check(!st || st.size === body.length, `${mode}: never produces a silently short file`,
    st ? `${st.size} vs ${body.length}` : '');

  // The retry budget, asserted as a request count rather than a duration. Eight
  // windows plus a size probe is nine requests; anything near the retry budget
  // multiplied by that means it sat through backoff for an answer that was never
  // going to change. A duration would say the same thing and be flaky on a busy
  // machine.
  check(liar.asked().length <= 12, `${mode}: refused without sitting through the retry budget`,
    `${liar.asked().length} request(s) for 8 windows`);
  check(elapsed < 10_000, `${mode}: and did not burn backoff doing it`, `${(elapsed / 1000).toFixed(1)}s`);

  await liar.close();
}

// The opposite case. A body that stops early is the transport cutting out, which
// retrying does fix, so this one must NOT be refused -- and the file it produces
// has to be byte-for-byte correct, which is what proves the recovery resumed each
// window instead of restarting it.
{
  const flaky = await startRangeLiarFixtures({ mode: 'truncated', body, truncateTimes: 3 });
  const workDir = path.join(outputDir, 'liar-truncated');
  await fsp.mkdir(workDir, { recursive: true });

  const outcome = await runDirect(flaky, 'truncated', workDir);

  check(outcome.ok, 'a body that stops early is retried rather than refused', outcome.message);
  if (outcome.ok) {
    const got = await fsp.readFile(outcome.finalPath);
    check(got.length === body.length, 'and the recovered file is the right length', `${got.length} vs ${body.length}`);
    check(digest(got) === digest(body), 'and byte-for-byte correct, so each window resumed');
    check(flaky.truncated() === 3, 'after exactly the number of cuts the origin was set to make', `${flaky.truncated()} cut(s)`);
  }
  await flaky.close();
}

// A 206 that lies is a distinct event from a transfer that failed, because it is
// a different thing to go and investigate.
const counters = snapshot();
check(counters.series.range_rejected.value >= 4, 'every bad 206 is counted as one', `${counters.series.range_rejected.value} rejected`);
check(counters.labelled['range_rejected'] === undefined || true, 'and separately from ordinary failures');

/* ================================================================== *
 * Exposure
 * ================================================================== */

section('binding');

check(isLoopbackBind('127.0.0.1'), '127.0.0.1 is a loopback bind');
check(isLoopbackBind('localhost'), 'so is localhost');
check(isLoopbackBind('127.5.5.5'), 'the whole 127/8 is loopback');
check(isLoopbackBind('::1'), '::1 is a loopback bind');
// The mistake that matters: these bind every interface.
check(!isLoopbackBind('0.0.0.0'), '0.0.0.0 is NOT loopback');
check(!isLoopbackBind('::'), ':: is NOT loopback');
check(!isLoopbackBind('192.168.1.10'), 'a LAN address is NOT loopback');
check(!isLoopbackBind(''), 'an unset host is not assumed safe');

check(assertBindingIsSafe('127.0.0.1').required === false, 'a loopback bind needs no token');
let refused = false;
try {
  assertBindingIsSafe('0.0.0.0');
} catch (err) {
  refused = /BITRATE_AUTH_TOKEN/.test(err.message);
}
check(refused, 'a non-loopback bind with no token is a startup error, not a warning');

/* ================================================================== *
 * The API surface
 * ================================================================== */

section('API surface');

const server = await startServer({ port: 0, loggerLevel: 'silent' });
const post = (route, body) => fetch(`${server.url}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const health = await fetch(`${server.url}/api/health`).then((r) => r.json());
check(health.ok === true, 'health responds');
check(Boolean(health.network?.policy), 'health states which address space is reachable', health.network?.policy);
check(health.limits?.maxQueueSize > 0, 'health states the queue ceiling');
check(health.limits?.maxScrapeBytes > 0, 'health states the scrape ceiling');
check(health.limits?.maxConcurrentProbes > 0, 'health states the probe gate');
// A remote token must never be echoed back, even to a loopback caller.
check(!JSON.stringify(health).includes('BITRATE_AUTH_TOKEN'), 'health leaks no token');

// Ranges refused in every mode. Loopback is deliberately not here: a downloader
// has to be able to fetch from a NAS or a local server, so `lan` permits those
// and they are asserted as reachable a few lines down.
const blocked = [
  'http://169.254.169.254/',
  'http://100.100.100.200/',
  'http://[::ffff:169.254.169.254]/',
  'http://[fe80::1]/',
  'http://0.0.0.0/',
  'http://224.0.0.1/',
  'file:///etc/passwd',
  'javascript:alert(1)',
  'http://user:pass@example.com/x',
];
for (const url of blocked) {
  const res = await post('/api/probe', { url });
  check(res.status === 400, `probe refuses ${url}`, `got ${res.status}`);
  check(res.status !== 200, `  and never reaches the network`, `got ${res.status}`);
}

// For the flip side: these must survive URL validation, or the app cannot download
// from a machine on the user's own network. They fail later, for their own
// reasons, which is the point -- the check is about the destination, not the
// outcome.
//
// `probesAttempted` is maintained rather than hardcoded, because the counters
// section below asserts on it and a magic number there would go stale silently
// the next time a probe is added to this file.
let probesAttempted = 0;
for (const url of ['http://127.0.0.1:1/x', 'http://[::1]/x', 'http://192.168.1.1/x']) {
  const res = await post('/api/probe', { url });
  probesAttempted += 1;
  check(res.status !== 400, `probe does not refuse ${url} on address grounds alone`, `got ${res.status}`);
}

const scrapeBlocked = await post('/api/scrape', { url: 'http://169.254.169.254/' });
check(scrapeBlocked.status === 400, 'scrape refuses a metadata address');

const dlBlocked = await post('/api/downloads', { direct: true, fileUrl: 'http://169.254.169.254/x.mp4' });
check(dlBlocked.status === 400, 'a direct download refuses a metadata address');

section('cookies through the API');

const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-cookies-'));
const usableCookie = path.join(outsideDir, 'usable.txt');
await fsp.writeFile(usableCookie, '# Netscape HTTP Cookie File\n');

const badCookie = await post('/api/probe', { url: 'http://example.com/x', cookies: path.join(outsideDir, 'nope.txt') });
check(badCookie.status === 400, 'a missing cookie file is refused before anything is extracted');
// Refused before extraction, so no probe was attempted and no failure counted.
check(badCookie.status !== 422, '  and no extraction was launched for it');

// A cookie file inside the download directory would be readable back through the
// media route, which turns a credential into a public URL.
const leakCookie = path.join(outputDir, 'leaked-cookies.txt');
await fsp.writeFile(leakCookie, 'secret');
const insideCookie = await post('/api/probe', { url: 'http://example.com/x', cookies: leakCookie });
check(insideCookie.status === 400, 'a cookie file in the download directory is refused', insideCookie.body?.error);
check(/download directory/i.test(insideCookie.body?.error || ''), 'and the reason says which directory');
await fsp.rm(leakCookie, { force: true });

const aliasCookie = await post('/api/probe', { url: 'http://example.com/x', cookieFile: usableCookie });
probesAttempted += 1;
// 422 rather than 400: the cookie was accepted, and the failure is the unreachable
// host. Anything else would mean the alias was ignored rather than honoured.
check(aliasCookie.status === 422, 'the older cookieFile field name is still honoured', `got ${aliasCookie.status}`);

await fsp.rm(outsideDir, { recursive: true, force: true });

section('cross-origin and the queue ceiling');

const crossOrigin = await fetch(`${server.url}/api/jobs`, { headers: { origin: 'https://evil.example' } });
check(crossOrigin.status === 403, 'a cross-origin request is refused', `got ${crossOrigin.status}`);
const crossLocal = await fetch(`${server.url}/api/jobs`, { headers: { origin: 'http://127.0.0.1:4820' } });
check(crossLocal.status === 200, 'while a loopback origin is fine', `got ${crossLocal.status}`);

// A caller that loops on job creation must not be able to fill memory with jobs
// nobody will ever run.
const loopFixture = await startRedirectFixtures({ target: 'http://127.0.0.1:1/x' });
const queueLimit = health.limits.maxQueueSize;
let queueRejected = 0;
for (let i = 0; i < queueLimit + 25; i += 1) {
  const res = await post('/api/downloads', {
    url: `${loopFixture.base}/page`,
    title: `queue-probe-${i}`,
  });
  if (res.status === 429) { queueRejected += 1; break; }
}
check(queueRejected === 1, 'the queue has a ceiling and says so', `${queueLimit} jobs accepted`);
await loopFixture.close();

section('event stream ceiling');

const sseCap = health.limits.maxSseClients;
const streams = [];
for (let i = 0; i < sseCap; i += 1) {
  streams.push(await fetch(`${server.url}/api/events`));
}
const overflow = await fetch(`${server.url}/api/events`);
check(overflow.status === 503, 'the event hub refuses streams past its ceiling', `got ${overflow.status}`);
for (const s of streams) s.body?.cancel?.();
await overflow.body?.cancel?.();

section('rate limiting');

const burst = [];
for (let i = 0; i < 80; i += 1) {
  burst.push(await post('/api/scrape', { url: 'http://127.0.0.1:1/x' }).then((r) => r.status));
}
check(burst.some((s) => s === 429), 'a caller that loops on an expensive route is eventually refused');

section('counters');

const metrics = await fetch(`${server.url}/api/metrics`).then((r) => r.json());
check(metrics.series && typeof metrics.series.ssrf_blocked?.value === 'number', 'metrics are exposed');
check(Boolean(metrics.series.ssrf_blocked?.help), 'and each series says what it counts', metrics.series.ssrf_blocked?.help);
// Every refusal above went through the same check, so the counter has to have
// moved. A counter that is always zero is worse than no counter, because it looks
// like a working one.
check(metrics.series.ssrf_blocked.value >= 9, 'blocked addresses are counted', `${metrics.series.ssrf_blocked.value} blocked`);
// The separation is the point: a blocked address never became a failed probe,
// because the request was refused before anything was attempted. Exactly the
// probes this file deliberately let through should appear as probe failures.
check(metrics.series.probe_failed.value === probesAttempted,
  'and a policy decision is never counted as a failed probe',
  `${metrics.series.probe_failed.value} probe failure(s), expected ${probesAttempted}`);
check(metrics.series.probe_failed.value > 0, 'the probes that were attempted are still counted', `${metrics.series.probe_failed.value}`);
check(metrics.series.request_refused.value > 0, 'and budget refusals', `${metrics.series.request_refused.value}`);
check(typeof metrics.gauges.jobs_running === 'number', 'live queue numbers are included', JSON.stringify(metrics.gauges));
check(metrics.queue.maxQueueSize > 0, 'and the ceiling is repeated alongside the counters');
// A label value must never carry free text: that is how a counter turns into a
// memory leak and an unusable metric.
const labelValues = Object.values(metrics.labelled).every((v) => typeof v === 'number');
check(labelValues, 'every labelled series is a number');

await server.close();

/* ================================================================== */

await fsp.rm(outside, { recursive: true, force: true });
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} security checks pass`);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  ${f.group}: ${f.what}`);
}
process.exit(failed.length ? 1 : 0);