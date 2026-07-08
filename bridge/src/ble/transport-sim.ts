import type { ResolvedState } from '../core/events.js';
import type { Transport, TransportState } from './transport.js';

interface Envelope {
  v: 1;
  seq: number;
  t: string;
  ts: number;
  p: unknown;
}

/**
 * `--simulate` transport: no real firmware, just a human-readable stdout log
 * plus synthetic acks/state_applied with zero latency, so the full pipeline
 * (retry logic, latency histogram, etc.) still runs exactly as it would with
 * a real BLE peer. This is what `npm run dev` uses.
 */
export class SimTransport implements Transport {
  #state: TransportState = 'disconnected';
  #lineCb: ((line: string) => void) | null = null;
  #stateCb: ((s: TransportState) => void) | null = null;

  connect(): Promise<void> {
    this.#state = 'connected';
    this.#stateCb?.('connected');
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#state = 'disconnected';
    this.#stateCb?.('disconnected');
    return Promise.resolve();
  }

  send(line: string): void {
    if (this.#state !== 'connected') {
      console.warn(`[sim] dropped send: transport not connected: ${line}`);
      return;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(line) as Envelope;
    } catch {
      return;
    }

    this.#log(envelope);

    switch (envelope.t) {
      case 'hello':
        this.#emit('hello', { role: 'fw', fw_version: 'sim', ts: envelope.ts });
        break;
      case 'hb':
        this.#emit('hb', {});
        break;
      case 'state':
      case 'state_sync':
        this.#emit('ack', { ack_seq: envelope.seq });
        this.#emit('state_applied', {
          ack_seq: envelope.seq,
          bridge_ts: envelope.ts,
          fw_applied_ts: envelope.ts,
        });
        break;
      default:
        break;
    }
  }

  onLine(cb: (line: string) => void): void {
    this.#lineCb = cb;
  }

  onStateChange(cb: (s: TransportState) => void): void {
    this.#stateCb = cb;
  }

  #emit(t: string, p: Record<string, unknown>): void {
    const envelope: Envelope = { v: 1, seq: 0, t, ts: Date.now(), p };
    this.#lineCb?.(JSON.stringify(envelope));
  }

  #log(envelope: Envelope): void {
    if (envelope.t === 'state' || envelope.t === 'state_sync') {
      const state = envelope.p as unknown as ResolvedState;
      console.log(`[sim] ${envelope.t} → ${state.emotion} leds=${JSON.stringify(state.leds)}`);
    }
  }
}
