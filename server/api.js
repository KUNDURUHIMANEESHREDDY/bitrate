import fs from 'node:fs';
import { probe, normaliseInfo, runtime, ytdlpVersion, errors } from './engine.js';
import { scrapeMediaLinks } from './scrape.js';
import {
  createJob, listJobs, getJob, cancelJob, clearFinished, publicJob, stats, init,
} from './jobs.js';
import * as library from './library.js';
import { hub } from './events.js';
import {
  DOWNLOAD_DIR, WEB_DIST, CONCURRENT_FRAGMENTS, MAX_CONCURRENT, ARIA2C, FFMPEG, YTDLP,
} from './config.js';

/** Handlers return the payload itself; Fastify wraps it in the HTTP response. */
const ok = (payload) => payload;

/** Only http(s). Blocks file://, and the assorted schemes a page URL might carry. */
function validUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const candidate = raw.trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    // Bare hostnames are common enough to be worth rescuing.
    try { parsed = new URL(`https://${candidate}`); } catch { return null; }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || !parsed.hostname.includes('.')) return null;
  return parsed.toString();
}

const fail = (code, message) => {
  const err = new Error(message);
  err.statusCode = code;
  return err;
};

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
  }));

  app.post('/api/probe', async (req) => {
    const url = validUrl(req.body?.url);
    if (!url) throw fail(400, 'That does not look like a valid http(s) link.');

    try {
      const info = await probe(url);
      return ok(normaliseInfo(info));
    } catch (err) {
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
      if (!fileUrl) throw fail(400, 'That does not look like a valid http(s) link.');
      const referer = validUrl(req.body?.referer) || null;
      const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : null;
      // Remembered so that if the link has to be refreshed mid-transfer, the
      // retry lands on the same quality the user chose.
      const preferRes = typeof req.body?.res === 'string' ? req.body.res.slice(0, 20) : null;
      const job = createJob({ url: fileUrl, title, direct: true, referer, preferRes });
      return publicJob(job);
    }

    const url = validUrl(req.body?.url);
    if (!url) throw fail(400, 'That does not look like a valid http(s) link.');

    const kind = req.body?.kind === 'audio' ? 'audio' : 'video';
    const allowed = new Set(['best', '2160', '1440', '1080', '720', '480', '360']);
    const quality = allowed.has(req.body?.quality) ? req.body.quality : 'best';
    const audioFormat = ['best', 'mp3', 'm4a'].includes(req.body?.audioFormat) ? req.body.audioFormat : 'best';
    const title = typeof req.body?.title === 'string' ? req.body.title.slice(0, 200) : null;

    const job = createJob({
      url,
      kind,
      quality,
      audioFormat,
      remuxMp4: Boolean(req.body?.remuxMp4),
      subtitle: Boolean(req.body?.subtitle),
      title,
    });
    return ok(publicJob(job));
  });

  /**
   * Scrape a page for direct media links. This is the fallback for sites
   * yt-dlp cannot extract: fresh tokens are read at request time, never stored.
   */
  app.post('/api/scrape', async (req) => {
    const url = validUrl(req.body?.url);
    if (!url) throw fail(400, 'That does not look like a valid http(s) link.');
    try {
      return await scrapeMediaLinks(url);
    } catch (err) {
      throw fail(422, err.message || 'Could not read that page.');
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
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : stat.size - 1;
        if (start >= stat.size || end >= stat.size || start > end) {
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
    hub.addClient(reply.raw, { lastEventId: Number(req.headers['last-event-id']) || 0 });
    // Tell Fastify the response is handled manually and will never end.
    reply.hijack();
  });
}

export { DOWNLOAD_DIR, WEB_DIST, YTDLP, FFMPEG, ARIA2C };
