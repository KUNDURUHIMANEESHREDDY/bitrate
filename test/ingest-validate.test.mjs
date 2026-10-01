/**
 * The ingest stand-in's own checks.
 *
 * A validator that never rejects anything would let every other trace test pass
 * for the wrong reason, so this feeds it payloads that are wrong in the specific
 * ways a real bug would produce, and requires it to catch each one.
 */
import { validateSpan, startIngestCapture } from './ingest-capture.mjs';

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const good = {
  name: 'download-media',
  traceId: 'a'.repeat(32),
  spanId: 'b'.repeat(16),
  startTimeUnixNano: '1700000000000000000',
  endTimeUnixNano: '1700000000500000000',
  attributes: [{ key: 'langfuse.observation.type', value: { stringValue: 'span' } }],
};

console.log('a well-formed span');
check(validateSpan(good, new Set([good.spanId])).length === 0, 'passes with no complaints');

console.log('\nthe specific ways a real bug would look');
check(validateSpan({ ...good, traceId: 'abc' }, new Set()).some((p) => p.includes('traceId')),
  'a truncated traceId is caught');
check(validateSpan({ ...good, spanId: 'nope' }, new Set()).some((p) => p.includes('spanId')),
  'a malformed spanId is caught');
check(validateSpan({ ...good, endTimeUnixNano: '1699999999000000000' }, new Set())
  .some((p) => p.includes('before startTimeUnixNano')), 'end before start is caught');
check(validateSpan({ ...good, startTimeUnixNano: undefined, endTimeUnixNano: undefined }, new Set())
  .some((p) => p.includes('startTimeUnixNano')), 'a missing timestamp is caught');
check(validateSpan({ ...good, name: '' }, new Set()).some((p) => p.includes('name')),
  'an unnamed span is caught');
check(validateSpan({ ...good, parentSpanId: 'z'.repeat(16) }, new Set())
  .some((p) => p.startsWith('DANGLING')), 'a parent that was never exported is flagged');
check(validateSpan({ ...good, parentSpanId: 'b'.repeat(16) }, new Set([good.spanId, 'b'.repeat(16)]))
  .length === 0, 'a parent in the same batch resolves cleanly');

console.log('\nthe receiver answers the way a real endpoint would');
{
  const capture = await startIngestCapture({ strict: true });
  const post = (payload) => fetch(`${capture.baseUrl}/api/public/otel/v1/traces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Basic cG86c2s=' },
    body: JSON.stringify(payload),
  });

  const goodBody = { resourceSpans: [{ scopeSpans: [{ spans: [good] }] }] };
  const okRes = await post(goodBody);
  check(okRes.status === 200, 'a valid payload is accepted', `HTTP ${okRes.status}`);
  check(capture.received.length === 1, 'and is recorded');

  const badBody = { resourceSpans: [{ scopeSpans: [{ spans: [{ ...good, traceId: 'zz' }] }] }] };
  const badRes = await post(badBody);
  check(badRes.status === 400, 'an invalid payload is rejected with 400', `HTTP ${badRes.status}`);
  check(capture.rejected.length === 1, 'and is recorded as rejected');
  check(String(capture.rejected[0].problems).includes('traceId'),
    'with a reason naming the problem', String(capture.rejected[0].problems).slice(0, 60));

  const junk = await fetch(`${capture.baseUrl}/api/public/otel/v1/traces`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json',
  });
  check(junk.status === 400, 'a non-JSON body is rejected too', `HTTP ${junk.status}`);

  await capture.close();
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\nthe validator actually rejects bad input');
process.exit(failed.length ? 1 : 0);
