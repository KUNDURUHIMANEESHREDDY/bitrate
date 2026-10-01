/**
 * Eval harness for the download engine.
 *
 * Each case is queued through the same HTTP API the UI uses, so what is measured
 * is the product's real path rather than an internal shortcut. A case passes
 * only if the job reaches `done` and the resulting file matches what was asked
 * for: exact byte count, and a matching digest where one is known.
 *
 * Offline cases use local fixtures, so `npm run eval` is deterministic and free.
 * Live cases against real sites are opt-in, because a remote host throttling or
 * changing its markup should read as a skipped case, not as a broken app.
 *
 *   node test/eval.mjs                 offline cases only
 *   node test/eval.mjs --live          include live site cases
 *   node test/eval.mjs --only=expire   run one case by name
 *   node test/eval.mjs --repeat=3      run the suite three times, to catch flakes
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startFixtures, makeBody, digest } from './fixtures.mjs';
import { withSpan, shutdownTracing, tracingStatus } from '../server/trace.js';

// The server resolves its download directory when config.js is first evaluated,
// so the environment has to be in place before that module loads. A static
// import of the server here would fix the directory before this line ran, and
// every case would quietly land in the user's real download folder instead.
const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-eval-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');
const { startServer } = await import('../server/app.js');

const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const value = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const LIVE = flag('live');
const ONLY = value('only');
const REPEAT = Math.max(1, Number.parseInt(value('repeat') || '1', 10) || 1);
const KEEP = flag('keep');

/** Fixtures are sized to straddle the 2 MB threshold that picks the split path. */
const SMALL = makeBody(512 * 1024, 7);
const LARGE = makeBody(3 * 1024 * 1024, 11);
const HUGE = makeBody(9 * 1024 * 1024, 13);

const RANGE_PAGE = 'html<head><source src="__MEDIA__"></head>';

const cases = [
  {
    name: 'ranged-large',
    why: 'server honours Range, so the file is fetched as parallel windows',
    setup: () => startFixtures({ ranges: true, body: LARGE }),
    request: (f) => ({ direct: true, fileUrl: f.fileUrl, title: 'ranged-large' }),
    expect: { bytes: LARGE.length, sha256: digest(LARGE) },
  },
  {
    name: 'ranged-huge',
    why: 'larger file, more windows, still byte-exact',
    setup: () => startFixtures({ ranges: true, body: HUGE }),
    request: (f) => ({ direct: true, fileUrl: f.fileUrl, title: 'ranged-huge' }),
    expect: { bytes: HUGE.length, sha256: digest(HUGE) },
  },
  {
    name: 'ranged-small',
    why: 'below the split threshold, so one sequential window is used',
    setup: () => startFixtures({ ranges: true, body: SMALL }),
    request: (f) => ({ direct: true, fileUrl: f.fileUrl, title: 'ranged-small' }),
    expect: { bytes: SMALL.length, sha256: digest(SMALL) },
  },
  {
    name: 'no-ranges-large',
    why: 'server ignores Range and always sends the whole body; splitting it would corrupt the file',
    setup: () => startFixtures({ ranges: false, body: LARGE }),
    request: (f) => ({ direct: true, fileUrl: f.fileUrl, title: 'no-ranges-large' }),
    expect: { bytes: LARGE.length, sha256: digest(LARGE) },
  },
  {
    name: 'expired-token',
    why: 'the link is already dead; the job must re-read the page and recover rather than error',
    setup: () => startFixtures({ ranges: true, body: LARGE, tokenTtl: 1, tokenPage: RANGE_PAGE }),
    request: (f) => ({ direct: true, fileUrl: f.deadUrl, referer: f.pageUrl, res: '1080p', title: 'expired-token' }),
    expect: { bytes: LARGE.length, sha256: digest(LARGE) },
  },
  {
    name: 'expired-token-no-ranges',
    why: 'recovery must also work when the origin does not support ranges',
    setup: () => startFixtures({ ranges: false, body: LARGE, tokenTtl: 1, tokenPage: RANGE_PAGE }),
    request: (f) => ({ direct: true, fileUrl: f.deadUrl, referer: f.pageUrl, res: '1080p', title: 'expired-nr' }),
    expect: { bytes: LARGE.length, sha256: digest(LARGE) },
  },
  {
    name: 'hostile-name',
    why: 'a title full of characters Windows forbids must not produce an unwritable path',
    setup: () => startFixtures({ ranges: true, body: SMALL }),
    request: (f) => ({ direct: true, fileUrl: f.fileUrl, title: 'a/b\\c:d*e?f"g<h>i|j' }),
    expect: { bytes: SMALL.length, sha256: digest(SMALL) },
  },
  ...(LIVE ? [{
    name: 'live-ytdlp',
    why: 'the ordinary yt-dlp path against a real site',
    live: true,
    request: () => ({ url: 'https://www.w3schools.com/html/mov_bbb.mp4' }),
    expect: { minBytes: 100_000, streams: ['video'] },
  }] : []),
];

/** ffprobe is the authority on whether a file is actually playable media. */
function probe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file,
  ], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).streams || []; } catch { return null; }
}

async function runCase(testCase, serverUrl, dir) {
  // Each case is its own observation, so a run reads as a list of results
  // rather than one aggregate number, and a single flaky case is identifiable.
  return withSpan('eval-case', async () => {
    let fixture = null;
    try {
      if (testCase.setup) fixture = await testCase.setup();

      const created = await fetch(`${serverUrl}/api/downloads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testCase.request(fixture)),
      }).then((r) => r.json());
      if (created.error) throw new Error(`queue refused: ${created.error}`);

      // Poll like the UI does, so the same progress path is exercised.
      const deadline = Date.now() + 180_000;
      let job = created;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        job = await fetch(`${serverUrl}/api/jobs/${created.id}`).then((r) => r.json());
        if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') break;
      }
      if (job.status !== 'done') throw new Error(`ended as ${job.status}${job.error ? `: ${job.error}` : ''}`);

      // The library is the app's own view of what landed, so use its name.
      const files = await fetch(`${serverUrl}/api/library`).then((r) => r.json());
      const entry = files.find((f) => f.name === job.file?.name) || files[0];
      if (!entry) throw new Error('job reported done but the library has no such file');
      const full = path.join(dir, entry.name);

      const stat = await fsp.stat(full);
      const { bytes, sha256, minBytes, streams } = testCase.expect;
      if (bytes !== undefined && stat.size !== bytes) {
        throw new Error(`size ${stat.size}, expected ${bytes}`);
      }
      if (minBytes !== undefined && stat.size < minBytes) {
        throw new Error(`size ${stat.size} is below the ${minBytes} floor`);
      }
      if (sha256) {
        const actual = digest(await fsp.readFile(full));
        if (actual !== sha256) throw new Error('content digest does not match');
      }
      if (streams) {
        const found = probe(full);
        if (!found) throw new Error('ffprobe could not read the file');
        for (const want of streams) {
          if (!found.some((s) => s.codec_type === want)) {
            throw new Error(`missing a ${want} stream (found ${found.map((s) => s.codec_type).join(',') || 'none'})`);
          }
        }
      }
      return { ok: true, bytes: stat.size, ms: Date.now() - (created.createdAt || Date.now()) };
    } catch (err) {
      return { ok: false, error: err.message };
    } finally {
      await fixture?.close();
    }
  }, {
    input: { case: testCase.name },
    output: (result) => result,
    level: (result) => (result?.ok ? 'DEFAULT' : 'ERROR'),
    // Labelled as its own environment so an eval run cannot pollute a real
    // dashboard, which is the point of the environment attribute.
    env: 'eval',
    metadata: { why: testCase.why, live: Boolean(testCase.live) },
  });
}

async function main() {
  const selected = cases.filter((c) => (!ONLY || c.name === ONLY) && (!c.live || LIVE));
  if (!selected.length) {
    console.error(ONLY ? `no case named "${ONLY}"` : 'no cases selected');
    process.exit(2);
  }

  const dir = outputDir;
  const server = await startServer({ port: 0, loggerLevel: 'silent' });
  console.log(`eval: ${selected.length} case(s) x ${REPEAT} run(s)  server ${server.url}  output ${dir}`);
  if (tracingStatus().enabled) console.log(`tracing: ${tracingStatus().reason}`);
  console.log('');

  const rows = [];
  let failed = 0;

  // The run is one trace whose output is the pass rate, with a child span per
  // case. That shape is what makes "did this get slower" and "which case is
  // flaky" answerable without reading logs.
  const summary = await withSpan('eval-run', async () => {
    for (let run = 1; run <= REPEAT; run++) {
      for (const c of selected) {
        const t0 = Date.now();
        const result = await runCase(c, server.url, dir);
        if (!result.ok) failed++;
        rows.push({ run, name: c.name, ok: result.ok, detail: result.ok ? `${fmt(result.bytes)} in ${((Date.now() - t0) / 1000).toFixed(1)}s` : result.error });
        process.stdout.write(result.ok ? '.' : 'F');
      }
    }
    return {
      cases: selected.length,
      runs: REPEAT,
      passed: rows.length - failed,
      total: rows.length,
      passRatePercent: Math.round(((rows.length - failed) / rows.length) * 1000) / 10,
      live: LIVE,
      failures: rows.filter((r) => !r.ok).map((r) => ({ case: r.name, run: r.run, error: r.detail })),
    };
  }, {
    input: { cases: selected.map((c) => c.name), runs: REPEAT, live: LIVE },
    output: (value) => value,
    level: () => (failed ? 'ERROR' : 'DEFAULT'),
    env: 'eval',
  });

  process.stdout.write('\n\n');

  const width = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) {
    console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }

  const total = rows.length;
  const passRate = ((total - failed) / total) * 100;
  console.log(`\n${total - failed}/${total} passed  (${passRate.toFixed(1)}%)`);

  if (!LIVE) console.log('live site cases skipped; pass --live to include them');
  if (ONLY) console.log(`filtered to "${ONLY}"; the pass rate above is not the whole suite`);

  const wasTracing = tracingStatus().enabled;
  await server.close();
  // server.close() flushes tracing, but the process is about to exit and a
  // partially flushed buffer is still a lost trace.
  await shutdownTracing();
  if (!KEEP) await fsp.rm(dir, { recursive: true, force: true });
  else console.log(`kept output in ${dir}`);

  if (wasTracing) console.log(`traced ${summary.cases * summary.runs} case(s) as eval-case spans`);
  process.exit(failed ? 1 : 0);
}

const fmt = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

main().catch((err) => {
  console.error('eval harness failed:', err);
  process.exit(2);
});
