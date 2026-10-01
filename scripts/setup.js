#!/usr/bin/env node
/**
 * First-run bootstrap: create the venv, install yt-dlp into it, make the
 * download folder. Safe to re-run; every step is a no-op when already done.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
// The desktop build keeps its venv in the user profile, because a packaged
// app's own directory is read-only. Both locations are overridable so this
// script and the server always agree on where the tools are.
const VENV = process.env.BITRATE_VENV || path.join(ROOT, '.venv');
const DOWNLOADS = process.env.BITRATE_DOWNLOAD_DIR || path.join(ROOT, 'downloads');
const DATA = process.env.BITRATE_DATA_DIR || path.join(ROOT, 'data');
const isWin = process.platform === 'win32';
const PY = isWin ? path.join(VENV, 'Scripts', 'python.exe') : path.join(VENV, 'bin', 'python');
const YTDLP = isWin ? path.join(VENV, 'Scripts', 'yt-dlp.exe') : path.join(VENV, 'bin', 'yt-dlp');

const log = (...a) => console.log('[setup]', ...a);
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });

function findPython() {
  for (const c of ['python3', 'python', 'py']) {
    const r = spawnSync(c, ['--version'], { stdio: 'ignore', shell: false });
    if (r.status === 0) return c;
  }
  return null;
}

log('root:', ROOT);

if (!fs.existsSync(PY)) {
  const py = findPython();
  if (!py) {
    console.error('[setup] No Python 3 found. Install Python 3.9+ and run this again.');
    process.exit(1);
  }
  log(`creating venv with ${py}`);
  const r = run(py, ['-m', 'venv', VENV]);
  if (r.status !== 0) { console.error('[setup] venv creation failed'); process.exit(1); }
} else {
  log('venv already exists');
}

log('installing yt-dlp');
const r = run(PY, ['-m', 'pip', 'install', '--upgrade', 'pip', 'yt-dlp']);
if (r.status !== 0) { console.error('[setup] pip install failed'); process.exit(1); }

const v = run(YTDLP, ['--version'], { stdio: 'pipe' });
log('yt-dlp version:', (v.stdout || '').toString().trim());

for (const d of [DOWNLOADS, DATA, VENV]) {
  fs.mkdirSync(d, { recursive: true });
  log('ensured', d);
}

for (const [bin, label] of [['ffmpeg', 'ffmpeg (needed to merge video and audio)'],
                            ['aria2c', 'aria2c (optional, faster transfers)']]) {
  const found = run(bin, ['-version'], { stdio: 'ignore' }).status === 0;
  log(`${found ? 'found   ' : 'missing '} ${label}`);
}

log('');
log('Setup done. Start the app with: npm run build && npm start');
