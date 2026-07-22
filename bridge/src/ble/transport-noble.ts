import { createRequire } from 'node:module';
import pino from 'pino';
import {
  DEFAULT_DEVICE_NAME_PREFIX,
  NUS_RX,
  NUS_RX_CHUNK_BYTES,
  NUS_SERVICE,
  NUS_TX,
  nameMatchesPrefix,
  normalizeUuid,
} from './nus.js';
import type { Transport, TransportState } from './transport.js';

const require = createRequire(import.meta.url);

const logger = pino({ name: 'transport-noble' });

/** Minimal noble surface we use — injectable for tests. */
export interface NoblePeripheral {
  id: string;
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverSomeServicesAndCharacteristicsAsync(
    serviceUuids: string[],
    characteristicUuids: string[],
  ): Promise<{
    characteristics: NobleCharacteristic[];
  }>;
  once(event: 'disconnect', cb: () => void): void;
}

export interface NobleCharacteristic {
  uuid: string;
  subscribeAsync(): Promise<void>;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
  on(event: 'data', cb: (data: Buffer) => void): void;
}

export interface NobleLike {
  state: string;
  startScanningAsync(serviceUuids: string[], allowDuplicates: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
  on(event: 'stateChange', cb: (state: string) => void): void;
  on(
    event: 'discover',
    cb: (peripheral: NoblePeripheral & { advertisement: { localName?: string } }) => void,
  ): void;
  removeAllListeners?(event?: string): void;
}

export type NobleFactory = () => NobleLike;

export interface NobleTransportOptions {
  deviceNamePrefix?: string;
  scanTimeoutMs?: number;
  /** Inject for tests. Defaults to dynamic import of @abandonware/noble. */
  nobleFactory?: NobleFactory;
}

/**
 * Real BLE Nordic UART transport (Fase 1B / M6).
 * ProtocolSession owns reconnect backoff; this class only connect/disconnect/send.
 */
export class NobleTransport implements Transport {
  #prefix: string;
  #scanTimeoutMs: number;
  #nobleFactory: NobleFactory;
  #state: TransportState = 'disconnected';
  #lineCb: ((line: string) => void) | null = null;
  #stateCb: ((s: TransportState) => void) | null = null;
  #noble: NobleLike | null = null;
  #peripheral: NoblePeripheral | null = null;
  #rx: NobleCharacteristic | null = null;
  #rxBuffer = '';
  /** Serializes chunked writes so two send() calls never interleave on the wire. */
  #writeChain: Promise<void> = Promise.resolve();

  constructor(opts: NobleTransportOptions = {}) {
    this.#prefix = opts.deviceNamePrefix ?? DEFAULT_DEVICE_NAME_PREFIX;
    this.#scanTimeoutMs = opts.scanTimeoutMs ?? 15_000;
    this.#nobleFactory = opts.nobleFactory ?? defaultNobleFactory;
  }

  async connect(): Promise<void> {
    if (this.#state === 'connected') return;
    this.#setState('connecting');
    const noble = this.#nobleFactory();
    this.#noble = noble;

    await waitForPoweredOn(noble);

    const peripheral = await this.#scanForDevice(noble);
    await peripheral.connectAsync();
    this.#peripheral = peripheral;
    peripheral.once('disconnect', () => {
      this.#rx = null;
      this.#peripheral = null;
      this.#setState('disconnected');
    });

    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [NUS_SERVICE],
      [NUS_RX, NUS_TX],
    );

    const rx = characteristics.find((c) => normalizeUuid(c.uuid) === NUS_RX);
    const tx = characteristics.find((c) => normalizeUuid(c.uuid) === NUS_TX);
    if (!rx || !tx) {
      await peripheral.disconnectAsync().catch(() => undefined);
      this.#setState('disconnected');
      throw new Error('NUS RX/TX characteristics not found on peripheral');
    }

    this.#rx = rx;
    this.#rxBuffer = '';
    tx.on('data', (data) => this.#onNotify(data));
    await tx.subscribeAsync();

    this.#setState('connected');
    logger.info({ id: peripheral.id, prefix: this.#prefix }, 'noble connected');
  }

  async disconnect(): Promise<void> {
    try {
      await this.#noble?.stopScanningAsync().catch(() => undefined);
      if (this.#peripheral) {
        await this.#peripheral.disconnectAsync().catch(() => undefined);
      }
    } finally {
      this.#rx = null;
      this.#peripheral = null;
      this.#noble = null;
      this.#rxBuffer = '';
      this.#writeChain = Promise.resolve();
      this.#setState('disconnected');
    }
  }

  send(line: string): void {
    if (this.#state !== 'connected' || !this.#rx) {
      logger.warn({ line }, 'dropped send: transport not connected');
      return;
    }
    const payload = line.endsWith('\n') ? line : `${line}\n`;
    const buf = Buffer.from(payload, 'utf8');
    // Host uart RX characteristic maxBytes is 64. A full state_sync envelope is
    // larger; firmware reassembles until `\n`, so we chunk without splitting
    // across concurrent send() calls.
    this.#writeChain = this.#writeChain
      .then(() => this.#writeChunked(buf))
      .catch((err: unknown) => {
        logger.warn({ err }, 'noble write failed');
      });
  }

  async #writeChunked(buf: Buffer): Promise<void> {
    const rx = this.#rx;
    if (!rx) return;
    for (let i = 0; i < buf.length; i += NUS_RX_CHUNK_BYTES) {
      await rx.writeAsync(buf.subarray(i, i + NUS_RX_CHUNK_BYTES), false);
    }
  }

  onLine(cb: (line: string) => void): void {
    this.#lineCb = cb;
  }

  onStateChange(cb: (s: TransportState) => void): void {
    this.#stateCb = cb;
  }

  #onNotify(data: Buffer): void {
    this.#rxBuffer += data.toString('utf8');
    let idx = this.#rxBuffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.#rxBuffer.slice(0, idx).replace(/\r$/, '');
      this.#rxBuffer = this.#rxBuffer.slice(idx + 1);
      if (line.length > 0) this.#lineCb?.(line);
      idx = this.#rxBuffer.indexOf('\n');
    }
  }

  #scanForDevice(noble: NobleLike): Promise<NoblePeripheral> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void noble.stopScanningAsync().catch(() => undefined);
        reject(
          new Error(
            `No BLE device matching prefix "${this.#prefix}" within ${this.#scanTimeoutMs}ms`,
          ),
        );
      }, this.#scanTimeoutMs);

      const onDiscover = (
        peripheral: NoblePeripheral & { advertisement: { localName?: string } },
      ) => {
        const name = peripheral.advertisement?.localName;
        if (!nameMatchesPrefix(name, this.#prefix)) return;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void noble.stopScanningAsync().catch(() => undefined);
        resolve(peripheral);
      };

      noble.on('discover', onDiscover);
      // Empty service filter: CoreS3 advertises name only (NUS UUID is GATT-only;
      // packing both into the 31-byte ADV packet overflows with "buildagotchi").
      void noble.startScanningAsync([], false).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  #setState(s: TransportState): void {
    this.#state = s;
    this.#stateCb?.(s);
  }
}

function waitForPoweredOn(noble: NobleLike): Promise<void> {
  if (noble.state === 'poweredOn') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Bluetooth adapter not poweredOn within 10s')),
      10_000,
    );
    noble.on('stateChange', (state) => {
      if (state === 'poweredOn') {
        clearTimeout(timer);
        resolve();
      } else if (state === 'unsupported' || state === 'unauthorized') {
        clearTimeout(timer);
        reject(new Error(`Bluetooth adapter state: ${state}`));
      }
    });
  });
}

function defaultNobleFactory(): NobleLike {
  // createRequire so unit tests never load the native binding unless they ask.
  return require('@abandonware/noble') as NobleLike;
}
