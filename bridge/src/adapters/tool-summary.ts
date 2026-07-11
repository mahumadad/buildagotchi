// Fase 0 (2026-07-11): forma de tool_input verificada empíricamente.
// Este resumen es lo único que sale al bus/robot; el tool_input crudo no.

const MAX_COMMAND = 200;
const FILE_TOOLS = new Set(['Edit', 'Write', 'Read', 'NotebookEdit', 'MultiEdit']);

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function cap(text: string): string {
  if (text.length <= MAX_COMMAND) return text;
  return `${text.slice(0, MAX_COMMAND - 1)}…`;
}

export function summarizeToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
): { command?: string; summary: string } {
  const input = toolInput ?? {};

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const command = cap(input.command);
    return { command, summary: `${toolName}: ${command}` };
  }

  if (FILE_TOOLS.has(toolName) && typeof input.file_path === 'string') {
    return { command: input.file_path, summary: `${toolName}: ${basename(input.file_path)}` };
  }

  const keys = Object.keys(input).sort();
  if (keys.length === 0) return { summary: toolName };
  return { summary: `${toolName}: ${keys.join(', ')}` };
}
