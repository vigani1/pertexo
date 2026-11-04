import { requestWorkflowRunCancellation } from '../../../../src/runs/commands/request-cancellation.js';
import { expect, it, onTestFinished } from 'vitest';
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
} from './callbacks.fixture.js';
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
it('closes a callback while its workspace is suspended, and does not resume the run', async () => {
  const { scope, callback } = await prepared();
  await queryAsOwner(
    `update app.workspaces set status='suspended' where id=$1`,
    [workspaceId],
  );
  try {
    await expect(
      callbacks.respond({
        callback,
        output: response,
        redactOutput: unchanged,
        signal: scope.signal,
      }),
    ).rejects.toMatchObject({ reason: 'closed' });
    await expect(
      executionQuery<{ status: string }>(
        'select status from app.pending_run_tasks where id=$1',
        [callback.id],
      ),
    ).resolves.toEqual([{ status: 'prepared' }]);
  } finally {
    await queryAsOwner(
      `update app.workspaces set status='active' where id=$1`,
      [workspaceId],
    );
  }
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
it('does not tie the task cap to the queued-run limit', async () => {
  const { scope } = await prepared();
  await queryAsOwner(
    'update app.workspace_execution_entitlement_versions set queued_run_limit=1 where workspace_id=$1',
    [workspaceId],
    workspaceId,
  );
  try {
    await expect(
      callbacks.prepare({
        ...scope,
        targets: [{ nodeId: 'beside-the-first', config }],
        keyVersion: '1',
        tokenHash: ({ id }) => hash(id),
      }),
    ).resolves.toHaveLength(1);
  } finally {
    await queryAsOwner(
      'update app.workspace_execution_entitlement_versions set queued_run_limit=100 where workspace_id=$1',
      [workspaceId],
      workspaceId,
    );
  }
});
it('counts prepared and early responses in the existing allowance and fences a stale attempt', async () => {
  const { scope, callback } = await prepared();
  await queryAsOwner('update app.instance_capacity set pending_task_limit=1');
  onTestFinished(async () => {
    await queryAsOwner(
      'update app.instance_capacity set pending_task_limit=10000',
    );
  });
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

it('refuses callback artifact descriptors outside its workflow without saving a response', async () => {
  const { scope, callback } = await prepared();
  const artifactId = crypto.randomUUID();
  const file = {
    kind: 'artifact',
    artifactId,
    byteLength: 4,
    mediaType: 'application/octet-stream',
    sha256: 'a'.repeat(64),
  };
  await queryAsOwner(
    "insert into app.artifacts(id,workspace_id,purpose,storage_key,media_type,byte_length,sha256,status,expires_at,finalized_at) values($1,$2,'run-output',$3,$4,4,$5,'available',clock_timestamp()+interval '1 day',clock_timestamp())",
    [
      artifactId,
      workspaceId,
      `workspaces/${workspaceId}/artifacts/${artifactId}`,
      file.mediaType,
      file.sha256,
    ],
    workspaceId,
  );
  const otherWorkflowId = crypto.randomUUID();
  const otherVersionId = crypto.randomUUID();
  await queryAsOwner(
    `with source as (
      select workflow.*,run.workflow_version_id from app.workflows workflow
      join app.workflow_runs run on run.workflow_id=workflow.id where run.id=$3
    ), new_workflow as (
      insert into app.workflows(id,workspace_id,name,created_by)
      select $1,workspace_id,'Other callback file owner',created_by from source
    ) insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
      select $2,version.workspace_id,$1,1,version.graph_json,version.checksum,version.executable_json,version.published_by
      from app.workflow_versions version join source on source.workflow_version_id=version.id`,
    [otherWorkflowId, otherVersionId, scope.runId],
    workspaceId,
  );
  await executionQuery(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status,completed_at,input_ref,input_ref_expires_at)
    values($1,$2,$3,$4,'api','succeeded',clock_timestamp(),$5::json,clock_timestamp()+interval '1 day')`,
    [
      crypto.randomUUID(),
      workspaceId,
      otherWorkflowId,
      otherVersionId,
      JSON.stringify({ kind: 'inline', value: { file } }),
    ],
  );
  await expect(
    callbacks.respond({
      callback,
      output: { body: { file } },
      redactOutput: unchanged,
      signal: scope.signal,
    }),
  ).rejects.toMatchObject({ name: 'ArtifactMetadataNotFoundError' });
  expect(
    await executionQuery(
      'select status,output_ref from app.pending_run_tasks where id=$1',
      [callback.id],
    ),
  ).toEqual([{ status: 'prepared', output_ref: null }]);
  await queryAsOwner(
    "update app.workflow_runs set input_ref=$2::json,input_ref_expires_at=clock_timestamp()+interval '1 day' where id=$1",
    [scope.runId, JSON.stringify({ kind: 'inline', value: { file } })],
    workspaceId,
  );
  await callbacks.respond({
    callback,
    output: { body: { file } },
    redactOutput: unchanged,
    signal: scope.signal,
  });
  expect(
    await executionQuery(
      'select status from app.pending_run_tasks where id=$1',
      [callback.id],
    ),
  ).toEqual([{ status: 'submitted' }]);
});
