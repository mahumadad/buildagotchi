import { readdirSync, unlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus } from '../core/bus.js';
import { type Adapter, type AdapterHealth, newEvent } from '../core/events.js';
import type { Metrics } from '../server/metrics.js';
import { readTranscriptTail } from './claude-transcript.js';

interface MinimalLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  state: 'working' | 'idle' | 'permission_pending' | 'stale';
  lastEventAt: number;
  pendingPermission?:
    | {
        eventId: string;
        command?: string;
        isCritical: boolean;
      }
    | undefined;
}

export interface ClaudeAdapterConfig {
  staleSessionTimeoutMs: number;
  transcriptReadEnabled: boolean;
  unknownLineThreshold: number;
  unknownLineBrokenThreshold: number;
}

export interface ClaudeAdapterDeps {
  logger: MinimalLogger;
  metrics: Metrics;
  criticalCommands: string[];
  stateDir: string;
}

const HEALTH_RANK: Record<AdapterHealth, number> = { HEALTHY: 0, DEGRADED: 1, BROKEN: 2 };
const RANK_TO_HEALTH: AdapterHealth[] = ['HEALTHY', 'DEGRADED', 'BROKEN'];
const STALE_EXTRA_MS = 300_000;
const HOOK_DEGRADED_MS = 300_000;

export class ClaudeAdapter implements Adapter {
  readonly name = 'claude';

  #cfg: ClaudeAdapterConfig;
  #deps: ClaudeAdapterDeps;
  #bus: EventBus | null = null;
  #sessions = new Map<string, ClaudeSession>();
  #lastEventAt: number | undefined;
  #unknownLineRatio = 0;
  #staleTimer: NodeJS.Timeout | null = null;
  #onSessionChange: ((sessions: ReadonlyMap<string, ClaudeSession>) => void) | null = null;

  constructor(cfg: ClaudeAdapterConfig, deps: ClaudeAdapterDeps) {
    this.#cfg = cfg;
    this.#deps = deps;
  }

  set onSessionChangeCallback(cb: (sessions: ReadonlyMap<string, ClaudeSession>) => void) {
    this.#onSessionChange = cb;
  }

  async start(bus: EventBus): Promise<void> {
    this.#bus = bus;
    this.#loadFallbackFiles();
    this.#staleTimer = setInterval(() => this.#cleanStale(), 60_000);
  }

  async stop(): Promise<void> {
    if (this.#staleTimer) {
      clearInterval(this.#staleTimer);
      this.#staleTimer = null;
    }
  }

  health(): { status: AdapterHealth; lastEventAt?: number; detail?: string } {
    const hookHealth = this.#computeHookHealth();
    const parseHealth = this.#computeParseHealth();
    const status = this.#worst(hookHealth, parseHealth);
    const result: { status: AdapterHealth; lastEventAt?: number; detail?: string } = { status };
    if (this.#lastEventAt !== undefined) result.lastEventAt = this.#lastEventAt;
    if (status !== 'HEALTHY') result.detail = `hook:${hookHealth} parse:${parseHealth}`;
    return result;
  }

  handleHookEvent(payload: Record<string, unknown>): void {
    const hookEventName = payload.hook_event_name;
    const sessionId = payload.session_id;
    if (typeof hookEventName !== 'string' || typeof sessionId !== 'string') {
      this.#deps.logger.warn(
        { payload },
        'invalid hook payload: missing hook_event_name or session_id',
      );
      return;
    }

    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
    const now = Date.now();
    this.#lastEventAt = now;

    let session = this.#sessions.get(sessionId);
    if (!session) {
      session = { sessionId, cwd, state: 'idle', lastEventAt: now };
      this.#sessions.set(sessionId, session);
    } else {
      session.lastEventAt = now;
      if (cwd) session.cwd = cwd;
    }

    switch (hookEventName) {
      case 'UserPromptSubmit':
        session.state = 'working';
        this.#emit('prompt', 'ambient', { sessionId, cwd: session.cwd });
        break;

      case 'Stop': {
        // The Stop payload carries the final text as `last_assistant_message`; only
        // dip into the transcript for the token count, which the payload lacks.
        const enrichment = this.#readTranscript(payload);
        const text =
          typeof payload.last_assistant_message === 'string'
            ? payload.last_assistant_message
            : enrichment?.text;
        session.state = 'idle';
        this.#emit('response', 'ambient', {
          sessionId,
          cwd: session.cwd,
          ...(enrichment?.tokens !== undefined ? { tokens: enrichment.tokens } : {}),
          ...(text !== undefined ? { text } : {}),
        });
        break;
      }

      case 'SessionEnd':
        this.#sessions.delete(sessionId);
        break;

      case 'Notification': {
        if (payload.notification_type === 'permission_prompt') {
          session.state = 'permission_pending';
          const enrichment = this.#readTranscript(payload);
          const command = enrichment?.command;
          const isCritical = command
            ? this.#deps.criticalCommands.some((c) => command.includes(c))
            : false;
          const event = newEvent({
            source: 'claude',
            category: 'permission',
            severity: 'critical',
            payload: {
              sessionId,
              cwd: session.cwd,
              ...(command !== undefined ? { command } : {}),
              isCritical,
            },
          });
          const pending: { eventId: string; command?: string; isCritical: boolean } = {
            eventId: event.id,
            isCritical,
          };
          if (command !== undefined) pending.command = command;
          session.pendingPermission = pending;
          this.#bus?.publish(event);
        } else {
          this.#emit('notification', 'low', {
            sessionId,
            type: payload.type,
          });
        }
        break;
      }

      case 'SubagentStop':
        this.#emit('subagent', 'ambient', { sessionId });
        break;

      default:
        this.#deps.logger.warn({ hookEventName }, 'unknown hook event');
        break;
    }

    this.#deps.metrics
      .counter('claude_hook_events_total', ['hook_event'])
      .inc({ hook_event: hookEventName });
    this.#notifySessionChange();
  }

  sessions(): ReadonlyMap<string, ClaudeSession> {
    return this.#sessions;
  }

  resolvePermission(sessionId: string, action: 'approved' | 'denied'): string | null {
    const session = this.#sessions.get(sessionId);
    if (!session?.pendingPermission) return null;

    const eventId = session.pendingPermission.eventId;
    session.pendingPermission = undefined;
    session.state = action === 'approved' ? 'working' : 'idle';
    this.#notifySessionChange();
    return eventId;
  }

  #emit(
    category: string,
    severity: 'critical' | 'high' | 'medium' | 'low' | 'ambient',
    payload: Record<string, unknown>,
  ): void {
    const event = newEvent({ source: 'claude', category, severity, payload });
    this.#bus?.publish(event);
  }

  #readTranscript(payload: Record<string, unknown>) {
    if (!this.#cfg.transcriptReadEnabled) return null;
    const transcriptPath = payload.transcript_path;
    if (typeof transcriptPath !== 'string') return null;
    const enrichment = readTranscriptTail(transcriptPath, 50);
    if (enrichment) {
      this.#unknownLineRatio = enrichment.unknownLineRatio;
    }
    return enrichment;
  }

  #loadFallbackFiles(): void {
    let files: string[];
    try {
      files = readdirSync(this.#deps.stateDir);
    } catch {
      return;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(this.#deps.stateDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        this.handleHookEvent(parsed);
        unlinkSync(filePath);
      } catch (err) {
        this.#deps.logger.warn({ err, file }, 'failed to process fallback state file');
      }
    }
  }

  #cleanStale(): void {
    const now = Date.now();
    let changed = false;

    for (const [id, session] of this.#sessions) {
      const elapsed = now - session.lastEventAt;
      if (session.state === 'stale' && elapsed > this.#cfg.staleSessionTimeoutMs + STALE_EXTRA_MS) {
        this.#sessions.delete(id);
        changed = true;
      } else if (session.state !== 'stale' && elapsed > this.#cfg.staleSessionTimeoutMs) {
        session.state = 'stale';
        changed = true;
      }
    }

    if (changed) this.#notifySessionChange();
  }

  #computeHookHealth(): AdapterHealth {
    if (this.#lastEventAt === undefined) return 'HEALTHY';
    return Date.now() - this.#lastEventAt > HOOK_DEGRADED_MS ? 'DEGRADED' : 'HEALTHY';
  }

  #computeParseHealth(): AdapterHealth {
    if (this.#unknownLineRatio > this.#cfg.unknownLineBrokenThreshold / 100) return 'BROKEN';
    if (this.#unknownLineRatio > this.#cfg.unknownLineThreshold / 100) return 'DEGRADED';
    return 'HEALTHY';
  }

  #worst(a: AdapterHealth, b: AdapterHealth): AdapterHealth {
    return RANK_TO_HEALTH[Math.max(HEALTH_RANK[a], HEALTH_RANK[b])] as AdapterHealth;
  }

  #notifySessionChange(): void {
    this.#onSessionChange?.(this.#sessions);
  }
}
