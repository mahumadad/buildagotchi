import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function runDoctor(opts: {
  configPath?: string;
  settingsPath?: string;
  bridgeUrl?: string;
}): Promise<DoctorCheck[]> {
  const configPath = opts.configPath ?? './config.yaml';
  const settingsPath =
    opts.settingsPath ?? join(process.env.HOME ?? '', '.claude', 'settings.json');
  const bridgeUrl = opts.bridgeUrl ?? 'http://127.0.0.1:1780';
  const checks: DoctorCheck[] = [];

  // 1. Config file
  if (existsSync(configPath)) {
    checks.push({ name: 'config', status: 'ok', detail: `${configPath} exists` });
  } else {
    checks.push({ name: 'config', status: 'fail', detail: `${configPath} not found` });
  }

  // 2. Bridge server reachable
  try {
    const res = await fetch(`${bridgeUrl}/health`);
    if (res.ok) {
      checks.push({ name: 'bridge', status: 'ok', detail: `${bridgeUrl} reachable` });
    } else {
      checks.push({
        name: 'bridge',
        status: 'warn',
        detail: `${bridgeUrl} returned ${res.status}`,
      });
    }
  } catch {
    checks.push({ name: 'bridge', status: 'fail', detail: `${bridgeUrl} not reachable` });
  }

  // 3. Claude hooks in settings.json
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      checks.push({ name: 'hooks', status: 'fail', detail: 'settings.json is not valid JSON' });
      return checks;
    }
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (hooks && hasBuildagotchiHooks(hooks)) {
      checks.push({
        name: 'hooks',
        status: 'ok',
        detail: 'buildagotchi hooks found in settings.json',
      });
    } else {
      checks.push({
        name: 'hooks',
        status: 'fail',
        detail: 'buildagotchi hooks not found in settings.json',
      });
    }
  } else {
    checks.push({ name: 'hooks', status: 'fail', detail: 'settings.json not found' });
  }

  // 4. Hook script exists and is executable
  const scriptPath = join(process.env.HOME ?? '', '.buildagotchi', 'hooks', 'buildagotchi-hook.sh');
  if (existsSync(scriptPath)) {
    const stat = statSync(scriptPath);
    // Check if executable (owner execute bit)
    const isExec = (stat.mode & 0o100) !== 0;
    if (isExec) {
      checks.push({ name: 'script', status: 'ok', detail: 'hook script exists and is executable' });
    } else {
      checks.push({
        name: 'script',
        status: 'warn',
        detail: 'hook script exists but is not executable',
      });
    }
  } else {
    checks.push({ name: 'script', status: 'fail', detail: 'hook script not found' });
  }

  // 5. MCP server entry
  const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers?.buildagotchi) {
    checks.push({ name: 'mcp', status: 'ok', detail: 'MCP server entry found' });
  } else {
    checks.push({
      name: 'mcp',
      status: 'warn',
      detail: 'MCP server entry not found in settings.json',
    });
  }

  return checks;
}

function hasBuildagotchiHooks(hooks: Record<string, unknown>): boolean {
  const requiredEvents = ['UserPromptSubmit', 'Stop', 'Notification'];
  return requiredEvents.some((event) => {
    const entries = hooks[event];
    if (!Array.isArray(entries)) return false;
    return entries.some((entry: Record<string, unknown>) => {
      const entryHooks = entry.hooks as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(entryHooks)) return false;
      return entryHooks.some(
        (h) => typeof h.command === 'string' && h.command.includes('buildagotchi'),
      );
    });
  });
}
