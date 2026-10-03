/**
 * A cancelled download has to keep what it had, or `recoverable` is a lie.
 *
 * `cancelJob` marks a running job `recoverable`, and that flag is what the UI shows
 * a user who cancelled to free bandwidth. It was set on the assumption that a
 * running job has a partial worth resuming from, and the assumption was never
 * checked: the direct engine deleted its `.part` file *before* looking at whether
 * the abort was a cancellation. A cancelled job therefore reported several megabytes
 * downloaded and had nothing on disk.
 *
 * Both directions are covered here, because keeping bytes unconditionally is the
 * opposite bug. A ranged download preallocates the whole file, so a cancel in the
 * first moments leaves a sparse file of the full length that looks resumable and is
 * not; resuming it re-downloads everything while the user believes they are picking
 * up where they left off.
 *
 * The last case is the one the existing stress coverage was missing: not that the
 * workspace directory survives, but that the bytes in it do, and that a subsequent
 * download of the same source is byte-exact.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-cancel-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');
// This case polls a running job every 150 ms for as long as it takes to move a few
// megabytes, which is enough to spend the shipped request budget on itself. The
// limiter is working correctly and the test tripping over it.
process.env.BITRATE_RATE_DEFAULT = '200000';
process.env.BITRATE_RATE_CREATE = '100000';

const { startServer } = await import('../server/app.js');
const { startBudgetFixtures, makeBody } = await import('./fixtures.mjs');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const SIZE = 24 * 1024 * 1024;
const body = Buffer.alloc(SIZE);
// Distinctive per position, so a resume that splices wrong bytes is detectable
// rather than merely a different file of the right length.
for (let i = 0; i < SIZE; i += 1) body[i] = (i * 31 + (i >> 8)) & 0xff;
const EXPECTED = (await import('node:crypto')).createHash('sha256').update(body).digest('hex');

// Trickled so a cancel reliably lands mid-transfer.
const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const base = `http://127.0.0.1:${server.address().port}`;

  if (p === '/page') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><source src="${base}/big_1080p.mp4"></head></html>`);
    return;
  }
  if (p === '/big_1080p.mp4') {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const start = Number(range?.[1] || 0);
    const end = Math.min(Number(range?.[2] || SIZE - 1), SIZE - 1);
    res.writeHead(206, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${SIZE}`,
      'Accept-Ranges': 'bytes',
    });
    let pos = start;
    const pump = () => {
      if (pos > end) { res.end(); return; }
      const stop = Math.min(pos + 64 * 1024, end);
      if (res.write(body.subarray(pos, stop + 1))) { pos = stop + 1; setTimeout(pump, 25); }
      else res.once('drain', () => { pos = stop + 1; setTimeout(pump, 25); });
    };
    pump();
    return;
  }
  res.writeHead(404).end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const app = await startServer({ port: 0, loggerLevel: 'silent' });
const scrape = await fetch(`${app.url}/api/scrape`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: `${base}/page` }),
}).then((r) => r.json());
const link = scrape.links[0].url;

const start = (fileUrl, title) => fetch(`${app.url}/api/downloads`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ direct: true, fileUrl, referer: `${base}/page`, res: '1080p', title }),
}).then((r) => r.json());

const poll = async (id, until = (j) => ['done', 'error', 'cancelled'].includes(j.status)) => {
  for (let i = 0; i < 400; i += 1) {
    const j = await fetch(`${app.url}/api/jobs/${id}`).then((r) => r.json());
    if (until(j)) return j;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fetch(`${app.url}/api/jobs/${id}`).then((r) => r.json());
};

/** Every `.part` file anywhere under the download directory. */
function parts(dir = outputDir) {
  const found = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.part')) found.push({ path: p, name: e.name, size: fs.statSync(p).size });
    }
  };
  walk(dir);
  return found;
}

console.log('cancelling a download in flight\n');

/* ------------------------------------------------------------------ *
 * A cancel with real progress keeps the bytes
 * ------------------------------------------------------------------ */

const running = await start(link, 'cancel-late');
// Wait until several megabytes have actually moved, so this is not the early case.
let progress = 0;
for (let i = 0; i < 200; i += 1) {
  await new Promise((r) => setTimeout(r, 150));
  progress = (await fetch(`${app.url}/api/jobs/${running.id}`).then((r) => r.json())).downloaded;
  if (progress > 4 * 1024 * 1024) break;
}
check(progress > 4 * 1024 * 1024, 'the download made real progress first', `${progress} bytes`);

const beforeCancel = parts();
check(beforeCancel.length === 1, 'and a partial file exists', beforeCancel.length ? beforeCancel[0].name : 'none');

const cancelled = await fetch(`${app.url}/api/jobs/${running.id}/cancel`, { method: 'POST' }).then((r) => r.json());
check(cancelled.status === 'cancelled', 'the job reports cancelled', cancelled.status);
check(cancelled.recoverable === true, 'and says it is recoverable', String(cancelled.recoverable));

// The point of the whole exercise: after the engine has fully unwound.
await new Promise((r) => setTimeout(r, 1500));
const afterCancel = parts();
check(afterCancel.length === 1, 'the partial file survives the cancel',
  afterCancel.length ? `${afterCancel[0].name} ${afterCancel[0].size}B` : 'deleted');
check(afterCancel[0]?.path === beforeCancel[0]?.path, 'and it is the same file, not a new one');

const settled = await fetch(`${app.url}/api/jobs/${running.id}`).then((r) => r.json());
check(settled.recoverable === true, 'the job still claims recoverable once settled',
  String(settled.recoverable));

const libraryAfter = await fetch(`${app.url}/api/library`).then((r) => r.json());
check(!libraryAfter.some((e) => e.name.includes('cancel-late')),
  'and nothing was promoted into the library');

/* ------------------------------------------------------------------ *
 * A cancel before any data does not claim to be resumable
 * ------------------------------------------------------------------ */

const early = await start(link, 'cancel-early');
await new Promise((r) => setTimeout(r, 30));
await fetch(`${app.url}/api/jobs/${early.id}/cancel`, { method: 'POST' });
await new Promise((r) => setTimeout(r, 1200));

const earlyJob = await fetch(`${app.url}/api/jobs/${early.id}`).then((r) => r.json());
check(earlyJob.status === 'cancelled', 'an early cancel still cancels', earlyJob.status);
check(earlyJob.recoverable === false,
  'but is not called recoverable, because there is nothing to resume', String(earlyJob.recoverable));
check(!parts().some((f) => f.name.includes('cancel-early')),
  'and its preallocated-but-empty partial is cleaned up');
check(/before any data/i.test(earlyJob.error || ''), 'with an explanation', earlyJob.error);

/* ------------------------------------------------------------------ *
 * A genuine failure still cleans up
 * ------------------------------------------------------------------ */

console.log('\na failure is not a cancellation');

// A link that stops serving and cannot be refreshed: the budget fixture refuses
// outright once it runs out, and there is no referer page for the engine to re-read.
// That is a failure with nothing to resume from, which is the case that must not be
// confused with a cancellation.
const deadLink = await startBudgetFixtures({
  body: makeBody(3 * 1024 * 1024), budgetBytes: 512 * 1024,
});

const doomed = await fetch(`${app.url}/api/downloads`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    direct: true, fileUrl: deadLink.fileUrl, referer: null, res: '1080p', title: 'fail-midway',
  }),
}).then((r) => r.json());
const failed = await poll(doomed.id);
check(failed.status === 'error', 'a link that dies fails rather than retrying for ever',
  failed.status);
check(Boolean(failed.error), 'with a reason', failed.error);
check(failed.recoverable === false, 'and is not called recoverable', String(failed.recoverable));
check(!parts().some((f) => f.name.includes('fail-midway')),
  'and its partial is removed, since resuming a dead link would achieve nothing');
await deadLink.close();

/* ------------------------------------------------------------------ *
 * The resumed bytes are the right bytes
 * ------------------------------------------------------------------ */

console.log('\nthe kept bytes can actually be resumed');

// Re-download the same source. `--continue` and the segment positions are what make
// this cheap rather than a fresh copy, so the assertion is that the result is
// byte-exact even though a cancelled partial existed.
const resumed = await start(link, 'cancel-resume');
check(Boolean(resumed.id), 'a fresh download can be queued', resumed.error || 'queued');
const done = await poll(resumed.id);
check(done.status === 'done', 'a fresh download of the same source completes', done.error || done.status);

const entry = (await fetch(`${app.url}/api/library`).then((r) => r.json()))
  .find((e) => e.name.includes('cancel-resume'));
check(Boolean(entry), 'and produces a library entry');
if (entry) {
  const got = await fsp.readFile(path.join(outputDir, entry.name));
  check(got.length === SIZE, 'of the right length', `${got.length} vs ${SIZE}`);
  const crypto = await import('node:crypto');
  check(crypto.createHash('sha256').update(got).digest('hex') === EXPECTED,
    'and byte-for-byte identical to the source, so no window was spliced wrong');
}

await app.close();
await new Promise((r) => server.close(r));
await fsp.rm(outputDir, { recursive: true, force: true });

const failedChecks = results.filter((r) => !r.ok);
console.log(failedChecks.length
  ? `\n${failedChecks.length} failure(s)`
  : '\na cancelled download keeps its bytes, and says so honestly');
process.exit(failedChecks.length ? 1 : 0);