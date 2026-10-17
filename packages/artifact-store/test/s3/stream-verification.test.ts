import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['abort', 'upstream', 'premature-close'])(
  'owns an early %s without crashing and preserves it for the eventual reader',
  (mode) => {
    const fixture = fileURLToPath(
      new URL('./stream-verification-process.fixture.ts', import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', fixture, mode],
      {
        encoding: 'utf8',
        timeout: 5_000,
      },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.signal).toBeNull();
    expect(JSON.parse(child.stdout)).toEqual({
      originalError: true,
      upstreamDestroyed: true,
      abortListeners: 0,
    });
  },
);
