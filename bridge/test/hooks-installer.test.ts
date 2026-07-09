import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateHookScript, installHooks } from '../src/hooks/installer.js';

let dir: string;
let settingsPath: string;
let scriptDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-hooks-'));
  settingsPath = join(dir, 'settings.json');
  scriptDir = join(dir, 'hooks');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('installHooks', () => {
  it('fresh install with no settings.json creates hooks, MCP entry, and script', async () => {
    const result = await installHooks({ settingsPath, scriptDir });

    expect(result.hooksInstalled).toBe(true);
    expect(result.mcpInstalled).toBe(true);
    expect(existsSync(settingsPath)).toBe(true);
    expect(existsSync(result.scriptPath)).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks.UserPromptSubmit).toBeDefined();
    expect(settings.mcpServers.buildagotchi).toBeDefined();
  });

  it('merges with existing hooks, adding buildagotchi entries without dropping others', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo other-tool' }] },
          ],
        },
      }),
    );

    const result = await installHooks({ settingsPath, scriptDir });

    expect(result.hooksInstalled).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    const entries = settings.hooks.UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>;
    const commands = entries.flatMap((e) => e.hooks.map((h) => h.command));
    expect(commands).toContain('echo other-tool');
    expect(commands.some((c) => c.includes('buildagotchi-hook.sh'))).toBe(true);
  });

  it('is idempotent: already installed results in no-op with empty diff', async () => {
    await installHooks({ settingsPath, scriptDir });
    const result = await installHooks({ settingsPath, scriptDir });

    expect(result.hooksInstalled).toBe(false);
    expect(result.mcpInstalled).toBe(false);
    expect(result.diff).toBe('');
  });

  it('generated hook script is valid bash with shebang, curl, and exit 0', () => {
    const script = generateHookScript('http://127.0.0.1:1780');
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(script).toContain('curl');
    expect(script.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('dry run returns a diff but does not write any files', async () => {
    const result = await installHooks({ settingsPath, scriptDir, dryRun: true });

    expect(result.diff.length).toBeGreaterThan(0);
    expect(existsSync(settingsPath)).toBe(false);
    expect(existsSync(result.scriptPath)).toBe(false);
  });

  it('rejecting the confirm callback does not write any files', async () => {
    const result = await installHooks({
      settingsPath,
      scriptDir,
      confirm: async () => false,
    });

    expect(result.hooksInstalled).toBe(false);
    expect(result.mcpInstalled).toBe(false);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('adds an mcpServers.buildagotchi entry', async () => {
    const result = await installHooks({ settingsPath, scriptDir });
    expect(result.mcpInstalled).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.mcpServers.buildagotchi.command).toBe('node');
  });

  it('writes the hook script as executable', async () => {
    const result = await installHooks({ settingsPath, scriptDir });
    const stat = statSync(result.scriptPath);
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });
});
