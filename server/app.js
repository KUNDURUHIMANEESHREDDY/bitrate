import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import api from './api.js';
import {
  HOST, PORT, WEB_DIST, ensureDirs, has, YTDLP, FFMPEG, ARIA2C,
  CONCURRENT_FRAGMENTS, MAX_CONCURRENT,
} from './config.js';
import { runtime, ytdlpVersion } from './engine.js';
import { hub } from './events.js';
import { initTracing, shutdownTracing } from './trace.js';
import { authenticate, assertBindingIsSafe, authStatus, isLoopbackBind } from './auth.js';
import { chargeRequest } from './limits.js';
import { increment, recordFailure } from './metrics.js';
import { closeClient, closeEgressProxy } from './http-client.js';

export const log = (...a) => console.log('[bitrate]', ...a);

/**
 * Build the Fastify app without binding a port.
 *
 * Split from listening so the same app can be embedded in another process. The
 * Electron shell imports this and runs the server inside its own main process,
 * which is why nothing here reads argv or calls process.exit.
 */
export async function buildApp({ loggerLevel = process.env.BITRATE_LOG || 'warn' } = {}) {
  ensureDirs();

  const app = Fastify({
    logger: { level: loggerLevel, transport: undefined },
    bodyLimit: 256 * 1024,
    // Destroy sockets instead of waiting for them when closing. The progress
    // stream is hijacked and would otherwise be waited on, and a request that
    // is mid-probe holds a request open for as long as yt-dlp takes. The
    // desktop app quits from a tray menu, so close() has to be prompt or the
    // app appears to hang.
    forceCloseConnections: true,
  });

  // Three checks run before any handler, in order of how much they cost an
  // attacker to satisfy.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;

    // 1. Origin. Loopback-only, but a page on another origin could still POST
    //    here. Blocking cross-origin requests stops a drive-by page from queueing
    //    downloads or deleting files through the user's browser session.
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).hostname; } catch { /* malformed origin */ }
      const allowed = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
      if (!host || !allowed.has(host)) {
        increment('request_refused', { kind: 'cross_origin' });
        return reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
      }
    }

    // 2. Authentication. A no-op unless BITRATE_AUTH_TOKEN is set, which a
    //    loopback install never needs.
    try {
      authenticate(req);
    } catch (err) {
      increment('request_refused', { kind: 'auth' });
      return reply.code(err.statusCode || 401).send({ error: err.message });
    }

    // 3. Budget. After the cheap checks, so a rejected origin is not also
    //    charged for the attempt.
    try {
      chargeRequest(req.ip || 'unknown', req.url);
    } catch (err) {
      increment('request_refused', { kind: 'budget' });
      if (err.retryAfter) reply.header('Retry-After', String(err.retryAfter));
      return reply.code(err.statusCode || 429).send({ error: err.message });
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'request failed');
    // One choke point for every handler failure, so a refusal is counted wherever
    // it was decided. Anything reaching here already went through the checks
    // above, so this only sees refusals raised by a route itself.
    if (req.url.startsWith('/api/') && status >= 400) {
      recordFailure(err, 'request_refused');
    }
    reply.code(status).send({ error: err.message || 'Something went wrong.' });
  });

  await app.register(api);

  if (existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: '/',
      index: ['index.html'],
      // Hashed asset filenames are safe to cache hard; index.html is not.
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        } else if (/\.[0-9a-f]{8,}\./.test(path.basename(filePath))) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });

    // SPA fallback for client-side routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found.' });
      }
      return reply.sendFile('index.html');
    });
  } else {
    log('web/dist is missing. Run `npm run build` first, or use `npm run dev:web` for the Vite dev server.');
    app.setNotFoundHandler((req, reply) =>
      reply.code(404).send({
        error: 'UI not built.',
        hint: 'Run: npm install && npm run build && npm start',
      }));
  }

  return app;
}

/**
 * Start the server and report where it ended up.
 *
 * `allowPortFallback` exists for the desktop shell: a second copy of the app,
 * or the dev server, may already hold the preferred port. Rather than refusing
 * to start, the app asks the OS for a free port. The returned `url` is the only
 * thing callers should trust, because the UI is same-origin and follows it.
 */
export async function startServer({
  host = HOST,
  port = PORT,
  loggerLevel,
  allowPortFallback = false,
} = {}) {
  // Refuses a non-loopback bind with no token configured. Checked before
  // anything is built or bound, so an unsafe configuration cannot even reach
  // the point of listening.
  const binding = assertBindingIsSafe(host);
  if (binding.required) {
    log(`bound to ${host}; BITRATE_AUTH_TOKEN is required and enforced.`);
  }

  let app = await buildApp({ loggerLevel });

  const bind = async (p) => {
    try {
      return await app.listen({ host, port: p });
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || !allowPortFallback) throw err;
      return null;
    }
  };

  let address = await bind(port);
  if (!address) {
    // A failed bind leaves the instance half-started. Build a fresh one rather
    // than reusing it, so the retry cannot inherit a broken server handle.
    await app.close();
    log(`port ${port} is already in use, asking the OS for a free one.`);
    app = await buildApp({ loggerLevel });
    address = await bind(0);
  }

  const actualPort = Number(address.split(':').pop());
  const url = `http://${host}:${actualPort}`;

  // Started here rather than in each entry point so the CLI, the desktop shell
  // and the eval runner all pick tracing up the same way. It is a no-op unless
  // Langfuse credentials are present.
  await initTracing();

  return {
    app,
    host,
    port: actualPort,
    url,
    close: async () => {
      hub.closeAll();
      await app.close();
      // Idle keep-alive sockets belong to the outbound client, not to Fastify, so
      // Fastify's close will not touch them. Leaving them to their reuse timeout
      // is what makes a desktop app look like it is hanging on quit.
      closeClient();
      // The proxy holds tunnelled TLS sockets that belong to no agent pool, so
      // closing it is what stops a live child download from keeping the process
      // alive after everything else has gone.
      await closeEgressProxy();
      // Spans are batched in the background, so a process that exits without
      // flushing loses exactly the traces it just produced.
      await shutdownTracing();
    },
  };
}

/** One-shot dependency report, used by the CLI banner and the desktop tray. */
export function toolReport() {
  return [
    [runtime.ytdlp || has(YTDLP), `yt-dlp ${ytdlpVersion() || 'NOT FOUND - run npm run setup'}`],
    [runtime.ffmpeg || has(FFMPEG), `ffmpeg ${has(FFMPEG) ? 'ready (merging + mp3)' : 'NOT FOUND - no merging or mp3'}`],
    [runtime.aria2c || has(ARIA2C), `aria2c ${has(ARIA2C) ? 'ready (multi-connection)' : 'absent (optional)'}`],
  ];
}

/** Whether this build's configuration is safe to expose on the network. */
export const exposure = () => ({
  loopback: isLoopbackBind(HOST),
  auth: authStatus(),
});

export { CONCURRENT_FRAGMENTS, MAX_CONCURRENT };
