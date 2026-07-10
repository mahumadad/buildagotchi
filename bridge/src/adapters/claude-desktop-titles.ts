import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

interface MinimalLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Reads Claude Desktop's per-chat metadata to extract user-assigned titles.
 *
 * Directory layout (macOS):
 *   ~/Library/Application Support/Claude/claude-code-sessions/
 *     {workspaceUuid}/
 *       {chatGroupUuid}/
 *         local_{uuid}.json
 *
 * Each JSON has fields: cliSessionId (maps to CLI sessionId), title, titleSource
 * ("user" | "auto" | absent). We only return titles where titleSource === "user":
 * "auto" / derived titles are worse than the last-prompt fallback the caller
 * already produces from the transcript.
 *
 * Returns a Map<cliSessionId, title>. Empty map if the directory doesn't exist
 * (e.g. Claude Desktop not installed, or non-macOS platform).
 */
export async function readDesktopSessionTitles(
  claudeDesktopSessionsDir: string,
  logger?: MinimalLogger,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!claudeDesktopSessionsDir) return out;

  let workspaces: string[];
  try {
    workspaces = await readdir(claudeDesktopSessionsDir);
  } catch (err) {
    logger?.warn({ err, dir: claudeDesktopSessionsDir }, 'desktop sessions dir not readable');
    return out;
  }

  for (const ws of workspaces) {
    const wsPath = join(claudeDesktopSessionsDir, ws);
    let groups: string[];
    try {
      groups = await readdir(wsPath);
    } catch {
      continue;
    }
    for (const grp of groups) {
      const grpPath = join(wsPath, grp);
      let files: string[];
      try {
        files = await readdir(grpPath);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('local_') || !file.endsWith('.json')) continue;
        const filePath = join(grpPath, file);
        try {
          const raw = await readFile(filePath, 'utf-8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed.titleSource !== 'user') continue;
          const cliSessionId = parsed.cliSessionId;
          const title = parsed.title;
          if (typeof cliSessionId === 'string' && typeof title === 'string' && title.length > 0) {
            out.set(cliSessionId, title);
          }
        } catch (err) {
          logger?.warn({ err, filePath }, 'failed to parse desktop session file');
        }
      }
    }
  }
  return out;
}

/** Default Claude Desktop sessions dir on macOS. Empty string on other platforms. */
export function defaultClaudeDesktopSessionsDir(): string {
  const home = process.env.HOME ?? '';
  if (!home || process.platform !== 'darwin') return '';
  return join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
}
