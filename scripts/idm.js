#!/usr/bin/env node
/**
 * IDM-style segmented downloader.
 *
 * Like Internet Download Manager: one HEAD to learn the size, then N parallel
 * Range requests, each writing its own byte window of a preallocated file.
 * A single connection is at the mercy of per-connection throttling; N
 * connections each get their own share, so the sum is usually far higher.
 *
 * Usage:
 *   node scripts/idm.js "<page-or-file-url>" [outputName] [--connections 8]
 *
 * If given a pimpbunny-style video PAGE url, it first scrapes the page for the
 * freshest direct mp4 link (tokens expire, so never reuse an old one).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = process.argv.slice(2);
const inputUrl = args.find((a) => !a.startsWith('--'));
// Skip option values (e.g. the "8" in --connections 8) when reading positionals.
const positionals = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--connections') { i++; continue; }
  if (!args[i].startsWith('--')) positionals.push(args[i]);
}
const outName = positionals[1] || null;
let connections = 8;
const ci = args.indexOf('--connections');
if (ci !== -1 && args[ci + 1]) connections = Math.max(1, Math.min(32, parseInt(args[ci + 1], 10) || 8));

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const OUT_DIR = path.join(ROOT, 'downloads');
fs.mkdirSync(OUT_DIR, { recursive: true });

const log = (...a) => console.log('[idm]', ...a);
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const fmtSpeed = (bps) => bps > 1048576 ? `${(bps / 1048576).toFixed(2)} MB/s` : `${(bps / 1024).toFixed(0)} KB/s`;

async function scrapePage(pageUrl) {
  log('fetching page for fresh links');
  const res = await fetch(pageUrl, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`page fetch failed: ${res.status}`);
  const html = await res.text();
  const urls = [...new Set([...html.matchAll(/https?:\/\/[^\s"']+\.mp4[^\s"']*/g)].map((m) => m[0]))]
    .filter((u) => !u.includes('preview') && !u.includes('.jpg'));
  if (!urls.length) throw new Error('no mp4 links found on page');
  const rank = (u) => (/1080p/.test(u) ? 4 : /720p/.test(u) ? 3 : /360p/.test(u) ? 2 : 1);
  urls.sort((a, b) => rank(b) - rank(a));
  // Prefer a tokenised link; tokens are the authorised ones.
  const withToken = urls.find((u) => /acctoken|token/i.test(u)) || urls[0];
  log('picked', withToken.slice(0, 110) + '...');
  // Derive a title from <title>
  const title = (html.match(/<title>([^<]+)<\/title>/i)?.[1] || 'video').split('|')[0].trim().slice(0, 120);
  return { fileUrl: withToken, referer: pageUrl, title };
}

async function resolveSize(url, headers) {
  // HEAD first; some CDNs lie on HEAD, so fall back to a 0-0 range probe.
  try {
    const head = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
    const len = head.headers.get('content-length');
    if (head.ok && len && Number(len) > 0) {
      return { size: Number(len), ranges: head.headers.get('accept-ranges') !== 'none' };
    }
  } catch { /* fall through to range probe */ }
  const probe = await fetch(url, { headers: { ...headers, Range: 'bytes=0-0' }, redirect: 'follow' });
  if (probe.status === 206) {
    const cr = probe.headers.get('content-range'); // bytes 0-0/2017864899
    const total = cr?.split('/')[1] ? Number(cr.split('/')[1]) : null;
    await probe.arrayBuffer().catch(() => null);
    if (total) return { size: total, ranges: true };
  }
  if (probe.ok) {
    const len = probe.headers.get('content-length');
    await probe.arrayBuffer().catch(() => null);
    if (len) return { size: Number(len), ranges: false };
  }
  throw new Error('could not determine file size');
}

async function downloadSegment(url, headers, start, end, fh, shared, idx, retries = 8) {
  let attempt = 0;
  let pos = start;
  for (;;) {
    try {
      const res = await fetch(url, {
        headers: { ...headers, Range: `bytes=${pos}-${end}` },
        redirect: 'follow',
      });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('empty body');
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await fh.write(value, 0, value.length, pos);
        pos += value.length;
        shared.downloaded += value.length;
      }
      if (pos <= end && res.status === 206) throw new Error('truncated segment');
      return;
    } catch (err) {
      attempt += 1;
      if (attempt > retries || pos > end) {
        if (pos > end) return;
        throw new Error(`segment ${idx} failed after ${retries} retries: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

async function main() {
  if (!inputUrl) {
    console.error('usage: node scripts/idm.js "<url>" [outputName] [--connections 8]');
    process.exit(1);
  }

  let fileUrl = inputUrl;
  let referer = new URL(inputUrl).origin + '/';
  let title = null;

  if (!/\.mp4|get_file|remote_control/i.test(inputUrl)) {
    const scraped = await scrapePage(inputUrl);
    fileUrl = scraped.fileUrl;
    referer = scraped.referer;
    title = scraped.title;
  }

  const headers = { 'User-Agent': UA, Referer: referer };

  const { size, ranges } = await resolveSize(fileUrl, headers);
  log(`size: ${fmtMB(size)} (${size} bytes), ranges: ${ranges ? 'yes' : 'no'}`);

  const safeTitle = (outName || title || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 120) || 'video';
  const outPath = path.join(OUT_DIR, `${safeTitle} [IDM].mp4`);
  const partPath = outPath + '.part';

  if (!ranges || size < 2 * 1048576) {
    log('server does not support ranges or file is small; single connection');
    const res = await fetch(fileUrl, { headers, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fh = await fsp.open(partPath, 'w');
    let done = 0;
    const t0 = Date.now();
    const reader = res.body.getReader();
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      await fh.write(value, 0, value.length, done);
      done += value.length;
      if (Date.now() - (main._t || 0) > 2000) {
        main._t = Date.now();
        log(`${fmtMB(done)} / ${fmtMB(size)} (${((done / size) * 100).toFixed(1)}%) ${fmtSpeed(done / ((Date.now() - t0) / 1000))}`);
      }
    }
    await fh.close();
    fs.renameSync(partPath, outPath);
    log('done ->', outPath);
    return;
  }

  const segs = Math.min(connections, Math.max(2, Math.floor(size / 1048576)));
  log(`downloading in ${segs} parallel segments (IDM-style)`);
  const segSize = Math.ceil(size / segs);

  const fh = await fsp.open(partPath, 'w');
  await fh.truncate(size);
  const shared = { downloaded: 0 };
  const t0 = Date.now();
  let lastLog = 0;

  const ticker = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    const pct = ((shared.downloaded / size) * 100).toFixed(1);
    log(`${fmtMB(shared.downloaded)} / ${fmtMB(size)} (${pct}%) ${fmtSpeed(shared.downloaded / Math.max(el, 0.1))}`);
    lastLog = Date.now();
  }, 2000);

  const tasks = [];
  for (let i = 0; i < segs; i++) {
    const start = i * segSize;
    const end = Math.min(start + segSize - 1, size - 1);
    tasks.push(downloadSegment(fileUrl, headers, start, end, fh, shared, i));
  }
  try {
    await Promise.all(tasks);
  } finally {
    clearInterval(ticker);
    await fh.close();
  }

  const st = fs.statSync(partPath);
  if (st.size !== size) throw new Error(`size mismatch: got ${st.size}, want ${size}`);
  fs.renameSync(partPath, outPath);
  const el = (Date.now() - t0) / 1000;
  log(`done in ${el.toFixed(1)}s (${fmtSpeed(size / el)}) -> ${outPath}`);
}

main().catch((err) => {
  console.error('[idm] FAILED:', err.message);
  process.exit(1);
});
