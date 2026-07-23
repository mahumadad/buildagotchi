import { readFileSync, writeFileSync } from 'node:fs';

export function loadJsonFile<T>(path: string, logger: { warn: (obj: object, msg: string) => void }): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn({ err, path }, 'corrupt JSON file; starting from zero');
    return null;
  }
}

export function saveJsonFile(path: string, data: unknown, logger: { warn: (obj: object, msg: string) => void }): void {
  try {
    writeFileSync(path, JSON.stringify(data));
  } catch (err) {
    logger.warn({ err, path }, 'could not persist JSON file');
  }
}
