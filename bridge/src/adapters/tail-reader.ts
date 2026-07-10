import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Synchronous tail reader for JSONL files (D-02).
 *
 * `readTranscriptTail` used to `readFileSync` the whole transcript to keep its
 * last 50 lines. Claude Code transcripts reach 70+ MB, and the hook that calls
 * it has a 2s budget (`curl -m 2`) before the shell script falls back to a
 * state file. Loading 70 MB to read 50 lines burned both memory and that budget.
 *
 * The scanner (`claude-jsonl-scanner.ts`) already seeks from the end, but it is
 * async and this path runs synchronously inside `handleHookEvent`. Hence a
 * sibling rather than a shared call: same idea, different colour of function.
 */

/** Bytes read from the end on the first attempt. */
const DEFAULT_WINDOW_BYTES = 256 * 1024;

/**
 * Hard ceiling for window growth. A transcript line carrying a large pasted
 * buffer or an image blob can exceed the initial window; we grow rather than
 * return nothing, but never to the point of reloading the whole file.
 */
const MAX_WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * Reads up to `maxLines` complete lines from the end of `filePath`.
 *
 * Returns `null` when the file can't be opened. Returns `[]` for an empty file.
 *
 * The window starts at `DEFAULT_WINDOW_BYTES` and doubles while it yields no
 * complete line and the file has more to give — a single line longer than the
 * window would otherwise be silently invisible.
 */
export function readTailLinesSync(filePath: string, maxLines: number): string[] | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return [];

    let window = Math.min(DEFAULT_WINDOW_BYTES, size);
    for (;;) {
      const start = Math.max(0, size - window);
      const length = size - start;
      const buf = Buffer.alloc(length);
      const bytesRead = readSync(fd, buf, 0, length, start);
      const raw = buf.subarray(0, bytesRead).toString('utf-8');

      // When we started mid-file the first line is almost certainly a fragment.
      // Drop it: a half-parsed JSON object would be counted as an unknown line
      // and skew `unknownLineRatio`, which drives the adapter's health status.
      // If the window contains no newline at all, every byte of it belongs to
      // one oversized line and we have nothing complete — grow, don't guess.
      let content: string;
      if (start > 0) {
        const firstNl = raw.indexOf('\n');
        content = firstNl < 0 ? '' : raw.slice(firstNl + 1);
      } else {
        content = raw;
      }
      const lines = content.split('\n').filter((l) => l.length > 0);

      const readWholeFile = start === 0;
      const enough = lines.length >= maxLines;
      if (enough || readWholeFile || window >= MAX_WINDOW_BYTES) {
        return lines.slice(-maxLines);
      }
      window = Math.min(window * 2, MAX_WINDOW_BYTES, size);
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
