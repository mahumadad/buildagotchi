import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { focusTerminal } from '../src/core/focus-terminal.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(childProcess.execFile);

describe('focusTerminal', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('does nothing on non-darwin platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    focusTerminal('/some/path');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('does nothing with empty cwd', () => {
    focusTerminal('');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('calls osascript with cwd on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    focusTerminal('/Users/dev/project');
    expect(mockExecFile).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining(['-e', expect.any(String), '/Users/dev/project']),
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    );
  });

  it('logs the focused app on success', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const logger = { info: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, 'Cursor\n', '');
      return {} as any;
    });
    focusTerminal('/Users/dev/project', logger);
    expect(logger.info).toHaveBeenCalledWith('focused Cursor');
  });

  it('does not log when osascript returns "none"', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const logger = { info: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, 'none\n', '');
      return {} as any;
    });
    focusTerminal('/Users/dev/project', logger);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('silently ignores osascript errors', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const logger = { info: vi.fn() };
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(new Error('timeout'), '', '');
      return {} as any;
    });
    focusTerminal('/Users/dev/project', logger);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
