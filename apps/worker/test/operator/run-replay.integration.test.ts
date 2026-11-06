import { createInitialCheckpoint } from '@pertexo/core/runs';
import { PLATFORM_NODE_CATALOG } from '@pertexo/node-catalog';
import { composeExecutableCatalog } from '@pertexo/workflow-engine/server';
import { acceptManualFixtureRun } from '../support/attempts/manual-start.js';
import { createHash, randomUUID } from 'node:crypto';
import { createOperatorCommandStore } from '@pertexo/core/operator';
import { parseDatabaseConfig } from '@pertexo/database/testing';
import { JOB_NAME } from '@pertexo/queue/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabaseOperatorRunReplayStore,
  createOperatorRunReplayHandler,
} from '../../src/operator/run-replay.js';
import { coordinatorFixture as fixture } from '../support/coordinator/consumer.js';
import { seedCallableWorkflow } from '../support/coordinator/workflows.js';

const { workspaceId, actorId } = fixture;
let commands: ReturnType<typeof createOperatorCommandStore>;
let replay: ReturnType<typeof createDatabaseOperatorRunReplayStore>;

describe.runIf(fixture.enabled)('operator replay input admission', () => {
  beforeAll(async () => {
    await fixture.setup();
    commands = createOperatorCommandStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.dispatcherUrl),
      }),
    );
    replay = createDatabaseOperatorRunReplayStore(
      parseDatabaseConfig({
        connectionString: fixture.databaseUrl(fixture.workerUrl),
      }),
    );
  }, 60_000);
  afterAll(async () => {
    await Promise.allSettled([commands.close(), replay.close()]);
    await fixture.restoreServicesAndClose();
  });

  it('ends invalid input as failed and lets the operator retry corrected input with a new command', async () => {
    const identity = {
      workflowId: randomUUID(),
      workflowVersionId: randomUUID(),
    };
    const executable = await seedCallableWorkflow(fixture.ownerQuery, {
      actorId,
      workspaceId,
      identity,
      callable: {
        input: { type: 'number' },
        resultType: { type: 'number' },
        result: { kind: 'literal', value: 1 },
      },
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
    const source = await fixture.apiDatabase.withWorkspace(
      workspaceId,
      (transaction) =>
        acceptManualFixtureRun(transaction, {
          initialCheckpoint: initial.checkpoint,
          ...(initial.validateInput === undefined
            ? {}
            : { validateInput: initial.validateInput }),
          keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
          requestHash: createHash('sha256').update('1').digest('hex'),
          operation: 'workflow.run.accept',
          scope: `workflow:${identity.workflowId}:manual`,
          triggerType: 'manual',
          ...identity,
          runInput: 1,
        }),
    );
    const sourceRunId = source.runId;
    const request = async (runInput: unknown) => {
      const commandId = randomUUID();
      const { result } = await commands.replayRun({
        actorRef: 'operator:test',
        reason: 'Correct replay input',
        commandId,
        dryRun: false,
        sourceRunId,
        workflowVersionId: identity.workflowVersionId,
        workspaceId,
        runInput,
      });
      return {
        commandId,
        outboxEventId: String(result.outboxEventId),
        workspaceId,
      };
    };
    const handler = createOperatorRunReplayHandler(replay);
    const deliver = (data: Awaited<ReturnType<typeof request>>) =>
      handler.handle(
        {
          name: JOB_NAME.replayWorkflowRun,
          data,
          transport: { attemptsMade: 0, jobId: `outbox-${data.outboxEventId}` },
        },
        { signal: new AbortController().signal },
      );
    const invalid = await request('not a number');
    await expect(deliver(invalid)).rejects.toMatchObject({
      name: 'UnrecoverableError',
    });
    const [failed] = await fixture.workerQuery(
      `select r.status,r.safe_error_code,r.completed_at is not null completed,
              c.status command_status,c.result,
              (select count(*)::int from app.workflow_runs where replay_command_id=r.command_id) runs
       from app.operator_run_replay_requests r join app.operator_commands c on c.id=r.command_id where r.command_id=$1`,
      [invalid.commandId],
    );
    expect(failed).toMatchObject({
      status: 'failed',
      safe_error_code: 'input_invalid',
      completed: true,
      command_status: 'failed',
      result: { safeErrorCode: 'input_invalid' },
      runs: 0,
    });
    const record = await commands.getCommand({
      actorRef: 'operator:test',
      reason: 'Read replay failure',
      commandId: invalid.commandId,
      workspaceId,
    });
    expect(record).toMatchObject({
      status: 'failed',
      outcome: 'replay_failed',
      result: {
        safeErrorCode: 'input_invalid',
        safeErrorMessage:
          'Replay input does not match the workflow input contract.',
        recoveryAction:
          'Correct the input and submit run.replay with a new command ID.',
      },
    });
    const corrected = await request(42);
    await expect(deliver(corrected)).resolves.toMatchObject({
      kind: 'processed',
    });
    const [created] = await fixture.workerQuery(
      'select input_ref from app.workflow_runs where replay_command_id=$1',
      [corrected.commandId],
    );
    expect(created).toMatchObject({ input_ref: { kind: 'inline', value: 42 } });
  });
});
