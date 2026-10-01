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
check('aria2c', 'aria2c', ['-version'], { required: false });

const py = path.join(VENV, bindir, isWin ? 'python.exe' : 'python');
console.log(`  [${fs.existsSync(py) ? 'ok  ' : 'FAIL'}] python    ${fs.existsSync(py) ? 'venv present' : 'run: npm run setup'}`);

const dist = path.join(ROOT, 'web', 'dist', 'index.html');
console.log(`  [${fs.existsSync(dist) ? 'ok  ' : 'warn'}] ui        ${fs.existsSync(dist) ? 'built' : 'not built, run: npm run build'}`);

const dl = process.env.BITRATE_DOWNLOAD_DIR || path.join(ROOT, 'downloads');
console.log(`  [ok  ] downloads ${dl}`);
