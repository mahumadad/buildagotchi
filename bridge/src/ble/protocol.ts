import type { Logger } from 'pino';
import type { ResolvedState } from '../core/events.js';
import type { Transport } from './transport.js';

const BRIDGE_VERSION = '0.1.0';
const HELLO_TIMEOUT_MS = 2_000;
const HELLO_RETRY_MS = 30_000;
const HELLO_REFRESH_MS = 10 * 60 * 1_000;
const ACK_TIMEOUT_MS = 500;

export interface BleConfig {
  heartbeatSeconds: number;
  missesBeforeDead: number;
  reconnectBackoff: { initial: number; max: number };
}

/** Minimal structural subset of the future `server/metrics.ts` Metrics registry (SA3, M4). */
export interface MetricsLike {
  counter(name: string): { inc(n?: number): void };
  histogram(name: string): { observe(ms: number): void };
}

export interface ProtocolSessionDeps {
  onInboundEvent: (kind: 'button' | 'touch', detail: unknown) => void;
  metrics: MetricsLike;
  logger: Logger;
  now?: () => number;
}

interface Envelope {
  v: 1;
  seq: number;
  t: string;
  ts: number;
  p: unknown;
}

interface AwaitingHello {
  sentAt: number;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
}

interface PendingState {
  type: 'state' | 'state_sync';
  state: ResolvedState;
  seq: number;
  retried: boolean;
  timer: NodeJS.Timeout;
}

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string' &&
    typeof (value as { p?: unknown }).p === 'object'
  );
}

/**
 * BLE session protocol on top of an abstract `Transport` (SPEC-FASE-1 §9).
 *
 * SPEC GAP: SPEC-FASE-1 §9 mandates a dedicated counter for the "second ack
 * miss forces reconnection" case ("contador propio", explicitly *not*
 * `heartbeat_misses_total`), but SPEC-FASE-1 §13's canonical metrics list
 * doesn't name one. Registered here as `ack_misses_total` — not in §13, but
 * required by §9's own wording; flagged for the metrics registry (M4) to pick
 * up without further discussion.
 */
export class ProtocolSession {
  #transport: Transport;
  #cfg: BleConfig;
  #deps: ProtocolSessionDeps;
  #now: () => number;

  #seq = 0;
  #clockOffset = 0;
  #lastState: ResolvedState | null = null;

  #pending: PendingState | null = null;
  #awaitingHello: AwaitingHello | null = null;
  #helloRefreshTimer: NodeJS.Timeout | null = null;

  #hbTimer: NodeJS.Timeout | null = null;
  #inboundSinceLastWindow = false;
  #missedWindows = 0;

  #reconnecting = false;
  #reconnectAttempt = 0;
  #reconnectStartedAt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;

  constructor(transport: Transport, cfg: BleConfig, deps: ProtocolSessionDeps) {
    this.#transport = transport;
    this.#cfg = cfg;
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  async start(): Promise<void> {
    this.#transport.onLine((line) => this.#handleLine(line));
    await this.#transport.connect();

    const ok = await this.#sendHelloAndAwait();
    if (ok) {
      this.#scheduleHelloRefresh(HELLO_REFRESH_MS);
    } else {
      this.#clockOffset = 0;
      this.#deps.metrics.counter('handshake_failures_total').inc();
      this.#scheduleHelloRefresh(HELLO_RETRY_MS);
    }

    this.#startHeartbeat();
  }

  async stop(): Promise<void> {
    this.#stopHeartbeat();
    this.#stopHelloTimers();
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#pending) clearTimeout(this.#pending.timer);
    this.#pending = null;
    await this.#transport.disconnect();
  }

  sendState(state: ResolvedState): void {
    this.#lastState = state;
    this.#sendStatePayload('state', state);
  }

  // --- hello / clock offset -------------------------------------------

  #sendHelloAndAwait(): Promise<boolean> {
    const sentAt = this.#now();
    const seq = this.#nextSeq();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#awaitingHello?.resolve === resolve) {
          this.#awaitingHello = null;
          resolve(false);
        }
      }, HELLO_TIMEOUT_MS);
      this.#awaitingHello = { sentAt, resolve, timer };

      const envelope: Envelope = {
        v: 1,
        seq,
        t: 'hello',
        ts: sentAt,
        p: { role: 'bridge', bridge_version: BRIDGE_VERSION, ts: sentAt },
      };
      this.#transport.send(JSON.stringify(envelope));
    });
  }

  #scheduleHelloRefresh(ms: number): void {
    this.#helloRefreshTimer = setTimeout(() => {
      void this.#refreshHello();
    }, ms);
  }

  async #refreshHello(): Promise<void> {
    const ok = await this.#sendHelloAndAwait();
    if (ok) {
      this.#scheduleHelloRefresh(HELLO_REFRESH_MS);
    } else {
      this.#deps.metrics.counter('handshake_failures_total').inc();
      this.#scheduleHelloRefresh(HELLO_RETRY_MS);
    }
  }

  #stopHelloTimers(): void {
    if (this.#helloRefreshTimer) clearTimeout(this.#helloRefreshTimer);
    this.#helloRefreshTimer = null;
    if (this.#awaitingHello) clearTimeout(this.#awaitingHello.timer);
    this.#awaitingHello = null;
  }

  #handleHello(envelope: Envelope): void {
    if (!this.#awaitingHello) return; // unsolicited hello: no send timestamp to pair it with
    const recvTs = this.#now();
    const rtt = recvTs - this.#awaitingHello.sentAt;
    const fwTs = (envelope.p as { ts: number }).ts;
    this.#clockOffset = fwTs - this.#awaitingHello.sentAt - rtt / 2;

    clearTimeout(this.#awaitingHello.timer);
    const { resolve } = this.#awaitingHello;
    this.#awaitingHello = null;
    resolve(true);
  }

  // --- heartbeat / liveness (SA8) --------------------------------------

  #startHeartbeat(): void {
    this.#missedWindows = 0;
    this.#inboundSinceLastWindow = false;
    const intervalMs = this.#cfg.heartbeatSeconds * 1_000;
    this.#hbTimer = setInterval(() => this.#onHeartbeatTick(), intervalMs);
  }

  #stopHeartbeat(): void {
    if (this.#hbTimer) clearInterval(this.#hbTimer);
    this.#hbTimer = null;
  }

  #onHeartbeatTick(): void {
    this.#sendEnvelope('hb', {});

    if (this.#inboundSinceLastWindow) {
      this.#missedWindows = 0;
    } else {
      this.#missedWindows += 1;
      this.#deps.metrics.counter('heartbeat_misses_total').inc();
      if (this.#missedWindows >= this.#cfg.missesBeforeDead) {
        this.#onLinkDead();
        return;
      }
    }
    this.#inboundSinceLastWindow = false;
  }

  // --- reconnection ------------------------------------------------------

  #onLinkDead(): void {
    if (this.#reconnecting) return;
    this.#stopHeartbeat();
    this.#stopHelloTimers();
    if (this.#pending) clearTimeout(this.#pending.timer);
    this.#pending = null;

    this.#reconnecting = true;
    this.#reconnectAttempt = 0;
    this.#reconnectStartedAt = this.#now();
    this.#scheduleReconnectAttempt();
  }

  #scheduleReconnectAttempt(): void {
    const backoff = Math.min(
      this.#cfg.reconnectBackoff.initial * 2 ** this.#reconnectAttempt,
      this.#cfg.reconnectBackoff.max,
    );
    this.#reconnectTimer = setTimeout(() => {
      void this.#attemptReconnect();
    }, backoff);
  }

  async #attemptReconnect(): Promise<void> {
    await this.#transport.disconnect();
    await this.#transport.connect();

    const ok = await this.#sendHelloAndAwait();
    if (!ok) {
      this.#reconnectAttempt += 1;
      this.#scheduleReconnectAttempt();
      return;
    }

    this.#reconnecting = false;
    this.#reconnectAttempt = 0;
    this.#deps.metrics.counter('ble_reconnects_total').inc();
    this.#deps.metrics
      .histogram('reconnect_duration_ms')
      .observe(this.#now() - this.#reconnectStartedAt);

    this.#scheduleHelloRefresh(HELLO_REFRESH_MS);
    this.#startHeartbeat();
    this.#sendStateSync();
  }

  // --- state / ack -------------------------------------------------------

  #sendStateSync(): void {
    if (this.#lastState) this.#sendStatePayload('state_sync', this.#lastState);
  }

  #sendStatePayload(type: 'state' | 'state_sync', state: ResolvedState): void {
    if (this.#pending) clearTimeout(this.#pending.timer);
    const seq = this.#nextSeq();
    this.#transmitState(type, state, seq);
    this.#pending = { type, state, seq, retried: false, timer: this.#scheduleAckTimeout(seq) };
  }

  #transmitState(type: 'state' | 'state_sync', state: ResolvedState, seq: number): void {
    const envelope: Envelope = { v: 1, seq, t: type, ts: this.#now(), p: state };
    this.#transport.send(JSON.stringify(envelope));
  }

  #scheduleAckTimeout(seq: number): NodeJS.Timeout {
    return setTimeout(() => this.#onAckTimeout(seq), ACK_TIMEOUT_MS);
  }

  #onAckTimeout(seq: number): void {
    if (!this.#pending || this.#pending.seq !== seq) return; // superseded by a newer state

    if (!this.#pending.retried) {
      const newSeq = this.#nextSeq();
      this.#transmitState(this.#pending.type, this.#pending.state, newSeq);
      this.#pending = {
        ...this.#pending,
        seq: newSeq,
        retried: true,
        timer: this.#scheduleAckTimeout(newSeq),
      };
      return;
    }

    this.#pending = null;
    this.#deps.metrics.counter('ack_misses_total').inc();
    this.#onLinkDead();
  }

  #handleAck(envelope: Envelope): void {
    const ackSeq = (envelope.p as { ack_seq: number }).ack_seq;
    if (this.#pending && this.#pending.seq === ackSeq) {
      clearTimeout(this.#pending.timer);
      this.#pending = null;
    }
  }

  #handleStateApplied(envelope: Envelope): void {
    const p = envelope.p as { ack_seq: number; bridge_ts: number; fw_applied_ts: number };
    const latency = p.fw_applied_ts - this.#clockOffset - p.bridge_ts;
    this.#deps.metrics.histogram('state_latency_ms').observe(latency);
  }

  #handleEvent(envelope: Envelope): void {
    const p = envelope.p as { kind: 'button' | 'touch'; detail: unknown };
    this.#deps.onInboundEvent(p.kind, p.detail);
  }

  // --- inbound dispatch ----------------------------------------------------

  #handleLine(line: string): void {
    this.#inboundSinceLastWindow = true; // SA8: any inbound line counts as liveness

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#warnParserError(line);
      return;
    }
    if (!isEnvelope(parsed)) {
      this.#warnParserError(line);
      return;
    }

    switch (parsed.t) {
      case 'hello':
        this.#handleHello(parsed);
        break;
      case 'ack':
        this.#handleAck(parsed);
        break;
      case 'state_applied':
        this.#handleStateApplied(parsed);
        break;
      case 'event':
        this.#handleEvent(parsed);
        break;
      case 'hb':
        break; // liveness already recorded above
      default:
        break;
    }
  }

  #warnParserError(line: string): void {
    this.#deps.logger.warn({ line }, 'unparseable inbound BLE line');
    this.#deps.metrics.counter('parser_errors_total').inc();
  }

  #sendEnvelope(t: string, p: Record<string, unknown>): void {
    const envelope: Envelope = { v: 1, seq: this.#nextSeq(), t, ts: this.#now(), p };
    this.#transport.send(JSON.stringify(envelope));
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }
}
