import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import {
  YTDLP, PYTHON, FFMPEG, ARIA2C, DOWNLOAD_DIR, has, resolveBin,
  CONCURRENT_FRAGMENTS, RETRIES, FRAGMENT_RETRIES,
} from './config.js';

const PROGRESS_SEP = '@@';

const uniqueToken = () => crypto.randomBytes(3).toString('hex');

/** Absolute ffmpeg path. yt-dlp cannot locate ffmpeg from a bare command name. */
const FFMPEG_PATH = resolveBin(FFMPEG);

export const runtime = {
  ytdlp: has(YTDLP),
  ytdlpVersion: null,
  ffmpeg: has(FFMPEG),
  ffmpegPath: FFMPEG_PATH,
  aria2c: has(ARIA2C),
  get python() { return has(PYTHON); },
};

export function ytdlpVersion() {
  if (runtime.ytdlpVersion) return runtime.ytdlpVersion;
  const r = spawnSync(YTDLP, ['--version'], { encoding: 'utf8', windowsHide: true });
  runtime.ytdlpVersion = r.status === 0 ? r.stdout.trim().split('\n')[0] : null;
  return runtime.ytdlpVersion;
}

const baseArgs = () => [
  '--no-colors',
  '--no-warnings',
  '--ignore-config',
  // Only pass the flag when ffmpeg actually resolved, otherwise yt-dlp errors
  // out on a path it cannot verify.
  ...(FFMPEG_PATH ? ['--ffmpeg-location', FFMPEG_PATH] : []),
  '--retries', String(RETRIES),
  '--fragment-retries', String(FRAGMENT_RETRIES),
  '--socket-timeout', '30',
  // Resumable: a dropped connection picks up the .part file instead of starting over.
  '--continue',
];

/** Only wire up an external downloader when it is actually installed. */
function downloaderArgs() {
  if (!runtime.aria2c) return [];
  return ['--external-downloader', 'aria2c', '--external-downloader-args', 'aria2c:-x16 -s16 -k1M --file-allocation=none --summary-interval=0 --console-log-level=warn'];
}

/**
 * Quality presets.
 *
 * The important property is that every one of these resolves to a stream that
 * already exists on the origin server. yt-dlp merges with a stream copy, so the
 * merge is a container rewrite over bytes we already downloaded, not a re-encode.
 * Transcoding only ever happens for the explicit mp3 preset.
 */
export function buildFormatSelector({ kind = 'video', quality = 'best' } = {}) {
  if (kind === 'audio') {
    return 'ba/b';
  }
  const cap = (h) => `bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
  switch (quality) {
    case 'best': return 'bv*+ba/b';
    case '2160': return cap(2160);
    case '1440': return cap(1440);
    case '1080': return cap(1080);
    case '720': return cap(720);
    case '480': return cap(480);
    case '360': return cap(360);
    default: return 'bv*+ba/b';
  }
}

function cookiesArgs(cookieFile) {
  return cookieFile ? ['--cookies', cookieFile] : [];
}

/** Fetch metadata without downloading media. */
export function probe(url, { playlist = true, cookieFile = null } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      ...baseArgs(),
      '--dump-single-json',
      '--no-playlist',
      '--skip-download',
      '--socket-timeout', '20',
      ...(playlist ? ['--yes-playlist'] : []),
      ...cookiesArgs(cookieFile),
      url,
    ];
    const proc = spawn(YTDLP, args, { windowsHide: true });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 || !out.trim()) {
        return reject(new Error(cleanError(err) || `yt-dlp exited with code ${code}`));
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`Could not parse yt-dlp output: ${e.message}`));
      }
    });
  });
}

/**
 * Normalise a yt-dlp info dict into the shape the UI consumes.
 * Thumbnail is kept as a remote URL: the browser fetches it directly, so the
 * server never proxies or stores image bytes.
 */
export function normaliseInfo(info) {
  const isPlaylist = Boolean(info._type === 'playlist' || Array.isArray(info.entries));
  const entries = (info.entries || []).filter(Boolean).map((e) => normaliseEntry(e));
  return {
    isPlaylist,
    id: info.id,
    title: info.title,
    uploader: info.uploader || info.channel || info.uploader_id || null,
    thumbnail: info.thumbnail || null,
    duration: info.duration ?? null,
    extractor: info.extractor_key || info.extractor || null,
    webpageUrl: info.webpage_url || null,
    entries,
    formats: (info.formats || []).map(normaliseFormat).filter(Boolean),
  };
}

function normaliseEntry(e) {
  return {
    id: e.id,
    title: e.title,
    uploader: e.uploader || e.channel || null,
    thumbnail: e.thumbnail || null,
    duration: e.duration ?? null,
    url: e.webpage_url || e.original_url || e.url || null,
  };
}

function normaliseFormat(f) {
  if (!f.format_id) return null;
  const height = f.height || parseInt(String(f.resolution || ''), 10) || null;
  return {
    id: f.format_id,
    ext: f.ext,
    height,
    fps: f.fps || null,
    vcodec: f.vcodec && f.vcodec !== 'none' ? f.vcodec : null,
    acodec: f.acodec && f.acodec !== 'none' ? f.acodec : null,
    filesize: f.filesize ?? f.filesize_approx ?? null,
    tbr: f.tbr ?? null,
    note: f.format_note || null,
    hasVideo: Boolean(f.vheight || f.height || (f.vcodec && f.vcodec !== 'none')),
    hasAudio: Boolean(f.acodec && f.acodec !== 'none'),
  };
}

/**
 * Turn yt-dlp's stderr into something a person can act on.
 *
 * yt-dlp prefixes real errors with a component tag ("ERROR: [generic] ..."), so
 * dropping every bracketed line throws away the only useful message. Keep those
 * lines and strip the tag instead, and discard only genuine progress noise.
 */
function cleanError(text) {
  if (!text) return '';
  const kept = String(text)
    .split('\n')
    .map((l) => l.replace(/\r/g, '').trim())
    .filter(Boolean)
    .filter((l) => !/^\[\d/.test(l))
    .filter((l) => !/^\d+(\.\d+)?\s*%/.test(l))
    .filter((l) => !/\bof\s+~?[\d.]+\s*[KMG]?iB\s+at\b/i.test(l))
    .filter((l) => !/^\[(?:download|info|Merger|ExtractAudio|VideoRemuxer|EmbedSubtitle|Metadata)\]/i.test(l))
    .map((l) => l
      .replace(/^ERROR:\s*/i, '')
      .replace(/^WARNING:\s*/i, '')
      .replace(/^\[[^\]]+\]\s*/, '')
      .trim())
    .filter((l) => l.length > 3);

  if (!kept.length) return '';
  // Drop yt-dlp's "please file a bug" boilerplate, which is never the answer.
  const message = kept.join(' ').split(/;\s*please report/i)[0].trim();
  return message.length > 400 ? `${message.slice(0, 400)}...` : message;
}

/**
 * Run one download as a child process, emitting structured events.
 *
 * Progress is read from an explicit template rather than scraping yt-dlp's
 * human output, so the numbers the UI shows are the numbers the downloader
 * actually reports. `--newline` keeps each update on a single line.
 */
export function startDownload({ url, kind, quality, audioFormat, remuxMp4, subtitle, cookieFile, uniqueOutput = false }, handlers = {}) {
  const emit = handlers.onEvent || (() => {});
  const args = [
    ...baseArgs(),
    ...downloaderArgs(),
    '--newline',
    '--continue',
    '--concurrent-fragments', String(CONCURRENT_FRAGMENTS),
    '--progress',
    '--progress-template',
    `download:PROG${PROGRESS_SEP}%(progress.status)s${PROGRESS_SEP}%(progress.downloaded_bytes)s${PROGRESS_SEP}%(progress.total_bytes)s${PROGRESS_SEP}%(progress.total_bytes_estimate)s${PROGRESS_SEP}%(progress.speed)s${PROGRESS_SEP}%(progress.eta)s`,
    '-f', buildFormatSelector({ kind, quality }),
    '--merge-output-format', 'mp4',
  ];

  if (kind === 'audio') {
    // `ba` already gives us the origin audio stream untouched. Transcoding only
    // happens when mp3 is explicitly requested.
    if (audioFormat === 'mp3') {
      args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
    } else if (audioFormat === 'm4a') {
      args.push('-x', '--audio-format', 'm4a', '--audio-quality', '0');
    } else {
      args.push('--skip-unavailable-fragments');
    }
  } else if (remuxMp4) {
    args.push('--remux-video', 'mp4');
  }

  if (subtitle) args.push('--write-subs', '--write-auto-subs', '--sub-langs', 'en.*', '--convert-subs', 'srt');
  if (cookieFile) args.push('--cookies', cookieFile);

  // Without an explicit output template yt-dlp writes into the server's own
  // working directory. The autonumber placeholder keeps two passthrough
  // downloads of the same title from colliding.
  //
  // Converting (-x / --remux-video) is different: yt-dlp downloads an
  // intermediate, converts it, then DELETES the intermediate. If that
  // intermediate name matches a file an earlier job already produced, the
  // conversion silently removes the user's previous download. Conversions
  // therefore get a job-scoped name that cannot collide with anything.
  const outDir = DOWNLOAD_DIR.replace(/\\/g, '/');
  const discriminator = uniqueOutput ? ` [${uniqueToken()}]` : '';
  args.push('-o', `${outDir}/%(title).150B [%(id)s]${discriminator} [%(autonumber)02d].%(ext)s`);

  args.push(url);

  const proc = spawn(YTDLP, args, { windowsHide: true });
  const state = { phase: 'downloading', mergePct: 0, finalPath: null, streamPath: null };

  /**
   * yt-dlp writes intermediates named like `title.f137.mp4` and only produces
   * the finished file after merging or extraction. Track every path it reports
   * so the caller gets the real final name instead of a guess.
   */
  const notePath = (p) => {
    if (!p) return;
    const clean = p.trim().replace(/^"|"$/g, '');
    if (!clean) return;
    // Ignore per-stream intermediates, they get deleted after the merge.
    if (/\.f\d+\.[a-z0-9]+$/i.test(clean) || /\.part$/i.test(clean)) {
      state.streamPath = clean;
      return;
    }
    state.finalPath = clean;
  };

  proc.stdout.on('data', (chunk) => handleLines(chunk.toString()));
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (/^\[Merger\]|^\[ExtractAudio\]|^\[EmbedSubtitle\]|^\[Metadata\]/.test(line)) {
        state.phase = 'processing';
        emit({ type: 'phase', phase: 'processing' });
      }
      const merger = /Merging formats into "(.+)"$/.exec(line.trim());
      if (merger) notePath(merger[1]);
      const dest = /^\[(?:download|ExtractAudio|EmbedSubtitle|Merger)\] Destination: (.+)$/.exec(line.trim());
      if (dest) notePath(dest[1]);
      if (/has been downloaded$/.test(line.trim())) {
        const done = /^\[(?:download|ExtractAudio|Merger)\] (.+?) has been downloaded/.exec(line.trim());
        if (done) notePath(done[1]);
      }
      if (/ERROR|Download Failed|unable to download|fragment.*not found/i.test(line)) {
        if (/Postprocessing|Conversion failed|remux/i.test(line)) {
          // The media itself arrived; only the optional post-processing failed.
          // Treating this as a hard failure would lose a file that is already
          // safely on disk, so flag it and let the caller decide.
          handlers.onPostprocessError?.(cleanError(text));
        } else {
          handlers.onError?.(cleanError(text));
        }
      }
    }
  });

  let buffer = '';
  function handleLines(text) {
    buffer += text;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('PROG' + PROGRESS_SEP)) {
        const [status, dl, total, est, speed, eta] = line.slice(PROGRESS_SEP.length + 4).split(PROGRESS_SEP);
        const downloaded = Number(dl) || 0;
        const totalBytes = Number(total) || Number(est) || 0;
        emit({
          type: 'progress',
          phase: state.phase,
          status: status || 'downloading',
          downloaded,
          total: totalBytes,
          percent: totalBytes > 0 ? Math.min(100, (downloaded / totalBytes) * 100) : null,
          speed: Number(speed) || null,
          eta: Number(eta) || null,
        });
        continue;
      }

      const dest = /^\[download\] Destination: (.+)$/.exec(line);
      if (dest) {
        notePath(dest[1]);
        emit({ type: 'destination', path: state.finalPath || state.streamPath });
      }
      if (/^\[download\]/.test(line) && /has already been downloaded/.test(line)) {
        emit({ type: 'phase', phase: 'processing' });
      }
      if (/^\[info\]/.test(line)) {
        const m = line.match(/^\[info\] (\d+(?:\.\d+)?)iB of (\d+(?:\.\d+)?)iB/);
        if (m) {
          const totalBytes = Math.round(Number(m[2]) * 1024 * 1024);
          const downloaded = Math.round(Number(m[1]) * 1024 * 1024);
          emit({
            type: 'progress', phase: state.phase, status: 'downloading',
            downloaded, total: totalBytes,
            percent: (downloaded / totalBytes) * 100, speed: null, eta: null,
          });
        }
      }
    }
  }

  proc.on('error', (e) => handlers.onError?.(e.message));
  proc.on('close', (code) => {
    // Hand back the resolved output path so the caller never has to infer it.
    handlers.onClose?.(code ?? 1, state.finalPath || state.streamPath);
  });

  return { proc, kill: () => { try { proc.kill('SIGTERM'); } catch {} } };
}

export const errors = { cleanError };
