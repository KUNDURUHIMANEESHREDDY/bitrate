/**
 * Local fixtures for the download engine.
 *
 * These exist so the eval harness can test the parts most likely to break
 * without depending on a third-party site. Remote hosts throttle, change
 * behaviour and go down, which turns a regression into a flaky test and trains
 * you to ignore failures. The three cases that actually broke during
 * development are all reproducible here:
 *
 *   ranges      - honours Range, so the segmented path runs
 *   no-ranges   - ignores Range and always sends the whole body, which silently
 *                 corrupts a file that is split into several windows
 *   expiring    - hands out a token that dies after a few seconds and issues a
 *                 fresh one on every page read, reproducing the short-lived
 *                 links that made the direct path fail before the token refresh
 *                 was added
 */
import http from 'node:http';
import crypto from 'node:crypto';

/** Deterministic bytes, so an expected digest can be recomputed independently. */
export function makeBody(size, seed = 1) {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i < size; i++) {
    // xorshift keeps this fast and reproducible without a PRNG dependency.
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

export const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Start the fixture server.
 *
 * tokenTtl is the lifetime in seconds of a media token, and tokenPage is the
 * HTML a scraper would read. A ttl of Infinity means tokens never expire.
 */
export async function startFixtures({
  ranges = true,
  body = makeBody(3 * 1024 * 1024),
  tokenTtl = Infinity,
  tokenPage = '',
  port = 0,
} = {}) {
  const issued = new Map();
  let counter = 0;
  // Named so the scraper reads it as a resolution, which is what makes the
  // quality-preserving refresh path testable.
  const FILE = '/file_1080p.mp4';

  const issue = () => {
    const token = `tok${++counter}`;
    issued.set(token, Date.now() + (Number.isFinite(tokenTtl) ? tokenTtl * 1000 : Infinity));
    return token;
  };
  const live = (token) => {
    const exp = issued.get(token);
    return exp !== undefined && Date.now() < exp;
  };

  let base = '';
  const mediaUrl = (token) => `${base}${FILE}?v-acctoken=${token}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    // The page a scraper reads to discover media links. Real pages carry
    // absolute URLs, and the scraper only matches those, so this must too.
    if (path === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(tokenPage.replaceAll('__MEDIA__', mediaUrl(issue())));
      return;
    }

    if (path === FILE) {
      const token = url.searchParams.get('v-acctoken');
      if (token && !live(token)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('expired');
        return;
      }
      if (ranges) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (range) {
          const start = range[1] ? Number(range[1]) : 0;
          const end = range[2] ? Number(range[2]) : body.length - 1;
          if (start >= body.length || end >= body.length || start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
            res.end();
            return;
          }
          const slice = body.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(slice.length),
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Accept-Ranges': 'bytes',
          });
          res.end(slice);
          return;
        }
      }
      // No range asked for, or this fixture does not do ranges at all.
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        ...(ranges ? { 'Accept-Ranges': 'bytes' } : {}),
      });
      res.end(body);
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  const dead = () => {
    const t = `tok${++counter}`;
    issued.set(t, Date.now() - 1000);
    return t;
  };

  return {
    base,
    pageUrl: `${base}/page`,
    fileUrl: mediaUrl(issue()),
    // A link that is already dead, for testing the refresh path directly.
    deadUrl: mediaUrl(dead()),
    body,
    close: () => new Promise((r) => server.close(r)),
  };
}

/**
 * A link that dies part way through a transfer.
 *
 * The resume path is hard to provoke for real: every window opens within the
 * first seconds, so a twenty-second token is still valid by the time the file
 * has moved much. This gives each token a *byte budget* instead of a clock, so
 * the first link is guaranteed to stop serving well before the file is
 * finished, however fast the machine is.
 *
 * Bytes actually served are recorded per token, which is what lets a test tell
 * a resume from a restart: a resumed transfer asks the second token for only the
 * missing tail, while a restart asks it for the whole file again.
 */
export async function startBudgetFixtures({
  body = makeBody(3 * 1024 * 1024),
  // In whole-window mode the byte ceiling is not what ends the link, the window
  // count is, so it must not be low enough to refuse a window of its own accord.
  budgetBytes = null,
  // A link fetched by re-reading the page is expected to work, which is the
  // whole reason the refresh is worth doing. Giving it the same small budget
  // would only be testing whether the downloader is willing to fail twice.
  pageBudget = null,
  /**
   * Refuse a window outright rather than truncating it, so the budget runs out
   * between windows instead of inside one.
   *
   * This makes the accounting exact: every window is either delivered whole or
   * not at all, so a correct resume fetches every byte of the file exactly
   * once. Truncating instead models a link that dies mid-body, which is the
   * realistic case but leaves a timing-dependent amount of the last window
   * already written, and therefore a variable amount of re-fetched overlap.
   *
   * Counting `budgetWindows` instead of a byte figure keeps the test from having
   * to know how the engine chose to split the file.
   */
  budgetWindows = 0,
  port = 0,
} = {}) {
  const recovery = pageBudget ?? body.length;
  const wholeWindowsOnly = budgetWindows > 0;
  const firstBudget = budgetBytes ?? recovery;
  const tokens = new Map();
  let counter = 0;
  let base = '';

  const issue = (budget, windowLimit) => {
    const token = `bt${++counter}`;
    tokens.set(token, { budget, windowLimit, served: 0, ranges: [], windows: 0 });
    return token;
  };
  const mediaUrl = (token) => `${base}/file_1080p.mp4?v-acctoken=${token}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/page') {
      // Every page read hands out a working link, which is what the real site
      // does and what the refresh path relies on.
      const fresh = issue(recovery, Infinity);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head><source src="${mediaUrl(fresh)}"></head></html>`);
      return;
    }

    if (url.pathname === '/file_1080p.mp4') {
      const token = url.searchParams.get('v-acctoken');
      const record = tokens.get(token);
      if (!record) {
        res.writeHead(403).end('unknown token');
        return;
      }

      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      const start = range?.[1] ? Number(range[1]) : 0;
      const end = range?.[2] ? Number(range[2]) : body.length - 1;
      if (start >= body.length || end >= body.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
        res.end();
        return;
      }

      const wanted = end - start + 1;
      // A one-byte range is the size probe that resolveSize sends to learn the
      // length, not a transfer window. It is always allowed and never counts
      // against the window allowance.
      const probe = wanted === 1;
      const left = record.budget - record.served;
      // In whole-window mode a window that will not fit is refused rather than
      // cut short, so the link dies between windows.
      const short = !probe && wholeWindowsOnly
        && (left < wanted || record.windows >= record.windowLimit);
      const allowed = short ? 0 : Math.min(wanted, left);
      record.ranges.push({ start, end, wanted, allowed, status: allowed > 0 ? 206 : 403 });
      if (allowed <= 0) {
        // Budget gone. Refuse, which is what an expired link does.
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('link expired');
        return;
      }

      const slice = body.subarray(start, start + allowed);
      record.served += allowed;
      if (!probe) record.windows += 1;
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${start + allowed - 1}/${body.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }

    res.writeHead(404).end('not found');
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    pageUrl: `${base}/page`,
    // Starts with a budget, so the first transfer gets going and then runs out.
    fileUrl: mediaUrl(issue(firstBudget, budgetWindows || Infinity)),
    body,
    /** Bytes handed out per token, in the order the tokens were issued. */
    bytesByToken: () => [...tokens.values()].map((t) => t.served),
    /** Every window asked of each token, in the order it was asked. */
    rangesByToken: () => [...tokens.entries()].map(([name, t]) => ({ name, served: t.served, ranges: t.ranges })),
    /**
     * Every byte position any link has handed out, as a sorted list of
     * [start, end) spans. Comparing that coverage against the file is how a
     * test tells a resume (no gaps, no overlap) from a restart.
     */
    coverage() {
      const spans = [];
      for (const t of tokens.values()) {
        for (const r of t.ranges) {
          if (r.allowed > 0) spans.push([r.start, r.start + r.allowed]);
        }
      }
      spans.sort((a, b) => a[0] - b[0]);
      return spans;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
