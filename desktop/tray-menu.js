/**
 * The tray menu template, as plain data.
 *
 * Deliberately free of any Electron import. Everything here is a description of
 * what a user can click, which means it can be inspected and tested without a
 * desktop session, and it keeps the policy (what the menu offers and when)
 * separate from the mechanism that renders it.
 */

const pct = (job) => (job.percent != null ? `${Math.round(job.percent)}%` : null);

const jobLabel = (job) => {
  const name = (job.title || job.url || 'Download').replace(/\s+/g, ' ').trim();
  const short = name.length > 44 ? `${name.slice(0, 43)}…` : name;
  const p = pct(job);
  return p ? `${short} — ${p}` : short;
};

export function buildTrayMenu(state, actions, appName = 'Bitrate') {
  const items = [
    { label: `Open ${appName}`, click: () => actions.open() },
    {
      label: state.clipboardUrl ? 'Download link from clipboard' : 'No link in clipboard',
      enabled: Boolean(state.clipboardUrl),
      click: () => actions.grabClipboard(),
    },
    { type: 'separator' },
  ];

  if (state.active.length) {
    items.push({
      label: `In progress (${state.active.length})`,
      submenu: [
        ...state.active.map((job) => ({
          label: `${job.status === 'queued' ? 'Queued' : 'Downloading'}  ${jobLabel(job)}`,
          // Read-only summary. Clicking opens the window instead of the file,
          // because a partial video is not worth launching a player for.
          click: () => actions.open(),
        })),
        { type: 'separator' },
        { label: 'Cancel all', click: () => actions.cancelAll() },
      ],
    });
  } else {
    items.push({ label: 'Idle', enabled: false });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Open downloads folder', click: () => actions.revealDownloads() });
  items.push({ label: 'Copy server address', click: () => actions.copyServerUrl() });

  // Only surface this when something is actually missing, so the everyday menu
  // stays short.
  if (!state.depsOk) {
    items.push({ type: 'separator' });
    items.push({
      label: state.setupRunning ? 'Installing dependencies…' : 'Install dependencies…',
      enabled: !state.setupRunning,
      click: () => actions.installDependencies(),
    });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Open log folder', click: () => actions.openLogs() });
  items.push({ label: `Quit ${appName}`, click: () => actions.quit() });

  return items;
}
