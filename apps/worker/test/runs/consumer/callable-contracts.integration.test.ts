import { createHash, randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { createInitialCheckpoint } from '@pertexo/execution';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine';
import {
  CallableInputInvalidError,
  type CallableDeclaration,
} from '@pertexo/workflow-model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { coordinatorFixture } from '../../support/coordinator/consumer.js';
import { seedCallableWorkflow } from '../../support/coordinator/workflows.js';
import { createCoordinatorRecoveryHarness } from '../../support/coordinator/recovery-harness.js';
import { acceptManualFixtureRun } from '../../support/attempts/manual-start.js';

const {
  enabled,
  setup,
  restoreServicesAndClose,
  actorId,
  workspaceId,
  ownerQuery,
  workerQuery,
  workerUrl,
  databaseUrl,
} = coordinatorFixture;
const describeIntegration = enabled ? describe : describe.skip;
const inputType: CallableDeclaration['input'] = {
  type: 'object',
  properties: [{ name: 'name', valueType: { type: 'string' }, required: true }],
};

describeIntegration('Standalone callable contract execution', () => {
  beforeAll(setup, 60_000);
  afterAll(restoreServicesAndClose);

  it.each([
    {
      result: { kind: 'node_output', nodeId: 'manual', path: '$.name' },
      status: 'succeeded',
      value: 'Ada',
      reason: null,
    },
    {
      result: {
        kind: 'expression',
        language: 'jsonata',
        expression: 'runInput.name & "!"',
      },
      status: 'succeeded',
      value: 'Ada!',
      reason: null,
    },
    {
      result: { kind: 'literal', value: 1 },
      status: 'failed',
      value: undefined,
      reason: 'callable_result_invalid',
    },
    {
      result: { kind: 'node_output', nodeId: 'terminate', path: '$.missing' },
      status: 'failed',
      value: undefined,
      reason: 'callable_result_missing',
    },
  ] as const)(
    'enforces $result.kind result completion after fresh-worker recovery ($status)',
    async ({ result, status, value, reason }) => {
      const identity = {
        workflowId: randomUUID(),
        workflowVersionId: randomUUID(),
      };
      const executable = await seedCallableWorkflow(ownerQuery, {
        actorId,
        workspaceId,
        identity,
        callable: { input: inputType, resultType: { type: 'string' }, result },
      });
      const initial = createInitialCheckpoint(
        {
          id: identity.workflowVersionId,
          workspaceId,
          workflowId: identity.workflowId,
          versionNumber: 1,
          checksum: executable.checksum,
          executableJson: executable.envelope,
        },
        { catalog: composeExecutableCatalog(PLATFORM_NODE_CATALOG) },
      );
      const accept = (runInput: unknown) =>
        coordinatorFixture.apiDatabase.withWorkspace(
          workspaceId,
          (transaction) =>
            acceptManualFixtureRun(transaction, {
              initialCheckpoint: initial.checkpoint,
              ...(initial.validateInput === undefined
                ? {}
                : { validateInput: initial.validateInput }),
              keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
              requestHash: createHash('sha256')
                .update(JSON.stringify(runInput))
                .digest('hex'),
              operation: 'workflow.run.accept',
              scope: `workflow:${identity.workflowId}:manual`,
              triggerType: 'manual',
              workflowId: identity.workflowId,
              workflowVersionId: identity.workflowVersionId,
              runInput,
            }),
        );
      await expect(accept({ name: 1 })).rejects.toBeInstanceOf(
        CallableInputInvalidError,
      );
      expect(
        await workerQuery(
          'select id from app.workflow_runs where workspace_id=$1 and workflow_id=$2',
          [workspaceId, identity.workflowId],
        ),
      ).toEqual([]);
      const accepted = await accept({ name: 'Ada' });
      const recovery = await createCoordinatorRecoveryHarness({
        accepted,
        database: parseDatabaseConfig({
          connectionString: databaseUrl(workerUrl),
          max: 6,
        }),
        runtimeCapabilities: {},
        workerIdPrefix: 'callable-contract',
      });
      try {
        await recovery.publishCoordinator(accepted.outboxEventId, 1);
        await recovery.executeNext('manual');
        await recovery.continueAfter(2);
        await recovery.executeNext('set');
        await recovery.continueAfter(3);
        await recovery.restart({ obliterateQueues: true });
        await recovery.executeNext('terminate');
        const finalOutbox = await recovery.continueAfter(4);
        expect(
          await workerQuery(
            'select status,output_ref,error_summary from app.workflow_runs where workspace_id=$1 and id=$2',
            [workspaceId, accepted.runId],
          ),
        ).toEqual([
          {
            status,
            output_ref: value === undefined ? null : { kind: 'inline', value },
            error_summary: reason,
          },
        ]);
        const terminalEvents = await workerQuery(
          'select type,payload from app.run_events where workspace_id=$1 and workflow_run_id=$2 and type=$3',
          [workspaceId, accepted.runId, `run.${status}`],
        );
        expect(terminalEvents).toHaveLength(1);
        if (reason !== null)
          expect(terminalEvents[0]?.payload).toMatchObject({
            reasonCode: reason,
          });
        expect(
          await workerQuery(
            'select status from app.node_runs where workspace_id=$1 and workflow_run_id=$2 order by node_id',
            [workspaceId, accepted.runId],
          ),
        ).toEqual([
          { status: 'succeeded' },
          { status: 'succeeded' },
          { status: 'succeeded' },
        ]);
        await recovery.restart({ obliterateQueues: true });
        await recovery.publishCoordinator(finalOutbox, 4);
        expect(
          await workerQuery(
            'select status,output_ref,error_summary from app.workflow_runs where workspace_id=$1 and id=$2',
            [workspaceId, accepted.runId],
          ),
        ).toEqual([
          {
            status,
            output_ref: value === undefined ? null : { kind: 'inline', value },
            error_summary: reason,
          },
        ]);
      } finally {
        await recovery.close();
      }
    },
    60_000,
  );
});
