/**
 * Does aria2c actually make Bitrate faster?
 *
 * The README claims it is "usually the largest single win available", on the
 * grounds that origins cap a single connection below the link rate. That claim
 * has never been measured. This measures it.
 *
 * The origin used here caps every connection separately, the way a CDN does.
 * A loopback server has no such cap, so benchmarking against one would compare
 * two downloaders over an unlimited pipe and find nothing, which would say
 * nothing about the claim either way. The cap is what makes extra connections
 * worth having.
 *
 * Both configurations download the same bytes from the same origin and both are
 * checked byte-for-byte, so a "win" cannot come from doing less work.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const { startThrottledOrigin, makeBody } = await import('./fixtures.mjs');
const { YTDLP, ARIA2C } = await import('../server/config.js');

const MB = 1024 * 1024;

// Big enough that a single throttled connection takes seconds rather than
// milliseconds, so the difference is not dominated by process startup.
const SIZE = Number(process.env.BENCH_SIZE || 48) * MB;
// Per-connection cap. High enough that sixteen connections are not instantly
// pegging the loopback socket, low enough that one is visibly slow.
const CAP = Number(process.env.BENCH_CAP || 6) * MB;
const RUNS = Number(process.env.BENCH_RUNS || 3);

const outDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-bench-'));
const body = makeBody(SIZE, 7);
const expected = createHash('sha256').update(body).digest('hex');

const origin = await startThrottledOrigin({ body, bytesPerSecond: CAP, chunkBytes: 128 * 1024 });

console.log('aria2c benchmark');
console.log(`  file        ${(SIZE / MB).toFixed(0)} MB`);
console.log(`  origin      per-connection cap of ${(CAP / MB).toFixed(1)} MB/s, ranged`);
console.log(`  runs        ${RUNS} each, alternating to spread any machine noise`);
const aria2c = detectAria2c();
console.log(`  aria2c      ${aria2c.version || 'not found, skipping the comparison'}\n`);

/** Resolve the real binary and its version, so the output names what was tested. */
function detectAria2c() {
  if (!ARIA2C) return { version: null };
  const which = spawnSync('where', [ARIA2C], { encoding: 'utf8', windowsHide: true });
  if (which.status !== 0) return { version: null };
  const bin = which.stdout.split(/\r?\n/)[0].trim();
  const v = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
  const version = v.status === 0 ? v.stdout.split(/\r?\n/)[0].trim() : bin;
  return { version, bin };
}

/**
 * One download, timed end to end.
 *
 * The output goes to a fresh directory each time so nothing can be resumed from
 * a previous run, which would make the second configuration look fast for the
 * wrong reason.
 */
function download({ useAria2 }, label, run) {
  return new Promise((resolve) => {
    const dir = path.join(outDir, `${label}-${run}`);
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'out.mp4');

    const args = [
      '--no-colors', '--no-warnings', '--ignore-config',
      '--retries', '3',
      // No --continue: this measures a cold transfer, not a resume.
      '-f', 'b',
      '-o', target,
      ...(useAria2
        ? ['--external-downloader', ARIA2C, '--external-downloader-args',
          'aria2c:-x16 -s16 -k1M --file-allocation=none --console-log-level=warn']
        : []),
      origin.fileUrl,
    ];

    const started = process.hrtime.bigint();
    const proc = spawn(YTDLP, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      let ok = false;
      let size = 0;
      let reason = `exit ${code}`;
      try {
        const got = fs.readFileSync(target);
        size = got.length;
        ok = createHash('sha256').update(got).digest('hex') === expected;
        if (!ok) reason = 'bytes differ';
      } catch (err) {
        reason = String(err.message).slice(0, 80);
      }
      resolve({ ms, ok, size, reason, connections: origin.peakConnections() });
    });
  });
}

const withAria2 = [];
const without = [];

if (!aria2c.version) {
  console.log('  aria2c is not installed, so there is nothing to compare against.');
  console.log('  The README claim cannot be checked until it is. See scripts/doctor.js.');
  await origin.close();
  await fsp.rm(outDir, { recursive: true, force: true });
  process.exit(2);
}

for (let run = 0; run < RUNS; run += 1) {
  // Alternate so a warm-up on the first run cannot bias one configuration.
  origin.resetPeak();
  const off = await download({ useAria2: false }, 'without', run);
  without.push(off);

  origin.resetPeak();
  const on = await download({ useAria2: true }, 'with', run);
  withAria2.push(on);

  const mbps = (ms) => (SIZE / MB / (ms / 1000)).toFixed(1);
  console.log(`  run ${run + 1}`);
  console.log(`    yt-dlp alone   ${(off.ms / 1000).toFixed(2)}s  ${mbps(off.ms)} MB/s  ${off.connections} conn  ${off.ok ? 'bytes ok' : `FAIL ${off.reason}`}`);
  console.log(`    with aria2c    ${(on.ms / 1000).toFixed(2)}s  ${mbps(on.ms)} MB/s  ${on.connections} conn  ${on.ok ? 'bytes ok' : `FAIL ${on.reason}`}`);
  console.log(`    speedup        ${(off.ms / on.ms).toFixed(2)}x\n`);
}

await origin.close();

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const offMed = median(without.map((r) => r.ms));
const onMed = median(withAria2.map((r) => r.ms));
const offConn = Math.max(...without.map((r) => r.connections));
const onConn = Math.max(...withAria2.map((r) => r.connections));
const allOk = [...without, ...withAria2].every((r) => r.ok);

console.log(`summary (median of ${RUNS})`);
console.log(`  yt-dlp alone    ${(offMed / 1000).toFixed(2)}s   ${(SIZE / MB / (offMed / 1000)).toFixed(1)} MB/s   ${offConn} connection(s)`);
console.log(`  with aria2c     ${(onMed / 1000).toFixed(2)}s   ${(SIZE / MB / (onMed / 1000)).toFixed(1)} MB/s   ${onConn} connection(s)`);
console.log(`  speedup         ${(offMed / onMed).toFixed(2)}x`);
console.log(`  bytes verified  ${allOk ? 'yes, every run' : 'NO, a run failed'}`);

// The honest caveat. Multiplying connections multiplies the allowance, but the
// host still has to push every byte, so the measured figure always lands well
// short of the connection ratio. On a real network the answer is somewhere
// between the two, which is why this is a direction, not a number to promise.
const ceiling = (CAP * onConn) / MB;
const achieved = SIZE / MB / (onMed / 1000);
console.log(`\n  the cap is ${(CAP / MB).toFixed(1)} MB/s per connection. ${onConn} connections could`);
console.log(`  reach ${ceiling.toFixed(0)} MB/s on paper, but this run managed ${achieved.toFixed(1)} MB/s:`);
console.log(`  the origin itself became the limit. A real CDN sits below both numbers.`);
console.log(`  Read ${(offMed / onMed).toFixed(1)}x as "extra connections buy real throughput against a`);
console.log(`  throttling origin", not as a figure to expect on any particular site.`);

await fsp.rm(outDir, { recursive: true, force: true });
process.exit(allOk ? 0 : 1);