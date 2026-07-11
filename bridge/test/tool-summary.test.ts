import { describe, expect, it } from 'vitest';
import { summarizeToolUse } from '../src/adapters/tool-summary.js';

/**
 * Fase 0 verificó la forma de tool_input por tool. Este resumen es lo único
 * que viaja al bus/robot — el tool_input completo (un Write de 500 líneas) no.
 */

describe('summarizeToolUse', () => {
  it('Bash: command is the summary, capped at 200 chars', () => {
    const r = summarizeToolUse('Bash', { command: 'git push origin main', description: 'push' });
    expect(r.command).toBe('git push origin main');
    expect(r.summary).toBe('Bash: git push origin main');
  });

  it('Bash: long command truncates with ellipsis at 200', () => {
    const long = 'echo ' + 'x'.repeat(300);
    const r = summarizeToolUse('Bash', { command: long });
    expect(r.command?.length).toBe(200);
    expect(r.command?.endsWith('…')).toBe(true);
    expect(r.summary.startsWith('Bash: echo ')).toBe(true);
  });

  it('Edit: summary is tool + basename, command is the path', () => {
    const r = summarizeToolUse('Edit', {
      file_path: '/Users/x/proj/src/server.ts',
      old_string: 'a',
      new_string: 'b',
    });
    expect(r.command).toBe('/Users/x/proj/src/server.ts');
    expect(r.summary).toBe('Edit: server.ts');
  });

  it('Write: summary is tool + basename', () => {
    const r = summarizeToolUse('Write', { file_path: '/tmp/notes.md', content: 'hi' });
    expect(r.summary).toBe('Write: notes.md');
  });

  it('Read: summary is tool + basename', () => {
    const r = summarizeToolUse('Read', { file_path: '/tmp/a/b/c.txt' });
    expect(r.summary).toBe('Read: c.txt');
  });

  it('unknown tool: summary is tool name plus first input keys', () => {
    const r = summarizeToolUse('WebFetch', { url: 'https://x.com', prompt: 'summarize' });
    expect(r.summary).toBe('WebFetch: prompt, url');
    expect(r.command).toBeUndefined();
  });

  it('tool with no usable input: summary is just the tool name', () => {
    const r = summarizeToolUse('SomeTool', {});
    expect(r.summary).toBe('SomeTool');
    expect(r.command).toBeUndefined();
  });

  it('missing/invalid fields never throw', () => {
    // @ts-expect-error probing runtime robustness
    expect(() => summarizeToolUse('Bash', null)).not.toThrow();
    const r = summarizeToolUse('Bash', {});
    expect(r.summary).toBe('Bash');
  });
});
