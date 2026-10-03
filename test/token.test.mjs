/**
 * The credential the UI has to carry, and the paths that cannot carry it as a
 * header.
 *
 * `EventSource`, `<audio>`, `<img>` and a download link cannot set a request
 * header. When BITRATE_AUTH_TOKEN is set, every one of those therefore 401s, and
 * the app is left showing a UI that looks like a disconnected server rather than
 * an authentication failure. That is the failure these cases exist to prevent.
 *
 * The server side of the same contract is in auth.test.mjs: the query form is
 * accepted, and only for the reason described here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const results = [];
const check = (ok, what, detail = '') => {
  results.push({ ok, what });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` (${detail})` : ''}`);
};

const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

const api = read('web/src/lib/api.js');
const hook = read('web/src/hooks/useServerState.js');
const main = read('desktop/main.js');
const preload = read('desktop/preload.cjs');
const builder = read('electron-builder.yml');

console.log('the UI credential\n');

console.log('surfaces that cannot set a header');

// The SSE stream is the one that matters most: it is the progress display, and a
// UI without it still looks plausible right up until a download finishes unseen.
check(/withToken\(\s*'\/api\/events'\s*\)/.test(hook),
  'the event stream carries the token in its URL');
check(/withToken/.test(api), 'and the helper that does it is the shared one');

// Preview and download both go through fileUrl, so one change covers all three
// elements that use it.
const fileUrlLine = (api.match(/export const fileUrl[\s\S]*?;/)?.[0]) || '';
check(/withToken/.test(fileUrlLine), 'the media and download URL carries the token', fileUrlLine);

console.log('\nthe request helper');

// A header wherever a header is possible. A query parameter on an ordinary fetch
// would put the credential in every access log on the way to the server.
check(/X-Bitrate-Token/.test(api), 'an ordinary request uses a header');
const fetchCall = api.match(/await fetch\([\s\S]*?\);/)?.[0] || '';
check(/authed\(/.test(fetchCall), 'and the header is attached on the fetch itself');
check(/withToken\(path\)/.test(fetchCall),
  'while the header is preferred over appending the token to the path', fetchCall.replace(/\s+/g, ' '));

console.log('\nwhere the token comes from');

// Both sources are legitimate: the shell injects one, a person can supply the other.
check(/__BITRATE_TOKEN__/.test(api), 'the page reads an injected token');
check(/token=/.test(api), 'and accepts one from the URL fragment');
check(/location\.hash/.test(api), 'which is the fragment, not the query string');

console.log('\nthe desktop shell');

check(/preload:\s*path\.join\(here,\s*'preload\.cjs'\)/.test(main),
  'the window loads the preload bridge');
check(/#token=/.test(main), 'and the token is delivered in the fragment');
check(!/loadURL\(`\$\{server\.url\}\/\?/.test(main),
  'never in the query string, which would reach a request log');

check(/contextBridge\.exposeInMainWorld/.test(preload), 'the bridge hands over one value');
// Asserted on code rather than on prose, so the comment explaining why cannot
// satisfy it by mentioning the name.
check(!/require\(['"]electron['"]\)\s*\.\s*ipcRenderer/.test(preload)
  && !/\bipcRenderer\s*\./.test(preload),
  'and opens no message channel to ask for more');

// sandbox: true means the preload runs without Node's module loader, so ESM syntax
// here is a runtime failure rather than a style question.
check(/require\(/.test(preload), 'the preload is CommonJS, which is what a sandbox requires');
check(!/^import /m.test(preload), 'and does not use ESM syntax that would throw there');

console.log('\npackaging');

check(/desktop\/\*\*\/\*\.cjs/.test(builder),
  'the builder ships the .cjs preload, or the packaged app cannot authenticate');

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\n${failed.length} failure(s)`
  : '\nevery surface that cannot set a header has a way to carry the token');
process.exit(failed.length ? 1 : 0);