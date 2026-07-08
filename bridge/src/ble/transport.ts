export type TransportState = 'disconnected' | 'connecting' | 'connected';

export interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Best-effort: if not connected, drop the line + warn (no throw, no queueing). */
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onStateChange(cb: (s: TransportState) => void): void;
}
