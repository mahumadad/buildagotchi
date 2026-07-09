import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClaudeAdapter } from '../adapters/claude-adapter.js';
import type { AttentionManager } from '../core/attention.js';
import type { EventBus } from '../core/bus.js';
import {
  type AdapterHealth,
  type Event,
  type NewEventInput,
  SeveritySchema,
  newEvent,
} from '../core/events.js';
import type { StateMachine } from '../core/state-machine.js';
import { TOKEN_ACCOUNT, TOKEN_SERVICE } from '../platform/platform.js';
import type { Platform } from '../platform/platform.js';
import type { EventRecorder } from '../recorder/recorder.js';
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

  notifyState(state: unknown): void {
    this.#broadcast('state', state);
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
    if (method === 'POST' && path === '/events') return this.#handlePostEvent(req, res);
    if (method === 'POST' && path === '/hooks/claude') return this.#handleHookClaude(req, res);
    if (method === 'POST' && path.startsWith('/approve/')) {
      return this.#handleApprove(req, res, path);
    }
    if (method === 'GET' && path === '/') return this.#serveStatic('/index.html', res);
    if (method === 'GET' && this.#isStaticPath(path)) return this.#serveStatic(path, res);

    sendJson(res, 404, { error: 'not found' });
  }

  #handleState(res: ServerResponse): void {
    const snapshot = this.#opts.attentionManager.snapshot();
    sendJson(res, 200, {
      resolvedState: this.#opts.stateMachine.current(),
      active: snapshot.active,
      queue: snapshot.queue,
      mode: snapshot.mode,
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
  }

  #handleMetrics(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(this.#opts.metrics.exposition());
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
    const resolved = this.#opts.claudeAdapter.resolvePermission(sessionId, mapped);
    if (resolved) {
      sendJson(res, 200, { resolved: true });
    } else {
      sendJson(res, 404, { error: 'no pending permission' });
    }
  }

  #isStaticPath(path: string): boolean {
    return /^\/([\w-]+\.(?:html|css|js))$/.test(path);
  }

  #serveStatic(path: string, res: ServerResponse): void {
    if (!this.#opts.publicDir) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const filename = path === '/' ? 'index.html' : path.slice(1);
    if (filename.includes('..') || filename.includes('/')) {
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
    };
    const ext = filename.split('.').pop() ?? '';
    const contentType = contentTypes[ext] ?? 'application/octet-stream';
    const content = readFileSync(filePath, 'utf-8');
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
