import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { NUS_RX, NUS_TX } from '../src/ble/nus.js';
import {
  type NobleCharacteristic,
  type NobleLike,
  type NoblePeripheral,
  NobleTransport,
} from '../src/ble/transport-noble.js';

class FakeChar extends EventEmitter implements NobleCharacteristic {
  uuid: string;
  writes: Buffer[] = [];
  constructor(uuid: string) {
    super();
    this.uuid = uuid;
  }
  async subscribeAsync(): Promise<void> {}
  async writeAsync(data: Buffer, _withoutResponse: boolean): Promise<void> {
    this.writes.push(data);
  }
}

class FakePeripheral extends EventEmitter implements NoblePeripheral {
  id = 'fake-1';
  advertisement = { localName: 'buildagotchi' };
  rx = new FakeChar(NUS_RX);
  tx = new FakeChar(NUS_TX);
  async connectAsync(): Promise<void> {}
  async disconnectAsync(): Promise<void> {
    this.emit('disconnect');
  }
  async discoverSomeServicesAndCharacteristicsAsync() {
    return { characteristics: [this.rx, this.tx] };
  }
}

function makeNoble(peripheral: FakePeripheral): NobleLike & EventEmitter {
  const ee = new EventEmitter() as NobleLike & EventEmitter;
  ee.state = 'poweredOn';
  ee.startScanningAsync = vi.fn(async () => {
    queueMicrotask(() => ee.emit('discover', peripheral));
  });
  ee.stopScanningAsync = vi.fn(async () => {});
  return ee;
}

describe('NobleTransport', () => {
  it('connects, reassembles notify lines, and writes RX with newline', async () => {
    const peripheral = new FakePeripheral();
    const noble = makeNoble(peripheral);
    const transport = new NobleTransport({
      nobleFactory: () => noble,
      scanTimeoutMs: 2000,
    });

    const lines: string[] = [];
    const states: string[] = [];
    transport.onLine((l) => lines.push(l));
    transport.onStateChange((s) => states.push(s));

    await transport.connect();
    expect(states).toContain('connecting');
    expect(states).toContain('connected');

    // Fragmented notify
    peripheral.tx.emit('data', Buffer.from('{"v":1,"t":"hb"'));
    peripheral.tx.emit('data', Buffer.from(',"seq":1,"ts":1,"p":{}}\n'));
    expect(lines).toEqual(['{"v":1,"t":"hb","seq":1,"ts":1,"p":{}}']);

    transport.send('{"v":1,"seq":2,"t":"hello","ts":1,"p":{}}');
    await vi.waitFor(() => expect(peripheral.rx.writes).toHaveLength(1));
    expect(peripheral.rx.writes[0]?.toString('utf8')).toBe(
      '{"v":1,"seq":2,"t":"hello","ts":1,"p":{}}\n',
    );

    await transport.disconnect();
    expect(states.at(-1)).toBe('disconnected');
  });

  it('chunks RX writes at 64 bytes so state_sync fits the uart maxBytes', async () => {
    const peripheral = new FakePeripheral();
    const transport = new NobleTransport({
      nobleFactory: () => makeNoble(peripheral),
      scanTimeoutMs: 2000,
    });
    await transport.connect();

    const fat = `{"v":1,"seq":2,"t":"state_sync","ts":1784762287391,"p":{"emotion":"NEUTRAL","decorators":[],"leds":[],"balloon":""}}`;
    expect(Buffer.byteLength(`${fat}\n`, 'utf8')).toBeGreaterThan(64);
    transport.send(fat);
    await vi.waitFor(() => expect(peripheral.rx.writes.length).toBeGreaterThan(1));

    const rejoined = Buffer.concat(peripheral.rx.writes).toString('utf8');
    expect(rejoined).toBe(`${fat}\n`);
    expect(peripheral.rx.writes.every((c) => c.length <= 64)).toBe(true);

    await transport.disconnect();
  });

  it('drops send when not connected', async () => {
    const transport = new NobleTransport({
      nobleFactory: () => makeNoble(new FakePeripheral()),
    });
    // should not throw
    transport.send('{"v":1,"seq":1,"t":"hb","ts":1,"p":{}}');
  });

  it('rejects scan timeout when no matching device', async () => {
    const ee = new EventEmitter() as NobleLike & EventEmitter;
    ee.state = 'poweredOn';
    ee.startScanningAsync = vi.fn(async () => {});
    ee.stopScanningAsync = vi.fn(async () => {});
    const transport = new NobleTransport({
      nobleFactory: () => ee,
      scanTimeoutMs: 50,
    });
    await expect(transport.connect()).rejects.toThrow(/No BLE device matching prefix/);
  });

  it('scans without NUS service filter (name-only ADV)', async () => {
    const peripheral = new FakePeripheral();
    const noble = makeNoble(peripheral);
    const transport = new NobleTransport({
      nobleFactory: () => noble,
      scanTimeoutMs: 2000,
    });
    await transport.connect();
    expect(noble.startScanningAsync).toHaveBeenCalledWith([], false);
    await transport.disconnect();
  });
});
