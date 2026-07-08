import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Platform } from './platform.js';

/** `security(1)` exits with 44 when the Keychain item doesn't exist. */
const NOT_FOUND_EXIT_CODE = 44;

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(stdout);
    });
  });
}

export class MacosPlatform implements Platform {
  async getSecret(service: string, account: string): Promise<string | null> {
    try {
      const stdout = await run(['find-generic-password', '-s', service, '-a', account, '-w']);
      return stdout.trim();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException & { code?: number }).code;
      if (code === NOT_FOUND_EXIT_CODE) {
        return null;
      }
      throw err;
    }
  }

  async setSecret(service: string, account: string, value: string): Promise<void> {
    await run(['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
  }

  dataDir(): string {
    return join(homedir(), '.buildagotchi');
  }
}
