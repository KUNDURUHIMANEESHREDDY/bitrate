import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

const int = (v, fallback) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Download destination. Defaults to ./downloads inside the project so a fresh
 * clone is self-contained, but any absolute path can be supplied.
 */
export const DOWNLOAD_DIR = path.resolve(
  process.env.BITRATE_DOWNLOAD_DIR || path.join(ROOT, 'downloads'),
);

export const DATA_DIR = path.resolve(process.env.BITRATE_DATA_DIR || path.join(ROOT, 'data'));
export const STATE_FILE = path.join(DATA_DIR, 'jobs.json');

/** The venv bootstrapped by `npm run setup`. */
export const PYTHON = process.env.BITRATE_PYTHON ||
  path.join(ROOT, '.venv', 'Scripts', 'python.exe');
export const YTDLP = process.env.BITRATE_YTDLP ||
  path.join(ROOT, '.venv', 'Scripts', 'yt-dlp.exe');

/**
 * aria2c is optional. When present yt-dlp hands the HTTP transfer to it, which
 * opens multiple range-request connections per stream. Most CDNs throttle a
 * single connection well below link capacity, so this is usually the single
 * biggest throughput win available. Absence is not an error.
 */
export const ARIA2C = process.env.BITRATE_ARIA2C || 'aria2c';

export const FFMPEG = process.env.BITRATE_FFMPEG || 'ffmpeg';
export const FFPROBE = process.env.BITRATE_FFPROBE || 'ffprobe';

/**
 * Segments downloaded in parallel per stream. This is the second biggest
 * throughput win, and it always applies (aria2c is optional).
 * Guarded because very high values get rate-limited by CDNs.
 */
export const CONCURRENT_FRAGMENTS = int(process.env.BITRATE_FRAGMENTS, 16);

/** How many downloads may run at once. Queued jobs wait their turn. */
export const MAX_CONCURRENT = int(process.env.BITRATE_CONCURRENCY, 3);

/** Dropped connections hurt more on short files than they help. */
export const RETRIES = int(process.env.BITRATE_RETRIES, 10);
export const FRAGMENT_RETRIES = int(process.env.BITRATE_FRAGMENT_RETRIES, 10);

export const HOST = process.env.BITRATE_HOST || '127.0.0.1';
export const PORT = int(process.env.BITRATE_PORT, 4820);

/**
 * Bearer token for the API.
 *
 * Absent by default, and that is safe only because the default bind is loopback:
 * a process on the same machine can already read the download directory, so an
 * unauthenticated loopback API gives an attacker nothing they did not have. That
 * stops being true the moment HOST is a real interface, so binding anywhere other
 * than loopback without a token is a startup error rather than a warning. See
 * `assertBindingIsSafe` in auth.js.
 */
export const AUTH_TOKEN = (process.env.BITRATE_AUTH_TOKEN || '').trim() || null;

/**
 * Which address space outbound requests may reach.
 *
 *   lan     loopback and RFC1918 are allowed. This is the default because a
 *           downloader legitimately targets them: a NAS, a router's own HTTP
 *           endpoint, a local media server, a dev server on the same box.
 *           Link-local, CGNAT, multicast, reserved and unspecified addresses are
 *           refused, because no download lives there and they are exactly what an
 *           SSRF pivot reaches for.
 *   strict  as above, and additionally no loopback or private address at all.
 *           For a machine that only ever downloads from the public internet.
 *   open    no address filtering. Deliberate escape hatch; say so out loud.
 *
 * The value is surfaced by /api/health so a deployment cannot forget which one it
 * is running.
 */
export const NETWORK_POLICY = ['lan', 'strict', 'open']
  .includes(process.env.BITRATE_NETWORK_POLICY)
  ? process.env.BITRATE_NETWORK_POLICY
  : 'lan';

/**
 * Resource budgets.
 *
 * These are not the same thing as request validation. A 256 KB body limit says
 * nothing about the size of the response the server then fetches on the caller's
 * behalf, and a concurrency limit on downloads says nothing about how many
 * yt-dlp extractions or scrapes can be in flight. Each of these caps one way a
 * caller can turn a single request into a large amount of work.
 */
export const MAX_SCRAPE_BYTES = int(process.env.BITRATE_MAX_SCRAPE_BYTES, 8 * 1024 * 1024);
export const MAX_SCRAPE_REDIRECTS = int(process.env.BITRATE_MAX_SCRAPE_REDIRECTS, 5);
export const SCRAPE_TIMEOUT_MS = int(process.env.BITRATE_SCRAPE_TIMEOUT_MS, 25_000);

/** Wall clock for one yt-dlp metadata extraction. It is a child process, so this needs killing. */
export const PROBE_TIMEOUT_MS = int(process.env.BITRATE_PROBE_TIMEOUT_MS, 90_000);

/** In-flight caps for the endpoints that cost real work. */
export const MAX_CONCURRENT_PROBES = int(process.env.BITRATE_MAX_PROBES, 2);
export const MAX_CONCURRENT_SCRAPES = int(process.env.BITRATE_MAX_SCRAPES, 4);

/** How many jobs may exist at once, running plus queued. */
export const MAX_QUEUE_SIZE = int(process.env.BITRATE_MAX_QUEUE_SIZE, 200);

/** Window in which the request budget is counted. */
export const RATE_WINDOW_MS = int(process.env.BITRATE_RATE_WINDOW_MS, 60_000);

/** Per-client request budgets per window. Reads are cheap; extraction is not. */
export const RATE_LIMIT_DEFAULT = int(process.env.BITRATE_RATE_DEFAULT, 600);
export const RATE_LIMIT_PROBE = int(process.env.BITRATE_RATE_PROBE, 20);
export const RATE_LIMIT_SCRAPE = int(process.env.BITRATE_RATE_SCRAPE, 20);
export const RATE_LIMIT_CREATE = int(process.env.BITRATE_RATE_CREATE, 60);

/** An SSE stream is a socket held open for the life of the tab. */
export const MAX_SSE_CLIENTS = int(process.env.BITRATE_MAX_SSE_CLIENTS, 8);

/**
 * Largest file a direct download will accept.
 *
 * A downloader is meant to fetch large things, so this is deliberately generous;
 * its job is to stop a hostile or broken origin streaming indefinitely into a
 * preallocated sparse file rather than to second-guess a large legitimate one.
 */
export const MAX_DOWNLOAD_BYTES = int(
  process.env.BITRATE_MAX_DOWNLOAD_BYTES,
  64 * 1024 * 1024 * 1024,
);

/** Largest cookie file worth handing to yt-dlp. */
export const MAX_COOKIE_BYTES = int(process.env.BITRATE_MAX_COOKIE_BYTES, 4 * 1024 * 1024);

/**
 * How long a transfer connection may make no progress before it is abandoned.
 *
 * A whole-request deadline cannot do this job: a 4 GB file legitimately outlives
 * any budget, and a stalled socket is otherwise indistinguishable from a slow one
 * until the job has been "downloading" at 0 bytes/s for an hour. Measured per
 * chunk, so a transfer that is still moving is never touched.
 */
export const TRANSFER_STALL_MS = int(process.env.BITRATE_STALL_MS, 60_000);

export const WEB_DIST = path.join(ROOT, 'web', 'dist');

/**
 * Per-job scratch space.
 *
 * Downloads land here first and are promoted into the library only once they are
 * verified. That removes the need to guess which file a finished job produced by
 * comparing timestamps in a directory several jobs share, and leaves a durable
 * artifact behind for a job that was interrupted.
 */
export const JOBS_DIR = path.join(DATA_DIR, 'jobs');

export function ensureDirs() {
  for (const dir of [DOWNLOAD_DIR, DATA_DIR, JOBS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const isWindows = process.platform === 'win32';
export const homedir = os.homedir();

const EXE_SUFFIXES = process.platform === 'win32'
  ? ['.exe', '.cmd', '.bat', '']
  : [''];

/**
 * Resolve a command name to an absolute path.
 *
 * yt-dlp's --ffmpeg-location wants a real path, not a bare name, so passing
 * "ffmpeg" makes it report the tool as missing even when it is on PATH.
 */
export function resolveBin(bin) {
  if (!bin) return null;
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) {
    return fs.existsSync(bin) ? bin : null;
  }
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of EXE_SUFFIXES) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable path entry */ }
    }
  }
  return null;
}

export const has = (bin) => resolveBin(bin) !== null;
