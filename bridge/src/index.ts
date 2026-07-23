import { join } from 'node:path';
import pino from 'pino';
import { ClaudeAdapter } from './adapters/claude-adapter.js';
import { DemoAdapter } from './adapters/demo.js';
import {
  CLAUDE_DESKTOP_BUNDLE_ID,
  TrustCheckMonitor,
  readFrontmostBundleId,
  secondsSinceLastInput,
} from './adapters/trust-check.js';
import { ProtocolSession } from './ble/protocol.js';
import { NobleTransport } from './ble/transport-noble.js';
import { SimTransport } from './ble/transport-sim.js';
import { parseArgs } from './cli.js';
import { ConfigLoader } from './config/loader.js';
import { AttentionManager } from './core/attention.js';
import { BalloonHistory } from './core/balloon-history.js';
import { EventBus } from './core/bus.js';
import { ContextPressureMonitor } from './core/context-pressure.js';
import { type Adapter, type Event, newEvent } from './core/events.js';
import { LifeStats } from './core/life-stats.js';
import { registerShutdown } from './core/lifecycle.js';
import { ScreenView } from './core/screen-view.js';
import { StateMachine } from './core/state-machine.js';
import { TokenStats } from './core/token-stats.js';
import { loadPreset } from './personality/loader.js';
import { PersonalityManager } from './personality/personality.js';
import { MacosPlatform } from './platform/macos.js';
import type { RecorderContext } from './recorder/recorder.js';
import { EventRecorder } from './recorder/recorder.js';
import { Metrics } from './server/metrics.js';
import { BridgeServer } from './server/server.js';

const logger = pino({ name: 'bridge' });

/**
 * Composition root for `bridge run` (SPEC-IMPL-FASE-1A §5.7). Startup order:
 * config → metrics → recorder → bus (recorder hook) → AM → state machine →
 * transport → server → adapters → registerShutdown.
 *
 * Under `--simulate`, `ProtocolSession` runs over `SimTransport` (synthetic
 * hello/ack/state_applied). Without `--simulate`, Fase 1B uses `NobleTransport`
 * against a CoreS3 advertising Nordic UART as `buildagotchi*`. Handshake,
 * heartbeat, retry, reconnect and safe mode are the same code either way.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.command !== 'run') {
    console.log(`${options.command}: not implemented in src/index.ts — see src/cli.ts`);
    return;
  }

  const simulate = options.simulate || options.demo; // --demo implies --simulate

  const metrics = new Metrics();
  const platform = new MacosPlatform();

  const configLoader = new ConfigLoader(options.configPath, { logger, metrics });
  const config = configLoader.load();

  const recorder = new EventRecorder({
    dir: config.recorder.dir,
    retentionDays: config.recorder.retentionDays,
  });

  const adapters: Adapter[] = [];

  // Assigned after the state machine exists (it needs a `forceSafeState` target).
  // Null when there is no transport at all: no hardware, no `--simulate`.
  let session: ProtocolSession | null = null;

  function recorderContext(): RecorderContext {
    return {
      metabolicScore: null, // Fase 1: sin Metabolic State
      activeMode: attentionManager.getMode(),
      bleHealthy: session?.linkHealthy() ?? false,
      adapterHealth: Object.fromEntries(adapters.map((a) => [a.name, a.health().status])),
    };
  }

  const bus = new EventBus(
    { windowMs: config.dedup.windowSeconds * 1000, autoMuteAfter: config.dedup.autoMuteAfter },
    {
      onAccepted: (e: Event) => {
        recorder.record({
          line_type: 'event',
          ts: e.timestamp,
          context: recorderContext(),
          data: e,
        });
        metrics.counter('events_total', ['source', 'category', 'severity']).inc({
          source: e.source,
          category: e.category,
          severity: e.severity,
        });
        // Tokens ride on `response` events (claude-adapter). Output is spend and
        // accumulates; context is pressure and is a level, not a delta.
        const out = e.payload.tokens;
        if (typeof out === 'number') tokenStats.addOutput(out);
        const ctx = e.payload.contextTokens;
        const sid = e.payload.sessionId;
        if (typeof ctx === 'number' && typeof sid === 'string') {
          tokenStats.setContext(sid, ctx);
          // `cwd` rides along so the pressure event can name the project. Without
          // it the balloon rendered as ": contexto 91%" — the template's
          // `{project}` resolves from `cwd`, not from the session id.
          contextPressure.observe(sid, ctx, typeof e.payload.cwd === 'string' ? e.payload.cwd : '');
        }

        // Life stats: only real Claude events mark activity (not demo, not replay).
        if (e.source === 'claude' && !e.payload.replayedFrom) {
          const result = lifeStats.markActive();
          if (result.crossedMilestone) {
            bus.publish(
              newEvent({
                source: 'life',
                category: 'life_milestone',
                severity: 'ambient',
                payload: { streak: result.streak },
              }),
            );
          }
        }

        // Life stats: count permission resolutions from the hook path.
        // 'external': the bus event carries no head/button signal.
        if (
          e.source === 'claude' &&
          e.category === 'permission_resolved' &&
          !e.payload.replayedFrom
        ) {
          const action = e.payload.action;
          if (action === 'approved') {
            lifeStats.recordResolution('approved', 'external');
          } else if (action === 'denied') {
            lifeStats.recordResolution('denied', 'external');
          }
          // 'external', 'abandoned', 'dismissed' → don't count (C1/C8)
        }

        attentionManager.push(e);
        server.notifyEvent(e);
      },
      onOutcome: (o) => {
        if (o.kind === 'invalid') {
          metrics.counter('bus_validation_errors_total').inc();
        }
      },
    },
  );

  const attentionManager = new AttentionManager(config.attentionManager, {
    record: (type, data) => {
      recorder.record({ line_type: type, ts: Date.now(), context: recorderContext(), data });
    },
    metrics,
    onActiveChange: (active) => stateMachine.apply(active),
  });
  attentionManager.setMode(config.mode);

  const personalityPreset = loadPreset(config.personality.preset);
  const personality = new PersonalityManager(
    personalityPreset,
    config.personality.preset === 'custom' ? config.personality.templates : undefined,
  );

  const balloonHistory = new BalloonHistory(config.dashboard.balloonHistorySize);
  const screenView = new ScreenView();

  // `today` survives a restart; `sinceStart` does not, by definition.
  const tokenStats = new TokenStats({ path: join(platform.dataDir(), 'token-stats.json') });

  const lifeStats = new LifeStats({
    path: join(platform.dataDir(), 'life-stats.json'),
    enabled: !options.demo,
    milestoneStreak: config.claude.milestoneStreakDays,
  });

  // Context pressure becomes events like any other source (D3): the state rules
  // decide what a full window looks like on the face, not this wiring.
  const pressureEventBySession = new Map<string, string>();
  const contextPressure = new ContextPressureMonitor(
    {
      windowTokens: config.claude.contextWindowTokens,
      warnAt: config.claude.contextWarnAt,
      highAt: config.claude.contextHighAt,
    },
    {
      onLevelChange: (level, ctx) => {
        const previous = pressureEventBySession.get(ctx.sessionId);
        const event = newEvent({
          source: 'claude',
          category: `context_${level}`,
          severity: level === 'high' ? 'high' : level === 'warn' ? 'medium' : 'ambient',
          payload: {
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            pct: Math.round(ctx.pct * 100),
            ...(previous !== undefined ? { resolvesEventId: previous } : {}),
          },
        });
        // `calm` retires its predecessor and leaves nothing behind to retire.
        if (level === 'calm') pressureEventBySession.delete(ctx.sessionId);
        else pressureEventBySession.set(ctx.sessionId, event.id);
        bus.publish(event);
      },
    },
  );

  const stateMachine = new StateMachine(
    config.stateRules,
    {
      emit: (state, eventId) => {
        // The wire (S2.5.15). `session` is null when there is no transport at
        // all — no hardware and no `--simulate` — and the dashboard is then the
        // only display. The server reads its own copy from the state machine.
        session?.sendState(state, eventId);
        server.notifyState();
      },
      record: (type, data) => {
        recorder.record({ line_type: type, ts: Date.now(), context: recorderContext(), data });
      },
      metrics,
      balloonHistory,
    },
    personality,
  );

  // Restore a sticky balloon from a previous run so the face doesn't go blank
  // on restart. Must happen before the AttentionManager starts, because the
  // first `apply(null)` -> backgroundMood decision will inherit it.
  const lastSticky = balloonHistory.lastSticky();
  if (lastSticky) {
    stateMachine.restoreBalloon(lastSticky.text);
  }

  const claudeAdapter = new ClaudeAdapter(
    {
      staleSessionTimeoutMs: config.claude.staleSessionTimeout,
      transcriptReadEnabled: config.claude.transcriptReadEnabled,
      unknownLineThreshold: config.claude.unknownLineThreshold,
      unknownLineBrokenThreshold: config.claude.unknownLineBrokenThreshold,
    },
    {
      logger,
      metrics,
      criticalCommands: config.criticalCommands,
      stateDir: join(platform.dataDir(), 'claude-state'),
    },
  );
  adapters.push(claudeAdapter);

  const server = new BridgeServer({
    host: config.server.host,
    port: config.server.port,
    rateLimitPerMinute: config.external.rateLimitPerMinute,
    requireToken: config.external.requireToken,
    simulate,
    logger,
    metrics,
    platform,
    bus,
    recorder,
    attentionManager,
    stateMachine,
    claudeAdapter,
    balloonHistory,
    tokenStats,
    lifeStats,
    screenView,
    publicDir: join(import.meta.dirname, 'server', 'public'),
    getHealth: () => ({
      adapters: Object.fromEntries(adapters.map((a) => [a.name, a.health()])),
      transport: {
        kind: session ? (simulate ? 'sim' : 'noble') : 'none',
        connected: session?.linkHealthy() ?? false,
        reconnects: 0,
        latency: { p50: 0, p95: 0 },
      },
    }),
  });

  configLoader.watch((next) => {
    bus.setDedupConfig({
      windowMs: next.dedup.windowSeconds * 1000,
      autoMuteAfter: next.dedup.autoMuteAfter,
    });
    attentionManager.setConfig(next.attentionManager);
    contextPressure.setConfig({
      windowTokens: next.claude.contextWindowTokens,
      warnAt: next.claude.contextWarnAt,
      highAt: next.claude.contextHighAt,
    });
    stateMachine.setRules(next.stateRules);
    // Hot-reload personality
    const nextPreset = loadPreset(next.personality.preset);
    personality.reload(
      nextPreset,
      next.personality.preset === 'custom' ? next.personality.templates : undefined,
    );
  });

  {
    const transport = simulate
      ? new SimTransport()
      : new NobleTransport({ deviceNamePrefix: config.ble.deviceNamePrefix });
    session = new ProtocolSession(transport, config.ble, {
      onInboundEvent: (kind, detail) => server.handleDeviceInput(kind, detail),
      onLinkChange: (healthy) => {
        logger.warn({ healthy }, healthy ? 'ble link up' : 'ble link dead');
        // D16: a face nobody can update is a face that lies.
        if (!healthy) {
          stateMachine.forceSafeState();
          screenView.reset(); // D16: a stats page nobody can update describes nothing
        }
        server.notifyState();
      },
      metrics,
      logger,
      // D-10: firmware-leg latency + eventId, persisted as its own state_change
      // line so it survives restart and joins the bridge-leg line offline.
      recordStateApplied: (data) =>
        recorder.record({
          line_type: 'state_change',
          ts: Date.now(),
          context: recorderContext(),
          data: { leg: 'firmware', ...data },
        }),
    });
  }

  attentionManager.start();
  await server.start();
  if (session) {
    // Seed before connect so start()'s post-hello state_sync wakes the face
    // out of firmware D16 SLEEPY (idle NEUTRAL may never emit a transition).
    session.sendState(stateMachine.current());
    await session.start();
  }
  logger.info({ host: config.server.host, port: config.server.port }, 'bridge listening');

  // D22. Writes to the recorder, not the bus: it is telemetry about the user,
  // and an event the robot reacted to would perturb the very state it samples.
  const trustCheck = new TrustCheckMonitor({
    watchedBundleId: CLAUDE_DESKTOP_BUNDLE_ID,
    frontmostBundleId: readFrontmostBundleId,
    currentEmotion: () => stateMachine.current().emotion,
    secondsSinceLastInput: secondsSinceLastInput,
    record: (data) =>
      recorder.record({ line_type: 'event', ts: Date.now(), context: recorderContext(), data }),
  });
  trustCheck.start();

  await claudeAdapter.start(bus);
  claudeAdapter.onSessionChangeCallback = (sessions) => {
    // A session that died leaves no context behind — same invariant the
    // permission deadlock taught us (DEBT: #retireSession).
    for (const id of Object.keys(tokenStats.snapshot().context.bySession)) {
      if (!sessions.has(id)) {
        tokenStats.forgetSession(id);
        contextPressure.forget(id);
        pressureEventBySession.delete(id);
      }
    }
    server.notifySession(Object.fromEntries(sessions));
  };

  if (options.demo) {
    const demo = new DemoAdapter({ attentionManager });
    adapters.push(demo);
    await demo.start(bus);
  }

  registerShutdown([
    {
      name: 'attention-manager',
      run: async () => attentionManager.stop(),
    },
    {
      name: 'trust-check',
      run: async () => trustCheck.stop(),
    },
    {
      name: 'ble-session',
      run: async () => {
        if (session) await session.stop();
      },
    },
    {
      name: 'adapters',
      run: async () => {
        for (const adapter of adapters) await adapter.stop();
      },
    },
    {
      name: 'server',
      run: async () => server.stop(),
    },
    {
      name: 'incident-line',
      run: async () => {
        recorder.record({
          line_type: 'incident',
          ts: Date.now(),
          context: recorderContext(),
          data: { reason: 'shutdown' },
        });
      },
    },
    {
      name: 'recorder',
      run: async () => recorder.close(),
    },
    {
      name: 'config-loader',
      run: async () => configLoader.close(),
    },
  ]);
}

main().catch((err) => {
  logger.error({ err }, 'fatal error during startup');
  process.exitCode = 1;
});
