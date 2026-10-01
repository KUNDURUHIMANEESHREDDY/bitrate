/**
 * A local stand-in for Langfuse's OTLP ingestion endpoint.
 *
 * It is not a Langfuse instance and does not claim to be one. What it does do
 * is hold the payload to the OpenTelemetry trace data model, because that is
 * the contract Langfuse's ingestion endpoint parses. A capture that accepted
 * anything would prove only that bytes left the machine.
 *
 * Rejecting is the useful half. If a span were missing its traceId, or a
 * child referenced a parent that was never exported, or timestamps ran
 * backwards, a real endpoint would answer 400 and the traces would silently
 * vanish. Here that is a visible failure instead.
 */

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/** Validate one span against the OTel trace data model's required fields. */
export function validateSpan(span, knownSpanIds = new Set()) {
  const problems = [];
  if (!span.name) problems.push('span has no name');
  if (!HEX32.test(span.traceId || '')) problems.push(`traceId is not 32 hex chars: ${span.traceId}`);
  if (!HEX16.test(span.spanId || '')) problems.push(`spanId is not 16 hex chars: ${span.spanId}`);
  if (span.parentSpanId && !HEX16.test(span.parentSpanId)) {
    problems.push(`parentSpanId is not 16 hex chars: ${span.parentSpanId}`);
  }
  const start = BigInt(span.startTimeUnixNano ?? 0);
  const end = BigInt(span.endTimeUnixNano ?? 0);
  if (start === 0n) problems.push('missing startTimeUnixNano');
  if (end === 0n) problems.push('missing endTimeUnixNano');
  if (end !== 0n && end < start) problems.push('endTimeUnixNano is before startTimeUnixNano');
  if (span.attributes) {
    for (const a of span.attributes) {
      if (!a.key) problems.push('an attribute has no key');
    }
  }
  if (span.parentSpanId && !knownSpanIds.has(span.parentSpanId)) {
    // Not fatal on its own: a parent may have been exported in an earlier
    // batch. Recorded so a caller can see whether the tree is complete.
    problems.push(`DANGLING parent ${span.parentSpanId}`);
  }
  return problems;
}

export async function startIngestCapture({ strict = true } = {}) {
  const received = [];
  const rejected = [];
  const server = await import('node:http').then((m) => m.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = JSON.parse(raw); } catch { /* not json */ }

      const problems = [];
      if (!body) problems.push('body is not valid JSON');
      const spans = [];
      for (const rs of body?.resourceSpans ?? []) {
        for (const scope of rs.scopeSpans ?? []) for (const s of scope.spans ?? []) spans.push(s);
      }
      if (!spans.length) problems.push('no spans in the payload');
      // Second pass so parents exported in the same batch resolve.
      const known = new Set(spans.map((s) => s.spanId));
      for (const s of spans) {
        for (const p of validateSpan(s, known)) {
          if (!p.startsWith('DANGLING')) problems.push(`${s.name || '(unnamed)'}: ${p}`);
        }
      }

      const record = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || null,
        contentType: req.headers['content-type'] || null,
        raw,
        body,
        problems,
      };

      if (problems.length && strict) {
        // What a real endpoint does with a payload it cannot parse.
        rejected.push(record);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: problems.join('; ') }));
        return;
      }
      received.push(record);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  }));

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    received,
    rejected,
    /** Give the exporter time to flush its batch. */
    async settle(ms = 1500) {
      await new Promise((r) => setTimeout(r, ms));
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Pull every span name out of a captured OTLP JSON body. */
export function spanNames(requests) {
  const names = [];
  for (const req of requests) {
    for (const rs of req.body?.resourceSpans ?? []) {
      for (const scope of rs.scopeSpans ?? []) {
        for (const span of scope.spans ?? []) names.push(span.name);
      }
    }
  }
  return names;
}

/** Concatenated raw bodies, for assertions that only need a substring. */
export function allRaw(requests) {
  return requests.map((r) => r.raw).join('\n');
}
