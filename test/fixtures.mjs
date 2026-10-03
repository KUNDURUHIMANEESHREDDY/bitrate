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

/**
 * A close function that actually closes.
 *
 * `server.close()` waits for existing connections to end, and a keep-alive agent
 * on the client side will happily hold one open for its reuse timeout. Without
 * this, every fixture that has served a request leaves a socket behind and the
 * suite hangs at teardown rather than failing.
 */
export function closable(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return () => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  });
}

/**
 * An origin that throttles each connection separately, the way a real CDN does.
 *
 * The README credits aria2c with being the biggest throughput win because
 * origins cap a single connection well below the link rate. That claim can only
 * be measured against a per-connection limit, not against a loopback socket,
 * which has no limit and therefore no headroom for extra connections to win.
 *
 * The cap is enforced per response rather than globally, which is what makes it
 * a fair model: sixteen connections get sixteen times the aggregate rate, up to
 * whatever the host can actually push.
 */
export async function startThrottledOrigin({
  body,
  bytesPerSecond = 6 * 1024 * 1024,
  chunkBytes = 256 * 1024,
  port = 0,
} = {}) {
  if (!body) throw new Error('startThrottledOrigin needs a body to serve');
  let base = '';
  let connections = 0;
  let peakConnections = 0;

  const server = http.createServer((req, res) => {
    if (req.url.split('?')[0] !== '/video.mp4') {
      res.writeHead(404).end('not found');
      return;
    }

    connections += 1;
    peakConnections = Math.max(peakConnections, connections);

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : body.length - 1, body.length - 1);

    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${body.length}` } : {}),
    });

    // Each tick hands over one chunk worth of budget, paced to the cap. A
    // connection asking for more than the cap allows simply takes longer, which
    // is the behaviour the aria2c claim depends on.
    const perChunkMs = (chunkBytes / bytesPerSecond) * 1000;
    let pos = start;
    let cancelled = false;
    res.on('close', () => { cancelled = true; });

    const pump = () => {
      if (cancelled) { connections -= 1; return; }
      if (pos > end) { res.end(); connections -= 1; return; }

      const stop = Math.min(pos + chunkBytes - 1, end);
      // Advance before writing. A full socket buffer makes write() return false
      // and the chunk is queued regardless, so the resume must move past it
      // rather than send the same bytes again when the drain fires.
      const slice = body.subarray(pos, stop + 1);
      pos = stop + 1;
      if (!res.write(slice)) {
        res.once('drain', () => setTimeout(pump, perChunkMs));
        return;
      }
      setTimeout(pump, perChunkMs);
    };
    setTimeout(pump, perChunkMs);
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    fileUrl: `${base}/video.mp4`,
    body,
    /** The most simultaneous range requests seen, which is what the win rests on. */
    peakConnections: () => peakConnections,
    resetPeak: () => { peakConnections = 0; },
    close: closable(server),
  };
}

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

/* ------------------------------------------------------------------ *
 * Fixtures for the security suite
 * ------------------------------------------------------------------ */

/**
 * A server that answers a correct Range request with an incorrect 206.
 *
 * The segmented downloader writes each window at its own offset of a
 * preallocated file, so it trusts the response to describe exactly the bytes it
 * asked for. Nothing downstream can catch a lie: the finished file is exactly the
 * right length either way. These are the four ways an origin can be wrong, each of
 * which produces a file of the correct size containing the wrong bytes:
 *
 *   wrong-range-start  claims a window that begins at 0
 *   over-long          streams past the end of the requested window
 *   wrong-length       declares a Content-Length that is not the window
 *   truncated          closes the body before the declared length
 */
export async function startRangeLiarFixtures({
  mode = 'wrong-range-start',
  body = makeBody(4 * 1024 * 1024),
  /**
   * For `truncated`: how many responses to cut short before behaving.
   *
   * Defaulting to Infinity models an origin that never recovers, which proves
   * only that the engine eventually gives up. A finite number is the more
   * interesting case and the cheaper one: it shows that retrying a body that
   * stopped early actually recovers, byte for byte, rather than merely stalling.
   */
  truncateTimes = Infinity,
  port = 0,
} = {}) {
  const asked = [];
  let truncated = 0;
  let base = '';

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/video.mp4') { res.writeHead(404).end('not found'); return; }

    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = m ? Number(m[1]) : 0;
    const end = m ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    const wanted = end - start + 1;
    asked.push({ start, end, wanted });

    const send = (headers, chunk, tail) => {
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        ...headers,
      });
      res.end(tail === undefined ? chunk : [chunk, tail]);
    };

    switch (mode) {
      case 'wrong-range-start': {
        // Claims to start at the beginning of the file whatever was asked for.
        // A correct client writing this at its own offset produces a file whose
        // windows overlap and whose tail is whatever was left over.
        const slice = body.subarray(0, wanted);
        return send({
          'Content-Range': `bytes 0-${wanted - 1}/${body.length}`,
          'Content-Length': String(slice.length),
        }, slice);
      }
      case 'over-long': {
        // Correct headers, but the body runs past the end of the window, into
        // whatever segment follows it.
        const extra = Math.min(wanted, body.length - end);
        const slice = body.subarray(start, Math.min(start + wanted + extra, body.length));
        return send({
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          'Content-Length': String(slice.length),
        }, slice);
      }
      case 'wrong-length': {
        const slice = body.subarray(start, end + 1);
        return send({
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          // Declares fewer bytes than the window it claims to be sending.
          'Content-Length': String(Math.max(1, wanted - 1024)),
        }, slice);
      }
      case 'truncated': {
        // A body that stops early is the transport cutting out, not the origin
        // lying about the file, so this is the one case where retrying is the
        // right answer. The window advances by whatever arrived, so recovery
        // resumes rather than restarts.
        const slice = body.subarray(start, end + 1);
        const cut = truncated < truncateTimes;
        if (cut) truncated += 1;
        const payload = cut
          ? slice.subarray(0, Math.max(1, Math.floor(slice.length / 2)))
          : slice;
        return send({
          'Content-Range': `bytes ${start}-${end}/${body.length}`,
          // The origin declares what it intends to send; on a cut it never sends
          // it all, so the socket dies mid-body exactly as a dropped one would.
          'Content-Length': String(slice.length),
        }, payload);
      }
      default:
        res.writeHead(400).end('unknown fixture mode');
    }
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    fileUrl: `${base}/video.mp4`,
    body,
    mode,
    asked: () => asked,
    /** How many responses were cut short, for the transient-recovery case. */
    truncated: () => truncated,
    close: closable(server),
  };
}

/**
 * An origin that streams slowly but genuinely.
 *
 * `startSlowFixture` holds the connection open without sending anything, which is
 * right for holding a job in the running state and useless for anything about the
 * bytes on disk. This one sends honest headers for a large file and then trickles,
 * so a job stays running *and* has progress worth keeping -- which is the only state
 * in which a cancellation is a pause rather than a loss.
 *
 * @param {number} size       total length to declare and serve
 * @param {number} chunkBytes bytes per tick
 * @param {number} tickMs     delay between ticks
 */
export async function startTrickleFixture({
  size = 24 * 1024 * 1024, chunkBytes = 64 * 1024, tickMs = 40, port = 0,
} = {}) {
  const body = makeBody(size);
  const timers = new Set();

  const server = http.createServer((req, res) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = Math.min(range?.[2] ? Number(range[2]) : size - 1, size - 1);
    if (start >= size || end >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    let pos = start;
    let open = true;
    const pump = () => {
      // `writableEnded` is getter-only on a response, so the closed state is
      // tracked here: writing to a socket the client has dropped throws.
      if (!open || pos > end) { res.end(); return; }
      const stop = Math.min(pos + chunkBytes - 1, end);
      const slice = body.subarray(pos, stop + 1);
      pos = stop + 1;
      try {
        if (res.write(slice)) setTimeout(pump, tickMs);
        else res.once('drain', () => setTimeout(pump, tickMs));
      } catch {
        open = false;
      }
    };
    pump();
    res.on('close', () => { open = false; });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    fileUrl: `${base}/trickle.mp4`,
    body,
    size,
    close: () => {
      for (const t of timers) clearTimeout(t);
      return closable(server)();
    },
  };
}

/**
 * An origin that accepts the connection and then says nothing.
 *
 * Used to hold download jobs in the `running` state on purpose. Whether a job is
 * running or queued is otherwise a race against a URL that fails instantly, and a
 * test whose assertions come and go depending on scheduling is a test that will
 * quietly stop testing anything.
 */
export async function startSlowFixture({ holdMs = 60_000, port = 0 } = {}) {
  const timers = new Set();
  const hits = [];
  let base = '';

  const server = http.createServer((req, res) => {
    hits.push(req.url);
    // Answer eventually, so a test that forgets to cancel cannot hang for ever,
    // but not soon enough that a job leaves the running state on its own.
    const t = setTimeout(() => {
      if (!res.writableEnded) res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '4' });
      if (!res.writableEnded) res.end('data');
    }, holdMs);
    timers.add(t);
    res.on('close', () => { clearTimeout(t); timers.delete(t); });
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    fileUrl: `${base}/slow.mp4`,
    hits: () => hits,
    close: () => {
      for (const t of timers) clearTimeout(t);
      return closable(server)();
    },
  };
}

/**
 * A one-route fixture bound to a chosen loopback address.
 *
 * The address is a parameter because the pinning tests need two fixtures that are
 * provably somewhere different. If a platform treated 127/8 as interchangeable,
 * "the socket went to the address it was given" would pass for the wrong reason
 * and prove nothing, so the test uses two and checks both directions.
 */
export async function startMultiFixture(bindAddress = '127.0.0.1') {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${bindAddress}:${req.url}`);
  });
  await new Promise((r) => server.listen(0, bindAddress, r));
  return {
    address: bindAddress,
    port: server.address().port,
    base: `http://${bindAddress}:${server.address().port}`,
    close: closable(server),
  };
}

/** A page that redirects to itself, to prove the hop budget is enforced. */
export async function startSelfRedirectFixture({ port = 0 } = {}) {
  let hops = 0;
  let base = '';
  const server = http.createServer((req, res) => {
    hops += 1;
    res.writeHead(302, { Location: `${base}/again`, 'Content-Type': 'text/plain' });
    res.end('again');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${base}/start`,
    hops: () => hops,
    close: closable(server),
  };
}

/**
 * A page or endpoint whose only job is to redirect somewhere else.
 *
 * This is the shape that defeats a check on the URL the user pasted: the entry
 * URL is entirely innocent and the request only becomes dangerous on the way to
 * the second hop. `target` is the address the policy is supposed to refuse.
 */
export async function startRedirectFixtures({ target, status = 302, port = 0 } = {}) {
  let base = '';
  let hops = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/redirect') {
      hops += 1;
      res.writeHead(status, { Location: target, 'Content-Type': 'text/plain' });
      res.end('go away');
      return;
    }
    // The page form: an innocent HTML page that mentions a private address among
    // its media links. This is how a hostile page aims the downloader at a host
    // the user never typed.
    if (url.pathname === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<html><head>
        <source src="${target}">
        <source src="${base}/real_1080p.mp4">
      </head><body></body></html>`);
      return;
    }
    if (url.pathname === '/real_1080p.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '4' });
      res.end('data');
      return;
    }
    res.writeHead(404).end('not found');
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    redirectUrl: `${base}/redirect`,
    pageUrl: `${base}/page`,
    target,
    /** How many times the redirect itself was served, which proves the hop was reached. */
    hops: () => hops,
    close: closable(server),
  };
}

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
    close: closable(server),
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
    close: closable(server),
  };
}
