import type { ChildProcess } from 'node:child_process';

import { z } from 'zod';

export function phase(child: ChildProcess, expected: string) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
      child.off('error', exit);
      if (error) reject(error);
      else resolve();
    };
    const message = (value: unknown) => {
      if (
        z.object({ phase: z.literal('health-startup-failed') }).safeParse(value)
          .success
      )
        finish(new Error('Owned health worker construction failed'));
      if (z.object({ phase: z.literal(expected) }).safeParse(value).success)
        finish();
    };
    const exit = () => {
      finish(new Error('Owned health worker failed startup'));
    };
    const timer = setTimeout(() => {
      finish(new Error(`Owned health worker startup deadline: ${expected}`));
    }, 20000);
    child.on('message', message);
    child.once('exit', exit);
    child.once('error', exit);
  });
}
