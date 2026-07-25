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

// Focus-stealing safety net: focusTerminal raises an editor/terminal to the
// front, which yanks the user out of whatever window they are in. A repeated
// trigger (a head-touch storm while a question is pending — #focusPendingQuestion
// fires per touch) once raised VS Code ~once a second, making it impossible to
// type anywhere else. Never bring a window forward more than once per cooldown,
// no matter how often callers ask.
let lastFocusAt = 0;
const FOCUS_COOLDOWN_MS = 8000;

/** Test-only: clear the cooldown so each test starts from a clean slate. */
export function resetFocusCooldownForTests(): void {
  lastFocusAt = 0;
}

export function focusTerminal(
  cwd: string,
  logger?: { info: (msg: string) => void },
): void {
  if (process.platform !== 'darwin') return;
  if (!cwd) return;
  const now = Date.now();
  if (now - lastFocusAt < FOCUS_COOLDOWN_MS) return;
  lastFocusAt = now;

  execFile('osascript', ['-e', OSASCRIPT, cwd], { timeout: 3000 }, (err, stdout) => {
    if (err) return;
    const app = stdout.trim();
    if (app && app !== 'none') {
      logger?.info(`focused ${app}`);
    }
  });
}
