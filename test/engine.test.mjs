/**
 * The yt-dlp engine's pure decisions.
 *
 * These are the parts that silently pick the wrong thing: the format selector
 * decides which stream you get, the error cleaner decides whether a failure is
 * actionable, and the normaliser decides what the UI shows. None of them need
 * a network or a child process, so they are checked directly and quickly.
 *
 * The end-to-end behaviour that depends on ffmpeg and on yt-dlp is covered by
 * eval-ytdlp.mjs instead.
 */
import { buildFormatSelector, normaliseInfo, errors } from '../server/engine.js';

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

console.log('format selector');
{
  check(buildFormatSelector({ kind: 'video', quality: 'best' }) === 'bv*+ba/b',
    'video best takes the best video plus the best audio');
  check(buildFormatSelector({ kind: 'audio', quality: 'best' }) === 'ba/b',
    'audio best takes the origin audio stream with no re-encode');

  // The cap is the whole point of the quality presets: it must come first, so
  // a 720p request on a 1080p-only source gets 720p when it exists. The
  // uncapped selector is kept only as a fallback, so a source that offers
  // nothing at or below the cap still downloads instead of failing.
  const cap720 = buildFormatSelector({ kind: 'video', quality: '720' });
  check(cap720.includes('height<=720'), 'a 720p cap is present', cap720);
  const [preferred, ...rest] = cap720.split('/');
  check(preferred.includes('height<=720'), 'the capped selector is tried first', preferred);
  check(rest.join('/').includes('bv*+ba/b'),
    'with an uncapped fallback so a too-low cap still downloads', cap720);

  for (const q of ['2160', '1440', '1080', '720', '480', '360']) {
    const s = buildFormatSelector({ kind: 'video', quality: q });
    check(s.includes(`height<=${q}`), `the ${q}p preset caps at ${q}`);
  }
  // An unknown or absent quality must fall back rather than producing something
  // that matches nothing.
  check(buildFormatSelector({ kind: 'video', quality: 'nonsense' }) === 'bv*+ba/b',
    'an unknown quality falls back to best');
  check(buildFormatSelector({}) === 'bv*+ba/b', 'no options at all still yields a valid selector');

  // Every selector has to be a real yt-dlp format expression, or the download
  // dies with an unhelpful parse error.
  for (const [kind, quality] of [['video', 'best'], ['video', '1080'], ['audio', 'best']]) {
    const s = buildFormatSelector({ kind, quality });
    check(/^[a-z0-9+*/\[\]<=]+$/i.test(s), `selector parses as a format expression: ${s}`);
  }
}

console.log('\ninfo normalisation');
{
  const info = normaliseInfo({
    _type: 'video',
    id: 'abc',
    title: 'A Video',
    uploader: 'Someone',
    duration: 120,
    extractor_key: 'Fixture',
    webpage_url: 'https://example.com/watch',
    formats: [
      { format_id: '137', ext: 'mp4', height: 1080, vcodec: 'avc1', acodec: 'none', filesize: 100 },
      { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 10 },
      { format_id: '251', ext: 'webm', height: 720, vcodec: 'vp9', acodec: 'none' },
    ],
  });
  check(info.title === 'A Video' && info.extractor === 'Fixture', 'title and extractor survive');
  check(info.formats.length === 3, 'all three formats are listed', String(info.formats.length));

  const video = info.formats.find((f) => f.id === '137');
  const audio = info.formats.find((f) => f.id === '140');
  check(video.hasVideo && !video.hasAudio, 'a video-only format is marked as such');
  check(audio.hasAudio && !audio.hasVideo, 'an audio-only format is marked as such');
  // "none" is yt-dlp's way of saying absent, and a UI that shows it as a codec
  // is showing the user noise.
  check(video.acodec === null, '"none" acodec becomes null, not the string none');
  check(video.vcodec === 'avc1', 'a real codec is preserved');

  // A format with no id cannot be requested, so offering it in the UI would
  // produce a download that fails at the last moment.
  const noId = normaliseInfo({ id: 'x', title: 't', formats: [{ ext: 'mp4', height: 720 }] });
  check(noId.formats.length === 0, 'a format with no id is dropped rather than offered');

  const approx = normaliseInfo({
    id: 'y', title: 't', formats: [{ format_id: '1', ext: 'mp4', height: 480, filesize_approx: 555 }],
  });
  check(approx.formats[0].filesize === 555, 'an approximate size is used when no exact size is known');
}

console.log('\nerror cleaning');
{
  const clean = errors.cleanError;
  check(clean('') === '', 'empty input yields nothing');
  check(clean('ERROR: [generic] Unable to extract flashvars') === 'Unable to extract flashvars',
    'the component tag is stripped but the message is kept', clean('ERROR: [generic] Unable to extract flashvars'));
  check(clean('WARNING: something odd') === 'something odd', 'warnings are cleaned the same way');

  // yt-dlp's progress output would otherwise swamp the one useful line.
  const noisy = [
    '[download]  50.0% of 10.00MiB at 1.00MiB/s ETA 00:05',
    '[download] Destination: video.mp4',
    'ERROR: [youtube] Video unavailable',
  ].join('\n');
  check(clean(noisy) === 'Video unavailable', 'progress lines are discarded', clean(noisy));

  // The boilerplate tail is never the answer, and it is long.
  const bugReport = 'ERROR: unable to download; please report this issue on https://github.com/x/y/issues?q= , filling out the template';
  check(!/please report/i.test(clean(bugReport)), 'the "please report" tail is cut off', clean(bugReport));
  check(clean(bugReport).length < 60, 'and what remains is short', String(clean(bugReport).length));

  const long = `ERROR: ${'x'.repeat(900)}`;
  check(clean(long).length <= 403, 'a runaway message is truncated', String(clean(long).length));

  // A failure with no recognised component must still say something.
  check(clean('something went wrong entirely').length > 0, 'an unrecognised message is passed through',
    clean('something went wrong entirely'));
  check(clean('   \n  \n ') === '', 'whitespace-only input yields nothing');
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\nengine decisions are correct');
process.exit(failed.length ? 1 : 0);
