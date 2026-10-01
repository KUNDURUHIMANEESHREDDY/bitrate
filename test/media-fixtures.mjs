/**
 * Media fixtures for exercising the yt-dlp path offline.
 *
 * The direct-download engine is easy to test with plain bytes, but the yt-dlp
 * path does things byte fixtures cannot reach: it selects among formats, merges
 * a separate video and audio stream, extracts audio to MP3, and remuxes into a
 * different container. All of that runs through ffmpeg and through yt-dlp's own
 * format logic, so it needs real media and a real manifest.
 *
 * Everything here is generated locally by ffmpeg and served over loopback. No
 * third-party site is involved, which is the point: extractor behaviour on
 * somebody else's site is neither stable nor ours to assert on, whereas the
 * merge, convert and remux behaviour is entirely ours and must not rot.
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.join(os.tmpdir(), 'bitrate-ytdlp-fixtures');
let generated = false;

const run = (args) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ok: r.status === 0, error: (r.stderr || '').trim().slice(0, 300) };
};

/**
 * Two seconds of a synthetic test pattern and a sine tone, deliberately small
 * enough that a full suite of cases stays fast, and long enough that a merge is
 * doing real work rather than trivially passing.
 *
 * The media is packaged as HLS rather than DASH. ffmpeg's DASH output does not
 * satisfy yt-dlp's manifest parser (it needs a sourceURL the muxer never
 * writes, and injecting one is not enough), while an HLS master playlist with
 * separate video and audio variants is a well-trodden path and exercises
 * exactly the same yt-dlp behaviour: pick two formats, fetch both, merge them.
 */
export function ensureMedia() {
  if (generated && fs.existsSync(path.join(ROOT, 'master.m3u8'))) return { ok: true, dir: ROOT };
  fs.mkdirSync(ROOT, { recursive: true });

  const v = path.join(ROOT, 'src-video.mp4');
  const a = path.join(ROOT, 'src-audio.m4a');

  let r = run(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x176:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
  if (!r.ok) return { ok: false, error: `video: ${r.error}` };

  r = run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-b:a', '64k', a]);
  if (!r.ok) return { ok: false, error: `audio: ${r.error}` };

  // A muxed source that genuinely carries both tracks. Extracting audio from a
  // video-only file cannot succeed, and a case built on one would be asserting
  // the impossible rather than testing anything.
  r = run(['-y', '-i', v, '-i', a, '-map', '0:v', '-map', '1:a', '-c', 'copy',
    path.join(ROOT, 'src-muxed.mp4')]);
  if (!r.ok) return { ok: false, error: `muxed: ${r.error}` };

  // A source that is genuinely not MP4, so the forced remux has something to do.
  // Pointing --remux-video at an MP4 would be a no-op and would pass whether or
  // not remuxing works at all.
  r = run(['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x176:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libvpx-vp9', '-b:v', '60k', '-c:a', 'libopus', '-b:a', '48k',
    path.join(ROOT, 'src-video.webm')]);
  if (!r.ok) return { ok: false, error: `webm: ${r.error}` };

  // MPEG-TS segments rather than fMP4. A raw fMP4 media segment is not a valid
  // file on its own, so ffmpeg cannot open it and the merge reports "Invalid
  // data found when processing input". TS segments are self-contained, which is
  // what the classic HLS world shipped and what real origins still serve.
  r = run(['-y', '-i', v, '-c', 'copy', '-f', 'hls', '-hls_segment_type', 'mpegts',
    '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(ROOT, 'v-%d.ts'),
    path.join(ROOT, 'v.m3u8')]);
  if (!r.ok) return { ok: false, error: `hls video: ${r.error}` };

  r = run(['-y', '-i', a, '-c', 'copy', '-f', 'hls', '-hls_segment_type', 'mpegts',
    '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(ROOT, 'a-%d.ts'),
    path.join(ROOT, 'a.m3u8')]);
  if (!r.ok) return { ok: false, error: `hls audio: ${r.error}` };

  // The master playlist ties the two variants together, which is what makes
  // yt-dlp see a video-only and an audio-only stream and decide to merge.
  fs.writeFileSync(path.join(ROOT, 'master.m3u8'), [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="a.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=31608,CODECS="mp4a.40.2",AUDIO="aac"',
    'a.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=180608,RESOLUTION=320x176,CODECS="avc1.64000b,mp4a.40.2",AUDIO="aac"',
    'v.m3u8',
    '',
  ].join('\n'));

  generated = true;
  return { ok: true, dir: ROOT };
}

/**
 * ffmpeg writes the absolute output path into <BaseURL>, which would make
 * yt-dlp read the representations from the local disk and quietly skip HTTP
 * entirely. Rewriting them to bare filenames is what makes this a network
 * fixture rather than a filesystem one.
 *
 * Kept because the HLS playlists carry the same hazard if they are ever
 * regenerated with absolute paths.
 */
function manifestWithRelativeUrls(selfUrl) {
  const raw = fs.readFileSync(path.join(ROOT, 'stream.mpd'), 'utf8');
  return raw
    .replace(/<BaseURL>[^<]*<\/BaseURL>/g, (match) => {
      const name = match.replace(/<\/?BaseURL>/g, '').split(/[\\/]/).pop();
      return `<BaseURL>${name}</BaseURL>`;
    })
    .replace(/<MPD\b/, `<MPD sourceURL="${selfUrl}"`);
}

/**
 * Remove the now-unused DASH helpers' leftover output so a stale manifest from
 * an earlier run cannot be served.
 */
function removeStaleDash() {
  for (const f of ['stream.mpd', 'stream-stream0.mp4', 'stream-stream1.mp4']) {
    try { fs.rmSync(path.join(ROOT, f), { force: true }); } catch { /* ignore */ }
  }
}

/** A few qualities, so a format selector has something to choose between. */
function ensureLadder() {
  const made = [];
  for (const [height, label] of [[176, 'low'], [360, 'high']]) {
    const out = path.join(ROOT, `ladder-${label}.mp4`);
    if (!fs.existsSync(out)) {
      const r = run(['-y', '-f', 'lavfi', '-i', `testsrc=size=320x${height}:rate=10:duration=2`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]);
      if (!r.ok) return { ok: false, error: `ladder ${label}: ${r.error}` };
    }
    made.push({ label, height, file: path.basename(out) });
  }
  return { ok: true, made };
}

/**
 * Serve the generated media over loopback.
 *
 * Range support is included because yt-dlp asks for it, and a fixture that
 * ignored Range would exercise a code path no real origin takes.
 */
export async function startMediaFixtures({ port = 0 } = {}) {
  const built = ensureMedia();
  if (!built.ok) return { ok: false, error: built.error };
  removeStaleDash();
  const ladder = ensureLadder();
  if (!ladder.ok) return { ok: false, error: ladder.error };

  // Segment files are discovered from the directory so a regenerated playlist
  // with a different segment count does not need the fixture edited too.
  const segmentFiles = fs.readdirSync(ROOT)
    .filter((f) => /^(v|a)-\d+\.ts$/.test(f));

  const files = {
    'master.m3u8': () => fs.readFileSync(path.join(ROOT, 'master.m3u8')),
    'v.m3u8': () => fs.readFileSync(path.join(ROOT, 'v.m3u8')),
    'a.m3u8': () => fs.readFileSync(path.join(ROOT, 'a.m3u8')),
    'src-video.mp4': () => fs.readFileSync(path.join(ROOT, 'src-video.mp4')),
    'src-muxed.mp4': () => fs.readFileSync(path.join(ROOT, 'src-muxed.mp4')),
    'src-video.webm': () => fs.readFileSync(path.join(ROOT, 'src-video.webm')),
    'src-audio.m4a': () => fs.readFileSync(path.join(ROOT, 'src-audio.m4a')),
    ...Object.fromEntries(segmentFiles.map((f) => [f, () => fs.readFileSync(path.join(ROOT, f))])),
    ...Object.fromEntries(ladder.made.map((l) => [l.file, () => fs.readFileSync(path.join(ROOT, l.file))])),
  };

  const requestCounts = new Map();
  const server = http.createServer((req, res) => {
    const name = path.basename(new URL(req.url, 'http://x').pathname);
    const read = files[name];
    if (!read) { res.writeHead(404).end('not found'); return; }

    const body = read();
    requestCounts.set(name, (requestCounts.get(name) || 0) + 1);

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
        'Content-Type': 'video/iso.segment',
        'Content-Length': slice.length,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
      : name.endsWith('.mpd') ? 'application/dash+xml'
        : 'video/mp4';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
      'Accept-Ranges': 'bytes',
    });
    res.end(body);
  });

  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    ok: true,
    base,
    // Separate video and audio variants: yt-dlp must fetch both and merge.
    manifestUrl: `${base}/master.m3u8`,
    // A single muxed file, for the convert and remux cases.
    videoUrl: `${base}/src-video.mp4`,
    muxedUrl: `${base}/src-muxed.mp4`,
    webmUrl: `${base}/src-video.webm`,
    audioUrl: `${base}/src-audio.m4a`,
    requestCounts,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** ffprobe summary, used to assert on what yt-dlp actually produced. */
export function probeFile(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height',
    '-show_entries', 'format=duration,format_name',
    '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    return {
      streams: parsed.streams || [],
      format: parsed.format || {},
      types: (parsed.streams || []).map((s) => s.codec_type),
      video: (parsed.streams || []).find((s) => s.codec_type === 'video') || null,
      audio: (parsed.streams || []).find((s) => s.codec_type === 'audio') || null,
    };
  } catch {
    return null;
  }
}

/** Remove any leftover working files from a run. */
export async function cleanFixtures() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  generated = false;
}
