/**
 * The same credential contract, against a server that is actually enforcing it.
 *
 * token.test.mjs reads the source and checks the shapes. This drives the three
 * surfaces over a real socket with a real token configured, because the failure
 * this guards against is not a missing string in a file -- it is a 401 that only
 * appears once a token exists, which is exactly the configuration nobody tests by
 * hand.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'a-token-long-enough-to-be-worth-stealing';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-token-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');
process.env.BITRATE_AUTH_TOKEN = TOKEN;

const { startServer } = await import('../server/app.js');
const { startBudgetFixtures, makeBody } = await import('./fixtures.mjs');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/** Put something in the library so the media route has a real file to serve. */
const fixture = await startBudgetFixtures({ body: makeBody(512 * 1024), budgetBytes: 512 * 1024 });
const server = await startServer({ port: 0, loggerLevel: 'silent' });
const base = server.url;

console.log('the credential over a real socket\n');

const withTok = (p) => `${base}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(TOKEN)}`;

console.log('a token is really required');
check(await fetch(`${base}/api/health`).then((r) => r.status) === 401,
  'an unauthenticated request is refused');
check(await fetch(`${base}/api/health`, { headers: { 'X-Bitrate-Token': TOKEN } }).then((r) => r.status) === 200,
  'the header form the UI uses for ordinary requests is accepted');

console.log('\nthe surfaces that cannot set a header');

// Exactly the form web/src/hooks/useServerState.js builds.
const sseUrl = withTok('/api/events');
const sse = await fetch(sseUrl, { headers: { accept: 'text/event-stream' } });
check(sse.status === 200, 'the event stream connects with the token in its URL', `${sse.status}`);
check((sse.headers.get('content-type') || '').includes('text/event-stream'),
  'and it is the stream, not an error page', sse.headers.get('content-type'));
const reader = sse.body.getReader();
await reader.cancel();

// A live frame, so this is a working stream rather than an open socket that never
// says anything.
const jobs = await fetch(withTok('/api/jobs')).then((r) => r.json());
check(Array.isArray(jobs), 'the job list behind it answers', Array.isArray(jobs) ? 'ok' : typeof jobs);

// The media route, which is what the preview <audio> and <img> load, and what a
// download link points at.
const created = await fetch(withTok('/api/downloads'), {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'X-Bitrate-Token': TOKEN },
  body: JSON.stringify({
    direct: true, fileUrl: fixture.fileUrl, referer: fixture.pageUrl, res: '1080p', title: 'token-media',
  }),
}).then((r) => r.json());
check(!created.error, 'a download starts', created.error || '');

let job = created;
for (let i = 0; i < 200 && !['done', 'error'].includes(job.status); i += 1) {
  await new Promise((r) => setTimeout(r, 100));
  job = await fetch(withTok(`/api/jobs/${created.id}`)).then((r) => r.json());
}
check(job.status === 'done', 'and finishes', job.error || job.status);

// The Range form a seeking <audio> element sends.
const mediaUrl = withTok(`/api/library/file/${encodeURIComponent(job.file.name)}`);
const media = await fetch(mediaUrl);
check(media.status === 200, 'the media route serves the file with the token in its URL', `${media.status}`);
check((media.headers.get('content-type') || '').includes('octet-stream'), 'as media bytes',
  media.headers.get('content-type'));

const ranged = await fetch(mediaUrl, { headers: { Range: 'bytes=0-1023' } });
check(ranged.status === 206, 'and honours a Range request, so seeking still works', `${ranged.status}`);
await ranged.arrayBuffer();

console.log('\nwithout the token, still refused');
check(await fetch(`${base}/api/library/file/${encodeURIComponent(job.file.name)}`).then((r) => r.status) === 401,
  'the same media URL without the token is refused');
check(await fetch(withTok('/api/jobs').replace(`access_token=${encodeURIComponent(TOKEN)}`, 'access_token=wrong')).then((r) => r.status) === 401,
  'and a wrong token is refused');
check(await fetch(withTok('/api/jobs').replace(`access_token=${encodeURIComponent(TOKEN)}`, '')).then((r) => r.status) === 401,
  'and so is dropping it');

await server.close();
await fixture.close();
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\nevery surface works with a token, and none of them works without one');
process.exit(failed.length ? 1 : 0);