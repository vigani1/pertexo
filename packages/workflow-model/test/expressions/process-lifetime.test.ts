import { execFile, execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const COMPILED = fileURLToPath(
  new URL('../../dist/server.js', import.meta.url),
);
// A host that evaluates once on the compiled evaluator and then does nothing more.
const HOST = (afterEvaluation: string) => `
  import { JsonataEvaluator } from ${JSON.stringify(COMPILED)};
  const result = await new JsonataEvaluator().evaluate({
    expression: '1 + 1',
    context: { runInput: null, nodeOutputs: {} },
  });
  process.stdout.write(JSON.stringify(result) + '\\n');
  ${afterEvaluation}
`;

function isRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function stoppedWithin(processId: number, millis: number) {
  const deadline = Date.now() + millis;
  while (isRunning(processId) && Date.now() < deadline) await delay(50);
  return !isRunning(processId);
}

describe('the lifetime of an evaluation process', () => {
  it('lets its host exit without being shut down', async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', HOST('')],
      { timeout: 30_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({ kind: 'value', value: 2 });
  }, 40_000);

  it('does not outlive a host that was killed', async () => {
    const host = spawn(
      process.execPath,
      ['--input-type=module', '-e', HOST('setInterval(() => {}, 1000);')],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    await once(host.stdout, 'data');
    const evaluation = Number(
      execFileSync('pgrep', ['-P', String(host.pid)], { encoding: 'utf8' }),
    );
    expect(isRunning(evaluation)).toBe(true);

    host.kill('SIGKILL');

    expect(await stoppedWithin(evaluation, 10_000)).toBe(true);
  }, 40_000);
});
