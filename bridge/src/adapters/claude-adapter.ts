import { readdirSync, unlinkSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EventBus } from '../core/bus.js';
import { type Adapter, type AdapterHealth, newEvent } from '../core/events.js';
import type { Metrics } from '../server/metrics.js';
import {
  defaultClaudeDesktopSessionsDir,
  readDesktopSessionTitles,
} from './claude-desktop-titles.js';
import { scanClaudeSessions } from './claude-jsonl-scanner.js';
import { readTranscriptTail } from './claude-transcript.js';
import { summarizeToolUse } from './tool-summary.js';

interface MinimalLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Every event category this adapter can emit. Consumed by the M13 contract test
 * that iterates all presets and asserts each has either a template or a
 * documented `silentCategories` entry (S2.5.8) — the same failure mode that hid
 * the vacuous `PersonalityManager.balloon()` for two phases.
 *
 * Adding a category here without updating the presets fails the test loudly.
 */
export const CLAUDE_CATEGORIES = [
  'prompt',
  'response',
  'permission',
  'permission_critical',
  'permission_resolved',
  'notification',
  'subagent',
] as const;

/**
 * Categories emitted with `severity: 'critical'`. Consumed by the TTL guard
 * test (S2.5.8): for every entry here, `AmConfig.ttlOverrides` MUST resolve to
 * `null` (infinite). Without this, `permission_critical` would silently fall
 * to `ttlBySeverity.critical` (5m) and leave the balloon stale — the exact
 * scenario the council verified on 2026-07-09.
 */
export const CLAUDE_CRITICAL_CATEGORIES = ['permission', 'permission_critical'] as const;

export type ClaudeCategory = (typeof CLAUDE_CATEGORIES)[number];

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  /** User-assigned chat title from Claude Desktop (titleSource="user").
   *  Highest-priority name shown in the dashboard when present. */
  desktopTitle?: string | undefined;
  /** Human-readable slug assigned by Claude Code (e.g. "dreamy-stirring-beaver").
   *  Only populated from transcript scan; hooks don't emit this field. */
  slug?: string | undefined;
  title?: string | undefined;
  state: 'working' | 'idle' | 'permission_pending' | 'stale';
  lastEventAt: number;
  lastPrompt?: string | undefined;
  lastResponse?: string | undefined;
  /**
   * Event id of the `prompt` currently in flight for this session, if any.
   * A prompt stops meaning anything once its `response` arrives, so the
   * response retires it (D-06). Without this, both being `ambient`, the
   * response would queue behind its own prompt and only surface when the
   * prompt expired 30s later — the answer reaching the screen long after
   * Claude gave it.
   */
  pendingPromptEventId?: string | undefined;
  pendingPermission?:
    | {
        eventId: string;
        command?: string;
        isCritical: boolean;
        toolName?: string;
        summary?: string;
      }
    | undefined;
  /** Summary of the last PreToolUse seen for this session, used to enrich the
   *  next permission prompt; overwritten on every tool call. Only the derived
   *  summary/command are kept — the raw tool_input (which the whole session is
   *  serialized to the dashboard SSE) must not carry file contents or secrets. */
  lastToolUse?: { toolName: string; command?: string; summary: string } | undefined;
}

export interface ClaudeAdapterConfig {
  staleSessionTimeoutMs: number;
  transcriptReadEnabled: boolean;
  unknownLineThreshold: number;
  unknownLineBrokenThreshold: number;
  /** How often to scan ~/.claude/projects for active sessions (0 disables). Default 30s. */
  scanIntervalMs?: number;
  /** Only files with mtime within this window are considered live. Default 2h. */
  scanFreshWindowMs?: number;
}

export interface ClaudeAdapterDeps {
  logger: MinimalLogger;
  metrics: Metrics;
  criticalCommands: string[];
  stateDir: string;
  /** Root of Claude Code transcript storage. Default `~/.claude/projects`. */
  projectsDir?: string;
  /** Claude Desktop's chat metadata dir. Default: macOS Application Support path. */
  claudeDesktopSessionsDir?: string;
}

const HEALTH_RANK: Record<AdapterHealth, number> = { HEALTHY: 0, DEGRADED: 1, BROKEN: 2 };
const RANK_TO_HEALTH: AdapterHealth[] = ['HEALTHY', 'DEGRADED', 'BROKEN'];
const STALE_EXTRA_MS = 300_000;
const HOOK_DEGRADED_MS = 300_000;
const DEFAULT_SCAN_INTERVAL_MS = 30_000;
const DEFAULT_SCAN_FRESH_WINDOW_MS = 2 * 60 * 60 * 1000;

function defaultProjectsDir(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return home ? join(home, '.claude', 'projects') : '';
}

export class ClaudeAdapter implements Adapter {
  readonly name = 'claude';

  #cfg: ClaudeAdapterConfig;
  #deps: ClaudeAdapterDeps;
  #bus: EventBus | null = null;
  #sessions = new Map<string, ClaudeSession>();
  #lastEventAt: number | undefined;
  #unknownLineRatio = 0;
  #staleTimer: NodeJS.Timeout | null = null;
  #scanTimer: NodeJS.Timeout | null = null;
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

    const scanInterval = this.#cfg.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
    if (scanInterval > 0) {
      // Fire once at startup so sessions that existed before this process launched appear
      // in the dashboard immediately (D19 hybrid: hooks still handle real-time events).
      void this.#runScan();
      this.#scanTimer = setInterval(() => void this.#runScan(), scanInterval);
    }
  }

  async stop(): Promise<void> {
    if (this.#staleTimer) {
      clearInterval(this.#staleTimer);
      this.#staleTimer = null;
    }
    if (this.#scanTimer) {
      clearInterval(this.#scanTimer);
      this.#scanTimer = null;
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
      case 'UserPromptSubmit': {
        // If the user approved/denied a permission in the CLI or Desktop chat
        // instead of the dashboard, we never got a resolve — clear it now so the
        // card and balloon stop showing a stale pending state.
        this.#autoResolvePending(session, 'external');
        session.state = 'working';
        const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
        if (prompt !== undefined) {
          session.lastPrompt = prompt;
          if (!session.title) session.title = prompt.replace(/\s+/g, ' ').trim().slice(0, 80);
        }
        // A new prompt supersedes the previous one; only the latest matters.
        // Without this, an unanswered prompt lingers in the AM for its full
        // 30s ambient TTL while a newer one waits behind it.
        const supersedes = session.pendingPromptEventId;
        session.pendingPromptEventId = this.#emit('prompt', 'ambient', {
          sessionId,
          cwd: session.cwd,
          ...(prompt !== undefined ? { text: prompt } : {}),
          ...(supersedes !== undefined ? { resolvesEventId: supersedes } : {}),
        });
        break;
      }

      case 'Stop': {
        this.#autoResolvePending(session, 'external');
        // The Stop payload carries the final text as `last_assistant_message`; only
        // dip into the transcript for the token count, which the payload lacks.
        const enrichment = this.#readTranscript(payload);
        const text =
          typeof payload.last_assistant_message === 'string'
            ? payload.last_assistant_message
            : enrichment?.text;
        session.state = 'idle';
        if (text !== undefined) session.lastResponse = text;
        // The prompt has been answered; it no longer describes anything. Retire
        // it (D-06) or the response — also `ambient` — queues behind it and only
        // reaches the screen when the prompt expires 30s later.
        const answeredPrompt = session.pendingPromptEventId;
        session.pendingPromptEventId = undefined;
        this.#emit('response', 'ambient', {
          sessionId,
          cwd: session.cwd,
          ...(enrichment?.tokens !== undefined ? { tokens: enrichment.tokens } : {}),
          ...(enrichment?.contextTokens !== undefined
            ? { contextTokens: enrichment.contextTokens }
            : {}),
          ...(text !== undefined ? { text } : {}),
          ...(answeredPrompt !== undefined ? { resolvesEventId: answeredPrompt } : {}),
        });
        break;
      }

      case 'PostToolUse': {
        // PostToolUse fires after Claude Code runs a tool the user approved.
        // If we had a pending permission on this session, that's how it was resolved.
        this.#autoResolvePending(session, 'approved');
        break;
      }

      case 'PreToolUse': {
        const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
        const toolInput =
          payload.tool_input && typeof payload.tool_input === 'object'
            ? (payload.tool_input as Record<string, unknown>)
            : undefined;
        if (toolName) {
          // Summarize now and discard the raw input — it must not linger on the
          // session, which is serialized wholesale to the dashboard SSE.
          const { command, summary } = summarizeToolUse(toolName, toolInput ?? {});
          session.lastToolUse = { toolName, summary, ...(command !== undefined ? { command } : {}) };
        }
        break;
      }

      case 'SessionEnd':
        this.#retireSession(session);
        break;

      case 'Notification': {
        if (payload.notification_type === 'permission_prompt') {
          session.state = 'permission_pending';
          const enrichment = this.#readTranscript(payload);
          const tool = session.lastToolUse;
          // Priority: explicit payload command (sim/push) → PreToolUse-derived →
          // transcript scan. The PreToolUse path is the fase-0 enrichment.
          const command =
            typeof payload.command === 'string'
              ? payload.command
              : typeof payload.message === 'string'
                ? payload.message
                : (tool?.command ?? enrichment?.command);
          const isCritical = command
            ? this.#deps.criticalCommands.some((c) => command.includes(c))
            : false;
          // S2.5.8: split into two categories so `stateRules` can map them to
          // distinct expressions (red-blink vs amber-solid, distinct templates)
          // without special-casing `payload.isCritical` in the state machine.
          // `payload.isCritical` is kept for the dashboard's `⚠` marker on the card.
          const event = newEvent({
            source: 'claude',
            category: isCritical ? 'permission_critical' : 'permission',
            severity: 'critical',
            payload: {
              sessionId,
              cwd: session.cwd,
              ...(command !== undefined ? { command } : {}),
              ...(tool?.summary !== undefined ? { tool: tool.summary } : {}),
              isCritical,
            },
          });
          const pending: {
            eventId: string;
            command?: string;
            isCritical: boolean;
            toolName?: string;
            summary?: string;
          } = { eventId: event.id, isCritical };
          if (command !== undefined) pending.command = command;
          if (session.lastToolUse) pending.toolName = session.lastToolUse.toolName;
          if (tool?.summary !== undefined) pending.summary = tool.summary;
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

  /**
   * How many sessions are live, working, and blocked on a permission. The buddy
   * prototype shows this on its screen ("3 running, 1 waiting"); we tracked it
   * internally and never surfaced it. Stale sessions don't count — a session
   * that stopped emitting 35 min ago is not "open".
   */
  sessionCounts(): { total: number; running: number; waiting: number } {
    let total = 0;
    let running = 0;
    let waiting = 0;
    for (const session of this.#sessions.values()) {
      if (session.state === 'stale') continue;
      total++;
      if (session.state === 'working') running++;
      else if (session.state === 'permission_pending') waiting++;
    }
    return { total, running, waiting };
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

  /**
   * Clears a pending permission when Claude Code signals the user resolved it
   * outside the dashboard (approve/deny in the CLI or Desktop chat). Publishes
   * an ambient event so the AttentionManager can drop the critical balloon.
   *
   * source="approved" is used for PostToolUse (we know the tool ran, so the
   * user approved). source="external" is used for UserPromptSubmit/Stop —
   * something happened but we can't tell if it was approve or deny, so the
   * event carries "external" and downstream code treats it as resolved.
   */
  #autoResolvePending(session: ClaudeSession, source: 'approved' | 'external' | 'abandoned'): void {
    const pending = session.pendingPermission;
    if (!pending) return;
    session.pendingPermission = undefined;
    // PostToolUse means the tool ran → Claude is back to working. For the
    // "external" case the surrounding switch (UserPromptSubmit / Stop) will
    // overwrite state right after this returns, so it doesn't matter here —
    // but nudging to a non-permission state avoids a stale flicker if some
    // future caller uses autoResolve without going through those cases.
    if (source === 'approved') {
      session.state = 'working';
    } else if (session.state === 'permission_pending') {
      session.state = 'idle';
    }
    this.#emit('permission_resolved', 'ambient', {
      sessionId: session.sessionId,
      cwd: session.cwd,
      action: source,
      // Tells the AttentionManager to retire the original permission event
      // (attention.ts:push). Without this the AM keeps it as active forever:
      // permission_critical has an infinite TTL and no ambient event can
      // preempt a critical one. The dashboard's approve path calls
      // `attentionManager.resolve()` directly (server.ts); the hook path
      // reaches it through this field.
      resolvesEventId: pending.eventId,
    });
  }

  /** Publishes to the bus and returns the event id, so callers can hand it to a
   *  later event's `payload.resolvesEventId` (see D-06 and the permission flow). */
  #emit(
    category: string,
    severity: 'critical' | 'high' | 'medium' | 'low' | 'ambient',
    payload: Record<string, unknown>,
  ): string {
    const event = newEvent({ source: 'claude', category, severity, payload });
    this.#bus?.publish(event);
    return event.id;
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

  /**
   * D19: pull-side discovery. Scans ~/.claude/projects transcript files for sessions
   * that never sent a hook to this process (e.g. bridge was restarted while sessions
   * were idle). Hooks remain source of truth for `state` and `pendingPermission` —
   * the scan only registers unknown sessions and refreshes `lastEventAt`.
   */
  async #runScan(): Promise<void> {
    const projectsDir = this.#deps.projectsDir ?? defaultProjectsDir();
    if (!projectsDir) return;
    const freshWindow = this.#cfg.scanFreshWindowMs ?? DEFAULT_SCAN_FRESH_WINDOW_MS;
    const discovered = await scanClaudeSessions(projectsDir, freshWindow, this.#deps.logger);
    // Desktop titles are cheap to read (~small JSONs) and apply even if no new
    // jsonl session was discovered, so we fetch them regardless.
    const desktopDir = this.#deps.claudeDesktopSessionsDir ?? defaultClaudeDesktopSessionsDir();
    const desktopTitles = desktopDir
      ? await readDesktopSessionTitles(desktopDir, this.#deps.logger)
      : new Map<string, string>();

    let changed = false;
    // Apply desktop titles to sessions the bridge already knows about (from hooks
    // or previous scans), even if they didn't appear in this scan pass.
    for (const [sessionId, session] of this.#sessions) {
      const desktopTitle = desktopTitles.get(sessionId);
      if (desktopTitle && session.desktopTitle !== desktopTitle) {
        session.desktopTitle = desktopTitle;
        changed = true;
      }
    }
    if (discovered.length === 0) {
      if (changed) this.#notifySessionChange();
      return;
    }
    for (const found of discovered) {
      const existing = this.#sessions.get(found.sessionId);
      if (!existing) {
        const session: ClaudeSession = {
          sessionId: found.sessionId,
          cwd: found.cwd,
          state: 'idle',
          lastEventAt: found.mtimeMs,
        };
        const desktopTitle = desktopTitles.get(found.sessionId);
        if (desktopTitle) session.desktopTitle = desktopTitle;
        if (found.slug !== undefined) session.slug = found.slug;
        if (found.title !== undefined) session.title = found.title;
        if (found.lastPrompt !== undefined) session.lastPrompt = found.lastPrompt;
        if (found.lastResponse !== undefined) session.lastResponse = found.lastResponse;
        this.#sessions.set(found.sessionId, session);
        changed = true;
      } else {
        // Hooks own live state; scan only refreshes lastEventAt and fills empty
        // metadata fields (never overwrites what a hook already set). slug is
        // scan-only (hooks don't emit it), so we refresh it whenever the scan
        // finds a value — Claude Code may assign one mid-session.
        if (found.mtimeMs > existing.lastEventAt) {
          existing.lastEventAt = found.mtimeMs;
          if (existing.state === 'stale') existing.state = 'idle';
          changed = true;
        }
        if (found.slug !== undefined && existing.slug !== found.slug) {
          existing.slug = found.slug;
          changed = true;
        }
        if (existing.title === undefined && found.title !== undefined) {
          existing.title = found.title;
          changed = true;
        }
        if (existing.lastPrompt === undefined && found.lastPrompt !== undefined) {
          existing.lastPrompt = found.lastPrompt;
          changed = true;
        }
        if (existing.lastResponse === undefined && found.lastResponse !== undefined) {
          existing.lastResponse = found.lastResponse;
          changed = true;
        }
      }
    }
    if (changed) this.#notifySessionChange();
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

    for (const [, session] of this.#sessions) {
      const elapsed = now - session.lastEventAt;
      if (session.state === 'stale' && elapsed > this.#cfg.staleSessionTimeoutMs + STALE_EXTRA_MS) {
        this.#retireSession(session);
        changed = true;
      } else if (session.state !== 'stale' && elapsed > this.#cfg.staleSessionTimeoutMs) {
        session.state = 'stale';
        changed = true;
      }
    }

    if (changed) this.#notifySessionChange();
  }

  /**
   * The ONLY way a session leaves `#sessions`. Retiring a session must also
   * retire any permission it left in flight, or the AttentionManager keeps it
   * as active forever — `permission_critical` has an infinite TTL (S2.5.8) and
   * nothing ambient can preempt a critical, so the robot would show a warning
   * for an operation nobody can ever resolve.
   *
   * This bug shipped twice: once through the `PostToolUse` hook path (fixed
   * 2026-07-09) and once through `SessionEnd` and `#cleanStale`. Funnelling
   * every deletion through here is what stops a third variant from appearing.
   * The invariant is pinned by test/permission-session-invariant.test.ts.
   */
  #retireSession(session: ClaudeSession): void {
    this.#autoResolvePending(session, 'abandoned');
    this.#sessions.delete(session.sessionId);
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
