import type { ChildProcess } from 'node:child_process';

import { z } from 'zod';

export function phase(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exited);
      child.off('error', exited);
      if (error) reject(error);
      else resolve();
    };
    const message = (value: unknown) => {
      if (z.object({ phase: z.literal(expected) }).safeParse(value).success)
        finish();
    };
    const exited = () => {
      finish(new Error('Owned concurrency worker startup failed'));
    };
    const timer = setTimeout(() => {
      finish(new Error('Owned concurrency worker startup deadline'));
    }, 20_000);
    child.on('message', message);
    child.once('exit', exited);
    child.once('error', exited);
  });
}

export function successfulExit(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    child.once('error', () => {
      reject(new Error('Owned concurrency process startup failed'));
    });
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Owned concurrency process exited ${String(code)}`));
    });
  });
}
