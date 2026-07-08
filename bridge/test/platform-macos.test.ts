import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

describe('MacosPlatform', () => {
  afterEach(() => {
    execFileMock.mockReset();
  });

  it('getSecret returns the stored value when found', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, 'super-secret-token\n', '');
    });
    const { MacosPlatform } = await import('../src/platform/macos.js');
    const platform = new MacosPlatform();
    await expect(platform.getSecret('svc', 'acct')).resolves.toBe('super-secret-token');
  });

  it('getSecret returns null when the item is not found (exit 44)', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      const err = new Error('not found') as Error & { code: number };
      err.code = 44;
      cb(err, '', '');
    });
    const { MacosPlatform } = await import('../src/platform/macos.js');
    const platform = new MacosPlatform();
    await expect(platform.getSecret('svc', 'acct')).resolves.toBeNull();
  });

  it('getSecret throws on an unexpected error', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      const err = new Error('boom') as Error & { code: number };
      err.code = 1;
      cb(err, '', '');
    });
    const { MacosPlatform } = await import('../src/platform/macos.js');
    const platform = new MacosPlatform();
    await expect(platform.getSecret('svc', 'acct')).rejects.toThrow(/boom/);
  });

  it('setSecret calls security add-generic-password with -U', async () => {
    execFileMock.mockImplementation((_cmd, _args, cb) => {
      cb(null, '', '');
    });
    const { MacosPlatform } = await import('../src/platform/macos.js');
    const platform = new MacosPlatform();
    await platform.setSecret('svc', 'acct', 'value123');
    expect(execFileMock).toHaveBeenCalledWith(
      'security',
      ['add-generic-password', '-U', '-s', 'svc', '-a', 'acct', '-w', 'value123'],
      expect.any(Function),
    );
  });

  it('dataDir() returns ~/.buildagotchi expanded', async () => {
    const { MacosPlatform } = await import('../src/platform/macos.js');
    const platform = new MacosPlatform();
    expect(platform.dataDir().endsWith('/.buildagotchi')).toBe(true);
  });
});
