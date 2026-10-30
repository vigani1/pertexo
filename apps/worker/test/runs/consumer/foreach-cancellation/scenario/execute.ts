import { parseCheckpoint } from '@pertexo/workflow-engine';

import { expect } from 'vitest';
import type { acceptStructuredForEachRun } from '../../../../support/coordinator/runs.js';
import { waitForCoordinatorOutbox } from '../../../../support/coordinator/runs.js';
import { workerQuery, workspaceId } from '../fixture.js';
import type {
  ForEachScenarioMode,
  ForEachScenarioContext,
} from './contract.js';
import { acceptScenarioRun } from './start.js';
import { createForEachDelivery } from './delivery.js';
import { assertSerialLoopRecovery } from './serial.js';
import { assertBetweenBatchCancellation } from './between-batches.js';
import { assertRunningLoopControl } from './running-control.js';
import { assertParallelLoopCompletion } from './completion.js';

export function createForEachScenario(options: ForEachScenarioContext) {
  const {
    ownedProducer,
    ownedCoordinatorQueue,
    ownedAttemptQueue,
    stopWorkers,
    eraseRedisAndRestart,
  } = options;
  const verifyScenario = async (mode: ForEachScenarioMode) => {
    let structuredKind:
      Parameters<typeof acceptStructuredForEachRun>[0] | undefined;
    if (mode === 'condition_complete') {
      structuredKind = 'condition';
    } else if (mode === 'switch_complete') {
      structuredKind = 'switch';
    } else if (mode === 'nested_complete') {
      structuredKind = 'nested';
    } else {
      structuredKind = undefined;
    }
    const accepted = await acceptScenarioRun({ structuredKind, mode });
    const delivery = createForEachDelivery({
      accepted,
      ownedProducer,
      ownedCoordinatorQueue,
      ownedAttemptQueue,
    });
    const {
      coordinatorOutboxes,
      publishCoordinator,
      continueAfter,
      execute,
      executeDuplicateAttempt,
    } = delivery;
    await publishCoordinator(accepted.outboxEventId, 1);
    await execute('manual');
    await continueAfter(2);
    const declaration = await execute('for-each');

    const declarationJob = await ownedAttemptQueue.getJob(
      `outbox-${declaration.outbox_id}`,
    );
    await declarationJob?.remove();
    await executeDuplicateAttempt(declaration);

    // The declaration outcome is durable before any coordinator consumes it.
    await eraseRedisAndRestart();
    const declarationContinuation = await waitForCoordinatorOutbox(
      accepted.runId,
      coordinatorOutboxes,
    );
    coordinatorOutboxes.push(declarationContinuation);
    await publishCoordinator(declarationContinuation, 3);
    const declarationCoordinatorJob = await ownedCoordinatorQueue.getJob(
      `outbox-${declarationContinuation}`,
    );
    await declarationCoordinatorJob?.remove();
    await publishCoordinator(declarationContinuation, 3);
    await eraseRedisAndRestart();

    if (mode === 'serial_complete' || structuredKind !== undefined) {
      await assertSerialLoopRecovery({
        accepted,
        mode,
        structuredKind,
        delivery,
        stopWorkers,
        eraseRedisAndRestart,
      });
      return;
    }

    const reserved = await workerQuery<{
      scheduler_state: unknown;
    }>(
      `select scheduler_state from app.run_checkpoints
            where workspace_id=$1 and workflow_run_id=$2`,
      [workspaceId, accepted.runId],
    );
    expect(parseCheckpoint(reserved[0]?.scheduler_state)).toMatchObject({
      remainingIterationBudget: 997,
      loops: [
        {
          activeOrdinals: [0, 1],
          nextOrdinal: 2,
          terminalOrdinals: [],
        },
      ],
    });

    if (mode !== 'cancel_running' && mode !== 'deadline_running') {
      for (const ordinal of [0, 1]) {
        await execute('body-map', ordinal);
        await continueAfter(4 + ordinal);
      }
      await execute('body-sink', 0);
      await execute('body-sink', 1);
    }

    if (mode === 'cancel_between_batches') {
      await assertBetweenBatchCancellation({
        accepted,
        mode,
        structuredKind,
        delivery,
        stopWorkers,
        eraseRedisAndRestart,
      });
      return;
    }

    if (mode === 'cancel_running' || mode === 'deadline_running') {
      await assertRunningLoopControl({
        accepted,
        mode,
        structuredKind,
        delivery,
        stopWorkers,
        eraseRedisAndRestart,
      });
      return;
    }

    await assertParallelLoopCompletion({
      accepted,
      mode,
      structuredKind,
      delivery,
      stopWorkers,
      eraseRedisAndRestart,
    });
  };
  return verifyScenario;
}
