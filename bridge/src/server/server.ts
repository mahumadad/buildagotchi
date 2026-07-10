import { createHash, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, sep as pathSep, resolve } from 'node:path';
import { z } from 'zod';
import type { ClaudeAdapter } from '../adapters/claude-adapter.js';
import type { AttentionManager, ResolveSource } from '../core/attention.js';
import type { BalloonHistory } from '../core/balloon-history.js';
import type { EventBus } from '../core/bus.js';
import {
  type AdapterHealth,
  EMOTIONS,
  type Event,
  type NewEventInput,
  SeveritySchema,
  newEvent,
} from '../core/events.js';
import { type Mode, nextMode } from '../core/modes.js';
import type { StateMachine } from '../core/state-machine.js';
import type { TokenStats } from '../core/token-stats.js';
import { TOKEN_ACCOUNT, TOKEN_SERVICE } from '../platform/platform.js';
import type { Platform } from '../platform/platform.js';
import { type EventRecorder, localDateString } from '../recorder/recorder.js';
import { type ReplayResult, replay } from '../recorder/replay.js';
import type { Metrics } from './metrics.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1MB (SPEC-IMPL-FASE-1A §5.3)
const SSE_KEEPALIVE_MS = 15_000;
const DEFAULT_EVENTS_LIMIT = 50;
const MAX_EVENTS_LIMIT = 200;

export interface HealthPayload {
  adapters: Record<string, { status: AdapterHealth; lastEventAt?: number; detail?: string }>;
  transport: {
    kind: string;
    connected: boolean;
    reconnects: number;
    latency: { p50: number; p95: number };
  };
}

interface MinimalLogger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface BridgeServerOptions {
  host: string;
  port: number;
  rateLimitPerMinute: number;
  requireToken: boolean;
  simulate: boolean;
  logger: MinimalLogger;
  metrics: Metrics;
  platform: Platform;
  bus: EventBus;
  recorder: EventRecorder;
  attentionManager: AttentionManager;
  stateMachine: StateMachine;
  getHealth: () => HealthPayload;
  claudeAdapter?: ClaudeAdapter;
  /** Optional. When present, `GET /balloons` returns its `recent()`. */
  balloonHistory?: BalloonHistory;
  tokenStats?: TokenStats;
  publicDir?: string;
}

const ExternalEventBodySchema = z
  .object({
    source: z.string().min(1),
    category: z.string().min(1),
    severity: SeveritySchema,
    payload: z.record(z.unknown()).optional(),
    hash: z.string().min(1).optional(),
    direction: z.enum(['left', 'right']).optional(),
    ttlMs: z.number().optional(),
  })
  .strict();

/** Token bucket with continuous refill (SPEC-IMPL-FASE-1A §5.3). */
class TokenBucket {
  #capacity: number;
  #refillPerMs: number;
  #tokens: number;
  #lastRefill: number;

  constructor(capacityPerMinute: number, now: () => number = Date.now) {
    this.#capacity = capacityPerMinute;
    this.#refillPerMs = capacityPerMinute / 60_000;
    this.#tokens = capacityPerMinute;
    this.#lastRefill = now();
  }

  tryTake(now: () => number = Date.now): boolean {
    const t = now();
    const elapsed = t - this.#lastRefill;
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#lastRefill = t;
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return true;
    }
    return false;
  }
}

/**
 * Wrap `replay()` so `lastN` — which lives in the HTTP shape, not in
 * ReplayOptions — can slice the ndjson before feeding it. When `lastN` is
 * undefined we call the real file directly; otherwise we materialize a tmp
 * ndjson with the last N event lines and replay THAT. The tmp file is
 * cleaned up in a finally to survive a mid-replay throw.
 */
async function runReplayWithLastN(
  file: string,
  bus: EventBus,
  opts: { instant?: boolean },
  lastN?: number,
): Promise<ReplayResult> {
  if (lastN === undefined) return replay(file, bus, opts);
  const raw = readFileSync(file, 'utf8');
  const eventLines = raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .filter((l) => {
      try {
        const parsed = JSON.parse(l) as { line_type?: unknown };
        return parsed.line_type === 'event';
      } catch {
        return false;
      }
    });
  const slice = eventLines.slice(-lastN);
  const tmpDir = mkdtempSync(join(tmpdir(), 'replay-lastN-'));
  const tmpFile = join(tmpDir, 'slice.ndjson');
  try {
    writeFileSync(tmpFile, slice.join('\n') + '\n');
    return await replay(tmpFile, bus, opts);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function safeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

/**
 * Reads the body up to `maxBytes`. Once the limit is exceeded, incoming
 * chunks are discarded but still drained to `end` — resolving (and letting
 * the caller respond) before the client finishes writing races the socket
 * teardown against the client's still-in-flight upload and shows up as a
 * flaky ECONNRESET on the client side instead of a clean 413.
 */
function readBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; data: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;

    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      total += chunk.length;
      if (total > maxBytes) {
        tooBig = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });

    req.on('end', () => {
      resolve(tooBig ? { ok: false } : { ok: true, data: Buffer.concat(chunks).toString('utf8') });
    });

    req.on('error', () => resolve({ ok: false }));
  });
}

export class BridgeServer {
  #opts: BridgeServerOptions;
  #server: Server;
  #startedAt = 0;
  #token: string | null = null;
  #warnedNoToken = false;
  #bucket: TokenBucket;
  #hookBucket: TokenBucket;
  #sseClients = new Set<ServerResponse>();
  #sseKeepAlive: NodeJS.Timeout | null = null;

  constructor(opts: BridgeServerOptions) {
    this.#opts = opts;
    this.#bucket = new TokenBucket(opts.rateLimitPerMinute);
    this.#hookBucket = new TokenBucket(120);
    // Registered up-front so /metrics exposes it at zero even before the first rejection.
    opts.metrics.counter('external_events_rejected_total', ['reason']);
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        this.#opts.logger.error({ err }, 'unhandled server error');
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      });
    });
  }

  async start(): Promise<void> {
    this.#token = await this.#opts.platform.getSecret(TOKEN_SERVICE, TOKEN_ACCOUNT);
    this.#startedAt = Date.now();
    await new Promise<void>((resolve) => {
      this.#server.listen(this.#opts.port, this.#opts.host, resolve);
    });
    this.#sseKeepAlive = setInterval(() => {
      for (const client of this.#sseClients) client.write(': hb\n\n');
    }, SSE_KEEPALIVE_MS);
    this.#sseKeepAlive.unref();
  }

  async stop(): Promise<void> {
    if (this.#sseKeepAlive) clearInterval(this.#sseKeepAlive);
    for (const client of this.#sseClients) client.end();
    this.#sseClients.clear();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  address(): AddressInfo | null {
    const addr = this.#server.address();
    return addr && typeof addr === 'object' ? addr : null;
  }

  /**
   * The shape every client (dashboard, firmware, MCP) needs to render:
   * resolved face state + attention snapshot. Single source, reused by every
   * path — SSE broadcasts, GET /state, initial /stream snapshot.
   *
   * M14: added `active` and `queue` so the Attention panel renders without
   * polling `/state`. `deadline` inside `active` may be `null` for events
   * whose TTL override is `infinite` (like `permission_critical`).
   */
  #statePayload(): {
    resolvedState: ReturnType<StateMachine['current']>;
    mode: ReturnType<AttentionManager['snapshot']>['mode'];
    active: ReturnType<AttentionManager['snapshot']>['active'];
    queue: ReturnType<AttentionManager['snapshot']>['queue'];
  } {
    const snap = this.#opts.attentionManager.snapshot();
    return {
      resolvedState: this.#opts.stateMachine.current(),
      mode: snap.mode,
      active: snap.active,
      queue: snap.queue,
    };
  }

  /**
   * Broadcast the current state to SSE clients. Reads directly from the state
   * machine and attention manager — no argument — so every caller (emit,
   * sim/mode, sim/touch) sends the same shape, and the class of bug where two
   * paths sent different shapes is gone at the type level (S2.5.15). The
   * defensive wrapper this replaced existed only to tolerate that split.
   */
  notifyState(): void {
    this.#broadcast('state', this.#statePayload());
  }

  notifyEvent(event: unknown): void {
    this.#broadcast('event', event);
  }

  notifyHealth(health: unknown): void {
    this.#broadcast('health', health);
  }

  notifySession(sessions: unknown): void {
    this.#broadcast('session', sessions);
  }

  #broadcast(type: 'state' | 'event' | 'health' | 'session', payload: unknown): void {
    const line = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.#sseClients) client.write(line);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/state') return this.#handleState(res);
    if (method === 'GET' && path === '/events') return this.#handleEvents(url, res);
    if (method === 'GET' && path === '/health') return this.#handleHealth(res);
    if (method === 'GET' && path === '/stream') return this.#handleStream(res);
    if (method === 'GET' && path === '/metrics') return this.#handleMetrics(res);
    if (method === 'GET' && path === '/balloons') return this.#handleBalloons(res);
    if (method === 'GET' && path === '/stats') return this.#handleStats(res);
    if (method === 'POST' && path === '/events') return this.#handlePostEvent(req, res);
    if (method === 'POST' && path === '/hooks/claude') return this.#handleHookClaude(req, res);
    if (method === 'POST' && path === '/replay') return this.#handleReplay(req, res);
    if (method === 'POST' && path.startsWith('/approve/')) {
      return this.#handleApprove(req, res, path);
    }
    if (method === 'POST' && path === '/sim/mode') return this.#handleSimMode(res);
    if (method === 'POST' && path === '/sim/emotion') return this.#handleSimEmotion(req, res);
    if (method === 'POST' && path === '/sim/button') return this.#handleSimButton(req, res);
    if (method === 'POST' && path === '/sim/touch') return this.#handleSimTouch(req, res);
    if (method === 'POST' && path === '/sim/permission') return this.#handleSimPermission(req, res);
    if (method === 'GET' && path === '/') return this.#serveStatic('/index.html', res);
    if (method === 'GET' && this.#isStaticPath(path)) return this.#serveStatic(path, res);

    sendJson(res, 404, { error: 'not found' });
  }

  #handleState(res: ServerResponse): void {
    // GET /state adds `uptimeMs` on top of the SSE-shared payload.
    sendJson(res, 200, {
      ...this.#statePayload(),
      uptimeMs: Date.now() - this.#startedAt,
    });
  }

  #handleEvents(url: URL, res: ServerResponse): void {
    const limitParam = Number(url.searchParams.get('limit') ?? DEFAULT_EVENTS_LIMIT);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : DEFAULT_EVENTS_LIMIT;
    sendJson(res, 200, this.#opts.recorder.recent(Math.min(limit, MAX_EVENTS_LIMIT)));
  }

  #handleHealth(res: ServerResponse): void {
    const health = this.#opts.getHealth();
    sendJson(res, 200, { bridge: 'ok', ...health });
  }

  #handleStream(res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': hb\n\n');
    this.#sseClients.add(res);
    res.on('close', () => {
      this.#sseClients.delete(res);
    });
    this.#writeSse(res, 'state', this.#statePayload());
    if (this.#opts.claudeAdapter) {
      this.#writeSse(res, 'session', this.#sessionsPayload());
    }
  }

  #writeSse(res: ServerResponse, event: string, data: unknown): void {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // client disconnected
    }
  }

  #sessionsPayload(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!this.#opts.claudeAdapter) return out;
    for (const [id, s] of this.#opts.claudeAdapter.sessions()) {
      out[id] = s;
    }
    return out;
  }

  #handleMetrics(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(this.#opts.metrics.exposition());
  }

  /**
   * M15: last N balloons the face has shown. No auth (localhost, non-destructive
   * — D26). Empty array if the history isn't wired.
   */
  /** Token spend and context pressure (see core/token-stats.ts). */
  #handleStats(res: ServerResponse): void {
    const snapshot = this.#opts.tokenStats?.snapshot() ?? {
      output: { sinceStart: 0, today: 0 },
      context: { bySession: {}, max: 0 },
    };
    sendJson(res, 200, snapshot);
  }

  #handleBalloons(res: ServerResponse): void {
    const recent = this.#opts.balloonHistory?.recent() ?? [];
    sendJson(res, 200, recent);
  }

  /**
   * M16: re-runs an ndjson through the bus. Gated by `--simulate` (S2.5.7):
   * republishing to the bus in production would rewrite real state. Path
   * traversal is closed via `realpath` — plain `resolve()` misses symlinks
   * that escape the recorder dir.
   */
  async #handleReplay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#opts.simulate) {
      sendJson(res, 403, { error: 'replay disabled in production' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: { file?: unknown; lastN?: unknown; instant?: unknown } = {};
    if (body.data.length > 0) {
      try {
        parsed = JSON.parse(body.data);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' });
        return;
      }
    }

    const recorderDir = this.#opts.recorder.dir;
    let filePath: string;
    if (typeof parsed.file === 'string') {
      const naive = resolve(recorderDir, parsed.file);
      // realpath resolves symlinks; a symlink escaping the recorder dir would
      // land the real path outside — reject with 400 rather than reading it.
      let real: string;
      try {
        real = realpathSync(naive);
      } catch {
        sendJson(res, 400, { error: 'file not found' });
        return;
      }
      const realRoot = realpathSync(recorderDir);
      if (!real.startsWith(realRoot + pathSep) && real !== realRoot) {
        sendJson(res, 400, { error: 'path escapes recorder dir' });
        return;
      }
      filePath = real;
    } else {
      // Local date, matching the recorder's own rotation (see recorder.ts).
      filePath = join(recorderDir, `${localDateString(Date.now())}.ndjson`);
    }

    if (!existsSync(filePath)) {
      sendJson(res, 400, { error: 'no ndjson to replay' });
      return;
    }

    const lastN =
      typeof parsed.lastN === 'number' && parsed.lastN > 0 ? Math.floor(parsed.lastN) : undefined;
    const instant = parsed.instant === true;

    // Setting replay mode on the recorder tags every re-recorded line so the
    // day-log doesn't turn into a lie later. Restored in finally.
    this.#opts.recorder.setReplayMode(true);
    try {
      const result = await runReplayWithLastN(filePath, this.#opts.bus, { instant }, lastN);
      this.#opts.metrics.counter('replay_runs_total').inc();
      sendJson(res, 200, result);
    } catch (err) {
      this.#opts.logger.error({ err }, 'replay failed');
      sendJson(res, 500, { error: 'replay failed' });
    } finally {
      this.#opts.recorder.setReplayMode(false);
    }
  }

  async #handlePostEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authError = this.#checkAuth(req);
    if (authError) {
      if (authError.status === 401) {
        this.#opts.metrics.counter('external_events_rejected_total', ['reason']).inc({
          reason: 'auth',
        });
      }
      sendJson(res, authError.status, authError.body);
      return;
    }

    if (!this.#bucket.tryTake()) {
      this.#opts.metrics.counter('external_events_rejected_total', ['reason']).inc({
        reason: 'rate_limit',
      });
      sendJson(res, 429, { error: 'rate limit exceeded' });
      return;
    }

    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(body.data);
    } catch {
      this.#opts.metrics.counter('external_events_rejected_total', ['reason']).inc({
        reason: 'schema',
      });
      sendJson(res, 400, { issues: ['body: invalid JSON'] });
      return;
    }

    const parsed = ExternalEventBodySchema.safeParse(raw);
    if (!parsed.success) {
      this.#opts.metrics.counter('external_events_rejected_total', ['reason']).inc({
        reason: 'schema',
      });
      sendJson(res, 400, {
        issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
      return;
    }

    const input = parsed.data;
    const source = input.source.startsWith('external:') ? input.source : `external:${input.source}`;
    const eventInput: NewEventInput = {
      source,
      category: input.category,
      severity: input.severity,
    };
    if (input.payload !== undefined) eventInput.payload = input.payload;
    if (input.hash !== undefined) eventInput.hash = input.hash;
    if (input.direction !== undefined) eventInput.direction = input.direction;
    if (input.ttlMs !== undefined) eventInput.ttlMs = input.ttlMs;
    const event: Event = newEvent(eventInput);

    const outcome = this.#opts.bus.publish(event);
    if (outcome.kind === 'invalid') {
      this.#opts.metrics.counter('external_events_rejected_total', ['reason']).inc({
        reason: 'schema',
      });
      sendJson(res, 400, { issues: outcome.issues });
      return;
    }

    sendJson(res, 202, { id: event.id, outcome });
  }

  async #handleHookClaude(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#opts.claudeAdapter) {
      sendJson(res, 404, { error: 'claude adapter not configured' });
      return;
    }
    if (!this.#hookBucket.tryTake()) {
      sendJson(res, 429, { error: 'rate limit exceeded' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.data);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
    if (typeof parsed.hook_event_name !== 'string' || typeof parsed.session_id !== 'string') {
      sendJson(res, 400, { error: 'missing hook_event_name or session_id' });
      return;
    }
    this.#opts.claudeAdapter.handleHookEvent(parsed);
    sendJson(res, 202, { ok: true });
  }

  async #handleApprove(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const authError = this.#checkAuth(req);
    if (authError && !this.#opts.simulate) {
      sendJson(res, authError.status, authError.body);
      return;
    }
    if (!this.#opts.claudeAdapter) {
      sendJson(res, 404, { error: 'claude adapter not configured' });
      return;
    }
    const sessionId = path.slice('/approve/'.length);
    if (!sessionId) {
      sendJson(res, 400, { error: 'missing session ID' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.data);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
    const action = parsed.action;
    if (action !== 'approve' && action !== 'deny') {
      sendJson(res, 400, { error: 'action must be approve or deny' });
      return;
    }
    const mapped = action === 'approve' ? 'approved' : 'denied';
    const eventId = this.#opts.claudeAdapter.resolvePermission(sessionId, mapped);
    if (eventId) {
      this.#opts.attentionManager.resolve(
        eventId,
        mapped === 'approved' ? 'approved' : 'denied',
        'dashboard',
      );
      sendJson(res, 200, { resolved: true });
    } else {
      sendJson(res, 404, { error: 'no pending permission' });
    }
  }

  /**
   * Real input coming off the firmware over BLE (`ProtocolSession.onInboundEvent`).
   * Deliberately the same semantics as the `/sim/*` endpoints below: button C
   * cycles the mode, A approves, B denies, a head tap approves, a hold sleeps.
   * If the two ever diverge, the simulator stops being evidence about the robot.
   */
  handleDeviceInput(kind: 'button' | 'touch', detail: unknown): void {
    if (kind === 'button') {
      const button = (detail as { button?: unknown })?.button;
      if (button === 'C') {
        this.#cycleMode();
        return;
      }
      if (button !== 'A' && button !== 'B') return;
      const action = button === 'A' ? 'approve' : 'deny';
      if (this.#resolveFirstPendingPermission(action, 'button')) return;
      this.#opts.bus.publish(
        newEvent({
          source: 'firmware',
          category: 'button_pressed',
          severity: 'low',
          payload: { button },
        }),
      );
      return;
    }

    const gesture = (detail as { gesture?: unknown })?.gesture;
    if (gesture === 'tap' && this.#resolveFirstPendingPermission('approve', 'head')) return;
    if (gesture === 'hold') {
      this.#opts.attentionManager.setMode('SLEEP');
      this.#opts.stateMachine.apply(this.#opts.attentionManager.snapshot().active);
      this.notifyState();
      return;
    }
    if (typeof gesture !== 'string') return;
    this.#opts.bus.publish(
      newEvent({
        source: 'firmware',
        category: 'touch_head',
        severity: 'low',
        payload: { gesture },
      }),
    );
  }

  #cycleMode(): Mode {
    const next = nextMode(this.#opts.attentionManager.snapshot().mode);
    this.#opts.attentionManager.setMode(next);
    this.#opts.stateMachine.apply(this.#opts.attentionManager.snapshot().active);
    this.notifyState();
    return next;
  }

  #handleSimMode(res: ServerResponse): void {
    if (!this.#opts.simulate) {
      sendJson(res, 403, { error: 'simulation endpoints disabled in production' });
      return;
    }
    sendJson(res, 200, { mode: this.#cycleMode() });
  }

  async #handleSimEmotion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#opts.simulate) {
      sendJson(res, 403, { error: 'simulation endpoints disabled in production' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.data);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
    const emotion = parsed.emotion;
    if (typeof emotion !== 'string' || !EMOTIONS.includes(emotion as never)) {
      sendJson(res, 400, { error: `emotion must be one of: ${EMOTIONS.join(', ')}` });
      return;
    }
    const event = newEvent({
      source: 'mcp:set_face',
      category: 'face_override',
      severity: 'medium',
      payload: { emotion, balloon: parsed.balloon ?? undefined },
      ttlMs: 10_000,
    });
    this.#opts.bus.publish(event);
    sendJson(res, 202, { emotion, id: event.id });
  }

  async #handleSimButton(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#opts.simulate) {
      sendJson(res, 403, { error: 'simulation endpoints disabled in production' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.data);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
    const button = parsed.button;
    if (button !== 'A' && button !== 'B' && button !== 'C') {
      sendJson(res, 400, { error: 'button must be A, B, or C' });
      return;
    }
    if (button === 'C') {
      this.#handleSimMode(res);
      return;
    }
    const action = button === 'A' ? 'approve' : 'deny';
    const resolved = this.#resolveFirstPendingPermission(action, 'button');
    if (resolved) {
      sendJson(res, 200, { button, action, resolved: true, sessionId: resolved });
      return;
    }
    const event = newEvent({
      source: 'firmware',
      category: 'button_pressed',
      severity: 'low',
      payload: { button },
    });
    this.#opts.bus.publish(event);
    sendJson(res, 202, { button, id: event.id });
  }

  async #handleSimTouch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#opts.simulate) {
      sendJson(res, 403, { error: 'simulation endpoints disabled in production' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body.data);
    } catch {
      sendJson(res, 400, { error: 'invalid JSON' });
      return;
    }
    const gesture = parsed.gesture;
    const valid = ['tap', 'swipe_fwd', 'swipe_back', 'hold'];
    if (typeof gesture !== 'string' || !valid.includes(gesture)) {
      sendJson(res, 400, { error: `gesture must be one of: ${valid.join(', ')}` });
      return;
    }
    if (gesture === 'tap') {
      const resolved = this.#resolveFirstPendingPermission('approve', 'head');
      if (resolved) {
        sendJson(res, 200, { gesture, action: 'approve', resolved: true, sessionId: resolved });
        return;
      }
    }
    if (gesture === 'hold') {
      this.#opts.attentionManager.setMode('SLEEP');
      this.#opts.stateMachine.apply(this.#opts.attentionManager.snapshot().active);
      this.notifyState();
      sendJson(res, 200, { gesture, mode: 'SLEEP' });
      return;
    }
    const event = newEvent({
      source: 'firmware',
      category: 'touch_head',
      severity: gesture === 'hold' ? 'medium' : 'low',
      payload: { gesture },
    });
    this.#opts.bus.publish(event);
    sendJson(res, 202, { gesture, id: event.id });
  }

  #resolveFirstPendingPermission(action: 'approve' | 'deny', source: ResolveSource): string | null {
    if (!this.#opts.claudeAdapter) return null;
    for (const [sessionId, session] of this.#opts.claudeAdapter.sessions()) {
      if (session.pendingPermission) {
        const mapped = action === 'approve' ? 'approved' : 'denied';
        const eventId = this.#opts.claudeAdapter.resolvePermission(sessionId, mapped);
        if (eventId) {
          this.#opts.attentionManager.resolve(eventId, mapped, source);
          return sessionId;
        }
      }
    }
    return null;
  }

  async #handleSimPermission(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#opts.simulate) {
      sendJson(res, 403, { error: 'simulation endpoints disabled in production' });
      return;
    }
    if (!this.#opts.claudeAdapter) {
      sendJson(res, 404, { error: 'claude adapter not configured' });
      return;
    }
    const body = await readBody(req, MAX_BODY_BYTES);
    if (!body.ok) {
      sendJson(res, 413, { error: 'payload too large' });
      return;
    }
    let parsed: Record<string, unknown> = {};
    if (body.data.length > 0) {
      try {
        parsed = JSON.parse(body.data);
      } catch {
        sendJson(res, 400, { error: 'invalid JSON' });
        return;
      }
    }
    const requestedSessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
    const existing = requestedSessionId
      ? this.#opts.claudeAdapter.sessions().get(requestedSessionId)
      : undefined;
    const sessionId = requestedSessionId ?? `sim-${Date.now().toString(36)}`;
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : (existing?.cwd ?? '/sim/cwd');
    const command = typeof parsed.command === 'string' ? parsed.command : 'rm -rf /tmp/example';
    if (!existing) {
      this.#opts.claudeAdapter.handleHookEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        cwd,
        prompt: command,
      });
    }
    this.#opts.claudeAdapter.handleHookEvent({
      hook_event_name: 'Notification',
      session_id: sessionId,
      cwd,
      notification_type: 'permission_prompt',
      command,
      message: command,
    });
    sendJson(res, 202, { sessionId, command, existed: !!existing });
  }

  #isStaticPath(path: string): boolean {
    return /^\/([\w./-]+\.(?:html|css|js|mjs|stl))$/.test(path);
  }

  #serveStatic(path: string, res: ServerResponse): void {
    if (!this.#opts.publicDir) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const filename = path === '/' ? 'index.html' : path.slice(1);
    if (filename.includes('..')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const filePath = join(this.#opts.publicDir, filename);
    if (!existsSync(filePath)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const contentTypes: Record<string, string> = {
      html: 'text/html; charset=utf-8',
      css: 'text/css; charset=utf-8',
      js: 'text/javascript; charset=utf-8',
      mjs: 'text/javascript; charset=utf-8',
      stl: 'application/octet-stream',
    };
    const ext = filename.split('.').pop() ?? '';
    const contentType = contentTypes[ext] ?? 'application/octet-stream';
    const binary = ext === 'stl';
    const content = binary ? readFileSync(filePath) : readFileSync(filePath, 'utf-8');
    res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' });
    res.end(content);
  }

  #checkAuth(req: IncomingMessage): { status: 401 | 503; body: unknown } | null {
    if (!this.#opts.requireToken) return null;

    if (this.#token === null) {
      if (this.#opts.simulate) {
        if (!this.#warnedNoToken) {
          this.#warnedNoToken = true;
          this.#opts.logger.warn(
            {},
            'POST /events: no token provisioned, allowing request because --simulate is set',
          );
        }
        return null;
      }
      return { status: 503, body: { error: 'token not provisioned, run bridge init' } };
    }

    const header = req.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    if (!provided || !safeEqual(provided, this.#token)) {
      return { status: 401, body: { error: 'unauthorized' } };
    }
    return null;
  }
}
