import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_NAME_PREFIX,
  NUS_RX,
  NUS_SERVICE,
  NUS_TX,
  nameMatchesPrefix,
  normalizeUuid,
} from '../src/ble/nus.js';

describe('nus constants', () => {
  it('uses the standard Nordic UART UUIDs without dashes', () => {
    expect(NUS_SERVICE).toBe('6e400001b5a3f393e0a9e50e24dcca9e');
    expect(NUS_RX).toBe('6e400002b5a3f393e0a9e50e24dcca9e');
    expect(NUS_TX).toBe('6e400003b5a3f393e0a9e50e24dcca9e');
    expect(DEFAULT_DEVICE_NAME_PREFIX).toBe('buildagotchi');
  });

  it('normalizes dashed UUIDs', () => {
    expect(normalizeUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E')).toBe(NUS_SERVICE);
  });

  it('matches advertise name by prefix', () => {
    expect(nameMatchesPrefix('buildagotchi', 'buildagotchi')).toBe(true);
    expect(nameMatchesPrefix('buildagotchi-r2', 'buildagotchi')).toBe(true);
    expect(nameMatchesPrefix('Claude Desk', 'buildagotchi')).toBe(false);
    expect(nameMatchesPrefix(undefined, 'buildagotchi')).toBe(false);
  });
});
