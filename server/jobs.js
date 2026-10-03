import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startDownload } from './engine.js';
import { startDirectDownload } from './direct.js';
import { startSpan } from './trace.js';

import { hub } from './events.js';
import { removeIfEmpty } from './library.js';
import { DOWNLOAD_DIR, DATA_DIR, STATE_FILE, MAX_CONCURRENT, MAX_QUEUE_SIZE, ensureDirs } from './config.js';
import {
  ensureWorkspace, workspaceFor, findArtifact, promote, cleanup,
  writeState, readState, pruneWorkspaces,
} from './workspace.js';
import { increment } from './metrics.js';
import { hostOf } from './network-policy.js';

const TERMINAL = new Set(['done', 'error', 'cancelled']);

let jobs = new Map();
let running = new Set();
let seq = 0;

/** Serialise writes; concurrent job events must not interleave a read-modify-write. */
let persistChain = Promise.resolve();

/**
 * The fields that may reach jobs.json.
 *
 * An allowlist rather than a deny-list, on purpose. Serialising the job object
 * itself means every field added from here on is persisted by default, and a field
 * only has to be *remembered* to be forgotten into a file that outlives the process:
 * `cookieFile` is a path to a browser credential export, and for a direct download
 * `url` carries the signed token the media server is currently honouring. A deny-list
 * would have caught both today and would catch neither tomorrow.
 *
 * What is here is what the UI shows after a restart, plus what identifies the bytes.
 * `usingCookies` is the deliberate substitute for `cookieFile`: the UI needs to know
 * that cookies were involved, and has no use for where they came from.
 */
const PERSISTED = [
  'id', 'title', 'kind', 'quality', 'audioFormat', 'remuxMp4', 'subtitle',
  'usingCookies', 'direct', 'status', 'phase', 'percent', 'downloaded', 'total',
  'speed', 'eta', 'error', 'file', 'workspace', 'recoverable', 'createdAt', 'finishedAt',
];

function persistedJob(j) {
  const out = {};
  for (const key of PERSISTED) {
    if (j[key] !== undefined) out[key] = j[key];
  }
  return out;
}

function persist() {
  persistChain = persistChain.then(() => {
    try {
      const snapshot = JSON.stringify(
        { seq, jobs: [...jobs.values()].slice(-200).map(persistedJob) },
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
        jobs.set(j.id, {
          ...j,
          status: 'error',
          error: 'Interrupted when the server stopped. Start it again to resume from the partial file.',
          recoverable: true,
        });
      } else {
        // A job read back from disk has no url and no cookieFile, because neither
        // was ever written. It is shown, not run: nothing here re-runs a job, so
        // the fields a restart would need are the ones the UI already has.
        jobs.set(j.id, j);
      }
    }
  } catch { /* first run, or corrupt state: start clean */ }
}

/**
 * The job as the UI sees it.
 *
 * `url` is here and `cookieFile` is not, and the difference is deliberate. A job
 * list is rendered by anyone who can reach the API, and for a direct download the
 * URL is a signed media link whose query string is a live credential for as long as
 * the token is valid -- while the UI needs nothing from it, because the job already
 * carries a title and a finished file name. `publicJob` therefore reports the host
 * instead of the URL, which is enough to tell a user which site a job came from and
 * useless to anyone who tries to replay it.
 *
 * `cookieFile` never appears here at all. Only the boolean `usingCookies` does.
 */
export function publicJob(j) {
  return {
    id: j.id,
    // Host rather than the full URL. The query string on a direct link carries a
    // token that authorises a download while it is valid.
    url: hostOf(j.url) || null,
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
    // Whether cookies were involved, never where they came from. The UI shows this
    // so a user can tell why a download needed a browser session; it has no use for
    // the path, and the path is a browser credential export.
    usingCookies: Boolean(j.usingCookies),
    recoverable: Boolean(j.recoverable),
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

/** How many jobs are occupying the queue, running or not. */
const queueDepth = () => [...jobs.values()].filter((j) => !TERMINAL.has(j.status)).length;

export function createJob({ url, kind = 'video', quality = 'best', audioFormat = 'best', remuxMp4 = false, subtitle = false, cookieFile = null, title = null, direct = false, referer = null, preferRes = null }) {
  ensureDirs();

  // A queue with no ceiling is a memory and disk problem waiting for a caller
  // that loops. Ten thousand queued jobs would otherwise sit there looking like
  // work in progress and all of them would eventually be attempted.
  if (queueDepth() >= MAX_QUEUE_SIZE) {
    const err = new Error(
      `The queue is full (${MAX_QUEUE_SIZE} jobs). Wait for something to finish, or clear finished jobs.`,
    );
    err.statusCode = 429;
    throw err;
  }

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
    // Never leaves the server: not in publicJob, not in a trace, not in an event.
    // What the UI shows is whether cookies were used, not where they came from.
    cookieFile,
    usingCookies: Boolean(cookieFile),
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
    workspace: workspaceFor(id),
    recoverable: false,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  void ensureWorkspace(id).then(() => writeState(id, {
    source: direct ? 'direct' : 'ytdlp',
    // The workspace is the identity of this job's bytes, so it is what a restart
    // reads to find them again. The URL is deliberately not recorded: for a
    // direct download it usually carries a token that has expired anyway.
    workspace: job.workspace,
    quality,
    audioFormat,
    kind,
    title: job.title,
    startedAt: Date.now(),
  }));
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
  // A job that was still queued never opened a file, so its workspace holds
  // nothing worth resuming from and is pure litter. One that was mid-transfer is a
  // different matter: the bytes are kept, but whether there are *any* worth keeping
  // is not known until the engine reports back, so `recoverable` is set optimistically
  // here and corrected in the `onClose` handler. A cancel in the first moments of a
  // transfer has nothing on disk, and claiming otherwise is what made this flag
  // mean nothing.
  const neverStarted = job.status === 'queued';
  job._kill?.();
  job.status = 'cancelled';
  job.phase = 'cancelled';
  job.speed = 0;
  job.finishedAt = Date.now();
  job.recoverable = !neverStarted;
  increment('download_cancelled', { stage: neverStarted ? 'queued' : 'running' });
  if (neverStarted) void cleanup(id);
  announce(job);
  void persist();
  return true;
}

export function clearFinished() {
  for (const [id, j] of jobs) {
    if (!TERMINAL.has(j.status)) continue;
    jobs.delete(id);
    // A finished job's workspace is scratch that has already been promoted, or
    // that will never be. Either way it should not outlive the job record.
    void cleanup(id);
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
  increment('download_started', { source: job.direct ? 'direct' : 'ytdlp' });
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
    //
    // Both engines are pointed at this job's own workspace rather than the
    // download directory. That is what makes the finished artifact identifiable
    // afterwards without guessing from timestamps in a shared directory.
    const handle = job.direct
      ? startDirectDownload({
        url: job.url,
        referer: job.referer,
        title: job.title,
        preferRes: job.preferRes,
        destDir: job.workspace || DOWNLOAD_DIR,
      }, makeHandlers(job))
      : startDownload({
        ...job,
        destDir: job.workspace || DOWNLOAD_DIR,
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
    onClose(code, finalPath, info) {
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
        // The engine reports whether it actually left bytes behind.
        //
        // `cancelJob` has already set `recoverable` on the assumption that a
        // running job has a partial worth keeping. That assumption was unchecked:
        // the direct engine used to delete the partial before noticing the abort,
        // so a cancelled job claimed to be resumable with nothing on disk. Trusting
        // the engine's own count instead means the flag says what it means.
        if (job.direct && info && typeof info.bytesKept === 'boolean') {
          job.recoverable = info.bytesKept;
          // Nothing to resume from, so the workspace is litter rather than an
          // opportunity -- the same treatment a queued job gets.
          if (!info.bytesKept) {
            job.error = 'Cancelled before any data arrived.';
            void cleanup(job.id);
          }
        }
        finish();
        void persist();
        pump();
        return;
      }

      void resolveOutcome(job, code, finalPath).then(() => {
        finish();
        void persist();
        pump();
      });
    },
  };
}

/**
 * Is there a partial file in this job's workspace worth resuming from?
 *
 * Size on disk is not the question, because a ranged direct download preallocates
 * the whole file: a `.part` is the full length from the first moment and says
 * nothing about how much of it is real. What can be trusted is whether anything
 * exists at all, since the engine deletes an empty one.
 */
function hasPartialBytes(job) {
  const dir = job.workspace;
  if (!dir) return false;
  try {
    return fs.readdirSync(dir).some((name) => {
      if (!/\.part$/i.test(name) && !/\.ytdl\b/i.test(name)) return false;
      try { return fs.statSync(path.join(dir, name)).size > 0; } catch { return false; }
    });
  } catch {
    return false;
  }
}

/**
 * Decide what a finished job actually produced, and move it into the library.
 *
 * Two sources, in order of trust:
 *
 *   the path the engine reported    confirmed to be inside this job's own
 *                                   workspace, and confirmed to be a real
 *                                   non-empty file
 *   a scan of this job's workspace  the fallback for a clean exit where nothing
 *                                   was reported
 *
 * Neither is a directory-wide search by timestamp. That used to be the third
 * option, and it was the source of a class of bug where two concurrent jobs
 * finishing in the same second meant one of them claimed the other's file.
 */
async function resolveOutcome(job, code, finalPath) {
  // Sweep up any empty file a failed post-processor left behind before looking
  // for a real one, so a zero-byte leftover cannot be mistaken for the artifact.
  if (job._postprocessNote) {
    for (const p of [finalPath, ...(job._emptyLeftovers || [])]) {
      if (p) removeIfEmpty(p);
    }
  }

  const artifact = describeOutput(finalPath, job.workspace)
    || (code === 0 ? await findArtifact(job.workspace) : null);

  if (!artifact) {
    job.status = 'error';
    job.phase = 'error';
    job.speed = 0;
    job.finishedAt = Date.now();
    job.error = job.error || (code === 0
      ? 'The download finished but no file was written.'
      : 'Download failed. Check the link and try again.');
    // The workspace is kept, so a re-run has somewhere to work. Whether that is
    // worth calling recoverable depends on whether anything is in it, and only the
    // engine knows that: a direct job deletes its partial on a genuine failure, so
    // an empty workspace is litter rather than an opportunity. yt-dlp keeps its own
    // `.part` and resumes from it, so for that path the workspace is always the
    // answer.
    job.recoverable = job.direct ? hasPartialBytes(job) : true;
    increment('download_failed', { source: job.direct ? 'direct' : 'ytdlp' });
    announce(job);
    return;
  }

  try {
    const entry = await promote(artifact);
    job.status = 'done';
    job.phase = 'done';
    job.percent = 100;
    job.speed = 0;
    job.finishedAt = Date.now();
    job.file = { name: entry.name, size: entry.size };
    job.recoverable = false;
    if (job._postprocessNote) {
      job.error = `Kept the original file. ${job._postprocessNote}`;
    }
    increment('download_completed', { source: job.direct ? 'direct' : 'ytdlp' });
    increment('bytes_transferred', { source: job.direct ? 'direct' : 'ytdlp' }, entry.size);
    announce(job);
    await writeState(job.id, { ...(await readState(job.id) || {}), completedAt: Date.now() });
    // The bytes are in the library; the scratch copy has served its purpose.
    void cleanup(job.id);
  } catch (err) {
    job.status = 'error';
    job.phase = 'error';
    job.speed = 0;
    job.finishedAt = Date.now();
    job.error = `The file downloaded but could not be moved into the library: ${err.message}`;
    job.recoverable = true;
    increment('download_failed', { source: 'promote' });
    announce(job);
  }
}

/**
 * Turn a path the engine reported into a real artifact.
 *
 * Two things are confirmed rather than trusted. First, that the path is inside
 * this job's own workspace: the engine is an external program writing names of
 * its own choosing, so "it said where the file is" is not the same as "the file
 * is where it said". Second, that it is a non-empty regular file, because a
 * failed remux leaves a zero-byte file at exactly the path it was going to write.
 */
function describeOutput(fullPath, workspace) {
  if (!fullPath) return null;
  try {
    const resolved = path.resolve(fullPath);
    const base = path.resolve(workspace || DOWNLOAD_DIR);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
    const st = fs.statSync(resolved);
    // A zero-byte file is a failed remux or a truncated transfer, never a result.
    if (!st.isFile() || st.size === 0) return null;
    return { name: path.basename(resolved), full: resolved, size: st.size };
  } catch {
    return null;
  }
}

export function init() {
  ensureDirs();
  load();
  // Workspaces belong to jobs. A crashed process leaves one behind for a job that
  // is still recorded, which is a resume opportunity; anything whose job is gone
  // is scratch nobody will ever come back for.
  void pruneWorkspaces([...jobs.keys()]);
}

export const stats = () => ({
  total: jobs.size,
  running: running.size,
  queued: [...jobs.values()].filter((j) => j.status === 'queued').length,
  maxConcurrent: MAX_CONCURRENT,
  maxQueueSize: MAX_QUEUE_SIZE,
});

export { DATA_DIR };
