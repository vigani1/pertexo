import { CORE_NODE_CATALOG } from '@pertexo/nodes-core';
import {
  buildWorkflowExecutable,
  composeExecutableCatalog,
  createCheckpoint,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';

import { createDecisionEngine } from '../support/decide.js';

import {
  RUN_ID,
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from '../support/workflow.fixture.js';

describe('advanceRun decisions', () => {
  it('verifies the persisted projection before advancing the exact executable', async () => {
    const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const checkpoint = createCheckpoint({
      engineVersion: 'phase3-engine-v1',
      workflowVersionId: VERSION_ID,
      iterationBudget: 0,
      nextEventSequence: 2,
    });
    const engine = createDecisionEngine({
      catalog,
    });

    const result = await engine.advance({
      runId: RUN_ID,
      workflowVersionId: VERSION_ID,
      projection: {
        id: VERSION_ID,
        workspaceId: WORKSPACE_ID,
        workflowId: WORKFLOW_ID,
        versionNumber: 1,
        schemaVersion: 1,
        checksum: executable.checksum,
        executableSchemaVersion: 2,
        executableJson: executable.envelope,
      },
      checkpoint,
      observations: [],
      occurredAt: '2026-08-21T00:00:00.000Z',
      maximumAdmissions: 1,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      kind: 'transition',
      plan: {
        attempts: [
          expect.objectContaining({
            nodeId: 'manual',
            sideEffectClass: 'safe',
          }),
        ],
        checkpoint: { workflowVersionId: VERSION_ID },
      },
    });

    if (result.kind !== 'transition')
      throw new Error('fixture did not produce its initial transition');
    await expect(
      engine.advance({
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        projection: {
          id: VERSION_ID,
          workspaceId: WORKSPACE_ID,
          workflowId: WORKFLOW_ID,
          versionNumber: 1,
          schemaVersion: 1,
          checksum: executable.checksum,
          executableSchemaVersion: 2,
          executableJson: executable.envelope,
        },
        checkpoint: result.plan.checkpoint,
        observations: [],
        occurredAt: '2026-08-21T00:00:01.000Z',
        maximumAdmissions: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ kind: 'no_change', revision: 1 });
  });

  it('returns a transition when a duplicate observation advances only the durable cursor', async () => {
    const catalog = composeExecutableCatalog(CORE_NODE_CATALOG);
    const executable = buildWorkflowExecutable({ graph: graph(), catalog });
    const projection = {
      id: VERSION_ID,
      workspaceId: WORKSPACE_ID,
      workflowId: WORKFLOW_ID,
      versionNumber: 1,
      schemaVersion: 1 as const,
      checksum: executable.checksum,
      executableSchemaVersion: 2 as const,
      executableJson: executable.envelope,
    };
    const engine = createDecisionEngine({
      catalog,
    });
    const advance = (
      checkpoint: Parameters<typeof engine.advance>[0]['checkpoint'],
      observations: Parameters<typeof engine.advance>[0]['observations'],
      maximumAdmissions: number,
    ) =>
      engine.advance({
        runId: RUN_ID,
        workflowVersionId: VERSION_ID,
        projection,
        checkpoint,
        observations,
        occurredAt: '2026-08-21T00:00:00.000Z',
        maximumAdmissions,
        signal: new AbortController().signal,
      });
    const started = await advance(
      createCheckpoint({
        engineVersion: 'phase3-engine-v1',
        workflowVersionId: VERSION_ID,
        iterationBudget: 0,
        nextEventSequence: 2,
      }),
      [],
      1,
    );
    if (started.kind !== 'transition')
      throw new Error('manual attempt was not admitted');
    const manual = started.plan.attempts[0];
    if (manual === undefined) throw new Error('manual attempt is missing');
    const outcome = {
      sequence: started.plan.checkpoint.nextEventSequence,
      occurredAt: '2026-08-21T00:00:01.000Z',
      attemptId: '55555555-5555-4555-8555-555555555555',
      attemptNumber: manual.attemptNumber,
      kind: 'outcome' as const,
      invocationKey: manual.invocationKey,
      status: 'succeeded' as const,
    };
    const completed = await advance(started.plan.checkpoint, [outcome], 1);
    if (completed.kind !== 'transition')
      throw new Error('manual outcome was not consumed');
    const duplicateSequence = completed.plan.checkpoint.nextEventSequence;

    const cursorOnly = await advance(
      completed.plan.checkpoint,
      [{ ...outcome, sequence: duplicateSequence }],
      0,
    );

    expect(cursorOnly).toMatchObject({
      kind: 'transition',
      plan: {
        attempts: [],
        consumedThroughEventSequence: duplicateSequence,
        events: [],
        nodeRunAdmissions: [],
      },
    });
    if (cursorOnly.kind !== 'transition')
      throw new Error('cursor-only transition was misclassified');
    expect(cursorOnly.plan.checkpoint.nextEventSequence).toBe(
      duplicateSequence + 1,
    );
  });
});
