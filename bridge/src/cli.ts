export interface CliOptions {
  command: 'run' | 'replay' | 'init';
  simulate: boolean; // --simulate
  demo: boolean; // --demo (M4; parsear ya)
  configPath: string; // --config <path>, default './config.yaml'
  replayFile?: string; // bridge replay <file>
  replaySpeed?: number; // --speed N
  replayInstant?: boolean; // --instant
  rotate?: boolean; // bridge init --rotate
}

const USAGE = `usage:
  bridge [run] [--simulate] [--demo] [--config <path>]
  bridge replay <file> [--speed N | --instant]
  bridge init [--rotate]`;

function usageError(detail: string): Error {
  return new Error(`${detail}\n\n${USAGE}`);
}

export function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  let command: CliOptions['command'] = 'run';

  if (args[0] === 'replay' || args[0] === 'init') {
    command = args[0];
    args.shift();
  } else if (args[0] === 'run') {
    args.shift();
  }

  let simulate = false;
  let demo = false;
  let configPath = './config.yaml';
  let replayFile: string | undefined;
  let replaySpeed: number | undefined;
  let replayInstant = false;
  let rotate = false;

  if (command === 'replay') {
    const file = args.shift();
    if (!file || file.startsWith('--')) {
      throw usageError('replay requires a file argument');
    }
    replayFile = file;
  }

  while (args.length > 0) {
    const arg = args.shift() as string;
    switch (arg) {
      case '--simulate':
        simulate = true;
        break;
      case '--demo':
        demo = true;
        break;
      case '--config': {
        const value = args.shift();
        if (!value) throw usageError('--config requires a path');
        configPath = value;
        break;
      }
      case '--speed': {
        const value = args.shift();
        if (!value) throw usageError('--speed requires a number');
        replaySpeed = Number(value);
        break;
      }
      case '--instant':
        replayInstant = true;
        break;
      case '--rotate':
        rotate = true;
        break;
      default:
        throw usageError(`unknown flag: ${arg}`);
    }
  }

  if (replaySpeed !== undefined && replayInstant) {
    throw usageError('--speed and --instant are mutually exclusive');
  }

  const options: CliOptions = { command, simulate, demo, configPath };
  if (replayFile !== undefined) options.replayFile = replayFile;
  if (replaySpeed !== undefined) options.replaySpeed = replaySpeed;
  if (replayInstant) options.replayInstant = replayInstant;
  if (rotate) options.rotate = rotate;
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  console.log(`${options.command}: not implemented yet`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
