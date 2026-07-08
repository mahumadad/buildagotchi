import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/cli.js';

describe('parseArgs', () => {
  it('defaults to run command with default config path', () => {
    expect(parseArgs([])).toEqual({
      command: 'run',
      simulate: false,
      demo: false,
      configPath: './config.yaml',
    });
  });

  it('parses --simulate', () => {
    expect(parseArgs(['--simulate'])).toEqual({
      command: 'run',
      simulate: true,
      demo: false,
      configPath: './config.yaml',
    });
  });

  it('parses --config <path>', () => {
    expect(parseArgs(['--config', '/tmp/x.yaml'])).toEqual({
      command: 'run',
      simulate: false,
      demo: false,
      configPath: '/tmp/x.yaml',
    });
  });

  it('parses --demo', () => {
    expect(parseArgs(['--demo'])).toEqual({
      command: 'run',
      simulate: false,
      demo: true,
      configPath: './config.yaml',
    });
  });

  it('parses replay <file> --speed 4', () => {
    expect(parseArgs(['replay', 'f.ndjson', '--speed', '4'])).toEqual({
      command: 'replay',
      simulate: false,
      demo: false,
      configPath: './config.yaml',
      replayFile: 'f.ndjson',
      replaySpeed: 4,
    });
  });

  it('parses replay <file> --instant', () => {
    expect(parseArgs(['replay', 'f.ndjson', '--instant'])).toEqual({
      command: 'replay',
      simulate: false,
      demo: false,
      configPath: './config.yaml',
      replayFile: 'f.ndjson',
      replayInstant: true,
    });
  });

  it('parses init --rotate', () => {
    expect(parseArgs(['init', '--rotate'])).toEqual({
      command: 'init',
      simulate: false,
      demo: false,
      configPath: './config.yaml',
      rotate: true,
    });
  });

  it('throws on unknown flag', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/usage/i);
  });

  it('throws when --speed and --instant are combined', () => {
    expect(() => parseArgs(['replay', 'f.ndjson', '--speed', '2', '--instant'])).toThrow();
  });
});
