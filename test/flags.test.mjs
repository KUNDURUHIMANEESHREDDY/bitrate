/**
 * Each external tool has its own version flag, and using the wrong one reports the
 * tool missing when it is installed.
 *
 * `scripts/doctor.js` probes aria2c with `--version` after a fix, but
 * `scripts/setup.js` probed both ffmpeg and aria2c with `-version`. aria2c parses
 * the single-dash form as a cluster of single-letter flags and exits 28, so setup
 * always printed `missing aria2c`. ffmpeg uses the opposite convention and fails on
 * `--version`. There is no shared spelling, so both must be named per tool.
 *
 * This test pins the fact itself, so a future refactor that "simplifies" the two
 * loops back into one with a single spelling fails immediately, and it does so by
 * asking real binaries rather than by trusting a string literal.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SETUP = readFileSync(path.join(ROOT, 'scripts', 'setup.js'), 'utf8');
const DOCTOR = readFileSync(path.join(ROOT, 'scripts', 'doctor.js'), 'utf8');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0
  || spawnSync(cmd, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;

console.log('the version-flag convention\n');

console.log('against the real binaries');

const ffmpegPresent = has('ffmpeg');
const aria2cPresent = has('aria2c');

if (ffmpegPresent) {
  const short = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true }).status;
  check(short === 0, 'ffmpeg accepts -version');
} else {
  console.log('  skip  ffmpeg not installed, so its convention cannot be exercised');
}

if (aria2cPresent) {
  const short = spawnSync('aria2c', ['-version'], { stdio: 'ignore', windowsHide: true }).status;
  const long = spawnSync('aria2c', ['--version'], { stdio: 'ignore', windowsHide: true }).status;
  check(short !== 0, 'aria2c refuses -version, so the old code reported it missing', `exit ${short}`);
  check(long === 0, 'and aria2c only accepts --version');
} else {
  console.log('  skip  aria2c not installed, so its convention cannot be exercised');
}

console.log('\nin the scripts');

// The setup script must name the flag each tool accepts. Both tools now have their
// own spelling, named per tuple, so this asserts the two are not collapsed.
check(/\['ffmpeg',[^\]]*'-version'\]/.test(SETUP.replace(/\s+/g, ' ')),
  'setup.js asks ffmpeg with -version');
check(/\['aria2c',[^\]]*'--version'\]/.test(SETUP.replace(/\s+/g, ' ')),
  'setup.js asks aria2c with --version');

// Doctor.js was fixed the same way; the two must not drift back into disagreement.
check(/'--version'/.test(DOCTOR), 'doctor.js also uses --version for aria2c');

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\neach tool is asked the flag it understands');
process.exit(failed.length ? 1 : 0);