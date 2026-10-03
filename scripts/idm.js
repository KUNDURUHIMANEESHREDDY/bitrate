#!/usr/bin/env node
/**
 * Command line front end for the segmented downloader.
 *
 * This used to be a second, independent implementation of the same idea: its own
 * size probe, its own range loop, its own retry policy. That is the worst kind of
 * duplication to have in a downloader, because the two engines drift apart and
 * only one of them gets fixed. The server's engine had content-range validation, a
 * redirect-checked fetch, a stall guard and a size ceiling; this one had none of
 * them, and nothing recorded that.
 *
 * So it is a wrapper now. Every fix to server/direct.js applies here too, which is
 * the only reason this file is short.
 *
 * Usage:
 *   node scripts/idm.js "<page-or-file-url>" [outputName] [--connections 8]
 *
 * If given a video PAGE url, it first scrapes the page for the freshest direct
 * link, because the tokens in those expire and an old one is worthless.
 */
import { startDirectDownload, IDM_CONNECTIONS } from '../server/direct.js';
import { scrapeMediaLinks } from '../server/scrape.js';
import { DOWNLOAD_DIR } from '../server/config.js';

const args = process.argv.slice(2);
const positionals = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--connections') { i += 1; continue; }
  if (!args[i].startsWith('--')) positionals.push(args[i]);
}

const inputUrl = positionals[0];
const outName = positionals[1] || null;

if (!inputUrl) {
  console.error('usage: node scripts/idm.js "<url>" [outputName] [--connections 8]');
  process.exit(1);
}

if (args.includes('--connections')) {
  console.warn(
    '[idm] --connections is ignored: the window count is chosen from the file size by '
    + `server/direct.js, which allows up to ${IDM_CONNECTIONS} windows per stream.`,
  );
}

const log = (...a) => console.log('[idm]', ...a);
const fmtMB = (n) => `${(n / 1048576).toFixed(1)} MB`;
const fmtSpeed = (bps) => (bps > 1048576
  ? `${(bps / 1048576).toFixed(2)} MB/s`
  : `${(bps / 1024).toFixed(0)} KB/s`);

/** True when the input already points at media rather than at a page. */
const looksLikeMedia = (url) => /\.(mp4|m3u8|webm|mkv|mov)(\?|$)/i.test(url);

const run = async () => {
  let fileUrl = inputUrl;
  let referer = new URL(inputUrl).origin + '/';
  let title = outName;

  if (!looksLikeMedia(inputUrl)) {
    log('fetching page for a fresh link');
    const scraped = await scrapeMediaLinks(inputUrl);
    if (!scraped.links?.length) throw new Error('No media links found on that page.');
    fileUrl = scraped.links[0].url;
    referer = inputUrl;
    title = outName || scraped.title;
    // Only the host is printed: these URLs carry signed tokens, and a token is a
    // credential for as long as it is valid.
    log('using', new URL(fileUrl).host, `- ${scraped.links[0].res}`);
  }

  let lastLog = 0;
  const handle = startDirectDownload({
    url: fileUrl,
    referer,
    title,
    destDir: DOWNLOAD_DIR,
  }, {
    onEvent(evt) {
      if (evt.type === 'progress' && evt.total > 0) {
        const now = Date.now();
        if (now - lastLog < 2000) return;
        lastLog = now;
        const el = Math.max((now - startedAt) / 1000, 0.1);
        log(`${fmtMB(evt.downloaded)} / ${fmtMB(evt.total)} `
          + `(${(evt.percent || 0).toFixed(1)}%) ${fmtSpeed(evt.speed || evt.downloaded / el)}`);
      } else if (evt.type === 'phase') {
        log(`phase: ${evt.phase}`);
      }
    },
    onError(message) {
      log('failed:', message);
    },
    onClose(code, finalPath) {
      if (code === 0) {
        log('done ->', finalPath);
        process.exitCode = 0;
      } else {
        process.exitCode = 1;
      }
    },
  });

  const startedAt = Date.now();
  process.on('SIGINT', () => {
    log('cancelling...');
    handle.kill();
  });
};

run().catch((err) => {
  console.error('[idm] FAILED:', err.message);
  process.exit(1);
});