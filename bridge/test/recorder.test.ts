import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventRecorder, type RecorderLine } from '../src/recorder/recorder.js';

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'bridge-recorder-'));
}

function line(overrides: Partial<RecorderLine> = {}): RecorderLine {
  return {
    line_type: 'event',
    ts: Date.now(),
    context: {
      metabolicScore: null,
      activeMode: 'NORMAL',
      bleHealthy: true,
      adapterHealth: {},
    },
    data: { hello: 'world' },
    ...overrides,
  };
}

describe('EventRecorder', () => {
  let recorder: EventRecorder | undefined;

  afterEach(async () => {
    await recorder?.close();
    recorder = undefined;
  });

  it('writes a parseable ndjson line', async () => {
    const dir = tmpDir();
    recorder = new EventRecorder({ dir, retentionDays: 30 });
    recorder.record(line());
    await recorder.flush();

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const content = readFileSync(join(dir, files[0] as string), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ line_type: 'event' });
  });

  it('names the file after the local date', async () => {
    const dir = tmpDir();
    const fixedNow = new Date('2026-07-08T12:00:00').getTime();
    recorder = new EventRecorder({ dir, retentionDays: 30, now: () => fixedNow });
    recorder.record(line({ ts: fixedNow }));
    await recorder.flush();
    expect(readdirSync(dir)).toContain('2026-07-08.ndjson');
  });

  it('rotates to a new file when the date changes', async () => {
    const dir = tmpDir();
    let now = new Date('2026-07-08T23:59:59').getTime();
    recorder = new EventRecorder({ dir, retentionDays: 30, now: () => now });
    recorder.record(line({ ts: now }));
    now = new Date('2026-07-09T00:00:01').getTime();
    recorder.record(line({ ts: now }));
    await recorder.flush();

    const files = readdirSync(dir).sort();
    expect(files).toEqual(['2026-07-08.ndjson', '2026-07-09.ndjson']);
  });

  it('deletes files older than retentionDays and keeps recent ones', async () => {
    const dir = tmpDir();
    writeFileSync(join(dir, '2020-01-01.ndjson'), '{}\n');
    writeFileSync(join(dir, '2026-07-07.ndjson'), '{}\n');
    const fixedNow = new Date('2026-07-08T12:00:00').getTime();
    recorder = new EventRecorder({ dir, retentionDays: 30, now: () => fixedNow });
    recorder.record(line({ ts: fixedNow }));
    await recorder.flush();

    const files = readdirSync(dir).sort();
    expect(files).not.toContain('2020-01-01.ndjson');
    expect(files).toContain('2026-07-07.ndjson');
    expect(files).toContain('2026-07-08.ndjson');
  });

  it('recent() returns the last N lines in order', async () => {
    const dir = tmpDir();
    recorder = new EventRecorder({ dir, retentionDays: 30 });
    for (let i = 0; i < 5; i++) {
      recorder.record(line({ data: { i } }));
    }
    const recent = recorder.recent(3);
    expect(recent.map((l) => l.data.i)).toEqual([2, 3, 4]);
  });

  it('flushes the full file after close', async () => {
    const dir = tmpDir();
    recorder = new EventRecorder({ dir, retentionDays: 30 });
    recorder.record(line());
    recorder.record(line());
    await recorder.close();
    recorder = undefined;

    const files = readdirSync(dir);
    const content = readFileSync(join(dir, files[0] as string), 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
  });
});
