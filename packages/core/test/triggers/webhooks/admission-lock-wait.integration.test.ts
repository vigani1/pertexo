import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  WebhookDeliveryIneligibleError,
  WebhookWorkflowPausedError,
} from '../../../src/triggers/webhooks/errors.js';
import {
  actorId,
  afterAllFixture2,
  beforeAllFixture1,
  hash,
  ownerQuery,
  secret,
  webhook,
  workspaceId,
} from './fixture.js';
import {
  acceptedScenario,
  closePools,
  closesAs,
  COMMANDS,
  delivery,
  holdEntitlement,
  insertVersionWithoutWebhookStep,
  openPools,
  SHARE_LOCK,
  touchedOneRow,
  traces,
  WORKSPACE_LOCK,
  type Scenario,
} from './ingress/admission-scenario.js';
import { waitForWaiter, type OpenTransaction } from './ingress/lock-holder.js';

beforeAll(async () => {
  await beforeAllFixture1();
  openPools();
}, 60_000);

afterAll(async () => {
  await closePools();
  await afterAllFixture2();
});

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
