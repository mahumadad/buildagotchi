import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scanClaudeSessions } from '../src/adapters/claude-jsonl-scanner.js';

const FRESH_WINDOW = 60 * 60 * 1000; // 1h

function firstLine(sessionId: string): string {
  return JSON.stringify({
    type: 'file-history-snapshot',
    sessionId,
    messageId: 'boot',
    isSnapshotUpdate: false,
  });
}

function assistantWithSlugLine(slug: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    slug,
  });
}

function userLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  });
}

function userToolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }],
    },
  });
}

function assistantTextLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
  });
}

function assistantToolUseLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
    },
  });
}

function writeSession(projectsDir: string, projectName: string, fileName: string, lines: string[]) {
  const projectPath = join(projectsDir, projectName);
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, fileName), `${lines.join('\n')}\n`);
  return join(projectPath, fileName);
}

describe('scanClaudeSessions', () => {
  let root: string;
  let projectsDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'claude-scan-test-'));
    projectsDir = join(root, 'projects');
    mkdirSync(projectsDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty when projects dir is missing', async () => {
    const result = await scanClaudeSessions(join(root, 'missing'), FRESH_WINDOW);
    expect(result).toEqual([]);
  });

  it('discovers session id from the first line and derives title from first user prompt', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine('Please refactor the login flow'),
      assistantTextLine('Sure, starting now.'),
    ]);

    const result = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(result).toHaveLength(1);
    const [s] = result;
    expect(s?.sessionId).toBe('sess-a');
    expect(s?.title).toBe('Please refactor the login flow');
  });

  it('extracts lastPrompt and lastResponse from the tail', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine('First message'),
      assistantTextLine('First reply'),
      userLine('Second message'),
      assistantTextLine('Second reply'),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.title).toBe('First message');
    expect(s?.lastPrompt).toBe('Second message');
    expect(s?.lastResponse).toBe('Second reply');
  });

  it('ignores tool_result user lines when picking title/lastPrompt', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine('Human question'),
      assistantToolUseLine(),
      userToolResultLine(),
      assistantTextLine('Answer'),
      userToolResultLine(),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.title).toBe('Human question');
    expect(s?.lastPrompt).toBe('Human question');
    expect(s?.lastResponse).toBe('Answer');
  });

  it('skips assistant messages that only contain tool_use when searching for lastResponse', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine('hello'),
      assistantTextLine('reply with text'),
      userToolResultLine(),
      assistantToolUseLine(),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.lastResponse).toBe('reply with text');
  });

  it('normalizes whitespace and truncates long fields', async () => {
    const longTitle = `${'x'.repeat(200)}`;
    const longPrompt = `line1\n\n${'y'.repeat(500)}`;
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine(longTitle),
      assistantTextLine('short reply'),
      userLine(longPrompt),
      assistantTextLine('final'),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.title?.length).toBe(80);
    expect(s?.lastPrompt?.length).toBe(400);
    expect(s?.lastPrompt).not.toMatch(/\n/);
  });

  it('filters out files older than freshWindowMs', async () => {
    const oldPath = writeSession(projectsDir, '-tmp-proj', 'old.jsonl', [
      firstLine('sess-old'),
      userLine('old'),
    ]);
    const freshPath = writeSession(projectsDir, '-tmp-proj', 'fresh.jsonl', [
      firstLine('sess-fresh'),
      userLine('fresh'),
    ]);

    // Age the old file by 2h and keep the fresh one at now.
    const oneHourAgo = Date.now() / 1000 - 2 * 60 * 60;
    const { utimesSync } = await import('node:fs');
    utimesSync(oldPath, oneHourAgo, oneHourAgo);
    void freshPath;

    const result = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(result.map((r) => r.sessionId)).toEqual(['sess-fresh']);
  });

  it('handles large transcripts using head + tail without loading the whole file', async () => {
    // Build > 128KB of assistant chatter between the first prompt and the tail.
    const filler = Array.from({ length: 400 }, (_, i) =>
      assistantTextLine(`mid message ${i} ${'z'.repeat(400)}`),
    );
    writeSession(projectsDir, '-tmp-proj', 'big.jsonl', [
      firstLine('sess-big'),
      userLine('The very first prompt'),
      ...filler,
      userLine('Final prompt'),
      assistantTextLine('Final answer'),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.sessionId).toBe('sess-big');
    expect(s?.title).toBe('The very first prompt');
    expect(s?.lastPrompt).toBe('Final prompt');
    expect(s?.lastResponse).toBe('Final answer');
  });

  it('returns session without enrichment when file has only the boot line', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [firstLine('sess-a')]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.sessionId).toBe('sess-a');
    expect(s?.title).toBeUndefined();
    expect(s?.lastPrompt).toBeUndefined();
    expect(s?.lastResponse).toBeUndefined();
  });

  it('drops files whose first line lacks sessionId', async () => {
    writeSession(projectsDir, '-tmp-proj', 'bad.jsonl', [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'no id' } }),
      userLine('follow-up'),
    ]);

    const logger = { warn: vi.fn() };
    const result = await scanClaudeSessions(projectsDir, FRESH_WINDOW, logger);
    expect(result).toEqual([]);
  });

  it('extracts slug from a line that carries it (Claude Code assigns it mid-session)', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine('hello'),
      assistantWithSlugLine('dreamy-stirring-beaver'),
      userLine('follow-up'),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.slug).toBe('dreamy-stirring-beaver');
  });

  it('leaves slug undefined when no line carries one (short/new sessions)', async () => {
    writeSession(projectsDir, '-tmp-proj', 'a.jsonl', [
      firstLine('sess-a'),
      userLine('just started'),
    ]);

    const [s] = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(s?.slug).toBeUndefined();
  });

  it('skips subagents/ subdirectories (D19 C2)', async () => {
    writeSession(projectsDir, '-tmp-proj/subagents', 'nested.jsonl', [
      firstLine('sess-nested'),
      userLine('nested prompt'),
    ]);

    const result = await scanClaudeSessions(projectsDir, FRESH_WINDOW);
    expect(result).toEqual([]);
  });
});
