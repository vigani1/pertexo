import { syncBuiltinESMExports } from 'node:module';
import { mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { executeAutomationCommand } from '../src/execute-automation-command.js';
import { parseAutomationArguments } from '../src/automation-arguments.js';
import type { AutomationHttpClient } from '../src/automation-http-client.js';

it('backs off pending run reads and completes as soon as a failed run is observed', async () => {
  const requests: { path: string; at: number }[] = [];
  const client: AutomationHttpClient = {
    request: ({ path }) => {
      requests.push({ path, at: Date.now() });
      return Promise.resolve({
        body: {
          run: { status: requests.length < 3 ? 'running' : 'failed' },
          futureField: true,
        },
        etag: null,
      });
    },
  };
  const command = parseAutomationArguments([
    'runs',
    'wait',
    '--workspace',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '--run',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '--timeout',
    '20',
  ]);
  if (typeof command === 'string') throw new Error('Expected run command');
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  syncBuiltinESMExports();
  try {
    const pending = executeAutomationCommand(
      client,
      command,
      new AbortController().signal,
    );
    await nextTurn();
    expect(requests.map((request) => request.at)).toEqual([0]);
    mock.timers.tick(999);
    await nextTurn();
    expect(requests).toHaveLength(1);
    mock.timers.tick(1);
    await nextTurn();
    expect(requests.map((request) => request.at)).toEqual([0, 1000]);
    mock.timers.tick(1999);
    await nextTurn();
    expect(requests).toHaveLength(2);
    mock.timers.tick(1);
    await nextTurn();
    expect(requests.map((request) => request.at)).toEqual([0, 1000, 3000]);
    await expect(pending).resolves.toEqual({
      run: { status: 'failed' },
      futureField: true,
    });
  } finally {
    mock.timers.reset();
    syncBuiltinESMExports();
  }
});
