import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DOWNLOAD_DIR } from './config.js';
import { scrapeMediaLinks } from './scrape.js';
import { withSpan } from './trace.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IDM_CONNECTIONS = 8;
const MIN_SEGMENT = 1024 * 1024;

/**
 * Does this failure mean "the link is no longer good" rather than "the file is
 * broken"?
 *
 * Sites like this hand out signed URLs whose token is only valid for a short
 * window. The panel that shows the choices is rendered seconds to minutes before
 * the button is pressed, so an expired token is an ordinary event rather than an
 * edge case, and it surfaces as an opaque transport error.
 */
const looksLikeDeadLink = (err) =>
  /fetch failed|determine file size|terminated|socket hang up|aborted|40[13]|forbidden|expired|invalid token/i
    .test(err?.message || '');

/**
 * Re-read the page for a link that is valid right now.
 *
 * Returns the URL for the same quality the user picked, so a silent retry does
 * not quietly hand them a different file than the one they chose.
 */
async function refreshLink(pageUrl, preferRes) {
  return withSpan('refresh-link', async () => {
    const { links } = await scrapeMediaLinks(pageUrl);
    if (!links?.length) return null;
    if (preferRes) {
      const same = links.find((l) => l.res === preferRes && /token/i.test(l.url))
        || links.find((l) => l.res === preferRes);
      if (same) return same.url;
    }
    return links[0].url;
  }, {
    input: { pageUrl, preferRes },
    output: (url) => (url ? { recovered: true, resolution: preferRes ?? 'highest' } : { recovered: false }),
  });
}

/** A referer only helps if it is a page that actually lists the media. */
const isScrapablePage = (ref) => {
  if (!ref) return false;
  try {
    const u = new URL(ref);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.pathname !== '/';
  } catch {
    return false;
  }
};

/**
 * Host only, for tracing.
 *
 * Media URLs here carry signed tokens in the query string, and a token is a
 * credential for as long as it is valid. Recording the whole URL would put a
 * live secret into a third-party trace, so only the host is reported.
 */
const hostOf = (url) => {
  try { return new URL(url).host; } catch { return null; }
};

/**
 * IDM-style segmented download.
 *
 * One connection is throttled as one connection. N connections doing Range
 * requests against a server that supports them each get their own share, so
 * the total is usually a multiple of single-connection speed. Each segment
 * writes its own byte window of a preallocated file, so there is nothing to
 * merge afterwards and a retry only refetches its own window.
 *
 * Emits the same event shapes as the yt-dlp engine: {type:'progress',...},
 * {type:'phase',...}. Cancellation is cooperative via AbortController.
 */
export function startDirectDownload({ url, referer, title, preferRes }, handlers = {}) {
  const emit = handlers.onEvent || (() => {});
  const controller = new AbortController();
  const { signal } = controller;
  const headers = { 'User-Agent': UA, Referer: referer || new URL(url).origin + '/' };
  let finished = false;
  let refreshed = false;
  let size = 0;
  let downloaded = 0;
  let t0 = Date.now();
  let lastEmit = 0;
  let outPath = null;
  let partPath = null;
  /** One entry per byte window, each tracking how far it has actually got. */
  let segments = [];

  const safeTitle = (title || 'video').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 120) || 'video';
  const canRefresh = isScrapablePage(referer);

  const fail = (message) => {
    if (finished || signal.aborted) return;
    finished = true;
    handlers.onError?.(message);
    handlers.onClose?.(1, null);
  };

  const progress = () => {
    const now = Date.now();
    if (now - lastEmit < 400 && downloaded < size) return;
    lastEmit = now;
    const el = Math.max((now - t0) / 1000, 0.1);
    const speed = downloaded / el;
    emit({
      type: 'progress', phase: 'downloading', status: 'downloading',
      downloaded, total: size,
      percent: size > 0 ? (downloaded / size) * 100 : null,
      speed: Math.round(speed),
      eta: speed > 0 ? (size - downloaded) / speed : null,
    });
  };

  /**
   * Decide the byte layout.
   *
   * Range support is not optional to check here. A server that ignores Range
   * answers every window with the *whole* file, so running N windows against it
   * writes the entire file once per window at N different offsets and produces
   * a corrupt result that only shows up as garbage much later. When ranges are
   * unavailable the file is fetched as one sequential window instead, which is
   * also the right call for files too small to be worth splitting.
   */
  const planSegments = (ranged) => {
    if (!ranged) {
      segments = [{ start: 0, end: size - 1, pos: 0, done: false }];
      return;
    }
    const count = Math.min(IDM_CONNECTIONS, Math.max(2, Math.floor(size / MIN_SEGMENT)));
    const segSize = Math.ceil(size / count);
    segments = [];
    for (let i = 0; i < count; i++) {
      const start = i * segSize;
      const end = Math.min(start + segSize - 1, size - 1);
      if (start > end) continue;
      segments.push({ start, end, pos: start, done: false });
    }
  };

  /** True when the layout is a single window and a whole-body reply is correct. */
  const wholeBodyOk = () => segments.length <= 1;

  /**
   * Fetch whatever is left, using whatever link is current.
   *
   * Segments carry their own position, so calling this again after a token
   * refresh resumes instead of restarting: only the missing tail of each window
   * is re-requested.
   *
   * The round signal matters more than it looks. When one window fails, the
   * others are still mid-transfer, and Promise.all rejecting does not stop
   * them. Returning early would re-dispatch windows that the stragglers are
   * still writing to, and two calls advancing the same position produce a file
   * that is the right length and the wrong content. So the round is abandoned
   * explicitly, and nothing is handed back until every straggler has unwound.
   */
  const transfer = async (target, fh) => {
    const open = segments.filter((s) => !s.done);
    if (!open.length) return;
    const allowWhole = wholeBodyOk();
    const round = new AbortController();
    const tasks = open.map((seg) => segment(
      target, headers, signal, fh, seg,
      (n) => { downloaded += n; progress(); },
      allowWhole, round.signal,
    ));
    try {
      await Promise.all(tasks);
    } catch (err) {
      round.abort();
      await Promise.allSettled(tasks);
      // Whichever window reported first is the one worth acting on. A straggler
      // that gave up because its siblings were torn down only ever saw the round
      // signal, so letting it win the race would turn one dead link into a
      // failure that looks like a network fault and gets retried pointlessly.
      throw isSuperseded(err) ? firstRealError(tasks) ?? err : err;
    }
  };

  /** True for a window that stopped only because the round was abandoned. */
  const isSuperseded = (err) => /superseded/i.test(err?.message || '');

  /**
   * The first genuine failure among the tasks, ignoring the ones that were only
   * collateral. Ordered by when the window was abandoned rather than by which
   * promise rejected first, since that order is not the order things went wrong.
   */
  function firstRealError(list) {
    for (const outcome of list) {
      if (outcome.status === 'rejected' && !isSuperseded(outcome.reason)) {
        return outcome.reason;
      }
    }
    return null;
  }

  const run = async () => {
    let target = url;
    downloaded = 0;
    t0 = Date.now();

    // Learn the size. An expired token usually dies right here, which is why
    // this is where a refresh is attempted first.
    let info;
    try {
      info = await withSpan('resolve-size', () => resolveSize(target, headers, signal), {
        input: { host: hostOf(target) },
        output: (found) => found && { bytes: found.size, ranges: found.ranges },
        metadata: { attempt: refreshed ? 'after-refresh' : 'initial' },
      });
    } catch (err) {
      if (!canRefresh || refreshed) throw err;
      emit({ type: 'phase', phase: 'refreshing' });
      const fresh = await refreshLink(referer, preferRes);
      if (!fresh) throw err;
      refreshed = true;
      target = fresh;
      info = await resolveSize(target, headers, signal);
    }
    size = info.size;
    outPath = path.join(DOWNLOAD_DIR, `${safeTitle} [${crypto.randomBytes(3).toString('hex')}].${extFor(info.contentType, target)}`);
    partPath = `${outPath}.part`;
    // Splitting only pays off when the origin honours Range. Below a couple of
    // segments' worth the handshake costs more than the time saved.
    const ranged = Boolean(info.ranges) && size >= 2 * MIN_SEGMENT;
    planSegments(ranged);
    emit({
      type: 'progress', phase: 'downloading', status: 'downloading',
      downloaded: 0, total: size, percent: 0, speed: null, eta: null,
    });

    const fh = await fsp.open(partPath, 'w');
    try {
      if (ranged) await fh.truncate(size);
      const bytesBefore = downloaded;
      const startedAt = Date.now();
      try {
        await withSpan('fetch-bytes', () => transfer(target, fh), {
          input: { bytes: size, windows: segments.length, ranges: ranged },
          output: (value) => {
            const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
            const moved = downloaded - bytesBefore;
            return {
              bytes: moved,
              windowsCompleted: segments.filter((s) => s.done).length,
              resumedAfterRefresh: refreshed,
              // Throughput is the number people actually want when they ask why
              // a download was slow, and it cannot be recovered after the fact.
              megabytesPerSecond: Math.round((moved / 1048576) / seconds * 100) / 100,
            };
          },
        });
      } catch (err) {
        // The link can also die part-way through a long transfer. Same remedy,
        // and the per-segment positions mean the retry continues rather than
        // throwing away an hour of transfer.
        if (!canRefresh || refreshed || !looksLikeDeadLink(err)) throw err;
        if (segments.every((s) => s.done)) throw err;
        emit({ type: 'phase', phase: 'refreshing' });
        const fresh = await refreshLink(referer, preferRes);
        if (!fresh) throw err;
        refreshed = true;
        target = fresh;
        // A different size means it is not the same file; start over cleanly
        // rather than splicing two different files together.
        const recheck = await resolveSize(target, headers, signal);
        const recheckRanged = Boolean(recheck.ranges) && size >= 2 * MIN_SEGMENT;
        if (recheck.size !== size || recheckRanged !== ranged) {
          segments = [];
          planSegments(recheckRanged);
          downloaded = 0;
          t0 = Date.now();
          if (recheckRanged) await fh.truncate(size);
        }
        await withSpan('fetch-bytes-resumed', () => transfer(target, fh), {
          input: { bytes: size, windows: segments.length },
          output: (value) => ({ bytes: downloaded - bytesBefore, afterRefresh: true }),
        });
      }
    } finally {
      await fh.close();
    }

    if (signal.aborted) return;
    const st = fs.statSync(partPath);
    if (st.size !== size) throw new Error(`Size mismatch: got ${st.size}, expected ${size}.`);
    fs.renameSync(partPath, outPath);
    finished = true;
    emit({ type: 'phase', phase: 'done' });
    handlers.onClose?.(0, outPath);
  };

  run().catch((err) => {
    try { if (partPath && fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* ignore */ }
    if (signal.aborted) {
      finished = true;
      handlers.onClose?.(1, null);
      return;
    }
    // Say what actually went wrong. "Could not determine file size" reads like
    // a bug in the app; it almost always means the site's link had expired.
    const detail = looksLikeDeadLink(err) && canRefresh
      ? "That site's download link expired before the transfer could start. Try again to get a fresh link."
      : err.message || 'Direct download failed.';
    fail(detail);
  });

  return {
    kill: () => controller.abort(),
  };
}

/**
 * Learn the file size, and whether range requests are honoured.
 *
 * Only 200 and 206 count as success. A 403 error page usually carries a
 * content-length of its own, and treating that as the file size produced
 * baffling "size mismatch" failures several minutes into a download.
 */
async function resolveSize(url, headers, signal) {
  const readType = (res) => (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;

  const probe = await fetch(url, {
    headers: { ...headers, Range: 'bytes=0-0' },
    redirect: 'follow',
    signal,
  }).catch((err) => {
    throw new Error(`fetch failed: ${err.cause?.code || err.message}`);
  });

  try {
    if (probe.status === 206) {
      const total = probe.headers.get('content-range')?.split('/')[1];
      if (total && Number(total) > 0) {
        return { size: Number(total), ranges: true, contentType: readType(probe) };
      }
    } else if (probe.status === 200) {
      const len = probe.headers.get('content-length');
      if (len && Number(len) > 0) {
        return { size: Number(len), ranges: false, contentType: readType(probe) };
      }
    } else {
      throw new Error(`The server refused the download (HTTP ${probe.status}).`);
    }
  } finally {
    await probe.arrayBuffer().catch(() => null);
  }
  throw new Error('Could not determine file size.');
}

/** Pick a real extension from the content type, falling back to the URL path. */
function extFor(contentType, url) {
  const map = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/wav': 'wav',
    'audio/flac': 'flac',
  };
  if (contentType && map[contentType]) return map[contentType];
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase().split(/[^a-z0-9]/)[0];
    if (ext && /^[a-z0-9]{2,4}$/.test(ext) && !['php', 'html', 'htm', 'asp', 'aspx', 'jsp'].includes(ext)) return ext;
  } catch { /* ignore */ }
  return 'mp4';
}

async function segment(url, headers, signal, fh, seg, onChunk, allowWholeBody, roundSignal, retries = 8) {
  let attempt = 0;
  while (seg.pos <= seg.end) {
    if (signal.aborted) throw new Error('cancelled');
    // The round was abandoned by another window failing. Stop here, before
    // writing anything, so this window cannot keep advancing a position that a
    // replacement call is about to take over.
    if (roundSignal?.aborted) throw new Error('superseded');
    try {
      const res = await fetch(url, {
        headers: { ...headers, Range: `bytes=${seg.pos}-${seg.end}` },
        redirect: 'follow',
        signal,
      });
      if (res.status !== 206 && res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }
      // A 200 means the server ignored the Range header and is sending the
      // whole file. That is only correct when this is the file's only window;
      // otherwise the bytes would land at the wrong offset.
      if (res.status === 200 && !allowWholeBody) {
        throw new Error('server refused range request');
      }
      const reader = res.body.getReader();
      for (;;) {
        if (roundSignal?.aborted) throw new Error('superseded');
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new Error('cancelled');
        await fh.write(value, 0, value.length, seg.pos);
        seg.pos += value.length;
        onChunk(value.length);
      }
      if (seg.pos <= seg.end) throw new Error('truncated segment');
      seg.done = true;
      return;
    } catch (err) {
      if (roundSignal?.aborted) throw new Error('superseded');
      if (signal.aborted || /cancelled/i.test(err.message)) throw new Error('cancelled');
      attempt += 1;
      if (seg.pos > seg.end) { seg.done = true; return; }
      // A refused or expired link is not a flaky network, and retrying it cannot
      // help: the same token will be refused again. Propagating it immediately
      // lets the caller fetch a fresh link and carry on from where this window
      // stopped, rather than burning the backoff first.
      if (/HTTP (401|403|410)\b/.test(err.message)) throw err;
      if (attempt > retries) throw new Error(`Segment failed: ${err.message}`);
      await sleep(500 * attempt, roundSignal);
      if (roundSignal?.aborted) throw new Error('superseded');
    }
  }
  seg.done = true;
}

/** A backoff that a superseded round can cut short instead of sitting through. */
function sleep(ms, roundSignal) {
  if (!roundSignal) return new Promise((r) => setTimeout(r, ms));
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      roundSignal.removeEventListener('abort', done);
      resolve();
    }
    roundSignal.addEventListener('abort', done, { once: true });
  });
}
