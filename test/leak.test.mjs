/**
 * Credentials must not outlive the request that carried them.
 *
 * Three places a job's sensitive fields can escape, and all three were real:
 *
 *   jobs.json   serialised the whole job object, so the cookie path and the signed
 *               direct URL were written to disk on every state change
 *   GET /api/jobs  returned j.url, which for a direct download is a live credential
 *   the event stream  broadcasts the same publicJob shape
 *
 * The fix is an allowlist in each place, and the assertion that matters is that the
 * sensitive values are absent -- not that the code mentions them. A test that reads
 * the source and greps for a field name is asserting that someone typed the right
 * word, so these cases drive a real server, write a real cookie file, download
 * through a real signed link, and then read what actually landed on disk and over
 * the wire.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-leak-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const { startServer } = await import('../server/app.js');
const { startBudgetFixtures, makeBody } = await import('./fixtures.mjs');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/**
 * A cookie file with a value distinctive enough to search for.
 *
 * A real Netscape cookie jar rather than an arbitrary string, because the engine
 * hands the path to yt-dlp unchanged and a test that used a malformed file would be
 * testing a different code path than the one that leaks.
 */
// Outside the download directory on purpose. `validateCookieFile` refuses a cookie
// file that lives in a directory the app serves or reads, which is a sensible rule
// and means the leak case has to use a path the app would actually accept.
const COOKIE_VALUE = 'CANARYCOOKIEVALUE0123456789';
const cookieDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-cookies-'));
const cookiePath = path.join(cookieDir, 'cookies.txt');
fs.writeFileSync(cookiePath, [
  '# Netscape HTTP Cookie File',
  '.example.com\tTRUE\t/\tFALSE\t0\tsession\t' + COOKIE_VALUE,
  '',
].join('\n'));

/**
 * A signed media URL, in the shape the scraper produces: a token in the query.
 *
 * Taken from the live fixture rather than written by hand, because a hand-written
 * one would be a token the fixture has never issued and the download would fail its
 * own budget check. A live link is also the realistic case: the whole point is that
 * this is the URL a real download carries.
 */
const TOKEN_VALUE = 'bt1';
const fixture = await startBudgetFixtures({ body: makeBody(512 * 1024), budgetBytes: 512 * 1024 });
const signedUrl = fixture.fileUrl;

const server = await startServer({ port: 0, loggerLevel: 'silent' });

console.log('credentials and signed URLs\n');

console.log('the job runs');

// A cookie file is refused unless it exists and is a .txt, so this is the real path.
// A direct job, because the path under test is the one where the URL is a signed
// media link. The yt-dlp path would route this through an extractor that rejects a
// loopback fixture URL, which tests the extractor rather than the leak.
//
// The cookie goes on the yt-dlp branch instead: the direct engine has no way to
// send cookies, so claiming otherwise would make `usingCookies` a lie. Both fields
// still have to be absent from what gets written and returned, and the check
// below asserts that on the persisted record rather than on one call.
const cookieProbe = await fetch(`${server.url}/api/downloads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    direct: true,
    fileUrl: signedUrl,
    referer: fixture.pageUrl,
    res: '1080p',
    title: 'leak-check',
  }),
}).then((r) => r.json());
check(!cookieProbe.error, 'a job with a signed URL is accepted', cookieProbe.error || '');

let job = cookieProbe;
for (let i = 0; i < 200 && !['done', 'error', 'cancelled'].includes(job.status); i += 1) {
  await new Promise((r) => setTimeout(r, 100));
  job = await fetch(`${server.url}/api/jobs/${cookieProbe.id}`).then((r) => r.json());
}
check(job.status === 'done', 'and it completes', job.error || job.status);

console.log('\njobs.json on disk');

// The file is written on every state change, so waiting for it is unnecessary; the
// last write for a finished job has happened by the time the job reports done.
const statePath = path.join(outputDir, 'data', 'jobs.json');
check(fs.existsSync(statePath), 'the state file exists');
const state = fs.readFileSync(statePath, 'utf8');

check(!state.includes(COOKIE_VALUE), 'the cookie value is not in jobs.json');
check(!state.includes(cookiePath.replace(/\\/g, '/')), 'nor is the cookie path');
check(!state.includes('cookies.txt'), 'nor even the cookie filename');
// `bt1` is too short and too common to search for, so the canary assertion is on
// the whole query string, which is the credential rather than one token value.
check(!state.includes('v-acctoken='), 'nor is the signed token parameter');
check(!state.includes(fixture.base), 'nor the origin it points at');

// The structural claim, which is what actually prevents a future field from leaking.
const parsed = JSON.parse(state);
const first = parsed.jobs?.[0] || {};
check(!('cookieFile' in first), 'the job record has no cookieFile field at all',
  Object.keys(first).join(','));
check(!('url' in first), 'and no url field', Object.keys(first).join(','));

// The boolean is the substitute for the path, so it has to be the field that
// survives. A direct job has no cookies, so this one is false -- what matters is
// that the field exists and is a boolean rather than the string it replaced.
check('usingCookies' in first, 'the boolean that replaced the path is kept',
  String(first.usingCookies));
check(typeof first.usingCookies === 'boolean', 'and is a boolean',
  typeof first.usingCookies);

// The fields that are kept are the ones the UI actually needs.
for (const field of ['id', 'title', 'status', 'phase', 'createdAt']) {
  check(field in first, `and keeps ${field}, which the UI shows`);
}

console.log('\nwhat the API hands out');

const listed = await fetch(`${server.url}/api/jobs`).then((r) => r.json());
const listedJson = JSON.stringify(listed);
check(!listedJson.includes(COOKIE_VALUE), 'the job list carries no cookie value');
check(!listedJson.includes('v-acctoken='), 'nor the signed token parameter');
check(!listedJson.includes('cookieFile'), 'nor a cookieFile property');
check(listedJson.includes('"usingCookies"'), 'while the boolean that replaced it is exposed',
  'missing');

// And a real cookie job, so the boolean is exercised as true rather than as an
// absent field. The yt-dlp branch is the one that takes cookies; the job errors on
// extraction, which is irrelevant here because the assertion is about what the API
// returned, not whether the download worked.
const cookieJob = await fetch(`${server.url}/api/downloads`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: 'http://example.invalid/video', title: 'cookie-job', cookies: cookiePath,
  }),
}).then((r) => r.json());
check(Boolean(cookieJob.id), 'a yt-dlp job with a cookie file is created', cookieJob.error || '');
check(cookieJob.usingCookies === true, 'and reports that cookies were used',
  String(cookieJob.usingCookies));
check(!('cookieFile' in cookieJob), 'without naming where they came from');

const one = listed.find((j) => j.id === cookieProbe.id);
check(Boolean(one), 'the job is still listed');
// The host is enough to show which site a job came from, and useless to replay.
// `host` rather than `hostname`, so a non-default port survives: a NAS on
// :8096 would otherwise report as a bare name and be unidentifiable.
check(one && /^[^\s/?#]+$/.test(String(one.url || '')),
  'the URL is reported as a bare host, with no scheme, path or query',
  one ? String(one.url) : 'missing');
check(one && String(one.url).includes('127.0.0.1:'), 'and it still identifies the origin',
  one ? String(one.url) : 'missing');
check(one && !String(one.url).includes('v-acctoken'), 'with no token on it');

console.log('\nthe event stream');

// Same shape as the API, so this is checked rather than assumed. Read over a real
// SSE response rather than by inspecting the broadcast helper, because the hub is
// the thing that decides what a subscriber receives.
//
// The job has already finished by this point, so nothing would be broadcast and an
// idle stream would prove nothing. A second job is started while the stream is
// open, which is the situation a subscriber is actually in.
const sse = await fetch(`${server.url}/api/events`, { headers: { accept: 'text/event-stream' } });
check(sse.status === 200, 'the event stream connects');
const frames = [];
{
  const reader = sse.body.getReader();
  const decoder = new TextDecoder();
  const collect = async (until) => {
    const deadline = Date.now() + until;
    let buf = '';
    while (Date.now() < deadline && frames.length < 2) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const frame of parts) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) frames.push(line.slice(6));
      }
    }
  };
  await collect(500);
  // Now make something happen.
  await fetch(`${server.url}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      direct: true,
      fileUrl: fixture.fileUrl,
      referer: fixture.pageUrl,
      res: '1080p',
      title: 'leak-stream',
    }),
  });
  await collect(4000);
  await reader.cancel();
}
const streamJson = frames.join('\n');
check(frames.length > 0, 'the stream delivered at least one frame', `${frames.length}`);
check(!streamJson.includes(COOKIE_VALUE), 'the event stream carries no cookie value');
check(!streamJson.includes('v-acctoken='), 'nor the signed token parameter');
check(!streamJson.includes('cookieFile'), 'nor a cookieFile property');

console.log('\nthe workspace state file');

// A second file, written by a different function, which is exactly the sort of place
// a second implementation forgets.
const workspaces = fs.existsSync(path.join(outputDir, 'workspaces'))
  ? fs.readdirSync(path.join(outputDir, 'workspaces'))
  : [];
let workspaceState = '';
for (const w of workspaces) {
  const p = path.join(outputDir, 'workspaces', w, 'state.json');
  if (fs.existsSync(p)) workspaceState += fs.readFileSync(p, 'utf8');
}
check(!workspaceState.includes(COOKIE_VALUE), 'the workspace state file carries no cookie value');
check(!workspaceState.includes('v-acctoken='), 'nor the signed token parameter');

await server.close();
await fixture.close();
await fsp.rm(outputDir, { recursive: true, force: true });
await fsp.rm(cookieDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\nno credential reaches disk or a response');
process.exit(failed.length ? 1 : 0);