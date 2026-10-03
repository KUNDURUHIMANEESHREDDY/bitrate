import {
  app, BrowserWindow, clipboard, dialog, globalShortcut, nativeImage,
  Notification, session, shell,
} from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTray } from './tray.js';
import { runSetup } from './setup-runner.js';

/**
 * Bitrate desktop shell.
 *
 * The whole point of wrapping the server is that one process owns everything:
 * the API, the job queue, and the window that talks to it. There is no child
 * server to supervise and no port to remember, because the window loads the
 * API's own origin, so the UI's relative /api calls and the SSE progress stream
 * keep working untouched.
 *
 * The app lives in the tray. Closing the window hides it, and downloads
 * continue, which is the behaviour people expect from a download manager.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ICON = path.join(here, 'icon.png');
const HOTKEY = 'Control+Shift+B';
const POLL_MS = 2000;
const APP_ID = 'com.bitrate.desktop';

/**
 * Deliberately not the server's logger. Importing it here would pull in
 * config.js, which reads the environment once at evaluation time, before
 * configureEnvironment() has had a chance to set it.
 */
const log = (...a) => console.log('[bitrate:desktop]', ...a);

let server = null;
let win = null;
let tray = null;
let poller = null;
let quitting = false;
let state = {
  active: [], url: null, downloadDir: null, depsOk: true, clipboardUrl: null, setupRunning: false,
};
/** Last seen status per job, so completion can be detected from polling alone. */
const jobStatus = new Map();

// --- environment ------------------------------------------------------------

/**
 * Point the server at writable, user-owned directories.
 *
 * Only in a packaged build. Unpackaged, the repo's own .venv, downloads/ and
 * data/ are already correct, and silently redirecting them would mean `npm run
 * desktop` and `npm start` behaved differently. Inside an asar archive nothing
 * is writable and nothing should be hidden from the user, so the venv goes to
 * userData and videos land next to the user's own movies.
 */
function configureEnvironment() {
  if (!app.isPackaged) return;

  const userData = app.getPath('userData');
  const bindir = process.platform === 'win32' ? 'Scripts' : 'bin';
  const venv = process.env.BITRATE_VENV || path.join(userData, 'venv');
  const bin = (name) => path.join(
    venv, bindir, process.platform === 'win32' ? `${name}.exe` : name,
  );

  process.env.BITRATE_VENV = venv;
  process.env.BITRATE_PYTHON = bin('python');
  process.env.BITRATE_YTDLP = bin('yt-dlp');
  process.env.BITRATE_DATA_DIR = path.join(userData, 'data');

  // Videos first, because that is where a person looks for a download. Fall
  // back to userData when the OS reports no video directory (headless CI, some
  // Linux profiles).
  let videos = '';
  try { videos = app.getPath('videos'); } catch { /* not available */ }
  process.env.BITRATE_DOWNLOAD_DIR = videos
    ? path.join(videos, 'Bitrate')
    : path.join(userData, 'downloads');
}

// --- window -----------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 900,
    minHeight: 620,
    // The UI paints its own dark background; showing the window only once it
    // has rendered avoids a white flash on a dark app.
    show: false,
    backgroundColor: '#0a0a0f',
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: {
      // The renderer is ordinary web content served by our own loopback server.
      // It gets no Node access. The preload bridge is the one exception, and it
      // hands over a single string and nothing else: see below.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(here, 'preload.cjs'),
    },
  });

  // The token goes in the fragment, not the query string.
  //
  // A fragment is never sent to the server and never appears in a Referer header,
  // so the UI can read it without the credential being written into a request log
  // on its way to our own loopback server. Query parameters would do the same job
  // and would also work in a browser served over http, at the cost of putting a
  // full-control credential in every access log between here and there.
  const url = process.env.BITRATE_AUTH_TOKEN
    ? `${server.url}/#token=${encodeURIComponent(process.env.BITRATE_AUTH_TOKEN)}`
    : server.url;
  win.loadURL(url);

  /**
   * Show once the UI has painted, which avoids a white flash on a dark app.
   *
   * `ready-to-show` is the right signal but not a guarantee: it depends on the
   * compositor producing a frame, and a renderer that stalls (a slow first
   * paint, a GPU that hands off to software) can leave it unfired, which would
   * strand the user with a running app and no window and no error. So the
   * timer is a floor, not a duplicate: whichever arrives first shows the
   * window, and `showWindow` is idempotent.
   */
  let shown = false;
  const self = win;
  const reveal = () => {
    // `win` is module state, so a stale timer from a window that has since been
    // replaced would otherwise reveal the new one early.
    if (shown || win !== self || !self || self.isDestroyed()) return;
    shown = true;
    self.show();
  };

  /** Timers that must not outlive the window. */
  const timers = [];
  const later = (ms, fn) => { const t = setTimeout(fn, ms); timers.push(t); return t; };
  win.once('closed', () => { for (const t of timers) clearTimeout(t); });

  win.once('ready-to-show', () => { log('window ready to show'); reveal(); });
  win.webContents.once('did-finish-load', () => {
    log('window finished loading');
    // The document may still be settling, but a loaded page is close enough
    // that waiting longer only delays a window the user is waiting for.
    later(400, reveal);
  });
  win.webContents.on('did-fail-load', (_e, code, description, url) => {
    // Deliberately not fatal: the floor below still reveals the window, so a
    // server that failed to come up shows an error page instead of nothing.
    log(`window failed to load ${url}: ${description} (${code})`);
  });
  later(4000, reveal);

  // Closing hides rather than quits: a download in flight must not be killed
  // by a stray Ctrl+W.
  win.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on('closed', () => { win = null; });

  // Anything pointing off our own origin goes to the real browser. Without
  // this, a link in the library would navigate the app shell away from the UI.
  const origin = new URL(server.url).origin;
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(origin)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * A "Save" click in the library would otherwise land in the OS Downloads
 * folder, splitting finished files across two places. Ask where to put it,
 * defaulting to the app's own downloads directory.
 */
function installDownloadInterception() {
  session.defaultSession.on('will-download', (_event, item) => {
    const target = dialog.showSaveDialogSync(win ?? undefined, {
      title: 'Save file',
      defaultPath: path.join(state.downloadDir || app.getPath('downloads'), item.getFilename()),
    });
    if (target) item.setSavePath(target);
    else item.cancel();
  });
}

// --- state ------------------------------------------------------------------

const api = async (route, options) => {
  const res = await fetch(`${server.url}${route}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options?.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
};

const clipboardLink = () => {
  const text = clipboard.readText().trim();
  return /^https?:\/\/\S+$/i.test(text) ? text : null;
};

function notifyJobs(jobs) {
  if (!win || !win.isFocused()) return;
  // A visible window already narrates its own progress; don't talk over it.
  const live = new Set();
  for (const job of jobs) {
    live.add(job.id);
    const before = jobStatus.get(job.id);
    jobStatus.set(job.id, job.status);
    if (before !== 'running' && before !== 'queued') continue;

    if (job.status === 'done') {
      new Notification({
        title: 'Download finished',
        body: job.title || job.url,
        icon: nativeImage.createFromPath(ICON),
      }).show();
    } else if (job.status === 'error') {
      new Notification({
        title: 'Download failed',
        body: job.error || job.title || job.url,
        icon: nativeImage.createFromPath(ICON),
      }).show();
    }
  }
  // The job list is capped server-side, but the map is ours to keep in step:
  // without this it would remember every job the app ever ran.
  for (const id of jobStatus.keys()) {
    if (!live.has(id)) jobStatus.delete(id);
  }
}

async function refresh() {
  if (!server) return;
  try {
    const [health, jobs] = await Promise.all([api('/api/health'), api('/api/jobs')]);
    notifyJobs(jobs);
    state = {
      ...state,
      active: jobs.filter((j) => j.status === 'running' || j.status === 'queued'),
      url: server.url,
      downloadDir: health.downloadDir,
      depsOk: Boolean(health.ytdlp?.available && health.ffmpeg),
      clipboardUrl: clipboardLink(),
    };
  } catch {
    // The server is not answering yet. Keep the last good state rather than
    // blanking the tray, since this poll runs from the moment we start.
    return;
  }
  tray?.refresh(state);
}

// --- actions ----------------------------------------------------------------

async function downloadFromClipboard() {
  const url = clipboardLink();
  if (!url) {
    dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      message: 'No link in the clipboard',
      detail: 'Copy a page address first, then try again.',
      buttons: ['OK'],
    });
    return;
  }
  try {
    await api('/api/downloads', { method: 'POST', body: JSON.stringify({ url }) });
    showWindow();
    new Notification({ title: 'Download queued', body: url, icon: nativeImage.createFromPath(ICON) }).show();
    await refresh();
  } catch (err) {
    dialog.showErrorBox('Could not queue that download', err.message);
  }
}

async function cancelAll() {
  const targets = state.active.filter((j) => j.status === 'running');
  await Promise.allSettled(
    targets.map((j) => api(`/api/jobs/${j.id}/cancel`, { method: 'POST' })),
  );
  await refresh();
}

async function installDependencies() {
  if (state.setupRunning) return;
  state = { ...state, setupRunning: true };
  tray?.refresh(state);

  const answer = await dialog.showMessageBox(win ?? undefined, {
    type: 'info',
    message: 'Install the download tools?',
    detail: [
      'Bitrate needs Python 3.9+ to create a private environment, then yt-dlp inside it.',
      'ffmpeg has to be on your PATH separately, because it is a normal system install.',
      '',
      `Environment: ${process.env.BITRATE_VENV || path.join(ROOT, '.venv')}`,
    ].join('\n'),
    buttons: ['Install', 'Not now'],
    defaultId: 0,
    cancelId: 1,
  });

  if (answer.response !== 0) {
    state = { ...state, setupRunning: false };
    tray?.refresh(state);
    return;
  }

  const { code, logPath, error } = await runSetup({ root: ROOT, logDir: app.getPath('userData') });
  state = { ...state, setupRunning: false };
  await refresh();

  // The engine resolves its tools once at import time, so a fresh install only
  // becomes visible after a restart. Saying so beats showing a tray that still
  // says "missing" with no explanation.
  dialog.showMessageBox(win ?? undefined, {
    type: code === 0 ? 'info' : 'error',
    message: code === 0 ? 'Tools installed' : 'Install did not finish',
    detail: code === 0
      ? `Restart ${app.name} to pick up yt-dlp.\n\nFull log: ${logPath}`
      : `${error || `setup exited with code ${code}`}\n\nFull log: ${logPath}`,
    buttons: ['OK'],
  });
}

function registerHotkey() {
  if (!globalShortcut.register(HOTKEY, showWindow)) {
    // Another application already owns the combination. Losing it is not fatal,
    // so the tray remains the way in and the user is told once.
    dialog.showMessageBox(win ?? undefined, {
      type: 'warning',
      message: `Could not register ${HOTKEY}`,
      detail: 'Another application is already using that shortcut. The tray icon still works.',
      buttons: ['OK'],
    });
  }
}

function doQuit() {
  if (quitting) return;
  quitting = true;
  clearInterval(poller);
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;

  // Closing the server is what stops the download engines, and exiting before
  // it settles would leave .part files behind. The server is configured to drop
  // its sockets on close so this settles in milliseconds; the timer is only a
  // backstop for something unforeseen wedging the process, because an app that
  // cannot be quit is worse than one that quits abruptly.
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    app.exit(0);
  };
  if (!server) {
    done();
    return;
  }
  const backstop = setTimeout(done, 3000);
  server.close().then(done, done);
}

// --- boot -------------------------------------------------------------------

async function boot() {
  configureEnvironment();
  app.setAppUserModelId(APP_ID);

  // Imported only after the environment is set, because config.js reads these
  // variables when it is first evaluated.
  const { startServer } = await import('../server/app.js');

  server = await startServer({
    allowPortFallback: true,
    loggerLevel: 'warn',
  });
  log(`server on ${server.url}`);
  // Stated rather than assumed. A user who has pointed this at a LAN address, or
  // set a policy that lets it reach private hosts, should be able to see that in
  // the log without reading the configuration back.
  const { NETWORK_POLICY, AUTH_TOKEN } = await import('../server/config.js');
  log(`outbound policy: ${NETWORK_POLICY}`
    + (AUTH_TOKEN ? ' | api requires a token' : ' | loopback only, no token'));

  createWindow();
  installDownloadInterception();
  registerHotkey();

  tray = createTray({
    iconPath: ICON,
    appName: app.name,
    actions: {
      open: showWindow,
      grabClipboard: () => void downloadFromClipboard(),
      cancelAll: () => void cancelAll(),
      revealDownloads: () => void shell.openPath(state.downloadDir || app.getPath('downloads')),
      copyServerUrl: () => clipboard.writeText(server.url),
      installDependencies: () => void installDependencies(),
      openLogs: () => void shell.openPath(app.getPath('userData')),
      quit: doQuit,
    },
  });

  await refresh();
  poller = setInterval(() => void refresh(), POLL_MS);

  // A first run with no yt-dlp cannot download anything, so say so once, at
  // startup, instead of letting the user paste a link and hit an error.
  if (!state.depsOk) {
    new Notification({
      title: `${app.name} needs its download tools`,
      body: 'Open the tray menu to install yt-dlp.',
      icon: nativeImage.createFromPath(ICON),
    }).show();
  }
}

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  // A second launch should surface the window that is already running, not
  // start a competing server on a fallback port.
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.on('window-all-closed', () => {
    // Deliberately empty: the tray keeps the app alive on every platform.
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    const active = state.active.length;
    if (!active) {
      doQuit();
      return;
    }
    // Killing a queue silently is the kind of surprise that loses work, so ask
    // once, and let "keep running" mean exactly that: hide, do not quit.
    void dialog.showMessageBox(win ?? undefined, {
      type: 'question',
      message: active === 1 ? '1 download is still running.' : `${active} downloads are still running.`,
      detail: 'Quitting cancels them. The finished files already on disk are kept.',
      buttons: ['Keep running', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      if (response === 1) doQuit();
      else if (win) win.hide();
    });
  });

  void app.whenReady().then(boot).catch((err) => {
    dialog.showErrorBox(`${app.name} could not start`, String(err?.stack || err));
    app.exit(1);
  });
}
