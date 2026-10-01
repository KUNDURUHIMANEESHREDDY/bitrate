import { Menu, Tray, nativeImage } from 'electron';
import { buildTrayMenu } from './tray-menu.js';

/**
 * System tray presence for Bitrate.
 *
 * The tray is the app's real home: downloads keep running when the window is
 * closed, so the tray has to answer "what is happening right now" without
 * opening anything. It therefore carries the live queue, a cancel action, and
 * the dependency warning, and it is the only reason the app needs no dock icon
 * to stay useful.
 *
 * The menu itself lives in tray-menu.js as plain data, so what the user can
 * click is defined and testable independently of Electron.
 */

export function createTray({ iconPath, appName = 'Bitrate', actions }) {
  // The tray shows the icon at ~16px. Handing it the 512px master makes
  // Windows downscale at paint time, which looks soft; resizing once up front
  // gives it a properly hinted bitmap.
  const master = nativeImage.createFromPath(iconPath);
  const image = master.isEmpty() ? master : master.resize({ width: 16, height: 16 });
  const tray = new Tray(image);

  // Only rebuild the menu when something a user can see actually changed.
  // Electron re-creates the native menu on every buildFromTemplate call, and
  // doing that twice a second makes the icon flicker on Windows.
  let signature = null;
  let last = null;

  function refresh(state) {
    last = state;
    const next = JSON.stringify([
      state.active.map((j) => [j.id, j.status, pct(j)]),
      state.clipboardUrl,
      state.depsOk,
      state.setupRunning,
      state.downloadDir,
    ]);
    if (next === signature) return;
    signature = next;

    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu(state, actions, appName)));
    // Windows renders setTitle text next to the icon, which is the only place
    // a glanceable active count fits at 16px. macOS and Linux ignore it.
    tray.setTitle(state.active.length ? String(state.active.length) : '');
    const running = state.active.filter((j) => j.status === 'running');
    const bytes = running.reduce((sum, j) => sum + (j.downloaded || 0), 0);
    tray.setToolTip(
      state.depsOk
        ? `${appName} — ${state.active.length ? `${state.active.length} active (${fmtBytes(bytes)})` : 'idle'}`
        : `${appName} — missing tools, click to install`,
    );
  }

  tray.on('click', () => actions.open());

  return {
    tray,
    refresh,
    get state() { return last; },
    destroy() {
      try { tray.destroy(); } catch { /* already gone during quit */ }
    },
  };
}

const pct = (job) => (job.percent != null ? `${Math.round(job.percent)}%` : null);

function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
