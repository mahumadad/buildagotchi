import { execFile } from 'node:child_process';

const APPS = ['Code', 'Cursor', 'Windsurf', 'Warp', 'iTerm2', 'Terminal'] as const;

const OSASCRIPT = `
on run argv
  set targetCwd to item 1 of argv
  set appOrder to {"Code", "Cursor", "Windsurf", "Warp", "iTerm2", "Terminal"}

  repeat with appName in appOrder
    if application (appName as text) is running then
      tell application (appName as text) to activate
      return appName as text
    end if
  end repeat

  return "none"
end run
`;

export function focusTerminal(
  cwd: string,
  logger?: { info: (msg: string) => void },
): void {
  if (process.platform !== 'darwin') return;
  if (!cwd) return;

  execFile('osascript', ['-e', OSASCRIPT, cwd], { timeout: 3000 }, (err, stdout) => {
    if (err) return;
    const app = stdout.trim();
    if (app && app !== 'none') {
      logger?.info(`focused ${app}`);
    }
  });
}
