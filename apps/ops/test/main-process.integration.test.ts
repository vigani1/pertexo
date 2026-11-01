import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../dist/main.js', import.meta.url));

it('answers a real command from a real database', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [entrypoint], {
    env: {
      ...process.env,
      LOG_LEVEL: 'silent',
      OPERATOR_COMMAND_TYPE: 'stuck-work.list',
    },
    timeout: 30_000,
  });

  expect(JSON.parse(stdout)).toEqual({
    runs: expect.any(Array) as unknown,
    failedOutboxEvents: expect.any(Array) as unknown,
  });
}, 40_000);
