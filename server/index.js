#!/usr/bin/env node
/**
 * CLI entry point. All the real work lives in app.js so the desktop shell can
 * embed the same server; this file only adds the console banner and signal
 * handling that a terminal user expects.
 */
import { startServer, log, toolReport } from './app.js';
import { DOWNLOAD_DIR, PORT, CONCURRENT_FRAGMENTS, MAX_CONCURRENT } from './config.js';

let server;
try {
  server = await startServer();
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    log(`Port ${PORT} is already in use. Set BITRATE_PORT to pick another.`);
    process.exit(1);
  }
  console.error('[bitrate] fatal:', err);
  process.exit(1);
}

const shutdown = async (signal) => {
  log(`${signal} received, shutting down.`);
  await server.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

log(`serving ${server.url}`);
log(`downloads -> ${DOWNLOAD_DIR}`);

for (const [good, label] of toolReport()) log(`  ${good ? '[ok]' : '[--]'} ${label}`);
log(`  tuning: ${CONCURRENT_FRAGMENTS} fragments/stream, ${MAX_CONCURRENT} concurrent downloads`);
