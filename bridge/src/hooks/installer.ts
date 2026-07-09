import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface HookInstallResult {
  hooksInstalled: boolean;
  mcpInstalled: boolean;
  scriptPath: string;
  diff: string;
}

const HOOK_EVENTS = ['UserPromptSubmit', 'Stop', 'SessionEnd', 'Notification', 'SubagentStop'];

export function generateHookScript(bridgeUrl: string): string {
  return `#!/usr/bin/env bash
set -euo pipefail

BRIDGE_URL="\${BUILDAGOTCHI_BRIDGE_URL:-${bridgeUrl}}"
STATE_DIR="\${HOME}/.buildagotchi/claude-state"

PAYLOAD=$(cat)

if ! curl -s -m 2 -X POST "\${BRIDGE_URL}/hooks/claude" \\
  -H "Content-Type: application/json" \\
  -d "$PAYLOAD" >/dev/null 2>&1; then
  SESSION_ID=$(echo "$PAYLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
  if [ -n "$SESSION_ID" ]; then
    mkdir -p "$STATE_DIR"
    echo "$PAYLOAD" > "\${STATE_DIR}/\${SESSION_ID}.json"
  fi
fi

exit 0
`;
}

export async function installHooks(opts: {
  settingsPath?: string;
  scriptDir?: string;
  bridgeUrl?: string;
  dryRun?: boolean;
  confirm?: (diff: string) => Promise<boolean>;
}): Promise<HookInstallResult> {
  const settingsPath =
    opts.settingsPath ?? join(process.env.HOME ?? '', '.claude', 'settings.json');
  const scriptDir = opts.scriptDir ?? join(process.env.HOME ?? '', '.buildagotchi', 'hooks');
  const bridgeUrl = opts.bridgeUrl ?? 'http://127.0.0.1:1780';
  const scriptPath = join(scriptDir, 'buildagotchi-hook.sh');

  // Read or create settings
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  }
  const original = JSON.stringify(settings, null, 2);

  // Ensure hooks object
  if (!settings.hooks || typeof settings.hooks !== 'object') {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;

  // SA21: dedupe-merge - for each event, filter existing entries containing 'buildagotchi' then add ours
  let hooksChanged = false;
  for (const event of HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event])
      ? (hooks[event] as Array<Record<string, unknown>>)
      : [];
    // Filter out any existing buildagotchi entries
    const filtered = existing.filter((entry) => {
      const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(entryHooks)) return true;
      return !entryHooks.some(
        (h) => typeof h.command === 'string' && h.command.includes('buildagotchi'),
      );
    });
    // Add our entry
    const newEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: scriptPath, timeout: 5 }],
    };
    filtered.push(newEntry);
    if (JSON.stringify(filtered) !== JSON.stringify(existing)) {
      hooksChanged = true;
    }
    hooks[event] = filtered;
  }

  // MCP server entry
  let mcpChanged = false;
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
    settings.mcpServers = {};
  }
  const mcpServers = settings.mcpServers as Record<string, unknown>;
  if (!mcpServers.buildagotchi) {
    mcpServers.buildagotchi = {
      command: 'node',
      args: ['dist/mcp.js'],
      cwd: join(dirname(settingsPath), '..'), // placeholder, user adjusts
    };
    mcpChanged = true;
  }

  const updated = JSON.stringify(settings, null, 2);
  const diff = computeDiff(original, updated);

  if (!hooksChanged && !mcpChanged) {
    return { hooksInstalled: false, mcpInstalled: false, scriptPath, diff: '' };
  }

  if (opts.dryRun) {
    return { hooksInstalled: hooksChanged, mcpInstalled: mcpChanged, scriptPath, diff };
  }

  if (opts.confirm) {
    const accepted = await opts.confirm(diff);
    if (!accepted) {
      return { hooksInstalled: false, mcpInstalled: false, scriptPath, diff };
    }
  }

  // Write settings
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${updated}\n`);

  // Write hook script
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(scriptPath, generateHookScript(bridgeUrl));
  chmodSync(scriptPath, 0o755);

  return { hooksInstalled: hooksChanged, mcpInstalled: mcpChanged, scriptPath, diff };
}

function computeDiff(original: string, updated: string): string {
  const oldLines = original.split('\n');
  const newLines = updated.split('\n');
  const lines: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i];
    const newLine = newLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined && !newLines.includes(oldLine)) lines.push(`- ${oldLine}`);
    if (newLine !== undefined && !oldLines.includes(newLine)) lines.push(`+ ${newLine}`);
  }
  return lines.join('\n');
}
