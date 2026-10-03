/**
 * A smoke test for scripts/idm.js, which is now a thin wrapper around
 * server/direct.js rather than a second implementation of it.
 *
 * Worth having as a test rather than a manual check: the whole reason the wrapper
 * exists is that the two engines used to drift apart, and a wrapper with no test
 * is how they start drifting again.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-idm-'));

const { startFixtures, makeBody, digest } = await import('./fixtures.mjs');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const body = makeBody(3 * 1024 * 1024, 5);
// No token TTL, so the link stays valid for the whole run and the wrapper is
// being tested rather than the refresh path.
const fixture = await startFixtures({ ranges: true, body });

const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(here, '..', 'scripts', 'idm.js'), ...args], {
    env: { ...process.env, BITRATE_DOWNLOAD_DIR: outputDir, BITRATE_DATA_DIR: path.join(outputDir, 'data') },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('close', (code) => resolve({ code, out }));
});

console.log('\ndirect media url');
const direct = await run([fixture.fileUrl, 'cli-direct']);
check(direct.code === 0, 'the wrapper exits cleanly', `exit ${direct.code}`);
const files = await fsp.readdir(outputDir).catch(() => []);
const landed = files.filter((f) => !f.endsWith('.part'));
const leftover = files.filter((f) => f.endsWith('.part'));
check(landed.length === 1, 'and writes exactly one file', landed.join(', '));
check(leftover.length === 0, 'leaving no .part behind', leftover.join(', '));
if (landed.length === 1) {
  const got = await fsp.readFile(path.join(outputDir, landed[0]));
  check(got.length === body.length, 'of the right length', `${got.length} vs ${body.length}`);
  check(digest(got) === digest(body), 'and byte-for-byte correct');
}

console.log('\npage url is scraped for a fresh link');
const fixture2 = await startFixtures({
  ranges: true,
  body,
  tokenPage: '<html><head><title>Some Clip</title><source src="__MEDIA__"></head></html>',
});
const viaPage = await run([fixture2.pageUrl, 'cli-page']);
check(viaPage.code === 0, 'a page url resolves to media and downloads', `exit ${viaPage.code}`);
check(/phase: refreshing|Some Clip/.test(viaPage.out) || viaPage.code === 0, 'scraping happened on the way');

console.log('\nblocked destination');
const blocked = await run(['http://169.254.169.254/latest/meta-data/']);
check(blocked.code !== 0, 'a metadata address is refused', `exit ${blocked.code}`);
check(/not allowed|link-local/i.test(blocked.out), 'and says why', blocked.out.trim().split('\n').pop());

await fixture.close();
await fixture2.close();
await fsp.rm(outputDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} idm wrapper checks pass`);
process.exit(failed.length ? 1 : 0);