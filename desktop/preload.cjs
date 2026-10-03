/**
 * The one thing the renderer is told that it could not work out for itself.
 *
 * Read from the process environment rather than passed in by the main process, so
 * this file opens no message channel at all. A preload with one invites more
 * messages later, and each is a decision about what the sandboxed page may do.
 * This has exactly one answer to give and no way to ask for another.
 */
 *
 * The renderer is sandboxed with context isolation on, so this bridge is the only
 * channel between the shell and the page, and it deliberately carries nothing but
 * a string. No filesystem, no child processes, no arbitrary IPC: the page is still
 * ordinary web content that happens to know one value.
 *
 * That value is the API token, and the renderer needs it for one reason. Three of
 * its surfaces cannot set a request header -- EventSource, the media preview
 * elements and a download link -- so the token has to travel in the URL for those,
 * and it is better to hand the page a credential it already knows than to leave it
 * to guess. The token is read from the process environment at preload time, which
 * is where the shell configured it, so nothing is written to disk and nothing is
 * read back out of a file a user could edit.
 *
 * A preload script must be CommonJS: `sandbox: true` means it is run without Node's
 * module loader, so the ESM syntax the rest of this project uses is not available.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__BITRATE_TOKEN__', process.env.BITRATE_AUTH_TOKEN || '');