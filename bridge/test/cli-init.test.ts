import { describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/cli.js';
import { TOKEN_ACCOUNT, TOKEN_SERVICE } from '../src/platform/platform.js';
import { makePlatform } from './helpers/factories.js';

describe('runInit', () => {
  it('generates and stores a new token, printing a curl example once', async () => {
    const platform = makePlatform({
      getSecret: vi.fn().mockResolvedValue(null),
      dataDir: () => '/tmp/buildagotchi-test',
    });
    const print = vi.fn();
    await runInit({ rotate: false }, platform, print);

    expect(platform.setSecret).toHaveBeenCalledTimes(1);
    const [service, account, token] = (platform.setSecret as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, string, string];
    expect(service).toBe(TOKEN_SERVICE);
    expect(account).toBe(TOKEN_ACCOUNT);
    expect(token.length).toBeGreaterThan(20);

    const printed = print.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('curl');
    expect(printed).toContain(token);
  });

  it('does not overwrite an existing token without --rotate', async () => {
    const platform = makePlatform({
      getSecret: vi.fn().mockResolvedValue('existing-token'),
      dataDir: () => '/tmp/buildagotchi-test',
    });
    const print = vi.fn();
    await runInit({ rotate: false }, platform, print);

    expect(platform.setSecret).not.toHaveBeenCalled();
    expect(print.mock.calls.join('\n')).toMatch(/rotate/);
  });

  it('regenerates the token when --rotate is set, even if one exists', async () => {
    const platform = makePlatform({
      getSecret: vi.fn().mockResolvedValue('existing-token'),
      dataDir: () => '/tmp/buildagotchi-test',
    });
    const print = vi.fn();
    await runInit({ rotate: true }, platform, print);

    expect(platform.setSecret).toHaveBeenCalledTimes(1);
  });
});
