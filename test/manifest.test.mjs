/**
 * A playlist is not a media file.
 *
 * The scraper used to offer `.m3u8` links alongside `.mp4` ones, and the UI treated
 * every entry identically. The direct engine is a byte-range downloader: it probes
 * for a length, plans windows across the body, and writes them to a `.part` file.
 * None of that means anything for a manifest, which is a text file listing other
 * URLs.
 *
 * The failure is worse than an error message. On an origin that reports a length for
 * its playlist -- which is a normal thing for a CDN to do -- the download *succeeds*
 * and writes a few kilobytes of text into the library under a video name, where
 * nothing downstream can tell it from a broken video. That is the case these
 * assertions exist to rule out.
 */
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-manifest-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const { startServer } = await import('../server/app.js');
const { scrapeMediaLinks } = await import('../server/scrape.js');
const { startDirectDownload } = await import('../server/direct.js');

const results = [];
let group = '';
const section = (n) => { group = n; console.log(`\n${n}`); };
const check = (ok, what, detail = '') => {
  results.push({ ok, what, group });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const SEG = Buffer.alloc(64 * 1024, 0x47);

// A page that carries only HLS, plus a page that carries both, so "HLS was
// filtered" and "HLS was never there" are distinguishable.
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const base = `http://127.0.0.1:${server.address().port}`;

  if (p === '/hls-only') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><source src="${base}/movie.m3u8"></head></html>`);
    return;
  }
  if (p === '/mixed') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head>
      <source src="${base}/movie.m3u8">
      <source src="${base}/movie_1080p.mp4">
    </head></html>`);
    return;
  }
  // The playlist. Content-Length is present and honest, which is the case that
  // used to produce a "successful" download of text.
  if (p === '/movie.m3u8') {
    const body = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-ENDLIST\n';
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(body),
      'Accept-Ranges': 'bytes',
    });
    res.end(body);
    return;
  }
  if (p === '/movie.mpd') {
    const body = '<?xml version="1.0"?><MPD></MPD>';
    res.writeHead(200, {
      'Content-Type': 'application/dash+xml',
      'Content-Length': Buffer.byteLength(body),
      'Accept-Ranges': 'bytes',
    });
    res.end(body);
    return;
  }
  if (p.endsWith('.ts')) {
    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Content-Length': String(SEG.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(SEG);
    return;
  }
  // A real file, so the happy path stays covered by the same run.
  if (p === '/movie_1080p.mp4') {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(SEG.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(SEG);
    return;
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const app = await startServer({ port: 0, loggerLevel: 'silent' });

console.log('manifest handling');

/* ------------------------------------------------------------------ *
 * The scraper does not offer one
 * ------------------------------------------------------------------ */

section('the scraper');

const hlsOnly = await scrapeMediaLinks(`${base}/hls-only`);
check(hlsOnly.links.length === 0, 'an HLS-only page offers no links', JSON.stringify(hlsOnly.links));
check(hlsOnly.hlsSeen > 0, 'but records that it saw HLS', String(hlsOnly.hlsSeen));
check(hlsOnly.links.every((l) => l.kind !== 'hls'), 'and no link is of kind hls');

const mixed = await scrapeMediaLinks(`${base}/mixed`);
check(mixed.links.length === 1, 'a page with both offers only the file', `${mixed.links.length}`);
check(mixed.links[0]?.kind === 'mp4', 'which is the mp4', mixed.links[0]?.kind);
check(mixed.links.every((l) => !/\.m3u8/.test(l.url)), 'and nothing ends in .m3u8');

/* ------------------------------------------------------------------ *
 * The API explains the empty result rather than returning nothing
 * ------------------------------------------------------------------ */

section('the API');

const scrapeHls = await fetch(`${app.url}/api/scrape`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `${base}/hls-only` }),
});
check(scrapeHls.status === 422, 'an HLS-only page is refused with a 422', `${scrapeHls.status}`);
const hlsErr = await scrapeHls.json();
check(/HLS/i.test(hlsErr.error || ''), 'and the message says the page is HLS', hlsErr.error);
check(/page URL/i.test(hlsErr.error || ''),
  'and says what to do instead, rather than just refusing');

const scrapeMixed = await fetch(`${app.url}/api/scrape`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `${base}/mixed` }),
});
check(scrapeMixed.status === 200, 'a page with a real file still works', `${scrapeMixed.status}`);
const mixedBody = await scrapeMixed.json();
check(mixedBody.links.length === 1, 'and returns the file', `${mixedBody.links.length}`);

/* ------------------------------------------------------------------ *
 * The engine refuses one, whatever the route
 * ------------------------------------------------------------------ */

section('the direct engine');

/** Run the engine and collect what it reported. */
function attempt(fileUrl, referer) {
  return new Promise((resolve) => {
    let error = null;
    startDirectDownload({ url: fileUrl, referer, title: 'probe' }, {
      onEvent: () => {},
      onError: (m) => { error = m; },
      onClose: () => resolve({ error }),
    });
    setTimeout(() => resolve({ error, timedOut: true }), 8000);
  });
}

const hlsAttempt = await attempt(`${base}/movie.m3u8`, `${base}/mixed`);
check(Boolean(hlsAttempt.error), 'an HLS URL is refused by the engine');
check(/playlist/i.test(hlsAttempt.error || ''), 'saying it is a playlist', hlsAttempt.error);
check(!/size/i.test(hlsAttempt.error || ''),
  'and not failing later with a size error', hlsAttempt.error);

const dashAttempt = await attempt(`${base}/movie.mpd`, `${base}/mixed`);
check(Boolean(dashAttempt.error), 'a DASH manifest is refused too');
check(/DASH playlist/i.test(dashAttempt.error || ''), 'and named as DASH, grammatically',
  dashAttempt.error);
// "an DASH" is the kind of small wrongness that reads as machine output.
check(!/\ban (DASH|MPD)\b/i.test(dashAttempt.error || ''),
  'with the right article', dashAttempt.error);

// The engine's own backstop, for a URL that arrives some other way -- a stale UI,
// a bookmarklet, a hand-written request.
const noReferer = await attempt(`${base}/movie.m3u8`, null);
check(Boolean(noReferer.error), 'refused even with no referer to refresh from');

/* ------------------------------------------------------------------ *
 * Nothing reaches the library
 * ------------------------------------------------------------------ */

section('nothing is saved');

const files = await fsp.readdir(outputDir);
const media = files.filter((f) => f !== 'data');
check(media.length === 0, 'no file was written by any refused attempt', media.join(', '));

const library = await fetch(`${app.url}/api/library`).then((r) => r.json());
check(library.length === 0, 'and the library is empty', `${library.length} entries`);
check(!library.some((e) => /\.m3u8$|\.mpd$/.test(e.name)),
  'with no playlist sitting in it under a video name');

/* ------------------------------------------------------------------ *
 * A real file still works
 * ------------------------------------------------------------------ */

section('a real file is unaffected');

const ok = await attempt(`${base}/movie_1080p.mp4`, `${base}/mixed`);
check(!ok.error, 'an mp4 is not refused', ok.error || 'accepted');
await new Promise((r) => setTimeout(r, 1200));
const after = (await fetch(`${app.url}/api/library`).then((r) => r.json()));
check(after.length === 1, 'and it lands in the library', `${after.length} entries`);
check(after[0]?.name.endsWith('.mp4'), 'with the right extension', after[0]?.name);

await app.close();
await new Promise((r) => server.close(r));
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\nno manifest is offered, refused, or saved');
process.exit(failed.length ? 1 : 0);