import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { waitForQ11OverlapBarrier } from '../support/parallel-run-barrier.js';

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

  it('admits one participant per marker and releases real waiters only after the release file exists', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-q11-'));
    process.env.PERTEXO_Q11_OVERLAP_DIRECTORY = directory;
    let completed = false;
    const waiting = waitForQ11OverlapBarrier().then(() => {
      completed = true;
    });
    try {
      await expect
        .poll(() =>
          access(path.join(directory, 'transport.ready')).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      expect(
        await readFile(path.join(directory, 'transport.ready'), 'utf8'),
      ).toBe('');
      await expect(waitForQ11OverlapBarrier()).rejects.toMatchObject({
        code: 'EEXIST',
      });
      expect(completed).toBe(false);
      await writeFile(path.join(directory, 'release'), '');
      await waiting;
      expect(completed).toBe(true);
    } finally {
      await writeFile(path.join(directory, 'release'), '');
      await waiting;
      await rm(directory, { recursive: true, force: true });
    }
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
