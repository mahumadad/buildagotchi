import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTranscriptTail } from '../src/adapters/claude-transcript.js';

// Real on-disk transcript lines use the nested Anthropic message format:
// `{type:'assistant', message:{content:[...blocks], usage:{...}}}`. Verified against
// ccboard (session-stop.sh jq) and claude-session-dashboard (parser types).
function assistantText(text: string, outputTokens?: number): string {
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
  if (outputTokens !== undefined) {
    message.usage = { input_tokens: 100, output_tokens: outputTokens };
  }
  return JSON.stringify({ type: 'assistant', message });
}

function assistantToolUse(name: string, command: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { command } }] },
  });
}

function userLine(content: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}

describe('readTranscriptTail', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(lines: string[]): string {
    dir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
    const p = join(dir, 'transcript.jsonl');
    writeFileSync(p, lines.join('\n'));
    return p;
  }

  it('parses valid transcript lines and extracts text, tokens, ratio 0', () => {
    const path = fixture([
      userLine('hello'),
      assistantText('response one', 250),
      assistantToolUse('Bash', 'echo hi'),
      userLine('next'),
      assistantText('response two', 120),
      userLine('more'),
      assistantText('final response', 80),
    ]);
    const result = readTranscriptTail(path, 50);
    expect(result).not.toBeNull();
    expect(result?.text).toBe('final response');
    expect(result?.tokens).toBe(80);
    expect(result?.unknownLineRatio).toBe(0);
  });

  it('counts unknown (non-JSON) lines in the ratio', () => {
    const path = fixture([
      userLine('hello'),
      assistantText('ok', 20),
      'not json line 1',
      userLine('x'),
      'not json line 2',
      assistantText('y', 10),
      'not json line 3',
      userLine('z'),
      assistantText('done', 5),
      userLine('bye'),
    ]);
    const result = readTranscriptTail(path, 50);
    expect(result).not.toBeNull();
    expect(result?.unknownLineRatio).toBeCloseTo(0.3);
  });

  it('returns null for non-existent file without throwing', () => {
    const result = readTranscriptTail('/tmp/nonexistent-transcript-path.jsonl', 50);
    expect(result).toBeNull();
  });

  it('returns null for empty file', () => {
    dir = mkdtempSync(join(tmpdir(), 'transcript-test-'));
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');
    const result = readTranscriptTail(p, 50);
    expect(result).toBeNull();
  });

  it('extracts command from a tool_use content block', () => {
    const path = fixture([
      userLine('do it'),
      assistantToolUse('Bash', 'rm -rf /tmp/test'),
      assistantText('done', 5),
    ]);
    const result = readTranscriptTail(path, 50);
    expect(result).not.toBeNull();
    expect(result?.command).toBe('rm -rf /tmp/test');
  });
});
