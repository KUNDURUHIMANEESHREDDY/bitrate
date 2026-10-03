/**
 * Promotion: claiming a name in the library.
 *
 * The library is a flat directory, so every finished download has to pick a name
 * that is not already taken. Doing that correctly means the claim and the decision
 * are the same filesystem operation, because the two halves of "does this name
 * exist?" followed by "rename onto it" can be separated by anything at all —
 * another job finishing in the same instant being the ordinary case rather than
 * the exotic one.
 *
 * When they are separated, the failure is silent rather than loud. Both callers
 * pass the check, both are told they succeeded, and both are handed the same name.
 * Only one file is on disk afterwards. Every job believes it worked, the library
 * shows one entry, and the downloads that were replaced leave no trace anywhere
 * that says otherwise. Nothing about the reported result is wrong from any single
 * job's point of view, which is exactly why this needs a test that looks at the
 * directory rather than at the return values.
 *
 * These cases therefore check bytes on disk and who each file belongs to, not the
 * shape of the answer.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const outputDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bitrate-promote-'));
const downloadDir = path.join(outputDir, 'downloads');
process.env.BITRATE_DOWNLOAD_DIR = downloadDir;
process.env.BITRATE_DATA_DIR = path.join(outputDir, 'data');

const { promote, ensureWorkspace } = await import('../server/workspace.js');

// The app creates these at startup; importing the module does not, so a test that
// points them somewhere new has to make them itself.
await fsp.mkdir(downloadDir, { recursive: true });
await fsp.mkdir(path.join(outputDir, 'data'), { recursive: true });

const results = [];
let group = '';
const section = (name) => { group = name; console.log(`\n${name}`); };
const check = (ok, what, detail = '') => {
  results.push({ ok, what, group });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

/**
 * A finished artifact in a workspace of its own.
 *
 * Every file is filled with a single repeated byte, so the contents identify which
 * job produced them. Two interchangeable files would let a promotion hand back the
 * right name and still have quietly lost a download, and a test could not tell.
 */
async function artifact(byte, size = 4096, name = 'clip.mp4') {
  const dir = await ensureWorkspace(crypto.randomUUID());
  const full = path.join(dir, name);
  fs.writeFileSync(full, Buffer.alloc(size, byte));
  return { name, full, size };
}

/** What is actually in the library, and whose bytes each file holds. */
function libraryContents() {
  const out = new Map();
  for (const name of fs.readdirSync(downloadDir)) {
    const bytes = fs.readFileSync(path.join(downloadDir, name));
    out.set(name, bytes[0]);
  }
  return out;
}

console.log('promotion\n');

/* ------------------------------------------------------------------ *
 * The race, which is the whole reason this file exists
 * ------------------------------------------------------------------ */

section('several jobs finishing at the same moment');

const COUNT = 8;
const artifacts = [];
for (let i = 0; i < COUNT; i += 1) artifacts.push(await artifact(65 + i));

// All of them want the same library name, and all of them are released together.
// Nothing coordinates them: that is the situation, not an artificial one.
const settled = await Promise.allSettled(
  artifacts.map((a) => promote(a, { title: 'Same Title' })),
);

const failed = settled.filter((s) => s.status === 'rejected');
check(failed.length === 0, 'every one of them is promoted rather than losing or throwing',
  failed.length ? failed.map((f) => f.reason.code || f.reason.message).join('; ') : '');

const entries = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
const distinctNames = new Set(entries.map((e) => e.name));
check(distinctNames.size === COUNT, 'and each is given a name of its own',
  `${distinctNames.size} distinct of ${COUNT}`);

const onDisk = libraryContents();
check(onDisk.size === COUNT, 'with one file per download actually on disk',
  `${onDisk.size} file(s): ${[...onDisk.keys()].join(', ')}`);

// The decisive check. Distinct names are necessary but not sufficient: a name can
// be unique and still hold the wrong download's bytes.
const mismatched = entries.filter((e) => {
  const byte = onDisk.get(e.name);
  return byte === undefined || byte !== fs.readFileSync(e.full)[0];
});
check(mismatched.length === 0, 'and each file holds its own download, none overwritten',
  mismatched.length ? mismatched.map((e) => e.name).join(', ') : '');

const survivors = new Set([...onDisk.values()]);
check(survivors.size === COUNT, 'so every byte pattern that went in came out',
  `${survivors.size} of ${COUNT} distinct contents in the library`);

const leftovers = artifacts.filter((a) => fs.existsSync(a.full));
check(leftovers.length === 0, 'and no workspace is left holding a promoted artifact',
  `${leftovers.length} leftover(s)`);

/* ------------------------------------------------------------------ *
 * The ordinary case, which must not have changed
 * ------------------------------------------------------------------ */

section('promotions one at a time');

for (const name of fs.readdirSync(downloadDir)) {
  fs.rmSync(path.join(downloadDir, name));
}

const first = await promote(await artifact(90), { title: 'Sequential' });
check(first.name === 'Sequential.mp4', 'the first promotion takes the name as asked',
  first.name);
check(fs.existsSync(first.full), 'and the file is there');

const second = await promote(await artifact(91), { title: 'Sequential' });
check(second.name === 'Sequential (1).mp4', 'the next one is numbered rather than replacing it',
  second.name);
check(fs.existsSync(second.full), 'and its file is there too');

const after = libraryContents();
check(after.get(first.name) === 90 && after.get(second.name) === 91,
  'with each keeping its own contents', `${after.get(first.name)} / ${after.get(second.name)}`);
check(after.size === 2, 'and nothing extra appeared', `${after.size} file(s)`);

/* ------------------------------------------------------------------ *
 * What a collision is not allowed to do
 * ------------------------------------------------------------------ */

section('a collision never disturbs what is already there');

const baseline = libraryContents().size;
const victim = await promote(await artifact(120), { title: 'Untouched' });
const before = fs.readFileSync(victim.full);

for (let i = 0; i < 3; i += 1) await promote(await artifact(121 + i), { title: 'Untouched' });

const afterCollision = fs.readFileSync(victim.full);
check(Buffer.compare(before, afterCollision) === 0,
  'the file already in the library is byte-identical afterwards',
  `${before.length} bytes`);
check(victim.name === 'Untouched.mp4', 'and kept the name it was given', victim.name);
check(libraryContents().size === baseline + 4,
  'while the newcomer and its three collisions took four names of their own',
  [...libraryContents().keys()].join(', '));

// A title that already carries its own extension must not produce `x.mp4.mp4`,
// and must still not collide with the file it names.
const noDoubleExt = await promote(await artifact(130, 4096, 'song.mp3'), { title: 'Song' });
check(noDoubleExt.name === 'Song.mp3', 'a title takes the artifact extension, not a second one',
  noDoubleExt.name);

await fsp.rm(outputDir, { recursive: true, force: true });

const failedChecks = results.filter((r) => !r.ok);
console.log(failedChecks.length
  ? `\n${failedChecks.length} failure(s)`
  : '\na name in the library is claimed in one operation, so no download can be replaced by another');
process.exit(failedChecks.length ? 1 : 0);