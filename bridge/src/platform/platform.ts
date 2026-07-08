export interface Platform {
  getSecret(service: string, account: string): Promise<string | null>;
  setSecret(service: string, account: string, value: string): Promise<void>;
  dataDir(): string;
}

/** Keychain service/account for the `POST /events` bearer token (SA2, S1.7). */
export const TOKEN_SERVICE = 'buildagotchi-bridge';
export const TOKEN_ACCOUNT = 'external-token';
