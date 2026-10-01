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

export const WEB_DIST = path.join(ROOT, 'web', 'dist');

export function ensureDirs() {
  for (const dir of [DOWNLOAD_DIR, DATA_DIR]) {
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
