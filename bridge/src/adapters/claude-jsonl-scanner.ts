import { access, open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface DiscoveredSession {
  sessionId: string;
  cwd: string;
  filePath: string;
  mtimeMs: number;
  /** Human-readable session slug assigned by Claude Code (e.g. "dreamy-stirring-beaver").
   *  Absent for very short sessions where Claude Code hasn't picked one yet. */
  slug?: string;
  /** First human prompt of the session, normalized and truncated. */
  title?: string;
  /** Most recent human prompt in the tail window, normalized and truncated. */
  lastPrompt?: string;
  /** Most recent assistant text response in the tail window, normalized and truncated. */
  lastResponse?: string;
}

interface MinimalLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Target bytes to read from the head of a transcript for title extraction. */
const HEAD_SCAN_BYTES = 64 * 1024;
/** Bytes to read from the tail of a transcript for lastPrompt/lastResponse.
 *  Sized so that sessions ending on a long streak of tool_uses/tool_results
 *  (common when Claude is doing heavy edits) still reach the last human prompt. */
const TAIL_SCAN_BYTES = 128 * 1024;
/** Hard upper bound for head reads. Attachments (images/pastes) embedded in the
 *  first JSONL line can be several hundred KB — extend past the target if the
 *  first newline hasn't appeared yet, but never past this limit. */
const HEAD_HARD_LIMIT = 1024 * 1024;
const MAX_TITLE_CHARS = 80;
const MAX_FIELD_CHARS = 400;

/**
 * Discovery scan of Claude Code session transcripts.
 *
 * Council decision D19 constraints (see DECISIONS.md → D19):
 * - C1: only stat() + bounded head/tail reads — never readFileSync of a full
 *   transcript. Some JSONL files reach 70+ MB; scanning them fully every N
 *   seconds would be prohibitive.
 * - C2: maxdepth 2 (top-level session files only), skip `subagents/` subdirectories.
 * - C3: sessionId comes from the JSONL first-line field, not from the filename.
 *   cwd is derived from the project directory name (reversing the `-` ← `/` transform).
 */
export async function scanClaudeSessions(
  projectsDir: string,
  freshWindowMs: number,
  logger?: MinimalLogger,
): Promise<DiscoveredSession[]> {
  const cutoff = Date.now() - freshWindowMs;
  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch (err) {
    logger?.warn({ err, projectsDir }, 'projects directory not readable');
    return [];
  }

  const results: DiscoveredSession[] = [];
  for (const projectName of projectDirs) {
    const projectPath = join(projectsDir, projectName);
    let entries: string[];
    try {
      entries = await readdir(projectPath);
    } catch {
      continue;
    }

    const cwd = await resolveProjectDirCwd(projectName);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const filePath = join(projectPath, entry);
      let mtimeMs: number;
      let fileSize: number;
      try {
        const st = await stat(filePath);
        if (!st.isFile()) continue;
        mtimeMs = st.mtimeMs;
        fileSize = st.size;
      } catch {
        continue;
      }
      if (mtimeMs < cutoff) continue;

      const head = await readHead(filePath, HEAD_SCAN_BYTES, logger);
      if (!head) continue;

      // If the file fits in the head window, reuse those lines for the tail scan;
      // otherwise seek from the end for a fresh tail window.
      const tailLines =
        fileSize > head.bytesRead
          ? await readTail(filePath, TAIL_SCAN_BYTES, fileSize, logger)
          : head.lines;

      const session: DiscoveredSession = {
        sessionId: head.sessionId,
        cwd,
        filePath,
        mtimeMs,
      };
      // slug can appear anywhere in the transcript; check the tail first (more
      // likely to have it once Claude Code has assigned one) and fall back to head.
      const slug = extractSlug(tailLines) ?? extractSlug(head.lines);
      if (slug !== undefined) session.slug = slug;
      const title = extractTitle(head.lines);
      if (title !== undefined) session.title = title;
      const lastPrompt = extractLastPrompt(tailLines);
      if (lastPrompt !== undefined) session.lastPrompt = lastPrompt;
      const lastResponse = extractLastResponse(tailLines);
      if (lastResponse !== undefined) session.lastResponse = lastResponse;
      results.push(session);
    }
  }
  return results;
}

/**
 * Claude Code encodes each session's cwd as a directory name by replacing `/`
 * with `-`. The encoding is lossy: real path segments may contain `-`, so
 * `-Users-mahumadad-Dev-work-omnitok-connect-api` matches BOTH
 *   /Users/mahumadad/Dev/work/omnitok/connect/api  (naive decode) AND
 *   /Users/mahumadad/Dev/work/omnitok-connect-api  (real path, with dashes)
 *
 * To disambiguate we start from the fully-split decode and greedily re-join
 * trailing segments with `-` until we find one that exists on disk. Falls back
 * to the naive decode if nothing matches (best-effort; a real cwd from a hook
 * event will overwrite it later).
 */
async function resolveProjectDirCwd(name: string): Promise<string> {
  const parts = name.startsWith('-') ? name.slice(1).split('-') : name.split('-');
  for (let joinFrom = parts.length; joinFrom >= 1; joinFrom--) {
    const head = parts.slice(0, joinFrom - 1);
    const tail = parts.slice(joinFrom - 1).join('-');
    const candidate = `/${[...head, tail].join('/')}`;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep trying with a longer trailing segment
    }
  }
  return `/${parts.join('/')}`;
}

/**
 * Reads the head of a JSONL file up to `targetBytes`, then keeps reading in
 * chunks until the first newline appears (bounded by HEAD_HARD_LIMIT). Returns
 * only complete lines and the sessionId parsed from the first line.
 */
async function readHead(
  filePath: string,
  targetBytes: number,
  logger?: MinimalLogger,
): Promise<{ sessionId: string; lines: string[]; bytesRead: number } | null> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const chunkSize = 16 * 1024;
    const buf = Buffer.alloc(chunkSize);
    const chunks: Buffer[] = [];
    let totalRead = 0;
    let sawNewline = false;
    while (totalRead < HEAD_HARD_LIMIT) {
      const { bytesRead } = await handle.read(buf, 0, chunkSize, totalRead);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buf.subarray(0, bytesRead));
      chunks.push(chunk);
      totalRead += bytesRead;
      if (!sawNewline && chunk.includes(0x0a)) sawNewline = true;
      if (sawNewline && totalRead >= targetBytes) break;
    }
    if (totalRead === 0) return null;

    const content = Buffer.concat(chunks).toString('utf-8');
    const lastNl = content.lastIndexOf('\n');
    const complete = lastNl >= 0 ? content.slice(0, lastNl) : content;
    const lines = complete.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;

    let sessionId: string | undefined;
    const firstLine = lines[0];
    if (firstLine) {
      try {
        const parsed = JSON.parse(firstLine) as Record<string, unknown>;
        if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId;
      } catch (err) {
        logger?.warn({ err, filePath }, 'failed to parse first line');
      }
    }
    if (!sessionId) return null;
    return { sessionId, lines, bytesRead: totalRead };
  } catch (err) {
    logger?.warn({ err, filePath }, 'failed to read head');
    return null;
  } finally {
    await handle?.close();
  }
}

/**
 * Seeks to `fileSize - maxBytes` and reads to EOF, discarding the first
 * (partial) line so only complete JSONL entries are returned.
 */
async function readTail(
  filePath: string,
  maxBytes: number,
  fileSize: number,
  logger?: MinimalLogger,
): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const start = Math.max(0, fileSize - maxBytes);
    const readSize = fileSize - start;
    if (readSize <= 0) return [];
    const buf = Buffer.alloc(readSize);
    const { bytesRead } = await handle.read(buf, 0, readSize, start);
    if (bytesRead === 0) return [];

    let content = buf.subarray(0, bytesRead).toString('utf-8');
    if (start > 0) {
      const firstNl = content.indexOf('\n');
      if (firstNl < 0) return [];
      content = content.slice(firstNl + 1);
    }
    return content.split('\n').filter((l) => l.length > 0);
  } catch (err) {
    logger?.warn({ err, filePath }, 'failed to read tail');
    return [];
  } finally {
    await handle?.close();
  }
}

function normalize(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Returns the human-authored prompt text of a `type:"user"` line, or undefined
 * if the line is a tool_result / non-user / structurally invalid.
 * String content is human; array content counts only if it contains a text block
 * (tool_result blocks are ignored).
 */
function extractUserText(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== 'user') return undefined;
  const msg = parsed.message as Record<string, unknown> | undefined;
  if (!msg) return undefined;
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
      }
    }
  }
  return undefined;
}

/** Returns the last text block of a `type:"assistant"` line, or undefined
 *  (e.g. tool_use-only messages). */
function extractAssistantText(parsed: Record<string, unknown>): string | undefined {
  if (parsed.type !== 'assistant') return undefined;
  const msg = parsed.message as Record<string, unknown> | undefined;
  if (!msg) return undefined;
  const content = msg.content;
  if (!Array.isArray(content)) return undefined;
  let text: string | undefined;
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b.type === 'text' && typeof b.text === 'string') text = b.text;
    }
  }
  return text;
}

function extractSlug(lines: string[]): string | undefined {
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof parsed.slug === 'string' && parsed.slug.length > 0) return parsed.slug;
  }
  return undefined;
}

function extractTitle(headLines: string[]): string | undefined {
  for (const line of headLines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = extractUserText(parsed);
    if (text) return normalize(text, MAX_TITLE_CHARS);
  }
  return undefined;
}

function extractLastPrompt(tailLines: string[]): string | undefined {
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = extractUserText(parsed);
    if (text) return normalize(text, MAX_FIELD_CHARS);
  }
  return undefined;
}

function extractLastResponse(tailLines: string[]): string | undefined {
  for (let i = tailLines.length - 1; i >= 0; i--) {
    const line = tailLines[i];
    if (!line) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const text = extractAssistantText(parsed);
    if (text) return normalize(text, MAX_FIELD_CHARS);
  }
  return undefined;
}
