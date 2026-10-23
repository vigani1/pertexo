import { expect } from 'vitest';

import { coordinatorFixture as fixture } from '../../../../support/coordinator/consumer.js';

import type { RoutingScenario } from './contract.js';

export async function assertRoutingOutcomes(scenario: RoutingScenario) {
  const { control, start, wait, runs, executed } = scenario;
  for (const [next, status] of [
    ['handler-failed', 'failed'],
    ['unknown', 'outcome_unknown'],
    ['normal', 'succeeded'],
  ] as const) {
    control.mode = next;
    const accepted = await start();
    await wait(accepted.run.id, status);
    const result = await runs.get({
      actorId: fixture.actorId,
      workspaceId: fixture.workspaceId,
      runId: accepted.run.id,
    });
    expect(result?.run.handledFailureCount).toBeUndefined();
    if (next === 'handler-failed')
      expect(
        result?.nodes.find((n) => n.nodeId === 'source')?.failureHandling
          ?.disposition,
      ).toBe('pending');
    else
      expect(
        executed.filter(
          (n) => n.runId === accepted.run.id && n.nodeId.startsWith('handler'),
        ),
      ).toEqual([]);
  }
  control.mode = 'handler-retry';
  const retried = await start();
  await wait(retried.run.id, 'succeeded');
  const retryHistory = await runs.get({
    actorId: fixture.actorId,
    workspaceId: fixture.workspaceId,
    runId: retried.run.id,
  });
  expect(
    retryHistory?.nodes.find((n) => n.nodeId === 'handler')
      ?.currentAttemptNumber,
  ).toBe(2);
  expect(retryHistory?.run.handledFailureCount).toBe(1);
  const handlerInputs = executed
    .filter((n) => n.runId === retried.run.id && n.nodeId === 'handler')
    .map((n) => n.input);
  expect(handlerInputs).toHaveLength(2);
  expect(handlerInputs[1]).toEqual(handlerInputs[0]);
}
