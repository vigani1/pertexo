import { createWorkspacePurgeCoordinator } from '../../../src/lifecycle/workspace-purge.js';
import { maintenanceUrl } from '../../lifecycle/retention.support.js';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance.js';
import { withWorkspaceTransaction } from '../../../src/tenant-access/transactions.js';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCheckpoint,
  type WorkflowTransitionPlan,
} from '@pertexo/workflow-engine';
import {
  createErrorWorkflowStore,
  ErrorWorkflowDeliveryMismatchError,
} from '../../../src/runs/error-workflows/store.js';
import { persistErrorWorkflowIntent } from '../../../src/runs/error-workflows/produce.js';
import { parseDatabaseConfig } from '../../../src/config.js';
import { withTenantScopedClient } from '../../../src/tenant-access/transactions.js';
import { admin, createFamily } from '../../lifecycle/calls/fixtures.js';
import {
  createWorkflowErrorStore,
  WorkflowErrorSettingsConflictError,
  WorkflowErrorTargetUnavailableError,
} from '../../../src/authoring/settings/error-workflow.js';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/errors.js';
import { userId } from '../../lifecycle/retention.support.js';
import { apiUrl } from '../../lifecycle/retention.support.js';

let pool: Pool;
let store: ReturnType<typeof createErrorWorkflowStore>;
beforeAll(() => {
  pool = new Pool({ connectionString: apiUrl, max: 2 });
  store = createErrorWorkflowStore(
    parseDatabaseConfig({ connectionString: apiUrl, max: 2 }),
    (version) => ({
      checkpoint: createCheckpoint({
        workflowVersionId: version.id,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
    }),
  );
});
afterAll(async () => {
  await Promise.all([pool.end(), store.close()]);
});

async function fixture(
  status:
    | 'failed'
    | 'succeeded'
    | 'canceled'
    | 'timed_out'
    | 'outcome_unknown' = 'failed',
  origin = false,
  canceled = false,
) {
  const family = await createFamily({
    executableJson: {
      graph: {
        nodes: [
          {
            id: 'error',
            definition: { key: 'core.workflow_error', version: 1 },
            config: {},
          },
        ],
      },
    },
  });
  const source = (
    await admin.query<{ workflow_id: string }>(
      'select workflow_id from app.workflow_runs where id=$1',
      [family.parentRunId],
    )
  ).rows[0];
  if (source === undefined) throw new Error('Source missing');
  await admin.query(
    'update app.workflows set published_version_id=$2 where id=$1',
    [family.childWorkflowId, family.childVersionId],
  );
  await admin.query(
    'update app.workflow_runs set error_workflow_origin=$2 where id=$1',
    [family.parentRunId, origin],
  );
  await admin.query(
    'insert into app.workflow_error_policies(workspace_id,workflow_id,target_workflow_id) values($1,$2,$3)',
    [family.workspaceId, source.workflow_id, family.childWorkflowId],
  );
  const checkpoint = {
    ...createCheckpoint({
      workflowVersionId: family.parentVersionId,
      iterationBudget: 200,
    }),
    runStatus: status,
  };
  const plan: WorkflowTransitionPlan = {
    expectedRevision: 0,
    expectedNextEventSequence: 1,
    consumedThroughEventSequence: 0,
    checkpoint,
    events: [
      {
        name: `run.${status}`,
        sequence: 1,
        occurredAt: new Date().toISOString(),
      },
    ],
    nodeRunAdmissions: [],
    attempts: [],
  };
  const produce = () =>
    withTenantScopedClient(
      pool,
      { workspaceId: family.workspaceId },
      (client) =>
        persistErrorWorkflowIntent(client, {
          workspaceId: family.workspaceId,
          workflowId: source.workflow_id,
          workflowVersionId: family.parentVersionId,
          runId: family.parentRunId,
          cancellationRequested: canceled,
          plan,
        }),
    );
  return { ...family, sourceWorkflowId: source.workflow_id, produce };
}
async function delivery(f: Awaited<ReturnType<typeof fixture>>) {
  const row = (
    await admin.query<{ id: string; payload_checksum: string }>(
      "select event.id,event.payload_checksum from app.outbox_events event join app.run_error_workflow_intents intent on intent.workspace_id=event.workspace_id and intent.outbox_event_id=event.id where event.workspace_id=$1 and event.aggregate_id=$2 and event.job_name='start-error-workflow'",
      [f.workspaceId, f.parentRunId],
    )
  ).rows[0];
  if (row === undefined) throw new Error('Missing delivery');
  return {
    workspaceId: f.workspaceId,
    sourceRunId: f.parentRunId,
    outboxEventId: row.id,
    payloadChecksum: row.payload_checksum,
    signal: new AbortController().signal,
  };
}
async function intent(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await admin.query<{
      status: string;
      accepted_run_id: string | null;
      refusal_code: string | null;
      context: unknown;
      queue_wait_expires_at: Date | null;
      outbox_event_id: string;
    }>(
      'select status,accepted_run_id,refusal_code,context,queue_wait_expires_at,outbox_event_id from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2',
      [f.workspaceId, f.parentRunId],
    )
  ).rows[0];
}
describe('durable error workflow admission', () => {
  it.each(['failed', 'timed_out', 'outcome_unknown'] as const)(
    'creates exactly one %s intent and target run under duplicate concurrent delivery',
    async (status) => {
      const f = await fixture(status);
      await Promise.all([f.produce(), f.produce()]);
      const input = await delivery(f);
      await Promise.all([store.dispatch(input), store.dispatch(input)]);
      await store.dispatch(input);
      const result = await intent(f);
      expect(result?.status).toBe('accepted');
      const runs = await admin.query<{
        trigger_type: string;
        error_workflow_origin: boolean;
        input_ref: unknown;
      }>(
        "select trigger_type,error_workflow_origin,input_ref from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
        [f.workspaceId],
      );
      expect(runs.rows).toHaveLength(1);
      expect(runs.rows[0]).toMatchObject({
        trigger_type: 'workflow_error',
        error_workflow_origin: true,
        input_ref: { kind: 'inline', value: result?.context },
      });
      expect(JSON.stringify(result?.context)).not.toContain(
        'Call retention input',
      );
    },
  );
  it.each([
    ['succeeded', false, false],
    ['canceled', false, false],
    ['failed', true, false],
    ['failed', false, true],
  ] as const)(
    'does not trigger for %s, error origin %s or cancellation %s',
    async (status, origin, canceled) => {
      const f = await fixture(status, origin, canceled);
      await f.produce();
      expect(await intent(f)).toBeUndefined();
    },
  );
  it('records target archive refusal without admitting a run', async () => {
    const f = await fixture();
    await f.produce();
    await admin.query(
      "update app.workflows set lifecycle_status='archived',lifecycle_revision=lifecycle_revision+1 where id=$1",
      [f.childWorkflowId],
    );
    await store.dispatch(await delivery(f));
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'target_unavailable',
      accepted_run_id: null,
    });
  });
  it('refuses changed transport data and cannot read another workspace intent', async () => {
    const f = await fixture();
    await f.produce();
    const input = await delivery(f);
    await expect(
      store.dispatch({ ...input, payloadChecksum: 'a'.repeat(64) }),
    ).rejects.toBeInstanceOf(ErrorWorkflowDeliveryMismatchError);
    const other = await fixture();
    await expect(
      store.dispatch({ ...input, workspaceId: other.workspaceId }),
    ).rejects.toBeInstanceOf(ErrorWorkflowDeliveryMismatchError);
    expect(await intent(f)).toMatchObject({ status: 'pending' });
  });
});

async function publishManualTarget(f: Awaited<ReturnType<typeof fixture>>) {
  const nextVersionId = crypto.randomUUID();
  await admin.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,executable_json,checksum,published_by)
      values($1,$2,$3,2,'{}',$4::jsonb,$5,$6)`,
    [
      nextVersionId,
      f.workspaceId,
      f.childWorkflowId,
      JSON.stringify({
        graph: {
          nodes: [{ definition: { key: 'core.manual', version: 1 } }],
        },
      }),
      `wf:sha256:${'b'.repeat(64)}`,
      userId,
    ],
  );
  await admin.query(
    'update app.workflows set published_version_id=$2 where id=$1',
    [f.childWorkflowId, nextVersionId],
  );
}

describe('error workflow settings authority and publication', () => {
  const settings = createWorkflowErrorStore(
    (workspaceId, actorId, operation, signal) =>
      withTenantScopedClient(
        pool,
        { workspaceId, actorId },
        operation,
        signal === undefined ? {} : { signal },
      ),
  );
  async function editable() {
    const f = await fixture();
    await admin.query(
      "insert into app.workspace_memberships(workspace_id,user_id,role,status) values($1,$2,'builder','active')",
      [f.workspaceId, userId],
    );
    return {
      ...f,
      scope: {
        workspaceId: f.workspaceId,
        workflowId: f.sourceWorkflowId,
        actorId: userId,
      },
    };
  }
  it('uses one revision/idempotent receipt, supports clearing and refuses stale or self targets', async () => {
    const f = await editable();
    const request = {
      ...f.scope,
      targetWorkflowId: null,
      expectedRevision: 1,
      idempotencyKey: 'clear-once',
    };
    const cleared = await settings.updateSettings(request);
    expect(cleared).toEqual({
      settings: { targetWorkflowId: null, revision: 2 },
      replayed: false,
    });
    expect(await settings.updateSettings(request)).toEqual({
      ...cleared,
      replayed: true,
    });
    await expect(
      settings.updateSettings({ ...request, idempotencyKey: 'stale' }),
    ).rejects.toBeInstanceOf(WorkflowErrorSettingsConflictError);
    await expect(
      settings.updateSettings({
        ...request,
        targetWorkflowId: f.sourceWorkflowId,
        expectedRevision: 2,
        idempotencyKey: 'self',
      }),
    ).rejects.toBeInstanceOf(WorkflowErrorTargetUnavailableError);
    expect(
      await settings.updateSettings({
        ...request,
        targetWorkflowId: f.childWorkflowId,
        expectedRevision: 2,
        idempotencyKey: 'choose',
      }),
    ).toMatchObject({
      settings: { targetWorkflowId: f.childWorkflowId, revision: 3 },
    });
    expect(await settings.listTargets(f.scope)).toEqual({
      items: [{ id: f.childWorkflowId, name: 'Call retention' }],
      nextCursor: null,
    });
  });
  it('requires a publication before the target can be selected', async () => {
    const f = await editable();
    await admin.query(
      'update app.workflows set published_version_id=null where id=$1',
      [f.childWorkflowId],
    );
    await expect(
      settings.updateSettings({
        ...f.scope,
        targetWorkflowId: f.childWorkflowId,
        expectedRevision: 1,
        idempotencyKey: 'unpublished',
      }),
    ).rejects.toBeInstanceOf(WorkflowErrorTargetUnavailableError);
    expect(await settings.listTargets(f.scope)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
  it('requires active edit membership at the command transaction and hides foreign targets', async () => {
    const f = await editable();
    const foreign = await fixture();
    await expect(
      settings.updateSettings({
        ...f.scope,
        targetWorkflowId: foreign.childWorkflowId,
        expectedRevision: 1,
        idempotencyKey: 'foreign',
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
    await admin.query(
      "update app.workspace_memberships set status='removed',role_revision=role_revision+1 where workspace_id=$1 and user_id=$2",
      [f.workspaceId, userId],
    );
    await expect(
      settings.updateSettings({
        ...f.scope,
        targetWorkflowId: null,
        expectedRevision: 1,
        idempotencyKey: 'removed',
      }),
    ).rejects.toBeInstanceOf(WorkflowNotFoundError);
  });
  it('records invalid-target refusal if the live publication no longer has the trigger', async () => {
    const f = await fixture();
    await publishManualTarget(f);
    await f.produce();
    await store.dispatch(await delivery(f));
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'invalid_target',
    });
  });
});

it('retains error-workflow origin on deliberate replay admission', async () => {
  const f = await fixture('failed', true);
  const accepted = await withWorkspaceTransaction(
    pool,
    f.workspaceId,
    (transaction) =>
      acceptWorkflowRun(transaction, {
        initialCheckpoint: createCheckpoint({
          workflowVersionId: f.childVersionId,
          iterationBudget: 200,
          nextEventSequence: 2,
        }),
        operation: 'workflow.run.accept',
        scope: `workflow-error-replay:${f.parentRunId}`,
        keyHash: 'd'.repeat(64),
        requestHash: 'e'.repeat(64),
        workflowId: f.childWorkflowId,
        workflowVersionId: f.childVersionId,
        triggerType: 'replay',
        replaySourceRunId: f.parentRunId,
        replayCommandId: crypto.randomUUID(),
        runInput: {},
      }),
  );
  const row = await admin.query<{ error_workflow_origin: boolean }>(
    'select error_workflow_origin from app.workflow_runs where id=$1',
    [accepted.runId],
  );
  expect(row.rows[0]?.error_workflow_origin).toBe(true);
});

async function fullQueue() {
  const f = await fixture();
  await f.produce();
  await admin.query(
    'insert into app.workspace_execution_entitlement_versions(workspace_id,version,active_run_limit,queued_run_limit) values($1,2,5,1)',
    [f.workspaceId],
  );
  await admin.query(
    'update app.workspace_execution_entitlements set current_version=2 where workspace_id=$1',
    [f.workspaceId],
  );
  const blocker = crypto.randomUUID();
  await admin.query(
    `insert into app.workflow_runs(id,workspace_id,workflow_id,workflow_version_id,trigger_type,status) values($1,$2,$3,$4,'manual','queued')`,
    [blocker, f.workspaceId, f.childWorkflowId, f.childVersionId],
  );
  return { ...f, blocker };
}

it('keeps one bounded pending intent under duplicate delivery, then admits once after capacity frees', async () => {
  const f = await fullQueue();
  const original = await delivery(f);
  await Promise.all([store.dispatch(original), store.dispatch(original)]);
  const pending = await intent(f);
  expect(pending).toMatchObject({
    status: 'pending',
    refusal_code: null,
    accepted_run_id: null,
  });
  expect(pending?.queue_wait_expires_at).toBeInstanceOf(Date);
  expect(pending?.outbox_event_id).not.toBe(original.outboxEventId);
  const next = await delivery(f);
  const scheduled = await admin.query<{ delay: number }>(
    'select extract(epoch from available_at-clock_timestamp())::float8 delay from app.outbox_events where id=$1',
    [next.outboxEventId],
  );
  expect(scheduled.rows[0]?.delay).toBeGreaterThan(0);
  expect(scheduled.rows[0]?.delay).toBeLessThanOrEqual(30);
  await store.dispatch(next);
  expect((await intent(f))?.queue_wait_expires_at).toEqual(
    pending?.queue_wait_expires_at,
  );
  await admin.query(
    "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1",
    [f.blocker],
  );
  const ready = await delivery(f);
  await Promise.all([
    store.dispatch(original),
    store.dispatch(ready),
    store.dispatch(next),
    store.dispatch(ready),
  ]);
  expect(await intent(f)).toMatchObject({
    status: 'accepted',
    refusal_code: null,
    queue_wait_expires_at: pending?.queue_wait_expires_at,
  });
  expect(
    (
      await admin.query(
        "select id from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
        [f.workspaceId],
      )
    ).rows,
  ).toHaveLength(1);
});

it('refuses visibly after the fixed capacity-wait deadline without losing the source failure', async () => {
  const f = await fullQueue();
  await store.dispatch(await delivery(f));
  await admin.query(
    "update app.run_error_workflow_intents set queue_wait_expires_at=clock_timestamp()-interval '1 second' where workspace_id=$1 and source_run_id=$2",
    [f.workspaceId, f.parentRunId],
  );
  await store.dispatch(await delivery(f));
  expect(await intent(f)).toMatchObject({
    status: 'refused',
    refusal_code: 'queue_full',
    accepted_run_id: null,
  });
  expect(
    (
      await admin.query('select id from app.workflow_runs where id=$1', [
        f.parentRunId,
      ])
    ).rows,
  ).toHaveLength(1);
});

it('purges the policy and captured target intent through ordinary workspace deletion', async () => {
  const f = await fixture();
  await f.produce();
  await admin.query(
    "update app.workspaces set status='purging',deletion_requested_at=clock_timestamp()-interval '2 days',deletion_requested_by=created_by,deletion_reason='Owned qualification',purge_after=clock_timestamp()-interval '1 day' where id=$1",
    [f.workspaceId],
  );
  const purge = createWorkspacePurgeCoordinator(
    parseDatabaseConfig({ connectionString: maintenanceUrl, max: 1 }),
    {
      purgeWorkspacePage: () =>
        Promise.resolve({ completed: true, deletedCount: 0 }),
    },
    { pageSize: 2 },
  );
  try {
    let completed = false;
    for (let page = 0; page < 100 && !completed; page++) {
      const result = await purge.processNext();
      completed =
        result.status === 'completed' && result.workspaceId === f.workspaceId;
    }
    expect(completed).toBe(true);
    expect(
      (
        await admin.query(
          'select source_run_id from app.run_error_workflow_intents where workspace_id=$1',
          [f.workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await admin.query(
          'select workflow_id from app.workflow_error_policies where workspace_id=$1',
          [f.workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
  } finally {
    await purge.close();
  }
});

it('runs the version captured at failure even if a different publication becomes current', async () => {
  const f = await fixture();
  await f.produce();
  await publishManualTarget(f);
  await store.dispatch(await delivery(f));
  const result = await intent(f);
  const accepted = await admin.query<{ workflow_version_id: string }>(
    'select workflow_version_id from app.workflow_runs where id=$1',
    [result?.accepted_run_id],
  );
  expect(accepted.rows[0]?.workflow_version_id).toBe(f.childVersionId);
});
