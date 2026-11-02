import { randomUUID } from 'node:crypto';

import { webhookRunInput } from '@pertexo/nodes-core';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { changeWorkspaceLifecycle } from '../../../src/lifecycle/deletion/change.js';
import {
  WebhookDeliveryIneligibleError,
  WebhookWorkflowPausedError,
} from '../../../src/triggers/webhooks/errors.js';
import { adminUrl, migrationBaseUrl } from './context.js';
import {
  actorId,
  afterAllFixture2,
  apiConfig,
  authoring,
  beforeAllFixture1,
  checkpointFactory,
  createWebhookScenario,
  hash,
  ownerQuery,
  post,
  publishNextTriggerWorkflowVersion,
  secret,
  url,
  webhook,
  workspaceId,
} from './fixture.js';
import {
  openTransaction,
  sqlStates,
  waitForWaiter,
  type OpenTransaction,
} from './ingress/lock-holder.js';

type Scenario = Awaited<ReturnType<typeof createWebhookScenario>>;

const SHARE_LOCK = /for share of /iu;
const WORKSPACE_LOCK = /lock_workspace_run_admission/iu;

let holders: Pool;
let apiPool: Pool;
/** Only an administrator can read another role's statements in pg_stat_activity. */
let observer: Pool;

beforeAll(async () => {
  await beforeAllFixture1();
  holders = new Pool({ connectionString: url(migrationBaseUrl), max: 8 });
  apiPool = new Pool({ connectionString: apiConfig.connectionString, max: 8 });
  observer = new Pool({ connectionString: url(adminUrl), max: 2 });
}, 60_000);

afterAll(async () => {
  await holders.end();
  await apiPool.end();
  await observer.end();
  await afterAllFixture2();
});

function delivery({ verification }: Scenario, label: string) {
  return {
    verification,
    verifiedSecretVersionId: verification.currentSecret.id,
    requestFingerprint: hash(`fingerprint-${label}`),
    idempotencyKeyHash: hash(`key-${label}`),
    runInput: webhookRunInput(
      verification.runInputMode,
      post({ event: label }),
    ),
    bodyBytes: 64,
    checkpointFactory,
  } as const;
}

/** What a delivery leaves behind, so a refusal can be seen to have left nothing. */
async function traces({ verification }: Scenario, label: string) {
  const { rows } = await ownerQuery<{
    runs: number;
    deliveries: number;
    replays: number;
    queued: number;
  }>(
    `select
       (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,
       (select count(*)::int from app.webhook_trigger_deliveries where endpoint_id=$2) deliveries,
       (select count(*)::int from app.webhook_trigger_replay_records where dedupe_key_hash=$3) replays,
       (select queued_runs::int from app.workspace_execution_admission_counters where workspace_id=$4) queued`,
    [
      verification.workflowId,
      verification.endpointId,
      hash(`key-${label}`),
      workspaceId,
    ],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('Delivery traces are unavailable');
  return row;
}

/** A pause needs the run that caused it, so every scenario starts with one accepted. */
async function acceptedScenario(): Promise<Scenario & { firstRunId: string }> {
  const scenario = await createWebhookScenario();
  const first = await webhook.acceptVerifiedDelivery(
    delivery(scenario, `first-${randomUUID()}`),
  );
  if (!('runId' in first)) throw new Error('Expected the first run');
  return { ...scenario, firstRunId: first.runId };
}

async function insertVersionWithoutWebhookStep(
  holder: OpenTransaction,
  { verification }: Scenario,
): Promise<string> {
  const versionId = randomUUID();
  await holder.query(
    `insert into app.workflow_versions(id,workspace_id,workflow_id,version_number,graph_json,checksum,executable_json,published_by)
     values($1,$2,$3,50,$4::jsonb,$5,'{}'::jsonb,$6)`,
    [
      versionId,
      workspaceId,
      verification.workflowId,
      JSON.stringify({ settings: {}, nodes: [], edges: [] }),
      `wf:sha256:${hash(versionId)}`,
      actorId,
    ],
  );
  return versionId;
}

/** Row security hides endpoint rows from the owner role, so those run as the app. */
const closesAs = (app: boolean | undefined) =>
  openTransaction(app === true ? apiPool : holders, observer, workspaceId, {
    role: app === true ? undefined : 'pertexo_owner',
  });

function touchedOneRow(result: unknown): void {
  expect(result).toMatchObject({ rowCount: 1 });
}

type Closure = Readonly<{
  name: string;
  asApp?: boolean;
  refused: new () => Error;
  /** The statement the delivery is stuck on while this is uncommitted. */
  waitsAt: RegExp;
  close: (
    holder: OpenTransaction,
    scenario: Scenario & { firstRunId: string },
  ) => Promise<unknown>;
  /** A status change on the one workspace these tests share has to be undone. */
  undo?: () => Promise<unknown>;
}>;

const setWorkspaceStatus = (status: string) =>
  ownerQuery('update app.workspaces set status=$2 where id=$1', [
    workspaceId,
    status,
  ]);

const CLOSURES: readonly Closure[] = [
  {
    name: 'a paused workflow',
    refused: WebhookWorkflowPausedError,
    waitsAt: SHARE_LOCK,
    close: (holder, { verification, firstRunId }) =>
      holder.query(
        `update app.workflows
            set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
                trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
                trigger_pause_last_run_id=$2,trigger_pause_revision=trigger_pause_revision+1
          where id=$1`,
        [verification.workflowId, firstRunId],
      ),
  },
  {
    name: 'an archived workflow',
    refused: WebhookDeliveryIneligibleError,
    waitsAt: SHARE_LOCK,
    close: (holder, { verification }) =>
      holder.query(
        "update app.workflows set lifecycle_status='archived' where id=$1",
        [verification.workflowId],
      ),
  },
  {
    name: 'an unpublished workflow',
    refused: WebhookDeliveryIneligibleError,
    waitsAt: SHARE_LOCK,
    close: (holder, { verification }) =>
      holder.query(
        'update app.workflows set published_version_id=null where id=$1',
        [verification.workflowId],
      ),
  },
  {
    name: 'a publish that removes the step',
    refused: WebhookDeliveryIneligibleError,
    waitsAt: SHARE_LOCK,
    close: async (holder, scenario) => {
      const versionId = await insertVersionWithoutWebhookStep(holder, scenario);
      return holder.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [scenario.verification.workflowId, versionId],
      );
    },
  },
  {
    name: 'a disabled endpoint',
    asApp: true,
    refused: WebhookDeliveryIneligibleError,
    waitsAt: SHARE_LOCK,
    close: (holder, { verification }) =>
      holder.query(
        "update app.webhook_trigger_endpoints set status='disabled' where id=$1",
        [verification.endpointId],
      ),
  },
  {
    name: 'a rotated endpoint',
    asApp: true,
    refused: WebhookDeliveryIneligibleError,
    waitsAt: SHARE_LOCK,
    close: (holder, { verification }) =>
      holder.query(
        'update app.webhook_trigger_endpoints set endpoint_key_hash=$2 where id=$1',
        [verification.endpointId, hash(randomUUID())],
      ),
  },
  {
    name: 'a changed way of proving the sender',
    asApp: true,
    refused: WebhookDeliveryIneligibleError,
    waitsAt: SHARE_LOCK,
    close: (holder, { verification }) =>
      holder.query(
        `update app.webhook_trigger_endpoints set authentication=$2::jsonb where id=$1`,
        [
          verification.endpointId,
          JSON.stringify({ mode: 'secret_url', allowedOrigins: [] }),
        ],
      ),
  },
  // These two stop earlier: admission share-locks the workspace row first.
  {
    name: 'a suspended workspace',
    refused: WebhookDeliveryIneligibleError,
    waitsAt: WORKSPACE_LOCK,
    close: (holder) =>
      holder.query("update app.workspaces set status='suspended' where id=$1", [
        workspaceId,
      ]),
    undo: () => setWorkspaceStatus('active'),
  },
  {
    name: 'a workspace pending deletion',
    refused: WebhookDeliveryIneligibleError,
    waitsAt: WORKSPACE_LOCK,
    close: (holder) =>
      holder.query(
        `update app.workspaces set status='pending_deletion',
           deletion_requested_at=clock_timestamp(),deletion_requested_by=$2,
           deletion_reason='test',purge_after=clock_timestamp()+interval '30 days'
         where id=$1`,
        [workspaceId, actorId],
      ),
    undo: () =>
      ownerQuery(
        `update app.workspaces set status='active',deletion_requested_at=null,
           deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
        [workspaceId],
      ),
  },
];

describe('a delivery waiting on the admission locks', () => {
  it.each(CLOSURES)(
    'is refused once it gets the lock, after $name committed during the wait, and leaves nothing',
    async ({ asApp, close, refused, waitsAt, undo }) => {
      const scenario = await acceptedScenario();
      const label = randomUUID();
      const before = await traces(scenario, label);
      const holder = await closesAs(asApp);
      try {
        touchedOneRow(await close(holder, scenario));
        const waiting = webhook.acceptVerifiedDelivery(
          delivery(scenario, label),
        );
        const refusal = expect(waiting).rejects.toBeInstanceOf(refused);
        await waitForWaiter(holder, waitsAt);
        await holder.commit();
        await refusal;
        expect(await traces(scenario, label)).toEqual(before);
      } finally {
        await holder.rollback();
        await undo?.();
      }
    },
    30_000,
  );

  it.each(CLOSURES)(
    'is admitted after the same wait when $name rolls back instead',
    async ({ asApp, close, waitsAt, undo }) => {
      const scenario = await acceptedScenario();
      const label = randomUUID();
      const before = await traces(scenario, label);
      const holder = await closesAs(asApp);
      try {
        touchedOneRow(await close(holder, scenario));
        const waiting = webhook.acceptVerifiedDelivery(
          delivery(scenario, label),
        );
        await waitForWaiter(holder, waitsAt);
        await holder.rollback();
        await expect(waiting).resolves.toMatchObject({ replayed: false });
        expect(await traces(scenario, label)).toEqual({
          runs: before.runs + 1,
          deliveries: before.deliveries + 1,
          replays: 1,
          queued: before.queued + 1,
        });
      } finally {
        await holder.rollback();
        await undo?.();
      }
    },
    30_000,
  );

  it('stays on the version it verified when a publish keeping the step commits during the wait', async () => {
    const scenario = await acceptedScenario();
    const { verification } = scenario;
    const label = randomUUID();
    const before = await traces(scenario, label);
    const holder = await closesAs(false);
    try {
      const versionId = await insertVersionWithoutWebhookStep(holder, scenario);
      await holder.query(
        `insert into app.workflow_triggers(id,workspace_id,workflow_id,workflow_version_id,
           node_id,kind,status,desired_config,config_fingerprint)
         values($1,$2,$3,$4,$5,'webhook','active','{}'::jsonb,$6)`,
        [
          randomUUID(),
          workspaceId,
          verification.workflowId,
          versionId,
          verification.nodeId,
          `trigger:sha256:${hash(versionId)}`,
        ],
      );
      await holder.query(
        'update app.workflows set published_version_id=$2 where id=$1',
        [verification.workflowId, versionId],
      );
      const waiting = webhook.acceptVerifiedDelivery(delivery(scenario, label));
      await waitForWaiter(holder, SHARE_LOCK);
      await holder.commit();
      const accepted = await waiting;
      if (!('runId' in accepted)) throw new Error('Expected an accepted run');
      const { rows } = await ownerQuery<{ workflow_version_id: string }>(
        'select workflow_version_id from app.workflow_runs where id=$1',
        [accepted.runId],
      );
      expect(rows).toEqual([
        { workflow_version_id: verification.workflowVersionId },
      ]);
      expect((await traces(scenario, label)).runs).toBe(before.runs + 1);
    } finally {
      await holder.rollback();
    }
  }, 30_000);
});

/**
 * Each real command, run for real. Admission's first statement also share-locks the
 * entitlement row, which none of these commands touches, so a delivery can be parked
 * there while the command commits in full.
 */
const COMMANDS = [
  {
    name: 'archiving',
    run: ({ verification }: Scenario) =>
      authoring.transitionWorkflowLifecycle({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: randomUUID(),
      }),
  },
  {
    name: 'rotating the endpoint',
    run: ({ verification, resources }: Scenario) =>
      webhook.rotateEndpoint({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        triggerId: resources.webhookId,
        endpointKeyHash: hash(randomUUID()),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
  },
] as const;

const holdEntitlement = async () => {
  const holder = await closesAs(false);
  touchedOneRow(
    await holder.query(
      'select 1 from app.workspace_execution_entitlements where workspace_id=$1 for update',
      [workspaceId],
    ),
  );
  return holder;
};

describe('a delivery parked behind a real command', () => {
  it.each(COMMANDS)(
    'is refused when $name finishes during the wait, and leaves nothing',
    async ({ run }) => {
      const scenario = await acceptedScenario();
      const label = randomUUID();
      const before = await traces(scenario, label);
      const holder = await holdEntitlement();
      try {
        const waiting = webhook.acceptVerifiedDelivery(
          delivery(scenario, label),
        );
        const refusal = expect(waiting).rejects.toBeInstanceOf(
          WebhookDeliveryIneligibleError,
        );
        await waitForWaiter(holder, WORKSPACE_LOCK);
        await run(scenario);
        await holder.commit();
        await refusal;
        expect(await traces(scenario, label)).toEqual(before);
      } finally {
        await holder.rollback();
      }
    },
    30_000,
  );

  it('keeps answering on the old secret when only the secret rotates during the wait', async () => {
    const scenario = await acceptedScenario();
    const { verification, resources } = scenario;
    const label = randomUUID();
    const holder = await holdEntitlement();
    try {
      const waiting = webhook.acceptVerifiedDelivery(delivery(scenario, label));
      await waitForWaiter(holder, WORKSPACE_LOCK);
      await webhook.rotateSecret({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        triggerId: resources.webhookId,
        endpointKeyHash: verification.endpointKeyHash,
        secret: secret(),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      });
      await holder.commit();
      await expect(waiting).resolves.toMatchObject({ replayed: false });
    } finally {
      await holder.rollback();
    }
  }, 30_000);
});

describe('admission against the commands that close it', () => {
  const lifecycle = (commandType: 'deletion_requested') =>
    changeWorkspaceLifecycle(apiPool, {
      operationId: randomUUID(),
      workspaceId,
      actorUserId: actorId,
      commandType,
      reason: 'deadlock attempt',
      idempotencyKeyHash: hash(randomUUID()),
      requestHash: hash(randomUUID()),
    });
  const restore = () =>
    ownerQuery(
      `update app.workspaces set status='active',deletion_requested_at=null,
         deletion_requested_by=null,deletion_reason=null,purge_after=null where id=$1`,
      [workspaceId],
    );

  const RACERS = [
    ...COMMANDS,
    {
      name: 'rotating the secret',
      run: ({ verification, resources }: Scenario) =>
        webhook.rotateSecret({
          workspaceId,
          actorId,
          workflowId: verification.workflowId,
          triggerId: resources.webhookId,
          endpointKeyHash: verification.endpointKeyHash,
          secret: secret(),
          idempotencyKey: randomUUID(),
          requestHash: hash(randomUUID()),
        }),
    },
    {
      name: 'publishing',
      run: ({ verification }: Scenario) =>
        publishNextTriggerWorkflowVersion(verification.workflowId),
    },
    {
      name: 'pausing',
      run: ({ verification, firstRunId }: Scenario & { firstRunId?: string }) =>
        ownerQuery(
          `update app.workflows
              set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
                  trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
                  trigger_pause_last_run_id=$2,trigger_pause_revision=trigger_pause_revision+1
            where id=$1`,
          [verification.workflowId, firstRunId],
        ),
    },
    {
      name: 'requesting workspace deletion',
      run: () => lifecycle('deletion_requested'),
      undo: restore,
    },
  ] as const;

  const HELD_ROWS = [
    [
      'the endpoint',
      'select 1 from app.webhook_trigger_endpoints where id=$1 for update',
      ({ verification }: Scenario) => [verification.endpointId],
      true,
    ],
    [
      'the workflow',
      'select 1 from app.workflows where id=$1 for update',
      ({ verification }: Scenario) => [verification.workflowId],
      false,
    ],
    [
      'the workspace',
      'select 1 from app.workspaces where id=$1 for update',
      () => [workspaceId],
      false,
    ],
    [
      'the admission counters',
      'select 1 from app.workspace_execution_admission_counters where workspace_id=$1 for update',
      () => [workspaceId],
      false,
    ],
  ] as const;

  const cases = RACERS.flatMap((racer) =>
    HELD_ROWS.map(([row, statement, parameters, asApp]) => ({
      name: racer.name,
      row,
      racer,
      statement,
      parameters,
      asApp,
    })),
  );

  const deadlocks = async () => {
    // Postgres publishes the counter when a backend goes idle.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const { rows } = await holders.query<{ deadlocks: string }>(
      'select deadlocks from pg_stat_database where datname=current_database()',
    );
    return Number(rows[0]?.deadlocks);
  };

  it.each(cases)(
    'never deadlocks with $name when both queue up behind $row',
    async ({ asApp, racer, statement, parameters }) => {
      const scenario = await acceptedScenario();
      const holder = await closesAs(asApp);
      try {
        touchedOneRow(await holder.query(statement, [...parameters(scenario)]));
        const deliveries = Array.from({ length: 3 }, (_, at) =>
          webhook.acceptVerifiedDelivery(
            delivery(scenario, `${String(at)}-${randomUUID()}`),
          ),
        );
        // Deliveries first, so they hold what they got when the command arrives.
        await expect
          .poll(async () => (await holder.waiters()).length > 0, {
            timeout: 10_000,
            interval: 10,
          })
          .toBe(true);
        const settled = Promise.allSettled([
          ...deliveries,
          Promise.resolve().then(() => racer.run(scenario)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await holder.commit();
        const outcomes = await settled;
        const states = outcomes.flatMap((outcome) =>
          outcome.status === 'rejected' ? sqlStates(outcome.reason) : [],
        );
        expect(states).not.toContain('40P01');
        // A delivery either starts a run or is refused for a named reason.
        for (const outcome of outcomes.slice(0, deliveries.length))
          if (outcome.status === 'rejected')
            expect(
              outcome.reason instanceof WebhookDeliveryIneligibleError ||
                outcome.reason instanceof WebhookWorkflowPausedError,
              String(outcome.reason),
            ).toBe(true);
      } finally {
        await holder.rollback();
        if ('undo' in racer) await racer.undo();
      }
    },
    30_000,
  );

  it('records no deadlock in the whole database after all of that', async () => {
    expect(await deadlocks()).toBe(0);
  }, 10_000);
});
