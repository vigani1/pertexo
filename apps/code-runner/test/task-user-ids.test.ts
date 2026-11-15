import { readFileSync } from 'node:fs';
import { CODE_SETTING_BOUNDS } from '@pertexo/node-sdk';
import { describe, expect, it } from 'vitest';

import { TASK_USER_ID_BASE } from '../src/process/slot.js';

/** The task user-id range the native launcher accepts for its first argument. */
function launcherUserIds(): Readonly<{ minimum: number; maximum: number }> {
  const source = readFileSync(
    new URL('../native/launch.c', import.meta.url),
    'utf8',
  );
  const match = /number\(argv\[1\],\s*(\d+),\s*(\d+)\)/u.exec(source);
  if (match === null)
    throw new Error('launch.c no longer reads a task user id');
  return { minimum: Number(match[1]), maximum: Number(match[2]) };
}

describe('task user ids', () => {
  it('match between the manager and the native launcher, one per slot', () => {
    expect(launcherUserIds()).toEqual({
      minimum: TASK_USER_ID_BASE,
      maximum: TASK_USER_ID_BASE + CODE_SETTING_BOUNDS.maximumConcurrency - 1,
    });
  });
});
