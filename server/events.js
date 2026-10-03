/**
 * Server-sent events hub.
 *
 * A download's progress changes many times a second, so polling would be both
 * slower and noisier than pushing. SSE keeps the connection open over plain
 * HTTP with no extra dependency, and reconnects on its own.
 */
import { MAX_SSE_CLIENTS } from './config.js';

export class EventHub {
  #clients = new Set();
  #lastId = 0;
  #max = Infinity;

  constructor({ max = Infinity } = {}) {
    this.#max = max;
  }

  /**
   * Attach a client, or refuse it.
   *
   * Returns null when the hub is already at its ceiling. Each stream is a socket
   * held open for the life of a tab and pinged every 15s, so an unbounded set is
   * a way to hold a desktop app's resources open indefinitely. A client that gets
   * refused can reconnect, so this degrades to a lagging progress bar rather than
   * a failure.
   */
  addClient(res, { lastEventId = 0 } = {}) {
    if (this.#clients.size >= this.#max) return null;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // Ask the browser to wait 3s before retrying a dropped stream, then poll in.
    res.write('retry: 3000\n\n');

    const client = { res, alive: true };
    this.#clients.add(client);

    // Comment frames keep intermediaries from closing an idle stream.
    const ping = setInterval(() => {
      if (!client.alive) return;
      try { res.write(': ping\n\n'); } catch { this.#drop(client); }
    }, 15_000);
    ping.unref?.();

    const close = () => {
      clearInterval(ping);
      this.#drop(client);
    };
    res.on('close', close);
    res.on('error', close);

    if (lastEventId) void lastEventId;
    return client;
  }

  #drop(client) {
    client.alive = false;
    this.#clients.delete(client);
    try { client.res.end(); } catch { /* already gone */ }
  }

  broadcast(type, data) {
    const id = ++this.#lastId;
    const frame = `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.#clients]) {
      if (!client.alive) { this.#drop(client); continue; }
      try {
        client.res.write(frame);
      } catch {
        this.#drop(client);
      }
    }
  }

  get size() { return this.#clients.size; }
  get max() { return this.#max; }

  closeAll() {
    for (const client of [...this.#clients]) this.#drop(client);
  }
}

export const hub = new EventHub({ max: MAX_SSE_CLIENTS });
