/**
 * Tray menu policy.
 *
 * The menu is the app's only always-available surface, so a mis-wired or
 * mislabelled item is invisible until someone clicks it. These checks assert
 * both the labels (matched by prefix, so a stray non-ASCII character in a
 * source file cannot silently break the suite) and that every item invokes the
 * action it advertises.
 */
import { buildTrayMenu } from '../desktop/tray-menu.js';

const results = [];
const check = (ok, what) => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`);
};

const calls = [];
const actions = {
  open: () => calls.push('open'),
  grabClipboard: () => calls.push('grabClipboard'),
  cancelAll: () => calls.push('cancelAll'),
  revealDownloads: () => calls.push('revealDownloads'),
  copyServerUrl: () => calls.push('copyServerUrl'),
  installDependencies: () => calls.push('installDependencies'),
  openLogs: () => calls.push('openLogs'),
  quit: () => calls.push('quit'),
};

/** Find by prefix so the ellipsis in the real label cannot break a lookup. */
const byPrefix = (items, prefix) => items.find((i) => typeof i.label === 'string' && i.label.startsWith(prefix));
const byExact = (items, text) => items.find((i) => i.label === text);

const idle = {
  active: [], clipboardUrl: null, depsOk: true, setupRunning: false, downloadDir: 'C:/d',
};
const busy = {
  active: [
    { id: 'a', title: 'A very long video title that should be truncated somewhere', status: 'running', percent: 42.3, downloaded: 1024, url: 'u' },
    { id: 'b', title: 'Queued one', status: 'queued', percent: 0, downloaded: 0, url: 'u' },
  ],
  clipboardUrl: 'https://example.com/v',
  depsOk: false, setupRunning: false, downloadDir: 'C:/d',
};

console.log('idle state');
let m = buildTrayMenu(idle, actions, 'Bitrate');
check(!!byExact(m, 'Idle'), 'shows Idle when nothing is running');
check(byExact(m, 'Idle').enabled === false, 'Idle is not clickable');
check(!byPrefix(m, 'Install'), 'no install item when dependencies are fine');
check(byExact(m, 'No link in clipboard').enabled === false, 'clipboard item disabled with no link');
check(!!byExact(m, 'Quit Bitrate'), 'Quit item present');
check(m[m.length - 1].label === 'Quit Bitrate', 'Quit is the last item');

console.log('\nbusy, and dependencies missing');
m = buildTrayMenu(busy, actions, 'Bitrate');
check(!!byExact(m, 'In progress (2)'), 'shows the active count');
check(byExact(m, 'Download link from clipboard').enabled === true, 'clipboard item enabled with a link');
const install = byPrefix(m, 'Install');
check(!!install, 'install item shown when dependencies are missing');
check(install && install.enabled === true, 'install item clickable while idle');
const rows = byExact(m, 'In progress (2)').submenu;
check(rows.some((i) => i.label.includes('42%')), 'job row carries the percentage');
check(rows.some((i) => i.label.startsWith('Queued')), 'queued job distinguished from running');
check(!!byExact(rows, 'Cancel all'), 'Cancel all present');
check(rows.filter((i) => i.type !== 'separator')
  .every((i) => typeof i.label === 'string' && i.label.length > 0), 'every job row has a readable label');
check(rows.some((i) => i.label.length <= 90), 'long titles are truncated rather than overflowing the menu');

console.log('\na job with no title falls back to its url');
const untitled = buildTrayMenu({
  ...busy,
  active: [{ id: 'c', status: 'running', percent: null, downloaded: 0, url: 'https://example.com/x' }],
}, actions, 'Bitrate');
const untitledRows = byExact(untitled, 'In progress (1)').submenu;
check(untitledRows.some((i) => i.label.includes('example.com')), 'untitled job falls back to its url');

console.log('\nsetup already running');
m = buildTrayMenu({ ...busy, setupRunning: true }, actions, 'Bitrate');
check(byPrefix(m, 'Installing').enabled === false, 'install item disabled while installing');

console.log('\nwiring: invoking each advertised item');
m = buildTrayMenu(busy, actions, 'Bitrate');
for (const prefix of ['Open Bitrate', 'Download link from clipboard', 'Open downloads folder',
  'Copy server address', 'Install', 'Open log folder', 'Quit']) {
  const item = byPrefix(m, prefix);
  if (!item) { check(false, `item starting "${prefix}" exists`); continue; }
  item.click();
}
byExact(m, 'In progress (2)').submenu.find((i) => i.label === 'Cancel all').click();
const expected = ['open', 'grabClipboard', 'revealDownloads', 'copyServerUrl',
  'installDependencies', 'openLogs', 'quit', 'cancelAll'];
check(JSON.stringify(calls) === JSON.stringify(expected),
  `every item calls its own action (${calls.length}/${expected.length})`);
if (JSON.stringify(calls) !== JSON.stringify(expected)) console.log(`   got: ${calls}`);

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} failure(s)` : '\nall tray menu checks passed');
process.exit(failed.length ? 1 : 0);
