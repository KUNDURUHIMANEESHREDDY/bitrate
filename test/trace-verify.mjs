#!/usr/bin/env node
/**
 * Verify tracing end to end against a real Langfuse.
 *
 * Everything else in the trace suite points at a local stand-in, which proves
 * the payload is well formed but cannot prove a real project accepted it. This
 * is the step that closes that gap, and it is the only thing here that needs
 * credentials.
 *
 * It runs a small real download with tracing on, then reads the traces back out
 * of the Langfuse API and checks that what it is looking for is actually there.
 * Sending is not enough: an exporter that silently failed would look identical
 * from the sender's side.
 *
 *   LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... node test/trace-verify.mjs
 *
 * Add LANGFUSE_BASE_URL for a self-hosted instance.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startFixtures, makeBody, digest } from './fixtures.mjs';

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

/**
 * Normalise whatever the user typed.
 *
 * A self-hosted Langfuse is usually reached as "langfuse.local", ":3001" or a
 * full origin, and only the last is a URL. Guessing wrong here would produce a
 * confusing connection error instead of an obvious one.
 */
function normaliseBaseUrl(raw) {
  const value = (raw || 'https://cloud.langfuse.com').trim();
  // A bare ":3001" is how people shorthand a local instance, and it is not a
  // valid host on its own.
  const withHost = value.startsWith(':') ? `localhost${value}` : value;
  const withScheme = /^https?:\/\//i.test(withHost) ? withHost : `http://${withHost}`;
  try {
    return new URL(withScheme).origin;
  } catch {
    return withScheme.replace(/\/$/, '');
  }
}
const baseUrl = normaliseBaseUrl(process.env.LANGFUSE_BASE_URL);

if (!publicKey || !secretKey) {
  console.error(`This check needs a real Langfuse project.

  1. Create a free project at https://cloud.langfuse.com
  2. Copy the API keys it shows you
  3. Run:

     LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-... \\
       node test/trace-verify.mjs

  For a self-hosted instance add LANGFUSE_BASE_URL=http://your-host:3001

Everything else in the test suite runs without credentials.`);
  process.exit(2);
}

const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;

/**
 * Check the instance before downloading anything.
 *
 * The JS SDK v5 speaks the v2 observations API, which Langfuse only implements
 * from 3.63.0. Against an older self-hosted instance the export fails with
 * something unhelpful, so the version is checked up front and named plainly.
 */
async function preflight() {
  try {
    const res = await fetch(`${baseUrl}/api/public/health`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.log(`  preflight: /api/public/health answered HTTP ${res.status}`);
      return true; // Not fatal on its own; not every version exposes it.
    }
    const info = await res.json().catch(() => null);
    const version = info?.version ?? info?.versionInfo;
    if (!version) return true;
    console.log(`  instance version: ${version}`);
    const [major, minor] = String(version).split('.').map((n) => parseInt(n, 10) || 0);
    if (major < 3 || (major === 3 && minor < 63)) {
      console.log(`  WARNING: this instance is ${version}. The JS SDK needs 3.63.0 or newer`);
      console.log('           for the observations API. Exports will fail until it is upgraded.');
      return false;
    }
    return true;
  } catch (err) {
    console.log(`  preflight could not reach ${baseUrl}: ${err.message}`);
    return false;
  }
}

process.env.LANGFUSE_ENVIRONMENT = 'verify';
const body = makeBody(2 * 1024 * 1024, 31);
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-verify-'));
process.env.BITRATE_DOWNLOAD_DIR = dir;
process.env.BITRATE_DATA_DIR = path.join(dir, 'data');

const { startServer } = await import('../server/app.js');
const { flushTracing, tracingStatus } = await import('../server/trace.js');

let failed = 0;
const check = (ok, what, detail = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

console.log(`verifying against ${baseUrl}\n`);
console.log('preflight');
const healthy = await preflight();
check(healthy, 'the instance is reachable and new enough');
if (!healthy) {
  console.log('\n  stopping before the download, since the export could not be trusted.');
  process.exit(1);
}

const server = await startServer({ port: 0, loggerLevel: 'silent' });
check(tracingStatus().enabled, 'tracing initialised', tracingStatus().reason);

const fixture = await startFixtures({ ranges: true, body });
const created = await fetch(`${server.url}/api/downloads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ direct: true, fileUrl: fixture.fileUrl, title: 'trace-verify' }),
}).then((r) => r.json());
check(!created.error, 'download queued', created.error || '');

let job = created;
for (;;) {
  await new Promise((r) => setTimeout(r, 400));
  job = await fetch(`${server.url}/api/jobs/${created.id}`).then((r) => r.json());
  if (['done', 'error', 'cancelled'].includes(job.status)) break;
}
await fixture.close();
check(job.status === 'done', 'the download finished', job.error || '');

const files = await fetch(`${server.url}/api/library`).then((r) => r.json());
const got = await fsp.readFile(path.join(dir, files[0].name));
check(digest(got) === digest(body), 'and the bytes are correct');

await flushTracing();
await server.close();          // also shuts tracing down and flushes
await fsp.rm(dir, { recursive: true, force: true });

// Give the ingestion a moment before asking whether anything arrived.
await new Promise((r) => setTimeout(r, 4000));

console.log('\nreading traces back from the Langfuse API');
let traces = null;
try {
  const res = await fetch(`${baseUrl}/api/public/traces?limit=20&fromStartTime=${new Date(Date.now() - 15 * 60 * 1000).toISOString()}`, {
    headers: { authorization: auth },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.ok) {
    const bodyJson = await res.json();
    traces = bodyJson.data || [];
  } else {
    check(false, 'the traces API answered', `HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 120));
  }
} catch (err) {
  check(false, 'the traces API was reachable', err.message);
}

if (traces) {
  const names = traces.flatMap((t) => (t.observations || []).map((o) => o.name));
  const ours = traces.filter((t) => (t.observations || []).some((o) => o.name === 'download-media'));
  const inVerifyEnv = ours.filter((t) => t.environment === 'verify' || t.metadata?.environment === 'verify');

  check(ours.length > 0, 'a download-media trace arrived', `${traces.length} recent trace(s) seen`);
  check(inVerifyEnv.length > 0, 'and it is labelled with the verify environment',
    inVerifyEnv.map((t) => t.environment).join(', '));
  check(names.includes('fetch-bytes'), 'with its child steps', names.join(', '));
  check(names.includes('resolve-size'), 'including size resolution', names.join(', '));

  const raw = JSON.stringify(traces);
  check(!raw.includes('v-acctoken'), 'no media token reached the stored trace');
  console.log(`\n  trace id: ${inVerifyEnv[0]?.id ?? ours[0]?.id ?? '(none)'}`);
} else {
  console.log('\n  Could not read traces back, so delivery is unconfirmed.');
}

console.log(failed ? `\n${failed} check(s) failed` : '\ntraces are landing in a real Langfuse');
process.exit(failed ? 1 : 0);
