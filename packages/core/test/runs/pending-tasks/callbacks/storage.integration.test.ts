import { requestWorkflowRunCancellation } from '../../../../src/runs/commands/cancel.repository.js';
import { expect, it } from 'vitest';
import {
  callbacks,
  config,
  prepared,
  response,
  hash,
  unchanged,
  executionQuery,
  workspaceId,
  otherWorkspaceId,
  apiPool,
  queryAsOwner,
} from './fixtures.js';
import {
  withTenantScopedClient,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';
import { bindCallbackTask } from '../../../../src/runs/pending-tasks/callbacks/bind.repository.js';
it.each(['api', 'test'])(
  'prepares and reuses one callback identity before Wait in a %s run',
  async (trigger) => {
    const { scope, callback } = await prepared(trigger);
    const again = await callbacks.prepare({
      ...scope,
      targets: [{ nodeId: 'wait', config }],
      keyVersion: '2',
      tokenHash: () => {
        throw new Error('Must retain first hash');
      },
    });
    expect(again).toEqual([callback]);
    const found = await callbacks.resolve(callback.tokenHash, scope.signal);
    expect(found).toMatchObject({
      id: callback.id,
      workspaceId,
      nodeId: 'wait',
      keyVersion: '1',
    });
    expect(found?.databaseTime).toBeInstanceOf(Date);
    const keys = [];
    for await (const item of callbacks.keysInUse(scope.signal)) keys.push(item);
    expect(keys).toContainEqual({
      id: callback.id,
      keyVersion: '1',
      tokenHash: hash(callback.id),
    });
    await expect(
      withTenantScopedClient(
        apiPool,
        { workspaceId: otherWorkspaceId },
        (client) =>
          client.query<{ id: string }>(
            'select id from app.pending_run_tasks where id=$1',
            [callback.id],
          ),
      ).then((result) => result.rows),
    ).resolves.toEqual([]);
  },
);
it('retains an early response and binds it through the existing app-role task owner', async () => {
  const { scope, callback } = await prepared();
  await callbacks.respond({
    callback,
    output: response,
    redactOutput: unchanged,
    signal: scope.signal,
  });
  const before = await executionQuery<{
    node_run_id: string | null;
    status: string;
  }>('select node_run_id,status from app.pending_run_tasks where id=$1', [
    callback.id,
  ]);
  expect(before).toEqual([{ node_run_id: null, status: 'submitted' }]);
  await executionQuery(
    "update app.node_runs set status='succeeded',completed_at=clock_timestamp() where id=$1",
    [scope.nodeRunId],
  );
  // The actual coordinator binds a completed Wait invocation, not the sending step.
  await queryAsOwner(
    "update app.node_runs set node_id='wait',invocation_key='wait' where id=$1",
    [scope.nodeRunId],
    workspaceId,
  );
  const bound = await withTenantScopedClient(
    apiPool,
    { workspaceId },
    (client) =>
      bindCallbackTask(client, workspaceId, {
        runId: scope.runId,
        intent: { kind: 'callback', invocationKey: 'wait', config },
        closed: false,
      }),
  );
  expect(bound.id).toBe(callback.id);
  expect(bound.status).toBe('submitted');
  expect(bound.expires_at.getTime()).toBeGreaterThan(Date.now() + 3_590_000);
  const row = (
    await executionQuery<{ node_run_id: string; output_ref: unknown }>(
      'select node_run_id,output_ref from app.pending_run_tasks where id=$1',
      [callback.id],
    )
  )[0];
  expect(row).toEqual({
    node_run_id: scope.nodeRunId,
    output_ref: { kind: 'inline', value: response },
  });
});
it('accepts one concurrent response and refuses cancellation without consuming another', async () => {
  const { scope, callback } = await prepared();
  const decisions = await Promise.allSettled(
    [1, 2].map(() =>
      callbacks.respond({
        callback,
        output: response,
        redactOutput: unchanged,
        signal: scope.signal,
      }),
    ),
  );
  expect(
    decisions.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const rejected = decisions.find((result) => result.status === 'rejected');
  expect(rejected?.status).toBe('rejected');
  await expect(
    callbacks.respond({
      callback,
      output: { body: 'second' },
      redactOutput: unchanged,
      signal: scope.signal,
    }),
  ).rejects.toMatchObject({ reason: 'resolved' });
  await withWorkspaceTransaction(apiPool, workspaceId, (transaction) =>
    requestWorkflowRunCancellation(transaction, {
      runId: scope.runId,
      actor: 'callback-test',
    }),
  );
  await expect(
    callbacks.respond({
      callback,
      output: response,
      redactOutput: unchanged,
      signal: scope.signal,
    }),
  ).rejects.toMatchObject({ reason: 'closed' });
});
it('counts prepared and early responses in the existing allowance and fences a stale attempt', async () => {
  const { scope, callback } = await prepared();
  await queryAsOwner(
    'update app.workspace_execution_entitlement_versions set queued_run_limit=1 where workspace_id=$1 and version=1',
    [workspaceId],
    workspaceId,
  );
  await callbacks.respond({
    callback,
    output: response,
    redactOutput: unchanged,
    signal: scope.signal,
  });
  await expect(
    callbacks.prepare({
      ...scope,
      targets: [{ nodeId: 'other', config }],
      keyVersion: '1',
      tokenHash: ({ id }) => hash(id),
    }),
  ).rejects.toMatchObject({ name: 'CallbackCapacityError' });
  await executionQuery(
    "update app.node_attempts set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [scope.attemptId],
  );
  await expect(
    callbacks.prepare({
      ...scope,
      targets: [{ nodeId: 'wait', config }],
      keyVersion: '1',
      tokenHash: ({ id }) => hash(id),
    }),
  ).rejects.toMatchObject({ name: 'ExecutionCapabilityExpiredError' });
});

it('keeps separate credentials for Wait identities and loop iterations in one run', async () => {
  const { scope, callback } = await prepared('api', 'wait', [
    { nodeId: 'loop', ordinal: 0 },
  ]);
  await queryAsOwner(
    'update app.node_runs set branch_context=$2::jsonb where id=$1',
    [
      scope.nodeRunId,
      JSON.stringify({
        branchPath: [],
        iterationPath: [{ nodeId: 'loop', ordinal: 1 }],
      }),
    ],
    workspaceId,
  );
  const records = await callbacks.prepare({
    ...scope,
    targets: [
      { nodeId: 'wait', config },
      { nodeId: 'other-wait', config },
    ],
    keyVersion: '1',
    tokenHash: ({ id }) => hash(id),
  });
  expect(new Set([callback.id, ...records.map((row) => row.id)]).size).toBe(3);
  expect(records.every((row) => row.scopeHash !== callback.scopeHash)).toBe(
    true,
  );
});
it('refuses an expired bound callback without storing a response', async () => {
  const { scope, callback } = await prepared();
  await queryAsOwner(
    "update app.node_runs set status='succeeded',completed_at=clock_timestamp(),node_id='wait',invocation_key='wait' where id=$1",
    [scope.nodeRunId],
    workspaceId,
  );
  await withTenantScopedClient(apiPool, { workspaceId }, (client) =>
    bindCallbackTask(client, workspaceId, {
      runId: scope.runId,
      intent: { kind: 'callback', invocationKey: 'wait', config },
      closed: false,
    }),
  );
  await queryAsOwner(
    "update app.pending_run_tasks set created_at=clock_timestamp()-interval '3 seconds',opened_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [callback.id],
    workspaceId,
  );
  await expect(
    callbacks.respond({
      callback,
      output: response,
      redactOutput: unchanged,
      signal: scope.signal,
    }),
  ).rejects.toMatchObject({ reason: 'closed' });
  expect(
    (
      await executionQuery<{ output_ref: unknown }>(
        'select output_ref from app.pending_run_tasks where id=$1',
        [callback.id],
      )
    )[0]?.output_ref,
  ).toBeNull();
});
