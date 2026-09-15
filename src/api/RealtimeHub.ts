import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import WebSocket, { WebSocketServer } from 'ws';

import type { EventBus } from '../events/index.js';
import { eventDto } from './ApiDtos.js';

export interface RealtimeHubOptions {
  readonly eventBus: EventBus;
  readonly maxQueuedBytes?: number;
  readonly maxQueuedMessages?: number;
}

/** A server-to-client, best-effort event stream. Slow clients are isolated. */
export class RealtimeHub {
  readonly #server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  readonly #clients = new Set<WebSocket>();
  readonly #maxQueuedBytes: number;
  readonly #maxQueuedMessages: number;
  readonly #queued = new WeakMap<WebSocket, number>();
  readonly #unsubscribe: () => void;
  #stopped = false;

  public constructor(options: RealtimeHubOptions) {
    this.#maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
    this.#maxQueuedMessages = options.maxQueuedMessages ?? 256;
    this.#server.on('connection', (socket) => {
      this.#clients.add(socket);
      socket.on('close', () => this.#clients.delete(socket));
      socket.on('message', () => socket.close(1008, 'server-to-client only'));
      socket.on('error', () => undefined);
      this.#send(socket, JSON.stringify({ type: 'hello', version: 1, apiVersion: 'v1' }));
    });
    this.#unsubscribe = options.eventBus.subscribe((event) => {
      try { this.broadcast(JSON.stringify({ type: 'event', version: 1, event: eventDto(event) })); } catch { /* transport isolation */ }
    });
  }

  public handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      if (this.#stopped || new URL(request.url ?? '/', 'http://localhost').pathname !== '/api/v1/realtime') {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
      }
      this.#server.handleUpgrade(request, socket, head, (client) => this.#server.emit('connection', client, request));
    } catch { socket.destroy(); }
  }

  public broadcast(message: string): void {
    for (const client of this.#clients) this.#send(client, message);
  }

  public stop(): void {
    if (this.#stopped) return;
    this.#stopped = true; this.#unsubscribe();
    for (const client of this.#clients) client.terminate();
    this.#clients.clear();
    this.#server.close();
  }

  #send(client: WebSocket, message: string): void {
    try {
      const queued = this.#queued.get(client) ?? 0;
      if (client.readyState !== WebSocket.OPEN || queued >= this.#maxQueuedMessages ||
        client.bufferedAmount + Buffer.byteLength(message) > this.#maxQueuedBytes) {
        if (client.readyState === WebSocket.OPEN) client.close(1013, 'client too slow');
        return;
      }
      this.#queued.set(client, queued + 1);
      client.send(message, (error) => {
        this.#queued.set(client, Math.max(0, (this.#queued.get(client) ?? 1) - 1));
        if (error) client.terminate();
      });
    } catch { try { client.terminate(); } catch { /* isolated */ } }
  }
}
