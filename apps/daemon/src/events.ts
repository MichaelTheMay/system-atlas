import { EventEmitter } from 'node:events';

/** In-process bus feeding the SSE stream. Payloads are small notifications, never artifact bytes. */
export interface BusMessage {
  type: string;
  data: Record<string, unknown>;
}

export class EventBus {
  private emitter = new EventEmitter();
  constructor() {
    this.emitter.setMaxListeners(100);
  }
  publish(msg: BusMessage): void {
    this.emitter.emit('msg', msg);
  }
  subscribe(fn: (msg: BusMessage) => void): () => void {
    this.emitter.on('msg', fn);
    return () => this.emitter.off('msg', fn);
  }
}
