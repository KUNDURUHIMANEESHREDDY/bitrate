/**
 * Regression test for prompt shutdown.
 *
 * The desktop app quits from a tray menu, so app.close() has to settle or the
 * app looks hung. Testing this with progress-stream clients is misleading:
 * those sockets close in about 2ms either way, so such a test passes with or
 * without the fix and proves nothing.
 *
 * What actually blocks a graceful close is a request that is in flight. This
 * holds one open with a half-sent HTTP request over a raw socket, which needs no
 * network, no yt-dlp and no timing luck, then measures how long close() takes.
 * With forceCloseConnections it drops the socket and returns in milliseconds;
 * without it, close() waits for the client forever.
 */
import net from 'node:net';
import { startServer } from '../server/app.js';

const PORT = 4899;
const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const server = await startServer({ port: PORT, loggerLevel: 'silent' });

// Progress-stream clients, as the UI holds. Included because they must not
// regress either, even though they were never the blocking case.
const streams = [0, 1].map(() => fetch(`${server.url}/api/events`, {
  headers: { accept: 'text/event-stream' },
}).then((r) => r.body.getReader()).catch(() => null));

await new Promise((r) => setTimeout(r, 400));

// A request that has begun but will never be answered: headers sent, no
// terminating blank line, so the server waits for more input forever.
const stalled = net.connect(PORT, '127.0.0.1');
await new Promise((resolve, reject) => {
  stalled.once('connect', resolve);
  stalled.once('error', reject);
});
stalled.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');

await new Promise((r) => setTimeout(r, 200));
check(!stalled.destroyed, 'half-sent request is still open before close');

const t0 = Date.now();
const outcome = await Promise.race([
  server.close().then(() => 'resolved', (e) => `rejected: ${e.message}`),
  new Promise((r) => setTimeout(() => r('pending'), 5000)),
]);
const ms = Date.now() - t0;

check(outcome === 'resolved', 'close() settles while a request is in flight', `${outcome} in ${ms}ms`);
check(ms < 1000, 'close() settles promptly, so the 3s backstop is never needed', `${ms}ms`);

// The stalled socket should have been destroyed rather than left dangling.
await new Promise((r) => setTimeout(r, 200));
check(stalled.destroyed, 'in-flight socket was dropped, not left open');

stalled.destroy();
for (const s of streams) { try { await s?.cancel(); } catch { /* already closed */ } }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\nshutdown behaves correctly');
process.exit(failed.length ? 1 : 0);
