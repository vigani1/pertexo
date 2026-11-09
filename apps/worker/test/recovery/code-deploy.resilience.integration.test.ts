import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  describeFaults,
  RECOVERY_LIMIT_MS,
  SCENARIO_LIMIT_MS,
} from '../support/recovery/environment.js';
import {
  delay,
  runFacts,
  waitForRunsToEnd,
  type RunFacts,
} from '../support/recovery/facts.js';
import { ServiceProcess } from '../support/recovery/processes.js';
import { startStack, type Stack } from '../support/recovery/stack.js';

// Exercise the real run, not just the deploy script's ordering of Docker calls.
describeFaults('deploy while Code steps are running', () => {
  let stack: Stack | undefined;
  let runner: ServiceProcess | undefined;
  let directory: string | undefined;
  let short: RunFacts | undefined;
  let interrupted: RunFacts | undefined;
  let drainMs: number;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'j1-code-'));
    const environment = {
      CODE_STEPS_ENABLED: 'true',
      CODE_RUNNER_MAX_SECONDS: '300',
      CODE_RUNNER_SOCKET: join(directory, 'runner.sock'),
    };
    runner = new ServiceProcess(
      fileURLToPath(
        new URL('../../../code-runner/dist/main.js', import.meta.url),
      ),
      { PATH: process.env.PATH, NODE_ENV: 'test', ...environment },
    );
    runner.startOnce();
    await runner.waitForLog(/Code runner ready/u, 30_000);
    const activeStack = await startStack('code-deploy', { environment });
    stack = activeStack;
    const workspace = await stack.api.createWorkspace('code-deploy');
    const start = async (name: string, seconds: number) => {
      const workflow = await activeStack.api.publish(workspace, name, {
        settings: {},
        nodes: [
          {
            id: 'manual',
            definition: { key: 'core.manual', version: 1 },
            position: { x: 0, y: 0 },
            configVersion: 1,
            config: {},
            inputMappings: {},
            connectionRefs: {},
          },
          {
            id: 'code',
            definition: { key: 'core.code', version: 1 },
            position: { x: 10, y: 0 },
            configVersion: 1,
            config: {
              code: `const end = Date.now() + ${String(seconds * 1000)}; while (Date.now() < end) {} return 'finished';`,
              timeoutSeconds: 300,
            },
            inputMappings: {},
            connectionRefs: {},
          },
        ],
        edges: [
          {
            id: 'edge',
            source: { nodeId: 'manual', port: 'out' },
            target: { nodeId: 'code', port: 'in' },
          },
        ],
      });
      return activeStack.api.startRun(workspace, workflow);
    };
    const shortId = await start('short-code', 20);
    const longId = await start('long-code', 290);
    const dispatchDeadline = Date.now() + 30_000;
    for (;;) {
      const facts = await Promise.all(
        [shortId, longId].map((id) => runFacts(activeStack, id)),
      );
      if (facts.every((fact) => fact.steps.code?.[0] === 'running')) break;
      if (Date.now() > dispatchDeadline)
        throw new Error(`Code steps did not start: ${JSON.stringify(facts)}`);
      await delay(100);
    }
    // Give the runner time to begin execution after the attempt is persisted.
    await delay(1_000);
    const signaledAt = Date.now();
    await stack.worker.stop('SIGTERM');
    drainMs = Date.now() - signaledAt;
    short = await runFacts(stack, shortId);
    await runner.stop('SIGTERM');
    runner.startOnce();
    await runner.waitForLog(/Code runner ready/u, 30_000);
    stack.worker.start();
    const facts = await waitForRunsToEnd(stack, [longId], RECOVERY_LIMIT_MS);
    interrupted = facts[longId];
    short = await runFacts(stack, shortId);
    console.info(
      'Code deploy outcomes',
      JSON.stringify({ drainMs, short, interrupted }),
    );
  }, SCENARIO_LIMIT_MS);

  afterAll(async () => {
    await stack?.close();
    await runner?.stop('SIGTERM');
    if (directory !== undefined)
      await rm(directory, { recursive: true, force: true });
  }, SCENARIO_LIMIT_MS);

  it('finishes short Code work and terminalizes Code work cut off by the drain after restart', () => {
    expect(short).toEqual({
      status: 'succeeded',
      steps: { manual: ['succeeded'], code: ['succeeded'] },
    });
    expect(drainMs).toBeGreaterThanOrEqual(55_000);
    expect(drainMs).toBeLessThan(85_000);

    expect(interrupted?.status).toBe('failed');
    expect(interrupted?.steps.code).toEqual(['failed']);
  });
});
