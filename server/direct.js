import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DOWNLOAD_DIR, MAX_DOWNLOAD_BYTES, TRANSFER_STALL_MS } from './config.js';
import { scrapeMediaLinks } from './scrape.js';
import { safeFetch } from './http-client.js';
import { safeFileName } from './workspace.js';
import { increment, recordFailure } from './metrics.js';
import { withSpan } from './trace.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/**
 * Windows per stream.
 *
 * Exported because the number is worth knowing about without reading the whole
 * planner, and a caller that used to be able to set it should be able to say so.
 * The actual count is chosen from the file size: splitting a small file costs more
 * in handshakes than it saves.
 */
export const IDM_CONNECTIONS = 8;
const MIN_SEGMENT = 1024 * 1024;

/** Raised when the origin changed the file underneath a resumed window. */
const RANGE_INVALIDATED = 'range invalidated';

/**
 * The least a cancelled download is worth keeping.
 *
 * Below this the partial is a preallocated file with nothing in it, which is the
 * case that made "recoverable" a lie in the other direction: a job would claim to
 * be resumable and would re-download everything. One window's worth is a reasonable
 * floor -- enough that resuming is genuinely cheaper than starting again.
 */
const MIN_RESUMABLE_BYTES = 1024 * 1024;

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
 * Is this URL a manifest rather than a media file?
 *
 * Both HLS (`.m3u8`) and DASH (`.mpd`) are playlists: text documents listing other
 * URLs. Matched on the path with the query and fragment excluded, so a signed media
 * link carrying a token parameter is not mistaken for one -- and so a path segment
 * that merely contains "m3u8" is not either.
 */
const isManifest = (raw) => {
  try {
    return /\.(m3u8|mpd)$/i.test(new URL(raw).pathname);
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
 * `destDir` is the directory the file is built in. The job manager passes a
 * private workspace per job, which is what lets a finished job's artifact be
 * identified without guessing; it defaults to the download directory, which is
 * what a standalone caller such as scripts/idm.js wants.
 *
 * Emits the same event shapes as the yt-dlp engine: {type:'progress',...},
 * {type:'phase',...}. Cancellation is cooperative via AbortController.
 */
export function startDirectDownload({ url, referer, title, preferRes, destDir = DOWNLOAD_DIR }, handlers = {}) {
  const emit = handlers.onEvent || (() => {});
  const controller = new AbortController();

  // Refuse a manifest rather than downloading it.
  //
  // This engine is a byte-range downloader. It probes for a length, plans windows
  // across the body and writes them to disk, and none of that means anything for a
  // playlist: an `.m3u8` or `.mpd` is a text file listing other URLs. The scraper no
  // longer offers one, so this is the backstop for a URL that arrives some other way
  // -- a stale UI, a bookmarklet, a hand-written request.
  //
  // The failure it prevents is worse than an error. Without this, an origin that
  // reports a length makes the download "succeed" and writes a few kilobytes of
  // playlist text into the library under a video name, where nothing downstream can
  // tell it from a broken video.
  if (isManifest(url)) {
    const isHls = /\.m3u8$/i.test(new URL(url).pathname);
    const article = isHls ? 'an HLS' : 'a DASH';
    handlers.onError?.(
      `That link is ${article} playlist, not a media file. `
      + 'Paste the page URL instead: the normal download path resolves the playlist '
      + 'and its segments.',
    );
    handlers.onClose?.(1, null);
    return { kill: () => {} };
  }
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
  /** Cached validators, so a partial re-request can refuse a file that changed. */
  let validators = null;
  /** One entry per byte window, each tracking how far it has actually got. */
  let segments = [];

  const safeTitle = safeFileName(title || 'video', 'video');
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
      allowWhole, round.signal, size, validators,
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
    validators = { etag: info.etag, lastModified: info.lastModified };
    outPath = path.join(
      destDir,
      `${safeTitle} [${crypto.randomBytes(3).toString('hex')}].${extFor(info.contentType, target)}`,
    );
    partPath = `${outPath}.part`;
    // Splitting only pays off when the origin honours Range. Below a couple of
    // segments' worth the handshake costs more than the time saved.
    const ranged = Boolean(info.ranges) && size >= 2 * MIN_SEGMENT;
    planSegments(ranged);
    emit({
      type: 'progress', phase: 'downloading', status: 'downloading',
      downloaded: 0, total: size, percent: 0, speed: null, eta: null,
    });

    await fsp.mkdir(destDir, { recursive: true });
    const fh = await fsp.open(partPath, 'w');
    try {
      if (ranged) await fh.truncate(size);
      await fetchBytes(target, fh);
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

  /**
   * Move every byte into the file, recovering from the two failures worth
   * recovering from.
   *
   * Three different things can go wrong here and they want three different
   * responses, which is why this is an explicit loop rather than a retry wrapper:
   *
   *   the origin changed the file   throw the bytes away and start clean
   *   the link expired              fetch a fresh one and carry on from each
   *                                 window's own position, which is the whole
   *                                 reason windows carry their own position
   *   neither                       let the error out to the caller
   *
   * The loop is bounded and both recoveries are guarded by a flag, so neither can
   * cycle: a refresh can happen once, and a restart can only follow a resume,
   * which a restart has just eliminated.
   */
  const fetchBytes = async (initialTarget, fh) => {
    let target = initialTarget;
    const bytesBefore = downloaded;
    const startedAt = Date.now();
    const wasRanged = () => segments.length > 1;

    const attempt = (label, extra = {}) => withSpan(label, () => transfer(target, fh), {
      input: { bytes: size, windows: segments.length, ranged: wasRanged(), ...extra },
      output: () => {
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

    for (let round = 0; round <= 2; round += 1) {
      try {
        await attempt(round === 0 ? 'fetch-bytes' : 'fetch-bytes-resumed',
          round === 0 ? {} : { afterRecovery: true });
        return;
      } catch (err) {
        if (isRangeInvalidated(err)) {
          // The validators proved this is not the file we started fetching.
          // Anything already on disk belongs to a different file, so the only
          // correct move is to throw it away rather than splice the two.
          emit({ type: 'phase', phase: 'restarting' });
          validators = null;
          segments = [];
          planSegments(wasRanged());
          downloaded = 0;
          t0 = Date.now();
          lastEmit = 0;
          if (wasRanged()) await fh.truncate(size);
          increment('download_restarted', { reason: 'origin_changed_file' });
          continue;
        }

        // A refused or expired link is not a flaky network. One fresh link is
        // worth trying; the per-window positions mean it continues rather than
        // discarding the transfer.
        if (!canRefresh || refreshed || !looksLikeDeadLink(err)) throw err;
        if (segments.every((s) => s.done)) throw err;

        emit({ type: 'phase', phase: 'refreshing' });
        const fresh = await refreshLink(referer, preferRes);
        if (!fresh) throw err;
        refreshed = true;
        target = fresh;
        increment('download_refreshed', { stage: 'transfer' });

        // A different size means it is not the same file; start over cleanly
        // rather than splicing two different files together.
        const recheck = await resolveSize(target, headers, signal);
        validators = { etag: recheck.etag, lastModified: recheck.lastModified };
        const recheckRanged = Boolean(recheck.ranges) && recheck.size >= 2 * MIN_SEGMENT;
        if (recheck.size !== size || recheckRanged !== wasRanged()) {
          size = recheck.size;
          segments = [];
          planSegments(recheckRanged);
          downloaded = 0;
          t0 = Date.now();
          lastEmit = 0;
          if (recheckRanged) await fh.truncate(size);
        }
      }
    }

    throw new Error('The download could not be completed after recovering from a failed link.');
  };

  /**
   * Keep the partial file after a cancellation, unless it is not really resumable.
   *
   * A ranged download preallocates the whole file, so the `.part` is the right
   * length from the first moment and its size says nothing about how much of it is
   * real. What says so is the progress the engine has actually reported, which is
   * why this compares against that rather than against the file.
   *
   * A cancel that lands in the first moments -- before a single window has
   * delivered anything -- leaves a sparse file of the full length that looks
   * resumable and is not, and resuming it would re-download the whole thing while
   * the user believes they are picking up where they left off. So below a small
   * floor the partial is deleted, and the caller is told there was nothing to keep.
   *
   * @returns {boolean} whether bytes worth resuming were left on disk.
   */
  const keepPartialOnCancel = () => {
    if (!partPath) return false;
    const worthKeeping = downloaded >= MIN_RESUMABLE_BYTES;
    if (worthKeeping) return true;
    try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* ignore */ }
    return false;
  };

  const isRangeInvalidated = (err) => /range invalidated/i.test(err?.message || '');

  run().catch((err) => {
    // A cancelled transfer keeps its bytes.
    //
    // This is checked before anything is deleted, and that ordering is the whole
    // point. Deleting first and asking why afterwards made a cancellation destroy
    // the very file the job then claimed was recoverable: `cancelJob` sets
    // `recoverable` on the strength of a partial file existing, so a cancelled job
    // reported 4 MB downloaded and had nothing on disk to resume from. A user who
    // cancelled to free bandwidth lost the download instead of pausing it.
    //
    // An abort during `fh.truncate` can leave a sparse file that is the right
    // length but almost entirely holes, which is the one case where keeping the
    // bytes would be worse than losing them -- it looks resumable and is not. So a
    // cancelled job whose partial is barely written is deleted, and `bytesKept`
    // tells the caller which happened.
    if (signal.aborted) {
      finished = true;
      const kept = keepPartialOnCancel();
      handlers.onClose?.(1, null, { bytesKept: kept });
      return;
    }
    // A genuine failure has nothing worth resuming: the link is dead or the origin
    // is refusing, and the bytes on disk would only be mistaken for progress.
    try { if (partPath && fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch { /* ignore */ }
    // Counted here rather than in fail(), because fail() is also reached for
    // cancellations on some paths and this is the one place the error is final.
    recordFailure(err, 'download_failed');
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
 *
 * The validators are kept because they are the only cheap way to notice that the
 * origin has swapped the file while a transfer was in flight.
 */
async function resolveSize(url, headers, signal) {
  const readType = (res) => (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || null;

  const probe = await safeFetch(url, {
    headers: { ...headers, Range: 'bytes=0-0' },
    signal,
    timeoutMs: 30_000,
  }).catch((err) => {
    throw new Error(`fetch failed: ${err.cause?.code || err.message}`);
  });

  const validators = {
    etag: probe.headers.get('etag') || null,
    lastModified: probe.headers.get('last-modified') || null,
  };

  try {
    if (probe.status === 206) {
      const total = probe.headers.get('content-range')?.split('/')[1];
      if (total && Number(total) > 0) {
        assertSize(Number(total));
        return { size: Number(total), ranges: true, contentType: readType(probe), ...validators };
      }
    } else if (probe.status === 200) {
      const len = probe.headers.get('content-length');
      if (len && Number(len) > 0) {
        assertSize(Number(len));
        return { size: Number(len), ranges: false, contentType: readType(probe), ...validators };
      }
    } else {
      throw new Error(`The server refused the download (HTTP ${probe.status}).`);
    }
  } finally {
    // Drained either way, so the socket is clean and may be reused.
    await probe.arrayBuffer().catch(() => null);
  }
  throw new Error('Could not determine file size.');
}

function assertSize(bytes) {
  if (bytes > MAX_DOWNLOAD_BYTES) {
    throw new Error(`That file is ${bytes} bytes, over the ${MAX_DOWNLOAD_BYTES} byte limit.`);
  }
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

/**
 * Check that a 206 really is the window we asked for.
 *
 * A 206 is a claim, not a guarantee. A CDN that answers `bytes=1000-1999/99999`
 * with `Content-Range: bytes 0-5000/99999` will have this window write over the
 * beginning of the previous one, and the result is a file of exactly the right
 * length whose contents are a shuffled interleaving of two regions of the source.
 * Nothing downstream can detect that, so it is checked here.
 *
 * Only structural claims are verified. The body itself is checked separately, by
 * byte count, in the read loop.
 */
function validateRange(res, seg, size) {
  const raw = res.headers.get('content-range');
  if (!raw) throw rejected('The server sent a partial response with no Content-Range.');

  const m = /^bytes\s+(\d+)\s*-\s*(\d+)\s*\/\s*(\d+|\*)$/i.exec(raw.trim());
  if (!m) throw rejected(`The server sent an unreadable Content-Range: ${raw}`);

  const start = Number(m[1]);
  const end = Number(m[2]);
  const total = m[3] === '*' ? null : Number(m[3]);

  if (start !== seg.pos) {
    throw rejected(`The server answered from byte ${start} when ${seg.pos} was asked for.`);
  }
  if (end < start) throw rejected(`The server sent a Content-Range that ends before it starts: ${raw}`);
  if (end > seg.end) {
    throw rejected(`The server sent more than this window (up to ${end}, expected ${seg.end}).`);
  }
  if (total !== null && Number.isFinite(size) && total !== size) {
    throw rejected(`The file changed size mid-download (${size} became ${total}).`);
  }

  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const len = Number(declared);
    if (!Number.isFinite(len) || len !== end - start + 1) {
      throw rejected(`The server declared ${declared} bytes for a ${end - start + 1} byte window.`);
    }
  }
  return end;
}

/**
 * A range complaint, counted as one.
 *
 * Worth distinguishing from an ordinary transport failure: this means the origin
 * said something untrue about the file, which is a different problem to chase and
 * a different thing to tell the user.
 */
function rejected(message) {
  increment('range_rejected');
  const err = new Error(message);
  err.rangeMismatch = true;
  return err;
}

async function segment(
  url, headers, signal, fh, seg, onChunk,
  allowWholeBody, roundSignal, size, validators, retries = 8,
) {
  let attempt = 0;
  while (seg.pos <= seg.end) {
    if (signal.aborted) throw new Error('cancelled');
    // The round was abandoned by another window failing. Stop here, before
    // writing anything, so this window cannot keep advancing a position that a
    // replacement call is about to take over.
    if (roundSignal?.aborted) throw new Error('superseded');

    // One controller per attempt so a stalled connection can be torn down without
    // disturbing the caller's cancellation or its siblings.
    const attemptCtl = new AbortController();
    let stallTimer = null;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => attemptCtl.abort(new Error('stalled')), TRANSFER_STALL_MS);
      stallTimer.unref?.();
    };

    try {
      const resuming = seg.pos > seg.start;
      const requestHeaders = { ...headers, Range: `bytes=${seg.pos}-${seg.end}` };
      // If-Range turns a changed file into a whole-body 200 instead of a 206 that
      // splices two versions together. Only meaningful once bytes are already
      // down; on a fresh window there is nothing to protect.
      if (resuming && validators?.etag) requestHeaders['If-Range'] = validators.etag;
      else if (resuming && validators?.lastModified) requestHeaders['If-Range'] = validators.lastModified;

      const res = await safeFetch(url, {
        headers: requestHeaders,
        signal: AbortSignal.any([signal, attemptCtl.signal]),
        // No whole-request deadline: a large transfer outlives any budget. The
        // stall timer is what catches a connection that has stopped moving.
        timeoutMs: 0,
      });

      // Any decision made from the headers alone leaves the body unread, so each
      // of those paths has to give the socket up. A half-read response left in the
      // reuse pool would corrupt the next request that picked it up.
      const refuse = async (err) => {
        try { res.destroy(); } catch { /* already gone */ }
        throw err;
      };

      if (res.status !== 206 && res.status !== 200) {
        await refuse(new Error(`HTTP ${res.status}`));
      }

      if (res.status === 206) {
        try {
          validateRange(res, seg, size);
        } catch (err) {
          await refuse(err);
        }
      } else {
        // A 200 means the server ignored the Range header and is sending the
        // whole file. That is only correct when this is the file's only window;
        // otherwise the bytes would land at the wrong offset.
        if (!allowWholeBody) await refuse(new Error('server refused range request'));
        // Sent for a partial window, so the validators were not honoured: the
        // origin has a different file now. Restart rather than splice.
        if (resuming) await refuse(new Error(RANGE_INVALIDATED));
      }

      armStall();
      const reader = res.body.getReader();
      for (;;) {
        if (roundSignal?.aborted) throw new Error('superseded');
        const { done, value } = await reader.read();
        if (done) break;
        if (signal.aborted) throw new Error('cancelled');
        // Refuse the write rather than let an over-long body spill into the next
        // window's bytes. The file would still be the right length.
        if (seg.pos + value.length - 1 > seg.end) {
          throw rejected('The server sent more bytes than this window asked for.');
        }
        await fh.write(value, 0, value.length, seg.pos);
        seg.pos += value.length;
        onChunk(value.length);
        armStall();
      }

      // Exact equality, not `<=`. Both a short body and an over-long one are
      // corruption, and only one of them was previously detected.
      //
      // The short case is deliberately *not* a range mismatch: a body that stops
      // early is the transport cutting out, and resuming from where it got to is
      // the whole reason a window carries its own position.
      if (seg.pos < seg.end + 1) throw new Error('truncated segment');
      if (seg.pos > seg.end + 1) {
        throw rejected('The server sent more bytes than this window asked for.');
      }
      seg.done = true;
      return;
    } catch (err) {
      if (roundSignal?.aborted) throw new Error('superseded');
      if (signal.aborted || /cancelled/i.test(err.message)) throw new Error('cancelled');
      // The origin swapped the file. No amount of retrying this window fixes it,
      // and retrying it would write one version's bytes into another's window.
      if (new RegExp(RANGE_INVALIDATED).test(err.message)) throw err;
      attempt += 1;
      if (seg.pos > seg.end) { seg.done = true; return; }

      // Two classes of failure cannot be fixed by asking again, and both used to
      // sit through the full retry budget first. That cost about eighteen seconds
      // of backoff per window for an answer that was never going to change:
      //
      //   a refused link     the same token will be refused again, so this goes
      //                      straight up to the caller, which fetches a fresh link
      //   a lying origin     Content-Range described the wrong window of the file.
      //                      Asking for the identical window returns the identical
      //                      lie, so this is a hard failure and the bytes on disk
      //                      are already suspect.
      //
      // Everything else -- a dropped connection, a truncated body, a 5xx -- is
      // genuinely transient and keeps the backoff.
      if (/HTTP (401|403|410)\b/.test(err.message)) throw err;
      if (err.rangeMismatch) {
        throw new Error(`The server described the wrong part of the file, so this window cannot be fetched safely: ${err.message}`);
      }

      if (attempt > retries) throw new Error(`Segment failed: ${err.message}`);
      await sleep(500 * attempt, roundSignal);
      if (roundSignal?.aborted) throw new Error('superseded');
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
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