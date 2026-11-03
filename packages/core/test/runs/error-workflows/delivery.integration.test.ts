import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthoringAccess } from '../../../src/authoring/workflows/access.js';
import { admin, insertHint } from '../../lifecycle/calls/fixtures.js';
import {
  createWorkflowErrorStore,
  WorkflowErrorSettingsConflictError,
  WorkflowErrorTargetUnavailableError,
} from '../../../src/authoring/settings/error-workflow/workflow-error.store.js';
import { WorkflowNotFoundError } from '../../../src/authoring/workflows/workflow-authoring.errors.js';
import {
  userId,
  maintenanceUrl,
  apiUrl,
} from '../../lifecycle/retention.support.js';
import {
  pool,
  store,
  fixture,
  delivery,
  intent,
  publishManualTarget,
  beforeAllFixture1,
  afterAllFixture2,
  fullQueue,
  cancelQueuedRun,
} from './delivery/fixture.js';
import { ErrorWorkflowDeliveryMismatchError } from '../../../src/runs/error-workflows/error-workflow.errors.js';
import { acceptWorkflowRun } from '../../../src/runs/commands/acceptance/accept.js';
import {
  withWorkspaceTransaction,
  withTenantScopedClient,
} from '@pertexo/database/primitives';
import { createCheckpoint } from '@pertexo/workflow-engine';
import { readErrorWorkflow } from '../../../src/runs/error-workflows/read.repository.js';
import { createWorkspacePurgeCoordinator } from '../../../src/lifecycle/purge/coordinator.js';
import { parseDatabaseConfig } from '@pertexo/database/platform';
import { waitForApplicationLock } from '../../support/postgres/lock-coordination.js';
import { createErrorWorkflowStore } from '../../../src/runs/error-workflows/error-workflow.store.js';

beforeAll(beforeAllFixture1);
afterAll(afterAllFixture2);
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
describe('error workflow settings authority and publication', () => {
  // The pool is set in a hook, so the store can't be built at load.
  let settings: ReturnType<typeof createWorkflowErrorStore>;
  beforeAll(() => {
    settings = createWorkflowErrorStore(createAuthoringAccess(pool));
  });
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
it('records an unpublished target on the source run without creating a delivery', async () => {
  const f = await fixture();
  await admin.query(
    'update app.workflows set published_version_id=null where id=$1',
    [f.childWorkflowId],
  );
  await Promise.all([f.produce(), f.produce()]);
  expect(await intent(f)).toMatchObject({
    status: 'refused',
    refusal_code: 'target_not_published',
    accepted_run_id: null,
    outbox_event_id: null,
  });
  const visible = await withWorkspaceTransaction(
    pool,
    f.workspaceId,
    (transaction) => readErrorWorkflow(transaction, f.parentRunId),
  );
  expect(visible).toMatchObject({
    errorWorkflow: {
      status: 'refused',
      refusalCode: 'target_not_published',
      targetVersionId: null,
    },
  });
  const deliveries = await admin.query(
    "select id from app.outbox_events where workspace_id=$1 and aggregate_id=$2 and job_name='start-error-workflow'",
    [f.workspaceId, f.parentRunId],
  );
  expect(deliveries.rows).toHaveLength(0);
});

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
  const scheduled = await admin.query<{ available_at: Date }>(
    'select available_at from app.outbox_events where id=$1',
    [next.outboxEventId],
  );
  expect(scheduled.rows[0]?.available_at).toEqual(
    pending?.queue_wait_expires_at,
  );
  await store.dispatch(next);
  expect((await intent(f))?.queue_wait_expires_at).toEqual(
    pending?.queue_wait_expires_at,
  );
  await cancelQueuedRun(f);
  const awake = await delivery(f);
  const due = await admin.query<{ due: boolean }>(
    'select available_at <= clock_timestamp() due from app.outbox_events where id=$1',
    [awake.outboxEventId],
  );
  expect(due.rows[0]?.due).toBe(true);
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
  await cancelQueuedRun(f);
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

it('does not lose a release racing with replacement delivery', async () => {
  const f = await fullQueue();
  await store.dispatch(await delivery(f));
  const next = await delivery(f);
  await Promise.all([cancelQueuedRun(f), store.dispatch(next)]);
  if ((await intent(f))?.status === 'pending') {
    const ready = await delivery(f);
    const due = await admin.query<{ due: boolean }>(
      'select available_at <= clock_timestamp() due from app.outbox_events where id=$1',
      [ready.outboxEventId],
    );
    expect(due.rows[0]?.due).toBe(true);
    await store.dispatch(ready);
  }
  expect(await intent(f)).toMatchObject({ status: 'accepted' });
});
it('fences wakeup updates to same-workspace error deliveries and leaves payloads immutable', async () => {
  const f = await fullQueue();
  await store.dispatch(await delivery(f));
  const next = await delivery(f);
  const otherJob = await insertHint(f.workspaceId, f.blocker);
  const other = await fixture();
  await other.produce();
  const otherDelivery = await delivery(other);
  await withTenantScopedClient(
    pool,
    { workspaceId: f.workspaceId },
    async (client) => {
      expect(
        (
          await client.query(
            'update app.outbox_events set available_at=clock_timestamp() where id=$1',
            [next.outboxEventId],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await client.query(
            'update app.outbox_events set available_at=clock_timestamp() where id=$1',
            [otherDelivery.outboxEventId],
          )
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await client.query(
            'update app.outbox_events set available_at=clock_timestamp() where id=$1',
            [otherJob],
          )
        ).rowCount,
      ).toBe(0);
    },
  );
  await expect(
    withTenantScopedClient(pool, { workspaceId: f.workspaceId }, (client) =>
      client.query(
        "update app.outbox_events set payload='{}'::jsonb where id=$1",
        [next.outboxEventId],
      ),
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

it('refuses a deadline that expires while admission waits for released capacity', async () => {
  const f = await fullQueue();
  await store.dispatch(await delivery(f));
  const next = await delivery(f);
  const connection = new URL(apiUrl);
  const application = `error-deadline-${crypto.randomUUID()}`;
  connection.searchParams.set('application_name', application);
  const waitingStore = createErrorWorkflowStore(
    parseDatabaseConfig({ connectionString: connection.toString(), max: 1 }),
    (version) => ({
      checkpoint: createCheckpoint({
        workflowVersionId: version.id,
        iterationBudget: 200,
        nextEventSequence: 2,
      }),
    }),
  );
  const holder = await pool.connect();
  let open = false;
  let delivered: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    await holder.query('begin');
    open = true;
    await holder.query("select set_config('app.workspace_id',$1,true)", [
      f.workspaceId,
    ]);
    // Free capacity in an uncommitted transaction, keeping its counter fenced.
    await holder.query(
      "update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1",
      [f.blocker],
    );
    await admin.query(
      "update app.run_error_workflow_intents set queue_wait_expires_at=clock_timestamp()+interval '2 seconds' where workspace_id=$1 and source_run_id=$2",
      [f.workspaceId, f.parentRunId],
    );
    delivered = Promise.allSettled([waitingStore.dispatch(next)]);
    await waitForApplicationLock(admin, application);
    await admin.query(
      'select pg_sleep(greatest(0,extract(epoch from queue_wait_expires_at-clock_timestamp()))+0.001) from app.run_error_workflow_intents where workspace_id=$1 and source_run_id=$2',
      [f.workspaceId, f.parentRunId],
    );
    await holder.query('commit');
    open = false;
    expect(await delivered).toEqual([
      { status: 'fulfilled', value: undefined },
    ]);
    expect(await intent(f)).toMatchObject({
      status: 'refused',
      refusal_code: 'queue_full',
      accepted_run_id: null,
    });
  } finally {
    if (open) await holder.query('rollback');
    holder.release();
    if (delivered !== undefined) await delivered;
    await waitingStore.close();
  }
});

it('records a visible concurrency refusal once when an error-workflow target selects Skip', async () => {
  const f = await fixture();
  await withWorkspaceTransaction(pool, f.workspaceId, (tx) =>
    acceptWorkflowRun(tx, {
      workflowId: f.childWorkflowId,
      workflowVersionId: f.childVersionId,
      initialCheckpoint: createCheckpoint({
        workflowVersionId: f.childVersionId,
        iterationBudget: 200,
      }),
      keyHash: 'd'.repeat(64),
      requestHash: 'e'.repeat(64),
      operation: 'workflow.run.accept',
      scope: 'error-busy',
      triggerType: 'api',
    }),
  );
  await admin.query(
    `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
    [f.workspaceId, f.childWorkflowId],
  );
  await f.produce();
  const input = await delivery(f);
  await Promise.all([store.dispatch(input), store.dispatch(input)]);
  expect(await intent(f)).toMatchObject({
    status: 'refused',
    refusal_code: 'concurrency_limit',
    accepted_run_id: null,
  });
  expect(
    (
      await admin.query(
        `select metadata from app.usage_events where workspace_id=$1 and category='trigger.skipped'`,
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([
    {
      metadata: {
        triggerType: 'workflow_error',
        reason: 'concurrency_limit',
      },
    },
  ]);
  expect(
    (
      await admin.query(
        `select id from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'`,
        [f.workspaceId],
      )
    ).rows,
  ).toEqual([]);
});
it('starts the error workflow on the set current at its own admission, not its source set', async () => {
  const f = await fixture();
  await admin.query(
    `insert into app.workspace_variable_set_revisions(workspace_id,revision,values_json)
       values($1,1,'{"RATE":10}'),($1,2,'{"RATE":20}')`,
    [f.workspaceId],
  );
  await admin.query(
    'insert into app.workspace_variables(workspace_id,revision) values($1,2)',
    [f.workspaceId],
  );
  await admin.query(
    'update app.workflow_runs set variable_set_revision=1 where id=$1',
    [f.parentRunId],
  );
  await f.produce();
  await store.dispatch(await delivery(f));
  const runs = await admin.query<{ revision: number }>(
    "select variable_set_revision as revision from app.workflow_runs where workspace_id=$1 and trigger_type='workflow_error'",
    [f.workspaceId],
  );
  expect(runs.rows).toEqual([{ revision: 2 }]);
  const source = await admin.query<{ revision: number }>(
    'select variable_set_revision as revision from app.workflow_runs where id=$1',
    [f.parentRunId],
  );
  expect(source.rows).toEqual([{ revision: 1 }]);
});
