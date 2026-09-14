import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForQ11OverlapBarrier } from './support/q11-benchmark.js';

const originalEnvironment = {
  directory: process.env.PERTEXO_Q11_OVERLAP_DIRECTORY,
  participant: process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT,
  timing: process.env.PERTEXO_Q11_OPERATION_TIMING,
};

function restoreEnvironment(name: keyof typeof originalEnvironment): void {
  const environmentName = {
    directory: 'PERTEXO_Q11_OVERLAP_DIRECTORY',
    participant: 'PERTEXO_Q11_OVERLAP_PARTICIPANT',
    timing: 'PERTEXO_Q11_OPERATION_TIMING',
  }[name];
  const value = originalEnvironment[name];
  if (value === undefined) Reflect.deleteProperty(process.env, environmentName);
  else process.env[environmentName] = value;
}

describe('Q11 overlap barrier', () => {
  beforeEach(() => {
    process.env.PERTEXO_Q11_OPERATION_TIMING = '1';
    process.env.PERTEXO_Q11_OVERLAP_DIRECTORY = '/tmp/q11-proof';
    process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT = 'transport';
  });

  afterEach(() => {
    restoreEnvironment('directory');
    restoreEnvironment('participant');
    restoreEnvironment('timing');
  });

  it('rejects partial and invalid configuration', async () => {
    delete process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT;
    await expect(waitForQ11OverlapBarrier()).rejects.toThrow(
      'Q11 overlap barrier configuration is incomplete',
    );
    process.env.PERTEXO_Q11_OVERLAP_PARTICIPANT = 'INVALID';
    await expect(waitForQ11OverlapBarrier()).rejects.toThrow(
      'Q11 overlap barrier configuration is incomplete',
    );
  });

  it('creates an exclusive participant marker and observes release', async () => {
    const write = vi.fn(() => Promise.resolve());
    const inspect = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      )
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn(() => Promise.resolve());
    await waitForQ11OverlapBarrier({
      access: inspect,
      delay: wait,
      writeFile: write,
    });
    expect(write).toHaveBeenCalledWith('/tmp/q11-proof/transport.ready', '', {
      flag: 'wx',
    });
    expect(inspect).toHaveBeenLastCalledWith('/tmp/q11-proof/release');
    expect(wait).toHaveBeenCalledWith(10);
  });

  it('propagates an existing marker and non-ENOENT access failure', async () => {
    const existing = Object.assign(new Error('exists'), { code: 'EEXIST' });
    await expect(
      waitForQ11OverlapBarrier({
        writeFile: () => Promise.reject(existing),
      }),
    ).rejects.toBe(existing);

    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    await expect(
      waitForQ11OverlapBarrier({
        access: () => Promise.reject(denied),
        writeFile: () => Promise.resolve(),
      }),
    ).rejects.toBe(denied);
  });

  it('uses a bounded deadline while the release is missing', async () => {
    const times = [0, 2] as const;
    let index = 0;
    await expect(
      waitForQ11OverlapBarrier({
        access: () =>
          Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          ),
        delay: () => Promise.resolve(),
        now: () => times[Math.min(index++, times.length - 1)] ?? 2,
        timeoutMillis: 1,
        writeFile: () => Promise.resolve(),
      }),
    ).rejects.toThrow('Timed out waiting for the Q11 overlap release');
  });
});
