/**
 * End-to-end coverage of the yt-dlp path.
 *
 * The direct-download engine is well covered by eval.mjs. This covers the other
 * path, the one most downloads actually take, which does things plain byte
 * fixtures cannot reach: choose among formats, fetch a video stream and an
 * audio stream separately, merge them with ffmpeg, extract audio to MP3, and
 * remux into a different container.
 *
 * The media is generated locally by ffmpeg and served over loopback as an HLS
 * master playlist with separate video and audio variants. Nothing here depends
 * on a third-party site, so these assertions are about our behaviour rather than
 * somebody else's uptime or rate limits.
 */
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-ytdlp-eval-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const { startServer } = await import('../server/app.js');
const { startMediaFixtures, probeFile, cleanFixtures } = await import('./media-fixtures.mjs');
const { buildFormatSelector } = await import('../server/engine.js');

const media = await startMediaFixtures();
if (!media.ok) {
  console.error(`could not build media fixtures: ${media.error}`);
  process.exit(2);
}

const server = await startServer({ port: 0, loggerLevel: 'silent' });

const cases = [
  {
    name: 'merge-separate-streams',
    why: 'yt-dlp must fetch a video stream and an audio stream and merge them',
    request: () => ({ url: media.manifestUrl, kind: 'video', quality: 'best' }),
    expect: { types: ['video', 'audio'], container: 'mp4' },
  },
  {
    name: 'passthrough-without-remux',
    why: 'the default video path must not transcode, only merge',
    request: () => ({ url: media.manifestUrl, kind: 'video' }),
    expect: { types: ['video', 'audio'], container: 'mp4' },
  },
  {
    name: 'extract-mp3',
    why: 'MP3 is the one path that re-encodes, and it must actually produce an mp3',
    request: () => ({ url: media.muxedUrl, kind: 'audio', audioFormat: 'mp3' }),
    expect: { types: ['audio'], ext: 'mp3' },
  },
  {
    name: 'extract-m4a',
    why: 'm4a is extracted without re-encoding, so the codec should survive',
    request: () => ({ url: media.muxedUrl, kind: 'audio', audioFormat: 'm4a' }),
    expect: { types: ['audio'], ext: 'm4a' },
  },
  {
    name: 'audio-passthrough',
    why: 'the default audio path takes the origin stream untouched',
    request: () => ({ url: media.audioUrl, kind: 'audio', audioFormat: 'best' }),
    expect: { types: ['audio'] },
  },
  {
    name: 'remux-webm-to-mp4',
    why: 'forced remux has to change the container, not quietly do nothing',
    request: () => ({ url: media.webmUrl, kind: 'video', remuxMp4: true }),
    expect: { types: ['video', 'audio'], ext: 'mp4' },
  },
  {
    name: 'quality-cap-still-merges',
    why: 'a 360p cap must not skip the audio track and leave a silent file',
    request: () => ({ url: media.manifestUrl, kind: 'video', quality: '360' }),
    expect: { types: ['video', 'audio'] },
  },
];

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

async function download(payload) {
  const created = await fetch(`${server.url}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (created.error) throw new Error(`queue refused: ${created.error}`);

  const deadline = Date.now() + 120_000;
  let job = created;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    job = await fetch(`${server.url}/api/jobs/${created.id}`).then((r) => r.json());
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
  }
  throw new Error('timed out');
}

console.log(`yt-dlp path: ${cases.length} case(s)  server ${server.url}\n`);

for (const c of cases) {
  process.stdout.write('  ');
  let detail = '';
  let ok = false;
  try {
    const job = await download(c.request());
    if (job.status !== 'done') throw new Error(`ended as ${job.status}: ${job.error || ''}`);

    const files = await fetch(`${server.url}/api/library`).then((r) => r.json());
    const entry = files.find((f) => f.name === job.file?.name);
    if (!entry) throw new Error('no library entry for the finished job');

    const info = probeFile(path.join(outputDir, entry.name));
    if (!info) throw new Error('ffprobe could not read the output');

    const want = c.expect;
    if (want.types) {
      for (const t of want.types) {
        if (!info.types.includes(t)) {
          throw new Error(`missing a ${t} stream (found ${info.types.join(',') || 'none'})`);
        }
      }
    }
    if (want.ext && !entry.name.toLowerCase().endsWith(`.${want.ext}`)) {
      throw new Error(`extension is not .${want.ext} (got ${entry.name})`);
    }
    if (want.container && !String(info.format.format_name || '').includes(want.container)) {
      throw new Error(`container is not ${want.container} (got ${info.format.format_name})`);
    }
    if (want.types?.includes('audio') && !info.audio) throw new Error('no audio stream object');
    if (want.types?.includes('video') && info.video && want.container === 'mp4') {
      if (info.video.codec_name !== 'h264') {
        throw new Error(`video codec is ${info.video.codec_name}, expected h264 (a remux must not transcode)`);
      }
    }
    ok = true;
    detail = `${entry.name}  ${(info.format.format_name || '').split(',')[0]}  ${info.types.join('+')}`;
    console.log(detail);
  } catch (err) {
    console.log(`\n  FAIL  ${c.name}: ${err.message}`);
    detail = err.message;
  }
  results.push({ ok, what: c.name, detail });
  process.stdout.write('\n');
}

check(results.every((r) => r.ok), 'every yt-dlp case passed');

// Intermediates must not survive. yt-dlp deletes the per-stream files after a
// merge, and a leftover .fNNN.mp4 in the library would be a file the UI offers
// to play that can never play.
const leftovers = (await fsp.readdir(outputDir)).filter((f) => /\.f\d+\./i.test(f));
check(leftovers.length === 0, 'no per-stream intermediates were left behind', leftovers.join(', '));

// The selector the audio cases rely on must be the non-transcoding one, or
// "passthrough" is a lie and the MP3 case proves nothing about opt-in cost.
check(buildFormatSelector({ kind: 'audio' }) === 'ba/b', 'the audio path is genuinely passthrough by default');

// Data loss. yt-dlp downloads an intermediate for a conversion, produces the
// converted file, then deletes the intermediate. If that intermediate is named
// the same as a file an earlier download already produced, the conversion
// silently removes the user's previous file. The engine guards this with a
// per-job token, and this is the only thing that would notice if it stopped
// doing so.
{
  console.log('\na conversion must not delete an earlier download');
  // A passthrough download of the same source first...
  const first = await download({ url: media.muxedUrl, kind: 'video', quality: 'best' });
  check(first.status === 'done', 'a passthrough download of the same source succeeds', first.error || '');
  // Conversions carry a short hex token in their name precisely so they cannot
  // collide with a passthrough file, so a passthrough file is one without it.
  const passthrough = (await fsp.readdir(outputDir))
    .filter((f) => f.startsWith('src-muxed') && f.endsWith('.mp4') && !/\[[0-9a-f]{6}\]/.test(f));
  check(passthrough.length >= 1, 'and leaves a passthrough mp4 behind with no collision token',
    passthrough.join(', ') || 'none found');

  if (!passthrough.length) {
    // Guard rather than crash: a stack trace tells you nothing about which
    // download went missing, and this suite exists to explain exactly that.
    check(false, 'a passthrough file survived to be compared against the conversion');
  } else {
    const keptPath = path.join(outputDir, passthrough[0]);
    const keptSize = (await fsp.stat(keptPath)).size;

    // ...then a conversion of the same source, which is the case that deletes.
    const second = await download({ url: media.muxedUrl, kind: 'audio', audioFormat: 'mp3' });
    check(second.status === 'done', 'a conversion of the same source succeeds', second.error || '');

    const stillThere = existsSync(keptPath);
    check(stillThere, 'the earlier passthrough file still exists after the conversion',
      stillThere ? '' : 'DELETED BY THE CONVERSION');
    check(stillThere && (await fsp.stat(keptPath)).size === keptSize,
      'and is byte-for-byte the same size it was', stillThere ? String(keptSize) : 'gone');
  }
}

await server.close();
await media.close();
await cleanFixtures();
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\nthe yt-dlp path behaves');
process.exit(failed.length ? 1 : 0);
