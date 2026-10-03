/**
 * Job isolation and recovery.
 *
 * Two properties that used to be true by accident rather than by construction,
 * and that the per-job workspace is now responsible for:
 *
 *   isolation    two downloads running at once, finishing at the same moment,
 *                each end up owning their own file. The old code identified a
 *                finished job's artifact by scanning the download directory for
 *                media files newer than the job and taking the newest, which two
 *                concurrent jobs make indistinguishable.
 *
 *   recovery     a job interrupted by the process dying is honestly reported as
 *                recoverable, and its workspace is still there to resume from.
 *                Its bytes are not thrown away with the job record.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-recovery-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const { startServer } = await import('../server/app.js');
const { workspaceFor, findArtifacts, promote, safeFileName } = await import('../server/workspace.js');
const { makeBody, digest } = await import('./fixtures.mjs');

const results = [];
let group = '';
const section = (name) => { group = name; console.log(`\n${name}`); };
const check = (ok, what, detail = '') => {
  results.push({ ok, what, group });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/**
 * A server that serves N distinct bodies under distinct names.
 *
 * Distinct content is the point. Two jobs fetching the same bytes would produce
 * interchangeable files, so a test could not tell a correct result from one job
 * having been handed the other's download.
 */
async function startMultiOrigin(bodies) {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    // /alpha.mp4 -> 'alpha'. The extension is stripped because the downloader
    // derives its own from the content type, not from the path.
    const name = new URL(req.url, 'http://x').pathname
      .replace(/^\//, '')
      .replace(/\.[a-z0-9]{2,4}$/i, '');
    const body = bodies[name];
    if (!body) { res.writeHead(404).end('nope'); return; }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (m) {
      const start = Number(m[1]);
      const end = Math.min(Number(m[2]), body.length - 1);
      if (start >= body.length || end >= body.length || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }
      const slice = body.subarray(start, end + 1);
      res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': String(slice.length),
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(body.length),
      'Accept-Ranges': 'bytes',
    });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    url: (name) => `${base}/${name}.mp4`,
    close: () => new Promise((r) => server.close(r)),
  };
}

const waitFor = async (url, id, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  let job = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    job = await fetch(`${url}/api/jobs/${id}`).then((r) => r.json());
    if (['done', 'error', 'cancelled'].includes(job.status)) break;
  }
  return job;
};

const server = await startServer({ port: 0, loggerLevel: 'silent' });

/* ================================================================== *
 * Concurrent jobs do not claim each other's files
 * ================================================================== */

section('concurrent job isolation');

// Big enough to be split into several windows, so each job has several transfer
// windows in flight and they all finish at genuinely unpredictable moments.
const bodies = {
  alpha: makeBody(3 * 1024 * 1024, 11),
  bravo: makeBody(3 * 1024 * 1024, 22),
  charlie: makeBody(3 * 1024 * 1024, 33),
  delta: makeBody(3 * 1024 * 1024, 44),
};
const origin = await startMultiOrigin(bodies);

const names = Object.keys(bodies);
const created = [];
for (const name of names) {
  created.push(await fetch(`${server.url}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // One shared title, so the only thing distinguishing the output files is the
    // random suffix the downloader adds. If the engine ever picked a file by
    // recency rather than by job, that collision is the trap.
    body: JSON.stringify({
      direct: true,
      fileUrl: origin.url(name),
      title: 'same-title-for-everyone',
    }),
  }).then((r) => r.json()));
}
check(created.every((j) => j.id), 'four concurrent jobs were accepted');

const finished = [];
for (const job of created) finished.push(await waitFor(server.url, job.id));

check(finished.every((j) => j.status === 'done'), 'every job completes',
  finished.map((j) => `${j.status}${j.error ? `: ${j.error}` : ''}`).join('; '));

// Now the assertion that matters: each job's library entry must contain the body
// it asked for. Matching by name proves nothing, since every job used the same
// title.
const library = await fetch(`${server.url}/api/library`).then((r) => r.json());
check(library.length === names.length, 'four distinct files land in the library', `${library.length} entries`);

let mismatches = 0;
for (let i = 0; i < finished.length; i += 1) {
  const job = finished[i];
  const entry = library.find((f) => f.name === job.file?.name);
  if (!entry) { mismatches += 1; continue; }
  const got = await fsp.readFile(path.join(outputDir, entry.name));
  if (digest(got) !== digest(bodies[names[i]])) mismatches += 1;
}
check(mismatches === 0, 'and each one contains exactly the bytes its own job fetched',
  `${mismatches} mismatch(es) out of ${finished.length}`);

// Four files with the same title means four distinct names, which is the whole
// reason the downloader salts them. If two shared a name the promotion would have
// had to disambiguate, which it also does, but the check above is the real one.
const distinctNames = new Set(library.map((f) => f.name));
check(distinctNames.size === library.length, 'no two library entries share a name');

await origin.close();

/* ================================================================== *
 * An interrupted job keeps its bytes
 * ================================================================== */

section('interrupted jobs');

// A workspace with a partial file in it, exactly as a crash mid-transfer leaves.
const orphanJobId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const orphanDir = workspaceFor(orphanJobId);
await fsp.mkdir(orphanDir, { recursive: true });
await fsp.writeFile(path.join(orphanDir, 'half-downloaded.mp4.part'), makeBody(64 * 1024));

const { readState, writeState } = await import('../server/workspace.js');
await writeState(orphanJobId, { source: 'direct', quality: 'best', bytesDone: 65536 });

check(orphanDir !== null, 'a workspace path is derived from a job id');
check(fs.existsSync(path.join(orphanDir, 'half-downloaded.mp4.part')), 'a partial file survives in it');

const state = await readState(orphanJobId);
check(state?.source === 'direct', 'and the resume state is readable', JSON.stringify(state));
check(state?.bytesDone === 65536, 'recording what had been transferred');
// A workspace holding only .part files offers no artifact, which is correct: a
// partial file is not a result.
check((await findArtifacts(orphanDir)).length === 0, 'a partial file is not mistaken for a finished one');

check(workspaceFor('not-a-uuid') === null, 'a job id that is not a uuid resolves to nothing');
check(workspaceFor('../../escape') === null, 'and neither does one shaped like a traversal');

/* ================================================================== *
 * Promotion
 * ================================================================== */

section('promotion into the library');

const src = path.join(orphanDir, 'promote-me.mp4');
await fsp.writeFile(src, makeBody(4096, 99));
const entry = await promote({ name: 'promote-me.mp4', full: src, size: 4096 });
check(fs.existsSync(path.join(outputDir, entry.name)), 'a promoted file exists in the library');
check(entry.size === 4096, 'with the size it had');
check(!fs.existsSync(src), 'and no longer exists in the workspace');

// The same name twice must not silently replace the first. rename() replaces on
// POSIX and fails on Windows, so relying on either platform's behaviour would make
// this bug platform-dependent.
await fsp.writeFile(src, makeBody(8192, 77));
const again = await promote({ name: 'promote-me.mp4', full: src, size: 8192 });
check(again.name !== entry.name, 'promoting the same name again does not overwrite', `${entry.name} vs ${again.name}`);
check(fs.existsSync(path.join(outputDir, entry.name)), 'the first file is still there');

const weird = path.join(orphanDir, 'weird name.mp4');
await fsp.writeFile(weird, makeBody(16));
const safe = await promote({ name: '../../escape.mp4', full: weird, size: 16 });
// The separators are what matter. Two dots inside a filename is just a filename;
// what must not survive is anything that could re-read as a path.
check(!/[\\/]/.test(safe.name) && path.dirname(path.join(outputDir, safe.name)) === path.resolve(outputDir),
  'a hostile filename is reduced to a bare name inside the library', safe.name);
check(fs.existsSync(path.join(outputDir, safe.name)), 'and the file still arrives');
check(safeFileName('../../escape.mp4') === safe.name, 'the same reduction happens in safeFileName');

await fsp.rm(orphanDir, { recursive: true, force: true });

/* ================================================================== */

await server.close();
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} recovery checks pass`);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  ${f.group}: ${f.what}`);
}
process.exit(failed.length ? 1 : 0);