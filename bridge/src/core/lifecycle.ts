import pino from 'pino';

const logger = pino({ name: 'lifecycle' });

export interface ShutdownStep {
  name: string;
  run: () => Promise<void>;
}

const SHUTDOWN_TIMEOUT_MS = 3000;

/**
 * Runs shutdown steps in order and resolves either when they all complete
 * ('clean') or when timeoutMs elapses first ('timeout'), whichever comes
 * first. Extracted from the signal handler so it can be unit-tested without
 * killing the test process (S1.8).
 */
export function runShutdown(
  steps: ShutdownStep[],
  timeoutMs: number,
): Promise<'clean' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, timeoutMs);
    timer.unref();

    (async () => {
      for (const step of steps) {
        try {
          await step.run();
        } catch (err) {
          logger.error({ err, step: step.name }, 'shutdown step failed');
        }
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('clean');
    })();
  });
}

let shuttingDown = false;

/**
 * Registers SIGTERM/SIGINT handlers that run the given steps once, then
 * exit(0) on clean completion or exit(1) on timeout. A second signal while
 * shutdown is in progress exits(1) immediately.
 */
export function registerShutdown(steps: ShutdownStep[]): void {
  const handler = () => {
    if (shuttingDown) {
      process.exit(1);
      return;
    }
    shuttingDown = true;

    runShutdown(steps, SHUTDOWN_TIMEOUT_MS).then((result) => {
      process.exit(result === 'clean' ? 0 : 1);
    });
  };

  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
