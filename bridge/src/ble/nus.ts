/**
 * Nordic UART Service constants shared by NobleTransport and docs.
 * Source: claude-desktop-buddy/REFERENCE.md + Moddable uartserver.js
 */
export const NUS_SERVICE = '6e400001b5a3f393e0a9e50e24dcca9e';
export const NUS_RX = '6e400002b5a3f393e0a9e50e24dcca9e'; // central → peripheral (write)
export const NUS_TX = '6e400003b5a3f393e0a9e50e24dcca9e'; // peripheral → central (notify)

/** Advertise name prefix the firmware MOD must use. */
export const DEFAULT_DEVICE_NAME_PREFIX = 'buildagotchi';

/**
 * Moddable host `uart` RX characteristic `maxBytes` (see uart/bleservices/uart.json).
 * Bridge must chunk writes at or below this; firmware reassembles until `\n`.
 */
export const NUS_RX_CHUNK_BYTES = 64;

/** Normalize UUID strings for noble comparisons (strip dashes, lower-case). */
export function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}

export function nameMatchesPrefix(name: string | undefined | null, prefix: string): boolean {
  if (!name) return false;
  return name.toLowerCase().startsWith(prefix.toLowerCase());
}
