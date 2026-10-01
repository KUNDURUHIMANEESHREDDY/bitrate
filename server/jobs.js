import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startDownload } from './engine.js';
import { startDirectDownload } from './direct.js';
import { startSpan } from './trace.js';

/** Host only, for tracing. Media URLs carry signed tokens; see trace.js. */
function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}
import { hub } from './events.js';
import { removeIfEmpty } from './library.js';
import { DOWNLOAD_DIR, DATA_DIR, STATE_FILE, MAX_CONCURRENT, ensureDirs } from './config.js';

const TERMINAL = new Set(['done', 'error', 'cancelled']);

let jobs = new Map();
let running = new Set();
let seq = 0;

/** Serialise writes; concurrent job events must not interleave a read-modify-write. */
let persistChain = Promise.resolve();

function persist() {
  persistChain = persistChain.then(() => {
    try {
      const snapshot = JSON.stringify(
        { seq, jobs: [...jobs.values()].slice(-200) },
        null,
        2,
      );
      const tmp = `${STATE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('[jobs] persist failed:', err.message);
    }
  });
  return persistChain;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    seq = raw.seq || 0;
    for (const j of raw.jobs || []) {
      // A job that was mid-flight when the process died cannot be resumed
      // silently: the child process is gone. Mark it interrupted so the UI
      // shows the truth rather than a download that will never progress.
      if (!TERMINAL.has(j.status)) {
        jobs.set(j.id, { ...j, status: 'error', error: 'Interrupted when the server stopped. Re-run to resume from the partial file.' });
      } else {
        jobs.set(j.id, j);
      }
    }
  } catch { /* first run, or corrupt state: start clean */ }
}

export function publicJob(j) {
  return {
    id: j.id,
    url: j.url,
    title: j.title,
    kind: j.kind,
    quality: j.quality,
    status: j.status,
    phase: j.phase,
    percent: j.percent,
    downloaded: j.downloaded,
    total: j.total,
    speed: j.speed,
    eta: j.eta,
    error: j.error,
    file: j.file,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  };
}

function announce(job) {
  hub.broadcast('job', publicJob(job));
  if (job.status === 'done' || job.status === 'error') {
    hub.broadcast('library-changed', { jobId: job.id });
  }
}

export function createJob({ url, kind = 'video', quality = 'best', audioFormat = 'best', remuxMp4 = false, subtitle = false, cookieFile = null, title = null, direct = false, referer = null, preferRes = null }) {
  ensureDirs();
  const id = crypto.randomUUID();
  const job = {
    id,
    url,
    title: title || url,
    kind: direct ? 'video' : kind,
    quality,
    audioFormat,
    remuxMp4,
    subtitle,
    cookieFile,
    direct: Boolean(direct),
    referer,
    preferRes,
    status: 'queued',
    phase: 'queued',
    percent: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    eta: null,
    error: null,
    file: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  void persist();
  announce(job);
  pump();
  return job;
}

export function getJob(id) { return jobs.get(id); }

export function listJobs() {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(publicJob);
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job || TERMINAL.has(job.status)) return false;
  job._kill?.();
  job.status = 'cancelled';
  job.phase = 'cancelled';
  job.speed = 0;
  job.finishedAt = Date.now();
  announce(job);
  void persist();
  return true;
}

export function clearFinished() {
  for (const [id, j] of jobs) {
    if (TERMINAL.has(j.status)) jobs.delete(id);
  }
  void persist();
  hub.broadcast('jobs-cleared', {});
}

/**
 * Start as many queued jobs as the concurrency budget allows.
 * A slot freed by a finished job immediately picks up the next in line.
 */
export function pump() {
  for (const job of jobs.values()) {
    if (running.size >= MAX_CONCURRENT) break;
    if (job.status !== 'queued') continue;
    run(job);
  }
}

function run(job) {
  running.add(job.id);
  job.status = 'running';
  job.phase = 'downloading';
  job.error = null;
  announce(job);

  // One trace per download: a self-contained unit of work with a clear outcome.
  // The span is opened here and closed in onClose, because the engine starts a
  // child process and returns immediately. The engines open their own child
  // observations for the steps that vary, so this span stays a summary rather
  // than swallowing the detail.
  job._trace = startSpan('download-media', {
    // Host only: a direct media URL carries a signed token in its query string
    // and that token is a credential while it is valid, so it does not belong
    // in a trace that leaves the machine.
    input: { host: hostOf(job.url) },
    metadata: {
      source: job.direct ? 'direct' : 'ytdlp',
      kind: job.kind,
      quality: job.quality,
      audioFormat: job.audioFormat,
      remuxMp4: job.remuxMp4,
      subtitle: job.subtitle,
    },
    // Resolved when the span closes, not now: the job is still running and the
    // numbers that matter do not exist yet.
    output: () => {
      const seconds = job.finishedAt ? (job.finishedAt - job.createdAt) / 1000 : null;
      return {
        outcome: job.status,
        file: job.file?.name ?? null,
        bytes: job.file?.size ?? job.downloaded ?? 0,
        durationSeconds: seconds === null ? null : Math.round(seconds * 100) / 100,
        error: job.error ?? null,
      };
    },
    level: () => (job.status === 'done' ? 'DEFAULT' : 'ERROR'),
  }, () => {
    // The engine is launched from inside the trace's context on purpose. Work
    // started by this function instead would run in this function's context
    // and its spans would land at the trace root rather than under the job.
    //
    // Direct (IDM-style) jobs skip yt-dlp entirely: the URL already points at
    // media bytes, so segmented Range requests are faster and avoid extractor
    // limitations such as the .php-extension safety block.
    const handle = job.direct
      ? startDirectDownload({
        url: job.url,
        referer: job.referer,
        title: job.title,
        preferRes: job.preferRes,
      }, makeHandlers(job))
      : startDownload({
        ...job,
        // Anything that transcodes or remuxes must not share a name with a file
        // an earlier passthrough produced, because yt-dlp deletes its own input.
        uniqueOutput: job.kind === 'audio'
          ? job.audioFormat !== 'best'
          : Boolean(job.remuxMp4),
      }, makeHandlers(job));

    job._kill = handle.kill;
    return handle;
  });

  job._kill = job._trace?.handle?.kill ?? null;
}

function makeHandlers(job) {
  return {
    onEvent(evt) {
      if (job.status === 'cancelled') return;
      switch (evt.type) {
        case 'progress':
          job.status = 'running';
          job.phase = evt.phase;
          job.downloaded = evt.downloaded;
          job.total = evt.total;
          job.percent = evt.percent;
          job.speed = evt.speed;
          job.eta = evt.eta;
          break;
        case 'phase':
          job.phase = evt.phase;
          if (evt.phase === 'done') job.percent = 100;
          break;
        case 'destination':
          if (!job._destinationSeen) {
            job._destinationSeen = true;
          }
          break;
        default:
          break;
      }
      announce(job);
    },
    onError(message) {
      if (job.status === 'cancelled') return;
      job.error = message;
    },
    onPostprocessError(message) {
      if (job.status === 'cancelled') return;
      job._postprocessNote = message || 'Post-processing failed.';
      // A failed remux or extract leaves an empty file where the output would
      // have been. Record it now so it can be removed once the real path is known.
      job._emptyLeftovers = job._emptyLeftovers || [];
    },
    onClose(code, finalPath) {
      running.delete(job.id);
      job._kill = null;

      // The trace has to be released on every exit from here, including the
      // cancelled one, or the span is left open and never exported.
      const finish = () => {
        job._trace?.release();
        // Nothing awaits the span's own promise, and a rejection here would be
        // an unhandled one.
        void job._trace?.closed?.catch(() => {});
        job._trace = null;
      };

      if (job.status === 'cancelled') {
        finish();
        void persist();
        pump();
        return;
      }

      // The path yt-dlp reported is the only trustworthy source. A time-window
      // scan of the download folder is NOT safe here: with concurrency above 1
      // it happily returns a sibling job's file and reports a failed download
      // as successful. The scan is only a last resort for a clean exit.
      const reported = describeOutput(finalPath);
      const output = reported || (code === 0 ? findOutputFor(job) : null);

      // Sweep up any empty file the failed post-processor left behind.
      if (job._postprocessNote) {
        for (const p of [finalPath, ...(job._emptyLeftovers || [])]) {
          if (p) removeIfEmpty(p);
        }
      }

      if (code === 0 || output) {
        if (!output) {
          job.status = 'error';
          job.phase = 'error';
          job.speed = 0;
          job.finishedAt = Date.now();
          job.error = job.error || 'The download finished but no file was written.';
          announce(job);
          finish();
          void persist();
          pump();
          return;
        }
        job.status = 'done';
        job.phase = 'done';
        job.percent = 100;
        job.speed = 0;
        job.finishedAt = Date.now();
        job.file = output;
        if (job._postprocessNote) {
          job.error = `Kept the original file. ${job._postprocessNote}`;
        }
        announce(job);
        void persist();
      } else {
        job.status = 'error';
        job.phase = 'error';
        job.speed = 0;
        job.finishedAt = Date.now();
        job.error = job.error || 'Download failed. Check the link and try again.';
        announce(job);
        void persist();
      }
      finish();
      pump();
    },
  };
}

/**
 * Turn the path yt-dlp reported into a library entry.
 * Confirms the file really landed inside the download directory before
 * exposing it, so a misbehaving extractor cannot steer writes elsewhere.
 */
function describeOutput(fullPath) {
  if (!fullPath) return null;
  try {
    const resolved = path.resolve(fullPath);
    const base = path.resolve(DOWNLOAD_DIR);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    const st = fs.statSync(resolved);
    // A zero-byte file is a failed remux or a truncated transfer, never a result.
    if (!st.isFile() || st.size === 0) return null;
    return { name: path.basename(resolved), size: st.size };
  } catch {
    return null;
  }
}

/**
 * Fallback for when yt-dlp never reported a path: match on the creation window
 * rather than trying to predict the filename.
 */
function findOutputFor(job) {
  try {
    const entries = fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true });
    const media = entries
      .filter((e) => e.isFile())
      .map((e) => {
        const full = path.join(DOWNLOAD_DIR, e.name);
        let st;
        try { st = fs.statSync(full); } catch { return null; }
        return { name: e.name, full, size: st.size, mtime: st.mtimeMs };
      })
      .filter(Boolean)
      .filter((f) => !f.name.endsWith('.part') && !f.name.endsWith('.ytdl'))
      .filter((f) => f.size > 0)
      .filter((f) => f.mtime >= job.createdAt - 5_000);

    if (!media.length) return null;
    media.sort((a, b) => b.mtime - a.mtime);
    return { name: media[0].name, size: media[0].size };
  } catch {
    return null;
  }
}

export function init() {
  ensureDirs();
  load();
}

export const stats = () => ({
  total: jobs.size,
  running: running.size,
  queued: [...jobs.values()].filter((j) => j.status === 'queued').length,
  maxConcurrent: MAX_CONCURRENT,
});

export { DATA_DIR };
