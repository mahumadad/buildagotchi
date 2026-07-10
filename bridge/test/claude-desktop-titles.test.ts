import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readDesktopSessionTitles } from '../src/adapters/claude-desktop-titles.js';

function writeLocal(
  root: string,
  ws: string,
  group: string,
  fileName: string,
  payload: Record<string, unknown>,
) {
  const dir = join(root, ws, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, fileName), JSON.stringify(payload));
}

describe('readDesktopSessionTitles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-desktop-titles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty map when directory does not exist', async () => {
    const result = await readDesktopSessionTitles(join(root, 'missing'));
    expect(result.size).toBe(0);
  });

  it('returns empty map when path is empty (unsupported platform)', async () => {
    const result = await readDesktopSessionTitles('');
    expect(result.size).toBe(0);
  });

  it('maps cliSessionId → title only for titleSource="user"', async () => {
    writeLocal(root, 'ws1', 'grp1', 'local_a.json', {
      cliSessionId: 'sess-a',
      title: 'BUILDATGOCHI',
      titleSource: 'user',
    });
    writeLocal(root, 'ws1', 'grp1', 'local_b.json', {
      cliSessionId: 'sess-b',
      title: 'Autogen title',
      titleSource: 'auto',
    });
    writeLocal(root, 'ws1', 'grp2', 'local_c.json', {
      cliSessionId: 'sess-c',
      title: 'No source field',
    });

    const result = await readDesktopSessionTitles(root);
    expect(result.get('sess-a')).toBe('BUILDATGOCHI');
    expect(result.has('sess-b')).toBe(false);
    expect(result.has('sess-c')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('walks two levels deep (workspace / chatGroup)', async () => {
    writeLocal(root, 'ws-1', 'grp-1', 'local_a.json', {
      cliSessionId: 'sess-a',
      title: 'A',
      titleSource: 'user',
    });
    writeLocal(root, 'ws-2', 'grp-x', 'local_b.json', {
      cliSessionId: 'sess-b',
      title: 'B',
      titleSource: 'user',
    });

    const result = await readDesktopSessionTitles(root);
    expect(result.get('sess-a')).toBe('A');
    expect(result.get('sess-b')).toBe('B');
  });

  it('skips files that are not local_*.json', async () => {
    writeLocal(root, 'ws1', 'grp1', 'local_a.json', {
      cliSessionId: 'sess-a',
      title: 'kept',
      titleSource: 'user',
    });
    writeLocal(root, 'ws1', 'grp1', 'workspace.json', {
      cliSessionId: 'sess-w',
      title: 'ignored',
      titleSource: 'user',
    });
    writeLocal(root, 'ws1', 'grp1', 'local_b.txt', {
      cliSessionId: 'sess-t',
      title: 'ignored',
      titleSource: 'user',
    });

    const result = await readDesktopSessionTitles(root);
    expect(result.size).toBe(1);
    expect(result.get('sess-a')).toBe('kept');
  });

  it('drops entries with missing/empty title or cliSessionId', async () => {
    writeLocal(root, 'ws1', 'grp1', 'local_a.json', {
      titleSource: 'user',
      title: 'no id',
    });
    writeLocal(root, 'ws1', 'grp1', 'local_b.json', {
      cliSessionId: 'sess-b',
      titleSource: 'user',
      title: '',
    });
    writeLocal(root, 'ws1', 'grp1', 'local_c.json', {
      cliSessionId: 'sess-c',
      titleSource: 'user',
    });

    const result = await readDesktopSessionTitles(root);
    expect(result.size).toBe(0);
  });

  it('tolerates malformed JSON files and logs a warning', async () => {
    const dir = join(root, 'ws1', 'grp1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'local_bad.json'), '{ not: valid json');
    writeLocal(root, 'ws1', 'grp1', 'local_good.json', {
      cliSessionId: 'sess-good',
      title: 'good',
      titleSource: 'user',
    });

    const logger = { warn: vi.fn() };
    const result = await readDesktopSessionTitles(root, logger);
    expect(result.get('sess-good')).toBe('good');
    expect(logger.warn).toHaveBeenCalled();
  });
});
