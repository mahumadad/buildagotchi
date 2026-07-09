import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/hooks/doctor.js';

let dir: string;
let originalHome: string | undefined;
let configPath: string;
let settingsPath: string;
let scriptPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-doctor-'));
  originalHome = process.env.HOME;
  process.env.HOME = dir;
  configPath = join(dir, 'config.yaml');
  settingsPath = join(dir, '.claude', 'settings.json');
  scriptPath = join(dir, '.buildagotchi', 'hooks', 'buildagotchi-hook.sh');
});

afterEach(() => {
  process.env.HOME = originalHome;
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

function writeSettingsWithHooksAndMcp(): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `${scriptPath}` }] }],
      },
      mcpServers: { buildagotchi: { command: 'node', args: ['dist/mcp.js'] } },
    }),
  );
}

function writeExecutableScript(): void {
  mkdirSync(join(dir, '.buildagotchi', 'hooks'), { recursive: true });
  writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(scriptPath, 0o755);
}

describe('runDoctor', () => {
  it('reports all checks ok when everything is installed', async () => {
    writeFileSync(configPath, 'server:\n  port: 1780\n');
    writeSettingsWithHooksAndMcp();
    writeExecutableScript();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const checks = await runDoctor({
      configPath,
      settingsPath,
      bridgeUrl: 'http://127.0.0.1:1780',
    });

    expect(checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('reports hooks check as fail when hooks are missing from settings.json', async () => {
    writeFileSync(configPath, 'server:\n  port: 1780\n');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({}));
    writeExecutableScript();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const checks = await runDoctor({
      configPath,
      settingsPath,
      bridgeUrl: 'http://127.0.0.1:1780',
    });

    const hooksCheck = checks.find((c) => c.name === 'hooks');
    expect(hooksCheck?.status).toBe('fail');
  });

  it('reports bridge as fail when the server is not reachable, but continues other checks', async () => {
    writeFileSync(configPath, 'server:\n  port: 1780\n');
    writeSettingsWithHooksAndMcp();
    writeExecutableScript();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect refused')));

    const checks = await runDoctor({
      configPath,
      settingsPath,
      bridgeUrl: 'http://127.0.0.1:1780',
    });

    const bridgeCheck = checks.find((c) => c.name === 'bridge');
    expect(bridgeCheck?.status).toBe('fail');
    expect(checks.find((c) => c.name === 'config')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'hooks')?.status).toBe('ok');
    expect(checks.find((c) => c.name === 'script')?.status).toBe('ok');
  });

  it('reports script check as fail when the hook script is missing', async () => {
    writeFileSync(configPath, 'server:\n  port: 1780\n');
    writeSettingsWithHooksAndMcp();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const checks = await runDoctor({
      configPath,
      settingsPath,
      bridgeUrl: 'http://127.0.0.1:1780',
    });

    const scriptCheck = checks.find((c) => c.name === 'script');
    expect(scriptCheck?.status).toBe('fail');
  });
});
