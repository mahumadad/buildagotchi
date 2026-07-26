export type TransportState = 'disconnected' | 'connecting' | 'connected';

export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Best-effort: if not connected, drop the line + warn (no throw, no queueing). */
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onStateChange(cb: (s: TransportState) => void): void;
  /**
   * Optional hard recovery for a wedged transport: tear down and re-initialise
   * any process-wide native state so the next connect() starts clean. The
   * reconnect loop calls this after repeated failures. Transports with no such
   * state (sim, loopback) leave it unimplemented.
   */
  reset?(): Promise<void>;
}
