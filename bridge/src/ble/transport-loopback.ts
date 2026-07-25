import pino from 'pino';
import type { Transport, TransportState } from './transport.js';

const logger = pino({ name: 'transport-loopback' });

const DEFAULT_ACK_DELAY_MS = 10;

interface Envelope {
  v: 1;
  seq: number;
  t: string;
  ts: number;
  p: unknown;
}

export interface LoopbackTransportOptions {
  ackDelayMs?: number;
  /** Seqs of bridge→fw messages to silently "lose" (never ack/state_applied). */
  dropSeqs?: Set<number>;
  respondHello?: boolean;
  /** Fake clock skew of the simulated firmware relative to the bridge's clock. */
  fwClockSkewMs?: number;
  /** Reject the next N `connect()` calls, as a device that isn't advertising yet. */
  failConnectTimes?: number;
}

/**
 * Fake firmware peer for tests: implements `Transport` from the bridge's side
 * (the bridge calls `send()` on it) while also acting as the other end of the
 * wire (responds to hello/state/hb, can be killed/revived, lines can be
 * injected as if the real firmware sent them).
 */
export class LoopbackTransport implements Transport {
  #ackDelayMs: number;
  #dropSeqs: Set<number>;
  #respondHello: boolean;
  #fwClockSkewMs: number;
  #failConnectRemaining: number;
  #state: TransportState = 'disconnected';
  #dead = false;
  #sentLines: string[] = [];
  #lineCb: ((line: string) => void) | null = null;
  #stateCb: ((s: TransportState) => void) | null = null;

  constructor(opts: LoopbackTransportOptions = {}) {
    this.#ackDelayMs = opts.ackDelayMs ?? DEFAULT_ACK_DELAY_MS;
    this.#dropSeqs = opts.dropSeqs ?? new Set();
    this.#respondHello = opts.respondHello ?? true;
    this.#fwClockSkewMs = opts.fwClockSkewMs ?? 0;
    this.#failConnectRemaining = opts.failConnectTimes ?? 0;
  }

  connect(): Promise<void> {
    if (this.#failConnectRemaining > 0) {
      this.#failConnectRemaining -= 1;
      return Promise.reject(new Error('loopback: no device advertising'));
    }
    this.#setState('connected');
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#setState('disconnected');
    return Promise.resolve();
  }

  send(line: string): void {
    if (this.#state !== 'connected') {
      logger.warn({ line }, 'dropped send: transport not connected');
      return;
    }
    this.#sentLines.push(line);
    if (this.#dead) return;

    let envelope: Envelope;
    try {
      envelope = JSON.parse(line) as Envelope;
    } catch {
      return;
    }
    if (this.#dropSeqs.has(envelope.seq)) return;

    this.#respond(envelope);
  }

  onLine(cb: (line: string) => void): void {
    this.#lineCb = cb;
  }

  onStateChange(cb: (s: TransportState) => void): void {
    this.#stateCb = cb;
  }

  // --- test controls -------------------------------------------------

  die(): void {
    this.#dead = true;
  }

  revive(): void {
    this.#dead = false;
  }

  inject(line: string): void {
    this.#lineCb?.(line);
  }

  /** Make the next N `connect()` calls reject (e.g. reconnect while rebooting). */
  failNextConnects(n: number): void {
    this.#failConnectRemaining = n;
  }

  /**
   * Shift the simulated firmware clock. A real CoreS3 reboot resets Date.now()
   * back toward zero, so a test drives this negative before a reconnect hello to
   * reproduce the backward ts jump the reboot detector keys on.
   */
  setFwClockSkew(ms: number): void {
    this.#fwClockSkewMs = ms;
  }

  sentLines(): string[] {
    return [...this.#sentLines];
  }

  // --- internals -------------------------------------------------------

  #setState(s: TransportState): void {
    this.#state = s;
    this.#stateCb?.(s);
  }

  #fwNow(): number {
    return Date.now() + this.#fwClockSkewMs;
  }

  #emit(t: string, p: Record<string, unknown>): void {
    const envelope: Envelope = { v: 1, seq: 0, t, ts: this.#fwNow(), p };
    this.#lineCb?.(JSON.stringify(envelope));
  }

  #respond(envelope: Envelope): void {
    switch (envelope.t) {
      case 'hello':
        if (this.#respondHello) {
          this.#emit('hello', { role: 'fw', fw_version: 'loopback', ts: this.#fwNow() });
        }
        break;
      case 'hb':
        this.#emit('hb', {});
        break;
      case 'state':
      case 'state_sync':
        setTimeout(() => {
          if (this.#dead) return;
          this.#emit('ack', { ack_seq: envelope.seq });
          this.#emit('state_applied', {
            ack_seq: envelope.seq,
            bridge_ts: envelope.ts,
            fw_applied_ts: this.#fwNow(),
          });
        }, this.#ackDelayMs);
        break;
      default:
        break;
    }
  }
}
