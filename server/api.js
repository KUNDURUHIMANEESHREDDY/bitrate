import fs from 'node:fs';
import { probe, normaliseInfo, runtime, ytdlpVersion, errors } from './engine.js';
import { scrapeMediaLinks } from './scrape.js';
import {
  createJob, listJobs, getJob, cancelJob, clearFinished, publicJob, stats, init,
} from './jobs.js';
import * as library from './library.js';
import { hub } from './events.js';
import { gates } from './limits.js';
import { quickCheck, policy as netPolicy } from './network-policy.js';
import { validateCookieFile, describeCookieFailure } from './credentials.js';
import { increment, recordFailure, snapshot, setGauge } from './metrics.js';
import {
  DOWNLOAD_DIR, WEB_DIST, CONCURRENT_FRAGMENTS, MAX_CONCURRENT, ARIA2C, FFMPEG, YTDLP,
  MAX_QUEUE_SIZE, MAX_SCRAPE_BYTES, MAX_DOWNLOAD_BYTES,
} from './config.js';

/** Handlers return the payload itself; Fastify wraps it in the HTTP response. */
const ok = (payload) => payload;

const fail = (code, message, extra = {}) => {
  const err = new Error(message);
  err.statusCode = code;
  Object.assign(err, extra);
  return err;
};

/** Snapshot the live numbers alongside the counters, so one read answers everything. */
function withGauges() {
  const q = stats();
  setGauge('jobs_running', q.running);
  setGauge('jobs_queued', q.queued);
  setGauge('jobs_total', q.total);
  setGauge('probes_in_flight', gates.probe.active);
  setGauge('scrapes_in_flight', gates.scrape.active);
  setGauge('event_clients', hub.size);
  return snapshot();
}

/**
 * Check a URL the caller handed us.
 *
 * Two stages on purpose. The synchronous one refuses the shapes that need no
 * network to decide -- an IP literal in a range we will not reach, a scheme that
 * is not http(s), a URL carrying credentials -- so an obviously bad request is
 * refused without waiting on DNS. Anything involving a name is allowed through
 * here and resolved properly when the request is actually made, because a lookup
 * is the expensive part and a queue of callers should not each pay for one
 * before the one before them has been served.
 */
function validUrl(raw) {
  const verdict = quickCheck(raw);
  if (verdict.ok) return verdict.url;
  // Marked so the refusal is counted as a policy decision rather than as a
  // download that failed, which are very different numbers to look at.
  throw fail(400, verdict.reason, { blocked: true, blockedRange: verdict.range || 'invalid' });
}

/**
 * Validate a caller-supplied cookie file.
 *
 * `cookieFile` is accepted as well as `cookies`, because that was the name the
 * README used and a caller following an older copy of it should not silently get
 * an unauthenticated download that fails for an unrelated-looking reason.
 */
function cookiesFrom(body) {
  const supplied = body?.cookies ?? body?.cookieFile;
  if (!supplied) return { ok: true, file: null };
  const result = validateCookieFile(supplied);
  if (!result.ok) return { ok: false, error: describeCookieFailure(result.error) };
  return result;
}

export default async function api(app) {
  init();

  app.get('/api/health', async () => ok({
    ok: true,
    downloadDir: DOWNLOAD_DIR,
    ytdlp: { available: runtime.ytdlp, version: ytdlpVersion() },
    ffmpeg: runtime.ffmpeg,
    aria2c: runtime.aria2c,
    tuning: { concurrentFragments: CONCURRENT_FRAGMENTS, maxConcurrent: MAX_CONCURRENT },
    queue: stats(),
    clients: hub.size,
    // The security posture, stated rather than assumed. A deployment should be
    // able to answer "what is this instance allowed to reach" from the API.
    network: {
      policy: netPolicy.mode,
      alwaysBlocked: netPolicy.blocks,
      strictAlsoBlocks: netPolicy.strictAlsoBlocks,
    },
    limits: {
      maxQueueSize: MAX_QUEUE_SIZE,
      maxScrapeBytes: MAX_SCRAPE_BYTES,
      maxDownloadBytes: MAX_DOWNLOAD_BYTES,
      maxSseClients: hub.max,
      maxConcurrentProbes: gates.probe.limit,
      maxConcurrentScrapes: gates.scrape.limit,
    },
  }));

  app.post('/api/probe', async (req) => {
    const url = validUrl(req.body?.url);
    const cookie = cookiesFrom(req.body);
    if (!cookie.ok) throw fail(400, cookie.error);

    try {
      // Gated: an extraction is a yt-dlp process launch, which is expensive
      // enough that an unbounded number of them is a way to make the app
      // unresponsive rather than a way to use it.
      const info = await gates.probe.run(() => probe(url, { cookieFile: cookie.file }));
      return ok(normaliseInfo(info));
    } catch (err) {
      recordFailure(err, 'probe_failed');
      const detail = errors.cleanError(err.message);
      throw fail(422, detail
        ? detail
        : 'yt-dlp could not read that link. The site may not be supported yet, or it may block automated requests. Trying again in a browser session with cookies set usually helps.');
    }
  });

  app.post('/api/downloads', async (req) => {
    // Direct (IDM-style) download: the URL already points at media bytes.
    // Used as the fallback when yt-dlp has no extractor for the page.
    if (req.body?.direct === true) {
      const fileUrl = validUrl(req.body?.fileUrl);
      const referer = req.body?.referer ? (quickCheck(req.body.referer).url || null) : null;
      const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : null;
      // Remembered so that if the link has to be refreshed mid-transfer, the
      // retry lands on the same quality the user chose.
      const preferRes = typeof req.body?.res === 'string' ? req.body.res.slice(0, 20) : null;
      // Cookies are deliberately not accepted here. The direct engine has no way to
      // send them, so recording `usingCookies` for this path would claim something
      // that never happened. Refusing is honest in a way a silently ignored
      // parameter is not.
      const job = createJob({ url: fileUrl, title, direct: true, referer, preferRes });
      return publicJob(job);
    }

    const url = validUrl(req.body?.url);

    const kind = req.body?.kind === 'audio' ? 'audio' : 'video';
    const allowed = new Set(['best', '2160', '1440', '1080', '720', '480', '360']);
    const quality = allowed.has(req.body?.quality) ? req.body.quality : 'best';
    const audioFormat = ['best', 'mp3', 'm4a'].includes(req.body?.audioFormat) ? req.body.audioFormat : 'best';
    const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : null;

    const cookie = cookiesFrom(req.body);
    if (!cookie.ok) throw fail(400, cookie.error);

    const job = createJob({
      url,
      kind,
      quality,
      audioFormat,
      remuxMp4: Boolean(req.body?.remuxMp4),
      subtitle: Boolean(req.body?.subtitle),
      cookieFile: cookie.file,
      title,
    });
    return ok(publicJob(job));
  });

  /**
   * Scrape a page for direct media links. This is the fallback for sites
   * yt-dlp cannot extract: fresh tokens are read at request time, never stored.
   *
   * A page whose only media is HLS gets a 422 with a reason rather than an empty
   * list. The distinction matters to the person looking at it: "no direct links on
   * this page" and "this page has streams but not files" are different problems, and
   * the second one has a real answer -- hand the page URL to yt-dlp, which resolves
   * a manifest properly.
   */
  app.post('/api/scrape', async (req) => {
    const url = validUrl(req.body?.url);
    try {
      const found = await scrapeMediaLinks(url);
      if (!found.links.length && found.hlsSeen) {
        throw fail(422,
          'This page offers HLS streams rather than direct file links. '
          + 'Paste the page URL as a normal download instead: that path resolves the '
          + 'playlist and its segments, which the direct downloader cannot do.',
          { hlsOnly: true });
      }
      return found;
    } catch (err) {
      throw fail(err.statusCode || 422, err.message || 'Could not read that page.');
    }
  });

  app.get('/api/jobs', async () => ok(listJobs()));

  app.get('/api/jobs/:id', async (req) => {
    const job = getJob(req.params.id);
    if (!job) throw fail(404, 'No such job.');
    return ok(publicJob(job));
  });

  app.post('/api/jobs/:id/cancel', async (req) => {
    const changed = cancelJob(req.params.id);
    if (!changed) throw fail(409, 'That job is no longer running.');
    return ok(publicJob(getJob(req.params.id)));
  });

  app.post('/api/jobs/clear', async () => {
    clearFinished();
    return ok({ cleared: true });
  });

  /**
   * Counters, for answering "why did that fail?" without reading a log.
   *
   * Every series carries its own meaning, because a rising number nobody can
   * interpret is the same as no number at all.
   */
  app.get('/api/metrics', async () => ok({
    ...withGauges(),
    queue: stats(),
    clients: hub.size,
  }));

  app.get('/api/library', async () => ok(await library.list()));

  app.delete('/api/library/:name', async (req) => {
    const res = await library.remove(req.params.name);
    if (!res.ok) throw fail(400, res.error);
    hub.broadcast('library-changed', { name: req.params.name });
    return ok({ deleted: true });
  });

  app.post('/api/library/reveal', async (req) => {
    const res = library.reveal(req.body?.name);
    if (!res.ok) throw fail(400, res.error);
    return ok({ ok: true });
  });

  /**
   * Media route for in-app preview. Sends the filename as
   * `Content-Disposition: inline` so the browser renders it instead of
   * downloading it, and never as `attach` with an attacker-controlled name.
   */
  app.get('/api/library/file/:name', async (req, reply) => {
    const found = library.streamFile(req.params.name);
    if (!found) throw fail(404, 'File not found.');
    const { full, stat } = found;

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'private, max-age=0, must-revalidate');
    // Escape quotes and strip CR/LF so the header cannot be split.
    reply.header(
      'Content-Disposition',
      `inline; filename="${String(req.params.name).replace(/["\r\n]/g, '')}"`,
    );

    // Range support: without it Chrome cannot seek in the preview.
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        if (!Number.isFinite(start) || !Number.isFinite(end)
          || start >= stat.size || end >= stat.size || start > end) {
          reply.code(416).header('Content-Range', `bytes */${stat.size}`).send();
          return reply;
        }
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        reply.header('Content-Length', String(end - start + 1));
        return reply.send(fs.createReadStream(full, { start, end }));
      }
    }

    reply.header('Content-Length', String(stat.size));
    return reply.send(fs.createReadStream(full));
  });

  app.get('/api/events', (req, reply) => {
    const client = hub.addClient(reply.raw, { lastEventId: Number(req.headers['last-event-id']) || 0 });
    if (!client) {
      reply.code(503).send({ error: 'Too many event streams open. Close another tab and retry.' });
      return;
    }
    // Tell Fastify the response is handled manually and will never end.
    reply.hijack();
  });
}

export { DOWNLOAD_DIR, WEB_DIST, YTDLP, FFMPEG, ARIA2C };