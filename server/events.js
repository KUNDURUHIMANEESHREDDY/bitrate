/**
 * Server-sent events hub.
 *
 * A download's progress changes many times a second, so polling would be both
 * slower and noisier than pushing. SSE keeps the connection open over plain
 * HTTP with no extra dependency, and reconnects on its own.
 */
export class EventHub {
  #clients = new Set();
  #lastId = 0;

  addClient(res, { lastEventId = 0 } = {}) {
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

  closeAll() {
    for (const client of [...this.#clients]) this.#drop(client);
  }
}

export const hub = new EventHub();
