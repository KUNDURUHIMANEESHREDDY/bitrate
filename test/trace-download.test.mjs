/**
 * A real download, traced.
 *
 * The unit test in trace.test.mjs proves the SDK is wired up. This proves the
 * instrumentation describes what actually happened: the span tree matches the
 * work, the numbers are plausible, a failed link is recorded as a failure, and
 * no signed token reaches the payload.
 *
 * That last one is a property worth asserting rather than assuming. Media URLs
 * here carry a token that authorises the download, and traces leave the
 * machine, so instrumentation that logged whole URLs would be leaking a live
 * credential on every run.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startIngestCapture, allRaw } from './ingest-capture.mjs';
import { startFixtures, makeBody, digest } from './fixtures.mjs';

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const body = makeBody(3 * 1024 * 1024, 23);
const capture = await startIngestCapture();

const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-trace-'));
process.env.BITRATE_DOWNLOAD_DIR = dir;
process.env.BITRATE_DATA_DIR = path.join(dir, 'data');
process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
process.env.LANGFUSE_BASE_URL = capture.baseUrl;
process.env.LANGFUSE_ENVIRONMENT = 'test';

const { startServer } = await import(`../server/app.js`);
const { flushTracing } = await import('../server/trace.js');
const server = await startServer({ port: 0, loggerLevel: 'silent' });

/** Flatten the exported payload into { name, parent, attributes } records. */
function readSpans() {
  const out = [];
  for (const req of capture.received) {
    for (const rs of req.body?.resourceSpans ?? []) {
      for (const scope of rs.scopeSpans ?? []) {
        for (const s of scope.spans ?? []) {
          const attrs = {};
          for (const a of s.attributes ?? []) {
            attrs[a.key] = a.value.stringValue ?? a.value.intValue ?? a.value.boolValue
              ?? a.value.arrayValue ?? a.value;
          }
          out.push({ name: s.name, parent: s.parentSpanId, spanId: s.spanId, attrs });
        }
      }
    }
  }
  return out;
}

const meta = (raw) => {
  try { return JSON.parse(raw); } catch { return null; }
};

async function download(payload) {
  const created = await fetch(`${server.url}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then((r) => r.json());
  if (created.error) throw new Error(created.error);
  for (;;) {
    await new Promise((r) => setTimeout(r, 300));
    const job = await fetch(`${server.url}/api/jobs/${created.id}`).then((r) => r.json());
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
  }
}

// --- 1. a healthy download, token that has already expired --------------------
console.log('download whose link had expired (forces a refresh)');
{
  const fixture = await startFixtures({
    ranges: true,
    body,
    tokenTtl: 1,
    tokenPage: 'html<head><source src="__MEDIA__"></head>',
  });
  const job = await download({
    direct: true,
    fileUrl: fixture.deadUrl,
    referer: fixture.pageUrl,
    res: '1080p',
    title: 'trace-check',
  });
  await fixture.close();
  check(job.status === 'done', 'the download itself succeeded', job.error || '');

  // The file really is correct, so the trace below is describing something true.
  const files = await fetch(`${server.url}/api/library`).then((r) => r.json());
  const got = await fsp.readFile(path.join(dir, files[0].name));
  check(digest(got) === digest(body), 'and the downloaded bytes are correct');

  // Exporter batching means spans are not readable until asked for.
  await flushTracing();
  await capture.settle(800);
  const spans = readSpans();
  const names = spans.map((s) => s.name);
  const raw = allRaw(capture.received);

  check(names.includes('download-media'), 'root span recorded');
  check(names.includes('scrape-page'), 'the link refresh is visible as a step');
  check(names.includes('refresh-link'), 'the refresh itself is visible');
  check(names.includes('resolve-size'), 'size resolution is visible');
  check(names.includes('fetch-bytes'), 'the transfer is visible');

  // Hierarchy: the steps must sit under the download, not dangle at the root.
  const roots = spans.filter((s) => !s.parent);
  check(roots.length === 1 && roots[0].name === 'download-media',
    'the download is the single root', roots.map((r) => r.name).join(', '));
  const downloadSpan = spans.find((s) => s.name === 'download-media');
  const children = spans.filter((s) => s.parent === downloadSpan?.spanId).map((s) => s.name);
  check(children.includes('resolve-size') && children.includes('fetch-bytes'),
    'the main steps nest under the download', children.join(', '));
  check(children.includes('refresh-link'), 'the link refresh nests under the download', children.join(', '));

  // Scraping is a sub-step of refreshing, not a sibling of it.
  const refreshSpan = spans.find((s) => s.name === 'refresh-link');
  const grandchildren = spans.filter((s) => s.parent === refreshSpan?.spanId).map((s) => s.name);
  check(grandchildren.includes('scrape-page'),
    'and scraping nests under the refresh, one level deeper', grandchildren.join(', '));

  // The numbers that cannot be recovered after the fact.
  const transferSpan = spans.find((s) => s.name === 'fetch-bytes');
  const transferOut = meta(transferSpan?.attrs['langfuse.observation.output']);
  check(transferOut?.bytes === body.length, 'bytes moved are recorded', String(transferOut?.bytes));
  check(typeof transferOut?.megabytesPerSecond === 'number' && transferOut.megabytesPerSecond > 0,
    'throughput is recorded', `${transferOut?.megabytesPerSecond} MB/s`);
  check(transferSpan?.attrs['langfuse.observation.input']?.includes('windows'),
    'window count is on the input');

  const root = meta(downloadSpan?.attrs['langfuse.observation.output']);
  check(root?.outcome === 'done', 'the outcome is recorded', String(root?.outcome));
  check(root?.bytes === body.length, 'final size is recorded', String(root?.bytes));
  check(Number.isFinite(root?.durationSeconds), 'duration is recorded', `${root?.durationSeconds}s`);
  check(downloadSpan?.attrs['langfuse.observation.level'] !== 'ERROR',
    'a successful download is not marked as an error');

  // Nothing signed should be in there.
  check(!raw.includes('v-acctoken'), 'no media token in the payload');
  check(!/tok\d/.test(raw), 'no token value in the payload');
  check(raw.includes('127.0.0.1'), 'the host is reported instead');

  check(capture.rejected.length === 0, 'the receiver rejected nothing',
    capture.rejected.map((r) => r.problems.join('; ')).join(' | ').slice(0, 120));
  // Every child must name a parent that was actually exported, or the tree
  // Langfuse builds would have orphans in it.
  const dangling = [];
  for (const s of spans) {
    if (s.parent && !spans.some((o) => o.spanId === s.parent)) dangling.push(s.name);
  }
  check(dangling.length === 0, 'no orphaned spans in the exported tree', dangling.join(', '));
}

// --- 2. a download that fails -------------------------------------------------
console.log('\ndownload that fails');
{
  const fixture = await startFixtures({ ranges: true, body, tokenTtl: 1, tokenPage: 'plain page with no media' });
  const job = await download({
    direct: true,
    fileUrl: fixture.deadUrl,
    referer: fixture.pageUrl,
    title: 'trace-fail',
  });
  await fixture.close();
  check(job.status === 'error', 'the download failed as expected', job.error || '');

  await flushTracing();
  await capture.settle(800);
  const spans = readSpans();
  const root = spans.filter((s) => s.name === 'download-media').pop();
  const out = meta(root?.attrs['langfuse.observation.output']);
  check(out?.outcome === 'error', 'the failure is recorded on the root span', String(out?.outcome));
  check(root?.attrs['langfuse.observation.level'] === 'ERROR', 'and marked at error level');
  check(Boolean(out?.error), 'with the reason attached', out?.error?.slice(0, 60));
  check(capture.rejected.length === 0, 'the receiver rejected nothing',
    capture.rejected.map((r) => r.problems.join('; ')).join(' | ').slice(0, 120));
}

await server.close();   // also flushes and shuts tracing down
await capture.close();
await fsp.rm(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\ntraces describe what actually happened');
console.log('note: the receiver is a local stand-in, not a Langfuse instance.');
process.exit(failed.length ? 1 : 0);
