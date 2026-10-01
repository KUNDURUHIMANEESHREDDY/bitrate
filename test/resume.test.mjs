/**
 * The mid-transfer resume.
 *
 * This path was implemented and then never exercised, because it is hard to
 * provoke for real: every window opens within the first seconds, so a link with
 * twenty seconds left is still good by the time a large file has moved much. The
 * fixture here gives each link a byte budget instead of a clock, so the first
 * one is certain to run out part way through, however fast the machine is.
 *
 * The assertion that matters is not that the download finishes. It is that the
 * bytes already on disk are kept: the replacement link is asked only for what
 * never arrived, and the coverage of everything served has no gaps. A restart
 * would produce a complete file too, so only the byte accounting can tell the
 * two apart.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-resume-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const { startServer } = await import('../server/app.js');
const { startBudgetFixtures, makeBody, digest } = await import('./fixtures.mjs');
const { flushTracing, tracingStatus } = await import('../server/trace.js');
const { startIngestCapture, spanNames } = await import('./ingest-capture.mjs');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const tracing = Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
const capture = tracing ? await startIngestCapture() : null;
if (capture) {
  process.env.LANGFUSE_BASE_URL = capture.baseUrl;
  process.env.LANGFUSE_ENVIRONMENT = 'test';
}

/**
 * Turn the served spans into a verdict on whether the transfer resumed.
 *
 * A resumed transfer covers the file with gaps only where a link was cut off,
 * and never asks a position twice. A restarted one re-asks the whole file, so
 * its spans overlap heavily and the total exceeds the file size.
 */
function readCoverage(fixture, size) {
  // A size probe on each link is not part of the transfer, so leaving it out
  // keeps the overlap figure about re-fetched content rather than about how many
  // links were tried.
  const spans = fixture.coverage().filter(([start, end]) => end - start > 1);
  let covered = 0;
  let overlap = 0;
  let reach = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start, reach);
    covered += Math.max(0, end - from);
    // Anything below the high-water mark was handed out a second time, whether
    // or not it was fully contained by an earlier span.
    overlap += Math.max(0, Math.min(end, reach) - start);
    reach = Math.max(reach, end);
  }
  return { spans, covered, overlap, complete: covered === size };
}

/** A 1-byte range request is the size probe, not a transfer window. */
const isProbe = (r) => r.wanted === 1;

async function runCase({ label, body, fixtureOptions, expectConcurrent }) {
  console.log(`\n${label}`);
  console.log(`  ${(body.length / 1048576).toFixed(1)} MB file, ${JSON.stringify(fixtureOptions)}\n`);

  const fixture = await startBudgetFixtures({ body, ...fixtureOptions });
  const created = await fetch(`${process.env.RESUME_SERVER}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      direct: true,
      fileUrl: fixture.fileUrl,
      referer: fixture.pageUrl,
      res: '1080p',
      title: `resume-${body.length}-${expectConcurrent ? 'concurrent' : 'single'}`,
    }),
  }).then((r) => r.json());
  check(!created.error, 'the job is accepted', created.error || '');

  const started = Date.now();
  let job = created;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    job = await fetch(`${process.env.RESUME_SERVER}/api/jobs/${created.id}`).then((r) => r.json());
    if (['done', 'error', 'cancelled'].includes(job.status)) break;
  }
  const elapsed = Date.now() - started;

  check(job.status === 'done', 'the download still completes', job.error || job.status);

  const library = await fetch(`${process.env.RESUME_SERVER}/api/library`).then((r) => r.json());
  const entry = library.find((f) => f.name === job.file?.name);
  check(Boolean(entry), 'and produces a library entry');
  if (entry) {
    const got = await fsp.readFile(path.join(outputDir, entry.name));
    check(got.length === body.length, 'the file is the right length', `${got.length} vs ${body.length}`);
    check(digest(got) === digest(body), 'and byte-for-byte correct');
  }

  const links = fixture.rangesByToken();
  const perToken = links.map((l) => l.served);
  const first = perToken[0] ?? 0;
  const rest = perToken.slice(1);

  check(rest.length > 0, 'a fresh link was fetched when the first one died',
    `${rest.length} replacement link(s)`);
  check(first > 0 && first <= (fixtureOptions.budgetBytes ?? Infinity),
    'the first link stopped at its budget', `${first} bytes served`);
  check(links.length > 1 && links.slice(0, -1).some((l) =>
    l.ranges.some((r) => r.status === 403)),
  'and refused a window rather than serving the whole file',
  links[0].ranges.map((r) => r.status).join(', '));

  // Every link but the last must have been cut short, otherwise there was
  // nothing to resume and the case proves nothing.
  const wasTruncated = perToken.slice(0, -1).some((n) => n > 0);
  check(wasTruncated, 'so at least one link really did die part way through');

  // Which shape the engine picked decides how strict the byte accounting below
  // can be, so it is worth asserting rather than assuming.
  //
  // A single window covers the whole file and is asked for once, from 0. A split
  // file is asked for once per window, so the first link opened a request at
  // several distinct offsets. Refused requests count, since a window that was
  // refused still shows the engine had planned to run it alongside the others.
  //
  // A split file also has siblings that can abandon each other's reads: one
  // window's refusal tears down the round mid-read, and a window cannot be called
  // finished before its last byte has been read, so the unconsumed tail of an
  // otherwise healthy window is necessarily re-fetched. A single window has no
  // such sibling, so its link dies at a known boundary and the resume is exact.
  //
  // The size probe is excluded throughout, since it legitimately asks for byte
  // 0 on every link.
  // Whether the engine split the file is decided by the ranges the first link
  // asked for: a single window is one request reaching the last byte, while a
  // split file opens several that each stop short of it.
  const asked = links[0].ranges.filter((r) => !isProbe(r));
  const concurrent = asked.some((r) => r.end < body.length - 1);
  check(concurrent === expectConcurrent, concurrent
    ? 'the engine split the file, so windows were in flight together'
    : 'the engine kept the file as a single window');

  // A window that delivered any bytes is never re-asked from its own beginning.
  // Asking again partway in is the resume; asking again from the start is a
  // restart, and would throw away everything that window had already delivered.
  //
  // Windows the dead link refused outright delivered nothing, so the replacement
  // link is expected to ask for those from their beginning.
  const begun = new Set(asked.filter((r) => r.status === 206 && r.allowed > 0).map((r) => r.start));
  const restart = links.slice(1).flatMap((l) =>
    l.ranges.filter((r) => r.status === 206 && !isProbe(r) && begun.has(r.start)));
  check(restart.length === 0,
    'no window that had already delivered bytes is re-asked from its start',
    restart.length
      ? `re-asked from ${[...new Set(restart.map((r) => r.start))].join(', ')}`
      : `${begun.size} window(s) resumed partway in`);

  const { spans, covered, overlap, complete } = readCoverage(fixture, body.length);
  check(complete, 'everything the file needs was served, with no gaps left',
    `${covered} of ${body.length} bytes covered in ${spans.length} span(s)`);

  // Probes excluded: each one legitimately costs a byte, and a link that is
  // replaced is probed again to confirm its length.
  const total = links
    .flatMap((l) => l.ranges)
    .filter((r) => !isProbe(r))
    .reduce((a, r) => a + r.allowed, 0);

  if (concurrent) {
    check(overlap < first,
      're-fetching is confined to the abandoned window, not the whole file',
      `${overlap} bytes re-served against ${first} delivered by the dead link`);
    check(total < body.length + first,
      'and the total stays well under a full re-fetch',
      `${total} served for a ${body.length} byte file`);
  } else {
    // Nothing could abandon this read, so the resume began at an exact
    // boundary and no byte should have crossed the wire twice.
    check(overlap === 0, 'and no byte was ever served twice', `${overlap} bytes re-served`);
    check(total === body.length,
      'total bytes served is exactly the file, so nothing was re-fetched',
      `${total} served for a ${body.length} byte file`);
  }

  check(elapsed < 20_000,
    'and the recovery is prompt rather than waiting out a backoff',
    `${(elapsed / 1000).toFixed(1)}s`);

  await fixture.close();
  return { elapsed, total, windows: spans.length, concurrent };
}

const server = await startServer({ port: 0, loggerLevel: 'silent' });
process.env.RESUME_SERVER = server.url;

// Three shapes, because the resume has to be right in each one the engine picks.
//
// A large file is split into windows that run at once, so a failing window has
// to abandon the others without two of them writing over the same bytes, and the
// unconsumed tail of an abandoned window is legitimately re-fetched. A small
// file is a single window, where nothing can abandon the read, so the resume
// lands on an exact boundary and the byte accounting has to come out perfect.
// A link that dies between windows rather than mid-body is the third shape.
const runs = [];
runs.push(await runCase({
  label: 'split across windows, link dies mid-body',
  body: makeBody(3 * 1024 * 1024),
  fixtureOptions: { budgetBytes: 640 * 1024 },
  expectConcurrent: true,
}));
runs.push(await runCase({
  label: 'split across windows, link dies between windows',
  body: makeBody(3 * 1024 * 1024),
  fixtureOptions: { budgetWindows: 1 },
  expectConcurrent: true,
}));
runs.push(await runCase({
  label: 'single window, link dies before the file is finished',
  body: makeBody(512 * 1024),
  fixtureOptions: { budgetBytes: 200 * 1024 },
  expectConcurrent: false,
}));

if (capture) {
  await flushTracing();
  await capture.settle(800);
  const names = spanNames(capture.received);
  check(names.includes('refresh-link'), 'the refresh is visible in the trace');
  check(names.includes('fetch-bytes-resumed'), 'and the resumed transfer is its own step');
  check(capture.rejected.length === 0, 'the receiver rejected nothing');
}

await server.close();
if (capture) await capture.close();
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\nevery case resumes: progress kept, no window restarted');
for (const r of runs) {
  console.log(`  ${(r.total / 1024).toFixed(0).padStart(6)} KB served`
    + `  ${String(r.windows).padStart(2)} window(s)`
    + `  ${(r.elapsed / 1000).toFixed(1)}s`
    + `  ${r.concurrent ? 'resumed, tail of the abandoned window re-fetched' : 'exact, nothing re-fetched'}`);
}
console.log(`  ${tracing ? 'traced' : 'tracing off'}`);
process.exit(failed.length ? 1 : 0);
