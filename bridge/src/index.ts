import { join } from 'node:path';
import pino from 'pino';
import { ClaudeAdapter } from './adapters/claude-adapter.js';
import { DemoAdapter } from './adapters/demo.js';
import {
  CLAUDE_DESKTOP_BUNDLE_ID,
  TrustCheckAdapter,
  readFrontmostBundleId,
} from './adapters/trust-check.js';
import { ProtocolSession } from './ble/protocol.js';
import { SimTransport } from './ble/transport-sim.js';
import { parseArgs } from './cli.js';
import { ConfigLoader } from './config/loader.js';
import { AttentionManager } from './core/attention.js';
import { BalloonHistory } from './core/balloon-history.js';
import { EventBus } from './core/bus.js';
import type { Adapter, Event } from './core/events.js';
import { registerShutdown } from './core/lifecycle.js';
import { StateMachine } from './core/state-machine.js';
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
 * The BLE transport is real under `--simulate`: `ProtocolSession` over
 * `SimTransport`, which answers hello/ack/state_applied. Handshake, heartbeat,
 * retry, reconnect backoff, safe mode and the latency histogram are all the same
 * code the CoreS3 will run against — only the peer is synthetic. Without
 * `--simulate` there is no transport at all, because no real one exists yet, and
 * the dashboard is the only display.
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

  const stateMachine = new StateMachine(
    config.stateRules,
    {
      emit: (state) => {
        // The wire (S2.5.15). `session` is null when there is no transport at
        // all — no hardware and no `--simulate` — and the dashboard is then the
        // only display. The server reads its own copy from the state machine.
        session?.sendState(state);
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
    publicDir: join(import.meta.dirname, 'server', 'public'),
    getHealth: () => ({
      adapters: Object.fromEntries(adapters.map((a) => [a.name, a.health()])),
      transport: {
        kind: session ? 'sim' : 'none',
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
    stateMachine.setRules(next.stateRules);
    // Hot-reload personality
    const nextPreset = loadPreset(next.personality.preset);
    personality.reload(
      nextPreset,
      next.personality.preset === 'custom' ? next.personality.templates : undefined,
    );
  });

  if (simulate) {
    // The firmware doesn't exist yet, so `SimTransport` answers hello/ack/
    // state_applied. Everything above it — handshake, heartbeat, retry, safe
    // mode, the latency histogram — is the same code the CoreS3 will run against.
    session = new ProtocolSession(new SimTransport(), config.ble, {
      onInboundEvent: (kind, detail) => server.handleDeviceInput(kind, detail),
      onLinkChange: (healthy) => {
        logger.warn({ healthy }, healthy ? 'ble link up' : 'ble link dead');
        // D16: a face nobody can update is a face that lies.
        if (!healthy) stateMachine.forceSafeState();
        server.notifyState();
      },
      metrics,
      logger,
    });
  }

  attentionManager.start();
  await server.start();
  if (session) await session.start();
  logger.info({ host: config.server.host, port: config.server.port }, 'bridge listening');

  // D22. Writes to the recorder, not the bus: it is telemetry about the user,
  // and an event the robot reacted to would perturb the very state it samples.
  const trustCheck = new TrustCheckAdapter({
    watchedBundleId: CLAUDE_DESKTOP_BUNDLE_ID,
    frontmostBundleId: readFrontmostBundleId,
    currentEmotion: () => stateMachine.current().emotion,
    record: (data) =>
      recorder.record({ line_type: 'event', ts: Date.now(), context: recorderContext(), data }),
  });
  trustCheck.start();

  await claudeAdapter.start(bus);
  claudeAdapter.onSessionChangeCallback = (sessions) => {
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
