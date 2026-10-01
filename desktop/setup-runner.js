import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run scripts/setup.js as a child process and capture everything it prints.
 *
 * ELECTRON_RUN_AS_NODE makes Electron's own binary behave as plain Node, so the
 * exact same script runs in development and inside a packaged app without
 * shipping a second runtime or resolving a system `node`. Output goes to a log
 * file rather than a console window, because a GUI app that pops up a terminal
 * on startup reads as a bug.
 */
export function runSetup({ root, logDir }) {
  const script = path.join(root, 'scripts', 'setup.js');
  const logPath = path.join(logDir, 'setup.log');

  return new Promise((resolve) => {
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.createWriteStream(logPath, { flags: 'w' });
    out.write(`[bitrate] setup started ${new Date().toISOString()}\n`);
    out.write(`[bitrate] script: ${script}\n\n`);

    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const tee = (stream) => {
      stream.on('data', (buf) => {
        out.write(buf);
        // Keep the process log useful for diagnosing a failed install.
        process.stdout.write(buf);
      });
    };
    tee(child.stdout);
    tee(child.stderr);

    child.on('error', (err) => {
      out.write(`\n[bitrate] could not start setup: ${err.message}\n`);
      out.end();
      resolve({ code: -1, logPath, error: err.message });
    });

    child.on('close', (code) => {
      out.write(`\n[bitrate] setup exited with code ${code}\n`);
      out.end();
      resolve({ code: code ?? -1, logPath });
    });
  });
}
