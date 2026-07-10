import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTailLinesSync } from '../src/adapters/tail-reader.js';

/**
 * D-02. The point of this module is that it never loads the whole file, so the
 * tests that matter are the ones about window growth and partial first lines —
 * not "does it read a small file".
 */

describe('readTailLinesSync', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tail-reader-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name: string, lines: string[]): string {
    const p = join(dir, name);
    writeFileSync(p, `${lines.join('\n')}\n`);
    return p;
  }

  it('returns null when the file cannot be opened', () => {
    expect(readTailLinesSync(join(dir, 'nope.jsonl'), 10)).toBeNull();
  });

  it('returns [] for an empty file', () => {
    const p = join(dir, 'empty.jsonl');
    writeFileSync(p, '');
    expect(readTailLinesSync(p, 10)).toEqual([]);
  });

  it('returns every line when the file is smaller than maxLines', () => {
    const p = write('few.jsonl', ['a', 'b', 'c']);
    expect(readTailLinesSync(p, 10)).toEqual(['a', 'b', 'c']);
  });

  it('returns the LAST maxLines, in order', () => {
    const p = write('many.jsonl', ['1', '2', '3', '4', '5']);
    expect(readTailLinesSync(p, 3)).toEqual(['3', '4', '5']);
  });

  it('never returns a partial first line when it starts mid-file', () => {
    // Lines big enough that 50 of them blow past the 256 KB initial window,
    // so the reader must seek and drop the fragment it lands in.
    const big = 'x'.repeat(20 * 1024);
    const lines = Array.from({ length: 40 }, (_, i) => `${i}:${big}`);
    const p = write('big.jsonl', lines);

    const got = readTailLinesSync(p, 5);
    expect(got).not.toBeNull();
    expect(got).toHaveLength(5);
    // Every returned line is whole: it still carries its index prefix and its
    // full payload. A fragment would be missing the `N:` head.
    for (const line of got ?? []) {
      expect(line).toMatch(/^\d+:x+$/);
      expect(line.length).toBe(big.length + `${line.split(':')[0]}`.length + 1);
    }
    expect(got?.[4]).toBe(lines[39]);
  });

  it('grows the window when a single line exceeds it', () => {
    // One line larger than the 256 KB initial window, preceded by a small one.
    // A non-growing reader would find no newline in its window and return [].
    const huge = 'y'.repeat(400 * 1024);
    const p = write('huge.jsonl', ['small', huge]);

    const got = readTailLinesSync(p, 1);
    expect(got).toEqual([huge]);
  });

  it('does not choke on a file that is one enormous line', () => {
    const only = 'z'.repeat(300 * 1024);
    const p = write('single.jsonl', [only]);
    // start === 0 once the window covers the file, so the line is complete.
    expect(readTailLinesSync(p, 5)).toEqual([only]);
  });

  it('skips blank lines', () => {
    const p = join(dir, 'blanks.jsonl');
    writeFileSync(p, 'a\n\n\nb\n');
    expect(readTailLinesSync(p, 10)).toEqual(['a', 'b']);
  });

  it('handles a file with no trailing newline', () => {
    const p = join(dir, 'no-nl.jsonl');
    writeFileSync(p, 'a\nb\nc');
    expect(readTailLinesSync(p, 2)).toEqual(['b', 'c']);
  });
});
