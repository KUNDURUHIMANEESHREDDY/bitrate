#!/usr/bin/env node
/** Report whether every external tool the app depends on is present. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const isWin = process.platform === 'win32';
const bindir = isWin ? 'Scripts' : 'bin';
const VENV = process.env.BITRATE_VENV || path.join(ROOT, '.venv');

const check = (label, cmd, args, { required, path: p } = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'pipe', shell: false });
  const ok = r.status === 0;
  const value = ok ? (r.stdout || '').toString().split('\n')[0].trim().slice(0, 60) : null;
  const mark = ok ? 'ok  ' : required ? 'FAIL' : 'warn';
  console.log(`  [${mark}] ${label.padEnd(10)} ${value || (required ? 'not found' : 'not found (optional)')}`);
  if (p) console.log(`           at ${p}`);
  return ok;
};

console.log('Bitrate environment check\n');

const ytdlp = path.join(VENV, bindir, isWin ? 'yt-dlp.exe' : 'yt-dlp');
check('yt-dlp', fs.existsSync(ytdlp) ? ytdlp : 'yt-dlp', ['--version'], { required: true, path: ytdlp });
check('ffmpeg', 'ffmpeg', ['-version'], { required: true });
// Two dashes. aria2c parses `-version` as a cluster of single-letter flags and
// exits 28, so a single dash here reports aria2c as missing even when installed.
check('aria2c', 'aria2c', ['--version'], { required: false });

const py = path.join(VENV, bindir, isWin ? 'python.exe' : 'python');
console.log(`  [${fs.existsSync(py) ? 'ok  ' : 'FAIL'}] python    ${fs.existsSync(py) ? 'venv present' : 'run: npm run setup'}`);

const dist = path.join(ROOT, 'web', 'dist', 'index.html');
console.log(`  [${fs.existsSync(dist) ? 'ok  ' : 'warn'}] ui        ${fs.existsSync(dist) ? 'built' : 'not built, run: npm run build'}`);

const dl = process.env.BITRATE_DOWNLOAD_DIR || path.join(ROOT, 'downloads');
console.log(`  [ok  ] downloads ${dl}`);

// The security posture, reported rather than left for the reader to infer from a
// set of environment variables. A misconfigured instance is the case worth
// catching here, because nothing else complains about it.
const { NETWORK_POLICY, HOST, AUTH_TOKEN, MAX_QUEUE_SIZE, MAX_SCRAPE_BYTES } =
  await import('../server/config.js');
const { isLoopbackBind } = await import('../server/auth.js');

console.log('\nSecurity posture');
const policyNote = {
  lan: 'loopback and private addresses allowed (a NAS or local server is a valid source)',
  strict: 'public addresses only',
  open: 'no address filtering',
}[NETWORK_POLICY];
const policyWarn = NETWORK_POLICY === 'open' ? 'warn' : 'ok';
console.log(`  [${policyWarn}] outbound ${NETWORK_POLICY.padEnd(7)} ${policyNote}`);

const loopback = isLoopbackBind(HOST);
console.log(`  [${loopback || AUTH_TOKEN ? 'ok' : 'FAIL'}] bind      ${HOST}`
  + (loopback ? ' (loopback only)' : AUTH_TOKEN ? ' (network, token required)' : ' (network, NO TOKEN)'));

if (AUTH_TOKEN) console.log('  [ok  ] token     required on every /api request');
else console.log('  [ok  ] token     not needed on a loopback bind');
console.log(`  [ok  ] budgets   queue ${MAX_QUEUE_SIZE}, scrape ${Math.round(MAX_SCRAPE_BYTES / 1048576)}MB`);
