/**
 * Startup configuration.
 *
 * These are checks that happen before anything is listening, or that depend on a
 * token being configured at import time, so they cannot be exercised in-process
 * alongside a server that already started with a different environment. Each case
 * therefore runs as its own child process.
 *
 * The one that matters most is the first: the configuration that turns a local
 * app into an unauthenticated network service has to be impossible to reach by
 * accident, and the only way to know that is to actually try to start one.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
// A Windows absolute path is not a valid ESM specifier, so the child is handed a
// file URL rather than a path.
const APP_MODULE = pathToFileURL(path.join(ROOT, 'server', 'app.js')).href;

const results = [];
let group = '';
const section = (name) => { group = name; console.log(`\n${name}`); };
const check = (ok, what, detail = '') => {
  results.push({ ok, what, group });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/** Start a real server in a child process and hand back its URL. */
function launch(env = {}) {
  return new Promise((resolve, reject) => {
    const script = `
      const { startServer } = await import(${JSON.stringify(APP_MODULE)});
      try {
        const s = await startServer({ port: 0, loggerLevel: 'silent' });
        process.stdout.write('READY ' + s.port + '\\n');
      } catch (err) {
        process.stderr.write('FATAL ' + err.message + '\\n');
        process.exit(3);
      }
      setInterval(() => {}, 1 << 30);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BITRATE_DATA_DIR: path.join(ROOT, 'data'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('child never became ready')); }, 30_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /READY (\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), stderr: () => err });
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`child exited ${code}: ${err.trim()}`), { code, stderr: err }));
    });
  });
}

/** Start expecting failure, and return the message. */
function expectRefusal(env) {
  return new Promise((resolve) => {
    const script = `
      const { startServer } = await import(${JSON.stringify(APP_MODULE)});
      try {
        const s = await startServer({ port: 0, loggerLevel: 'silent' });
        process.stdout.write('STARTED ' + s.port + '\\n');
        setTimeout(() => process.exit(0), 500);
      } catch (err) {
        process.stderr.write('FATAL ' + err.message + '\\n');
        process.exit(3);
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.on('exit', (code) => resolve({ code, started: /STARTED/.test(out), message: err.trim() }));
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
  });
}

const TOKEN = 'a-long-enough-test-token-value';

/* ================================================================== *
 * The unsafe configuration has to be unreachable
 * ================================================================== */

section('a network bind is refused without a token');

for (const host of ['0.0.0.0', '::', '192.168.1.50']) {
  const r = await expectRefusal({ BITRATE_HOST: host, BITRATE_AUTH_TOKEN: '' });
  check(!r.started && r.code === 3, `${host} does not start`, `exit ${r.code}`);
  check(/BITRATE_AUTH_TOKEN/.test(r.message), `  and the message says what to set`, r.message.split('\n')[0]);
  check(/bind to 127\.0\.0\.1/.test(r.message), '  and offers the local alternative');
}

section('a loopback bind needs no token');

{
  const r = await expectRefusal({ BITRATE_HOST: '127.0.0.1', BITRATE_AUTH_TOKEN: '' });
  // It exits 0 after a moment if it started, so a refusal is code 3.
  check(r.code === 0 && r.started, '127.0.0.1 starts unauthenticated, as it always has', `exit ${r.code}`);
}

/* ================================================================== *
 * A token, when set, is enforced
 * ================================================================== */

section('a configured token is enforced');

{
  const { child, port } = await launch({ BITRATE_HOST: '0.0.0.0', BITRATE_AUTH_TOKEN: TOKEN });
  const base = `http://127.0.0.1:${port}`;
  const get = (route, headers = {}) => fetch(`${base}${route}`, { headers })
    .then((r) => r.status)
    .catch((e) => `error: ${e.message}`);

  check(await get('/api/health') === 401, 'an unauthenticated API request is refused');
  check(await get('/api/health', { authorization: 'Bearer wrong-token' }) === 401, 'a wrong token is refused');
  check(await get('/api/health', { authorization: `Bearer ${TOKEN}` }) === 200, 'the right token is accepted');
  check(await get('/api/health', { 'x-bitrate-token': TOKEN }) === 200, 'the header form works too');
  // EventSource and media elements cannot set headers, so the query form has to
  // exist or the UI breaks the moment a token is configured.
  check(await get(`/api/health?access_token=${TOKEN}`) === 200, 'the query form works, for streams that cannot set headers');
  check(await get(`/api/health?access_token=wrong`) === 401, 'a wrong query token is refused');
  // Truncating the token must not help: the compare is length-checked first.
  check(await get('/api/health', { authorization: `Bearer ${TOKEN.slice(0, -1)}` }) === 401, 'a prefix of the token is refused');

  child.kill();
}

/* ================================================================== *
 * A token on a loopback bind is still enforced
 * ================================================================== */

section('a token is enforced even on loopback');

{
  const { child, port } = await launch({ BITRATE_HOST: '127.0.0.1', BITRATE_AUTH_TOKEN: TOKEN });
  const base = `http://127.0.0.1:${port}`;
  check(await fetch(`${base}/api/health`).then((r) => r.status) === 401,
    'setting a token is taken literally, rather than being assumed unnecessary on loopback');
  check(await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((r) => r.status) === 200,
    'and the right token still works');
  child.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} startup checks pass`);
if (failed.length) {
  console.log('\nfailures:');
  for (const f of failed) console.log(`  ${f.group}: ${f.what}`);
}
process.exit(failed.length ? 1 : 0);