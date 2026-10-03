/**
 * Resource budgets.
 *
 * A concurrency limit on downloads is the obvious one and the least interesting:
 * it bounds the number of transfers, not the number of things a caller can ask
 * the process to do. What is actually unbounded without these is:
 *
 *   yt-dlp extractions   a child process each, launched by a POST that returns
 *                        as soon as the job is queued
 *   scrapes              a fetch, a body read into memory, and a regex over it
 *   queued jobs          a record in memory and a workspace directory
 *   event streams        a socket and a timer each, held for the life of a tab
 *
 * Most of this file is unit-level because it can then be exact: "the gate never
 * held more than N at once" is a claim about every observation, not about one
 * lucky run. The integration checks at the end confirm the wiring, since a budget
 * that is computed correctly and never called is worth nothing.
 */
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-stress-'));
process.env.BITRATE_DOWNLOAD_DIR = outputDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');
// The point of this file is the queue and the gates. The request budget is
// deliberately lifted so a flood big enough to fill the queue is not refused for
// being loud first, which would hide the thing under test. security.test.mjs
// covers the budget itself, in a process where it is the subject.
process.env.BITRATE_MAX_QUEUE_SIZE = '40';
process.env.BITRATE_RATE_CREATE = '100000';
process.env.BITRATE_RATE_DEFAULT = '200000';

const { RateLimiter, Gate, routeBudget } = await import('../server/limits.js');
const { EventHub } = await import('../server/events.js');
const { startServer } = await import('../server/app.js');
const { startFixtures, startSlowFixture, startTrickleFixture, makeBody } = await import('./fixtures.mjs');

const results = [];
let group = '';
const section = (name) => { group = name; console.log(`\n${name}`); };
const check = (ok, what, detail = '') => {
  results.push({ ok, what, group });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/* ================================================================== *
 * The gate
 * ================================================================== */

section('concurrency gate');

const gate = new Gate(3);
let live = 0;
let peak = 0;
await Promise.all(Array.from({ length: 40 }, () => gate.run(async () => {
  live += 1;
  peak = Math.max(peak, live);
  await new Promise((r) => setTimeout(r, 5));
  live -= 1;
})));
check(peak === 3, 'forty concurrent callers never exceed the limit', `peak ${peak}`);
check(gate.active === 0, 'and the gate is empty afterwards', `${gate.active} left active`);
check(gate.waiting === 0, 'with nothing left waiting', `${gate.waiting} waiting`);

const limitOfOne = new Gate(1);
const order = [];
await Promise.all([1, 2, 3].map((n) => limitOfOne.run(async () => {
  order.push(n);
  await new Promise((r) => setTimeout(r, 5));
})));
check(order.join(',') === '1,2,3', 'a gate of one serialises rather than dropping work', order.join(','));

// A failure inside must not leak a slot, or the gate silently shrinks to nothing
// after enough errors and every caller queues for ever.
const leaky = new Gate(2);
const outcomes = await Promise.allSettled([
  leaky.run(async () => { throw new Error('boom'); }),
  leaky.run(async () => 'fine'),
]);
check(outcomes[0].status === 'rejected' && outcomes[1].value === 'fine', 'a failure propagates and does not deadlock the queue');
check(leaky.active === 0, 'and releases its slot', `${leaky.active} active`);
check(await leaky.run(async () => 'still works') === 'still works', 'so the gate still admits callers');

/* ================================================================== *
 * The rate limiter
 * ================================================================== */

section('request budgets');

const limiter = new RateLimiter({ limit: 5, windowMs: 200 });
const firstFive = Array.from({ length: 5 }, () => limiter.check('client')).filter((v) => v.ok).length;
const sixth = limiter.check('client');
check(firstFive === 5, 'a client gets its allowance', `${firstFive}/5`);
check(sixth.ok === false, 'and no more than its allowance', sixth.ok ? '' : `retry in ${sixth.retryAfter}s`);
check(sixth.retryAfter > 0 && sixth.retryAfter <= 1, 'the refusal says when to come back', String(sixth.retryAfter));

const other = limiter.check('someone-else');
check(other.ok, 'one noisy client does not spend another client budget');

await new Promise((r) => setTimeout(r, 260));
check(limiter.check('client').ok, 'the budget comes back after the window');

check(routeBudget('/api/probe') < routeBudget('/api/library'), 'an extraction costs less budget than a listing');
check(routeBudget('/api/scrape') < routeBudget('/api/library'), 'and so does a scrape');
check(routeBudget('/api/downloads') < routeBudget('/api/library'), 'and so does creating a job');

/* ================================================================== *
 * The event hub
 * ================================================================== */

section('event hub ceiling');

const capped = new EventHub({ max: 2 });
const fakeResponse = () => {
  const handlers = {};
  return {
    writeHead() {},
    write() {},
    end() {},
    on(evt, fn) { handlers[evt] = fn; },
    emit: (evt) => handlers[evt]?.(),
  };
};
check(capped.addClient(fakeResponse()) !== null, 'a client is accepted below the ceiling');
check(capped.addClient(fakeResponse()) !== null, 'and the next one too');
check(capped.addClient(fakeResponse()) === null, 'and the one past it is refused');
check(capped.size === 2, 'the refused one is not counted', `${capped.size}`);

capped.broadcast('job', { a: 1 });
check(capped.size === 2, 'broadcasting keeps everyone');

// A dropped socket has to release its slot, or a tab that closed slowly would
// eventually lock every other tab out of progress updates.
capped.closeAll();
check(capped.size === 0, 'closing releases every slot', `${capped.size}`);

/* ================================================================== *
 * Wiring
 * ================================================================== */

section('integration');

const srv = await startServer({ port: 0, loggerLevel: 'silent' });
const post = (route, body) => fetch(`${srv.url}${route}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

const health = await fetch(`${srv.url}/api/health`).then((r) => r.json());
check(health.limits.maxQueueSize > 0 && health.limits.maxConcurrentProbes > 0 && health.limits.maxConcurrentScrapes > 0,
  'the budgets are reported rather than hidden');

// A real scrape against a real fixture, so the gate is doing actual work.
const fixture = await startFixtures({
  body: makeBody(2048),
  tokenPage: '<html><head><source src="__MEDIA__"></head></html>',
});
const scrapes = await Promise.all(Array.from({ length: 12 }, () => post('/api/scrape', { url: fixture.pageUrl })));
check(scrapes.filter((r) => r.status === 200).length > 0, 'concurrent scrapes still succeed', `${scrapes.filter((r) => r.status === 200).length}/12 ok`);
await fixture.close();

// The queue ceiling is enforced where jobs are created, so it holds however the
// jobs arrive. 200 by default, so this asks for more than that.
const ceiling = health.limits.maxQueueSize;
const created = [];
let refused = 0;
for (let i = 0; i < ceiling + 10; i += 1) {
  const res = await post('/api/downloads', { url: 'http://127.0.0.1:1/never', title: `flood-${i}` });
  if (res.status === 429) { refused += 1; break; }
  created.push(res.body.id);
}
check(refused === 1, 'the queue refuses work past its ceiling', `${created.length} accepted, then refused`);
check(health.queue.maxQueueSize === ceiling, 'and reports the ceiling it enforced');

// The flood is still mostly queued, which is right: "clear finished" means
// finished, and cancelling someone else's job for them would be worse than the
// problem. Cancelling them one at a time has to release the capacity.
let cancelled = 0;
for (const id of created) {
  const res = await fetch(`${srv.url}/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => null);
  if (res?.status === 200) cancelled += 1;
}
check(cancelled === created.length, 'every flooded job can be cancelled', `${cancelled}/${created.length}`);

const afterClear = await fetch(`${srv.url}/api/health`).then((r) => r.json());
check(afterClear.queue.queued === 0, 'and cancelling them empties the queue', `${afterClear.queue.queued} left`);

// With the queue empty the ceiling has to open again, or a refusal is permanent.
const reopen = await post('/api/downloads', { url: 'http://127.0.0.1:1/never', title: 'after-clear' });
check(reopen.status === 200 && Boolean(reopen.body.id), 'and a freed queue accepts work again', `got ${reopen.status}`);
await fetch(`${srv.url}/api/jobs/${reopen.body.id}/cancel`, { method: 'POST' }).catch(() => {});

const maxConcurrent = health.queue.maxConcurrent;

// Cancelling a job that never started should not leave a workspace behind: there
// are no bytes in it to resume from. Cancelling one that was mid-transfer should,
// because those bytes are the thing a re-run resumes from.
//
// The two states are produced deliberately rather than caught in the act: an
// origin that accepts the connection and then says nothing holds MAX_CONCURRENT
// jobs in `running`, and the one job past that is provably still `queued`. Letting
// this depend on how fast a URL to a dead port fails makes the assertions come and
// go with machine load.
let drained = false;
for (let i = 0; i < 100 && !drained; i += 1) {
  await new Promise((r) => setTimeout(r, 100));
  const q = await fetch(`${srv.url}/api/health`).then((r) => r.json());
  drained = q.queue.running === 0 && q.queue.queued === 0;
}
check(drained, 'the queue drains once the cancelled jobs have finished winding down');

const slow = await startSlowFixture();
const held = [];
for (let i = 0; i < maxConcurrent + 2; i += 1) {
  const r = await post('/api/downloads', {
    direct: true,
    fileUrl: slow.fileUrl,
    title: `held-${i}`,
  });
  if (r.status === 200) held.push(r.body.id);
}
check(held.length === maxConcurrent + 2, 'the flood of slow jobs is accepted', `${held.length} accepted`);

// Give the running ones a moment to actually start, rather than assuming.
let listed = [];
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 50));
  listed = await fetch(`${srv.url}/api/jobs`).then((r) => r.json());
  if (listed.filter((j) => held.includes(j.id) && j.status === 'running').length >= maxConcurrent) break;
}
const running = listed.filter((j) => held.includes(j.id) && j.status === 'running');
const queued = listed.filter((j) => held.includes(j.id) && j.status === 'queued');
check(running.length === maxConcurrent, 'exactly the concurrency budget is running', `${running.length} running`);
check(queued.length >= 1, 'and the rest are provably waiting', `${queued.length} queued`);

const workspaceGone = async (id) => {
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    if (!fs.existsSync(path.join(outputDir, 'data', 'jobs', id))) return true;
  }
  return false;
};

if (queued.length) {
  const job = queued[0];
  await fetch(`${srv.url}/api/jobs/${job.id}/cancel`, { method: 'POST' });
  check(await workspaceGone(job.id), 'cancelling a job that never started leaves no workspace behind');
  const cancelled = await fetch(`${srv.url}/api/jobs/${job.id}`).then((r) => r.json());
  check(cancelled.recoverable === false, 'and it is not advertised as resumable, because there is nothing to resume');
} else {
  check(false, 'a queued job was available to cancel');
  check(false, '  and reported as not resumable');
}

if (running.length) {
  // Free the concurrency budget first. Every slot is held by a slow job, so a new
  // one would sit queued and this case would be testing the queue rather than the
  // cancel.
  for (const id of held) {
    await fetch(`${srv.url}/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
  }
  for (let i = 0; i < 60 && (await fetch(`${srv.url}/api/jobs`).then((r) => r.json()))
    .some((j) => j.status === 'running' || j.status === 'queued'); i += 1) {
    await new Promise((r) => setTimeout(r, 100));
  }

  // The previous version of this case cancelled as soon as a job was running and
  // asserted `recoverable`, which passed for the wrong reason: the engine used to
  // delete the partial before it noticed the abort, so the flag was set on an
  // assumption nobody checked.
  //
  // The slow fixture never sends a byte, so a job against it has nothing to keep and
  // correctly reports *not* recoverable -- the honest answer, but the wrong case to
  // prove the point. This one runs against an origin that trickles, so the transfer
  // has real progress and cancelling it is a pause rather than a loss.
  const trickle = await startTrickleFixture();
  const live = await fetch(`${srv.url}/api/downloads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ direct: true, fileUrl: trickle.fileUrl, title: 'stress-trickle' }),
  }).then((r) => r.json());

  let moved = 0;
  for (let i = 0; i < 150; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    moved = (await fetch(`${srv.url}/api/jobs/${live.id}`).then((r) => r.json())).downloaded;
    if (moved > 2 * 1024 * 1024) break;
  }
  check(moved > 0, 'the trickling transfer has made real progress', `${moved} bytes`);

  await fetch(`${srv.url}/api/jobs/${live.id}/cancel`, { method: 'POST' });
  await new Promise((r) => setTimeout(r, 900));

  const cancelled = await fetch(`${srv.url}/api/jobs/${live.id}`).then((r) => r.json());
  check(cancelled.status === 'cancelled', 'cancelling it stops it', cancelled.status);
  check(cancelled.recoverable === true,
    'and it is resumable, because it kept the bytes it had', String(cancelled.recoverable));

  // The claim and the disk have to agree. An empty workspace directory is not a
  // resume opportunity, which is what made the old assertion meaningless.
  const workspace = path.join(outputDir, 'data', 'jobs', live.id);
  check(fs.existsSync(workspace), 'its workspace survives the cancel');
  const kept = fs.existsSync(workspace)
    ? fs.readdirSync(workspace).filter((n) => /\.(part|ytdl)$/i.test(n))
    : [];
  check(kept.length > 0, 'and holds a partial file', kept.join(', ') || 'none');

  await trickle.close();
} else {
  check(false, 'a running job was available to cancel');
}

for (const id of held) await fetch(`${srv.url}/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
await slow.close();

await srv.close();
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} budget checks pass`);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  ${f.group}: ${f.what}`);
}
process.exit(failed.length ? 1 : 0);