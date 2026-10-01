/**
 * Tracing behaviour.
 *
 * Two things are checked, because they fail in opposite ways:
 *
 *   1. With no credentials, instrumented code runs, the SDK is never imported,
 *      and nothing is sent anywhere. A local-first tool must not become a thing
 *      that phones home just because observability code was added to it.
 *
 *   2. With credentials, the real LangfuseSpanProcessor is wired up and emits a
 *      well-formed payload to the ingestion endpoint. The receiver here is a
 *      local stand-in, not a Langfuse instance, so this proves the pipeline and
 *      the payload shape, and deliberately does not claim that a real Langfuse
 *      project would accept them.
 */
import { startIngestCapture, spanNames, allRaw } from './ingest-capture.mjs';

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

for (const key of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL']) {
  delete process.env[key];
}

// --- 1. disabled path -------------------------------------------------------
console.log('no credentials configured');
{
  const trace = await import('../server/trace.js');
  const { initTracing, withSpan, tracingStatus, shutdownTracing } = trace;

  const started = await initTracing();
  check(started === false, 'initTracing reports disabled');
  check(tracingStatus().enabled === false, 'status says disabled');
  check(/not both set/.test(tracingStatus().reason), 'reason explains why', tracingStatus().reason);

  let ran = false;
  let sawSpan = 'unset';
  const value = await withSpan('should-not-appear', async (span) => { ran = true; sawSpan = span; return 'ok'; });
  check(ran === true, 'the instrumented function still runs');
  check(value === 'ok', 'its return value is passed through untouched');
  check(sawSpan === null, 'it receives no span object when disabled');

  // A throwing step must still propagate, or instrumentation would swallow bugs.
  let caught = null;
  try {
    await withSpan('boom', async () => { throw new Error('original failure'); });
  } catch (err) { caught = err.message; }
  check(caught === 'original failure', 'errors propagate unchanged when disabled');

  await shutdownTracing();
}

// --- 2. enabled path --------------------------------------------------------
console.log('\ncredentials configured, exporter pointed at a local receiver');
const capture = await startIngestCapture();
{
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
  process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
  process.env.LANGFUSE_BASE_URL = capture.baseUrl;
  process.env.LANGFUSE_ENVIRONMENT = 'test';

  // A fresh module instance so the disabled state from above is not reused.
  const { initTracing, withSpan, shutdownTracing } = await import(`../server/trace.js?enabled=${Date.now()}`);

  const started = await initTracing();
  check(started === true, 'initTracing reports enabled');

  await withSpan('download-media', async () => {
    await withSpan('probe-source', async () => ({ extractor: 'failed' }), {
      input: { url: 'https://example.com/video' },
      metadata: { engine: 'ytdlp' },
    });
    await withSpan('fetch-bytes', async () => ({ bytes: 2017864899 }), {
      input: { windows: 8, ranges: true },
      tags: ['direct'],
    });
    return { file: 'video.mp4', bytes: 2017864899 };
  }, {
    input: { url: 'https://example.com/video' },
    metadata: { source: 'direct' },
    tags: ['video'],
  });

  // A step that fails has to be recorded *and* has to keep throwing, or
  // instrumentation would quietly hide real failures.
  let failurePropagated = null;
  try {
    await withSpan('failing-step', async () => { throw new Error('segment 3 failed'); });
  } catch (err) { failurePropagated = err.message; }
  check(failurePropagated === 'segment 3 failed', 'a failing step still propagates its error');

  await capture.settle(2500);
  await shutdownTracing();
}

const names = spanNames(capture.received);
const raw = allRaw(capture.received);
// Basic auth carries the keys base64-encoded, so decode rather than searching
// the header for the plaintext key.
const auth = capture.received[0]?.auth || '';
const decodedAuth = auth.startsWith('Basic ')
  ? Buffer.from(auth.slice(6), 'base64').toString('utf8')
  : '';

check(capture.received.length > 0, 'spans were exported', `${capture.received.length} request(s)`);
check(names.includes('download-media'), 'root observation present', names.join(', '));
check(names.includes('probe-source'), 'nested step recorded');
check(names.includes('fetch-bytes'), 'second nested step recorded');
check(names.includes('failing-step'), 'failing step still recorded');
check(auth.startsWith('Basic '), 'an Authorization header is sent');
check(decodedAuth === 'pk-lf-test:sk-lf-test', 'credentials are sent as public:secret', decodedAuth);
check(capture.received.every((r) => r.url === '/api/public/otel/v1/traces'),
  'posted to the OTLP traces endpoint', capture.received[0]?.url || 'none');
check(raw.includes('example.com/video'), 'the input URL reached the payload');
check(raw.includes('2017864899'), 'output values reached the payload');
check(raw.includes('ytdlp'), 'metadata reached the payload');
check(raw.includes('direct') && raw.includes('video'), 'tags reached the payload via metadata');
check(raw.includes('segment 3 failed'), 'the error message reached the payload');
check(raw.includes('ERROR'), 'the failure is marked at error level');
check(raw.includes('test'), 'the environment label is carried');

// The receiver validates against the OpenTelemetry trace data model and
// answers 400 to anything malformed, so nothing rejected means the payload
// Langfuse would parse is well formed.
check(capture.rejected.length === 0, 'the receiver rejected nothing',
  capture.rejected.map((r) => r.problems.join('; ')).join(' | ').slice(0, 120));

await capture.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\ntracing behaves correctly');
console.log('note: the receiver is a local stand-in, not a Langfuse instance.');
process.exit(failed.length ? 1 : 0);
