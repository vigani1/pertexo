import { maintenanceConfig } from '../../../../infrastructure/testing/worker-databases.mjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  beforeAllFixture1,
  afterAllFixture2,
  workspaceId,
  workflowId,
  versionId,
  reconciliation,
  ownerQuery,
  maintenancePool,
  publishTriggerWorkflow,
  actorId,
  hash,
  secret,
  webhook,
  workflowTriggerIds,
  triggerId,
  endpointId,
  outboxEventId,
  endpointHash,
  post,
  acceptWebhook,
  schedules,
  readinessPool,
  workerReadinessPool,
  workerPool,
  workerQuery,
  checkpointFactory,
  appendReconciliationEvent,
  deliverReconciliation,
  setWorkflowLifecycle,
  immutableWorkflowHistory,
  provisionWebhook,
  triggerFacts,
  workflowState,
  publishNextTriggerWorkflowVersion,
  notificationSecretVersionId,
  notificationDestinationId,
  createWebhookScenario,
  authoring,
  pausedNow,
  owner,
  apiQuery,
  apiConfig,
} from './webhooks/webhooks.fixture.js';
import { randomUUID } from 'node:crypto';
import {
  canonicalOutboxPayloadChecksum,
  checkDatabaseReadiness,
  withWorkspaceTransaction,
} from '@pertexo/database/primitives';
import {
  WorkflowTriggerReconciliationMismatchError,
  WorkflowTriggerStalePublicationError,
} from '../../src/triggers/reconciliation/trigger-reconciliation.errors.js';
import {
  WebhookTriggerNotFoundError,
  WebhookDeliveryIneligibleError,
  WebhookDeliveryReplayMismatchError,
  WebhookWorkflowPausedError,
  WebhookIngressRateLimitExceededError,
  WebhookIntakeBusyError,
} from '../../src/triggers/webhooks/webhook-trigger.errors.js';
import { webhookRunInput } from '@pertexo/nodes-core';
import { EXPECTED_MIGRATION_HEAD } from '@pertexo/database/testing';
import { ScheduleTriggerError } from '../../src/triggers/schedules/schedule-trigger.errors.js';
import { isScheduleClaimEligible } from '../../src/triggers/schedules/scanning/occurrences.repository.js';
import { waitForBlockedBy } from '../support/postgres/lock-coordination.js';
import type { WebhookDeliveryPosition } from '../../src/triggers/webhooks/webhook-delivery.types.js';
import { createTriggerEventScanner } from '../../src/triggers/coordination/event-scanner.store.js';
import { setTimeout as delay } from 'node:timers/promises';
import { holdAdmissionRow } from './webhooks/ingress/hold-admission-row.js';
import { Pool } from 'pg';
import { createEventCoordinationPreparation } from '../../src/triggers/coordination/prepare.js';
import { acceptVerifiedWebhookDelivery } from '../../src/triggers/webhooks/runtime/accept.repository.js';
import { createWorkspaceTurns } from '../../src/triggers/webhooks/runtime/workspace-turns.js';

beforeAll(beforeAllFixture1, 60_000);
afterAll(afterAllFixture2);
describe('generic webhook database seam', () => {
  it.each([
    {
      eventExists: false,
      message: 'Reconciliation outbox event is unavailable',
    },
    {
      eventExists: true,
      message: 'Reconciliation outbox payload is invalid',
    },
  ])(
    'rejects invalid reconciliation input: $message',
    async ({ eventExists, message }) => {
      const eventId = randomUUID();
      const payloadChecksum = canonicalOutboxPayloadChecksum({});
      if (eventExists) {
        await ownerQuery(
          `insert into app.outbox_events(id,workspace_id,job_name,
           aggregate_type,aggregate_id,payload,payload_checksum)
         values($1,$2,'reconcile-workflow-triggers','workflow',$3,'{}'::jsonb,$4)`,
          [eventId, workspaceId, workflowId, payloadChecksum],
        );
      }
      const failure = reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: versionId,
        outboxEventId: eventId,
        delivery: { outboxEventId: eventId, payloadChecksum },
      });
      await expect(failure).rejects.toBeInstanceOf(
        WorkflowTriggerReconciliationMismatchError,
      );
      await expect(failure).rejects.toHaveProperty('message', message);
      const receipts = await ownerQuery<{ count: number }>(
        `select count(*)::int count from app.inbox_receipts
         where consumer_name='trigger-runtime.reconciliation'
           and message_id=$1 and workspace_id=$2`,
        [eventId, workspaceId],
      );
      expect(receipts.rows).toEqual([{ count: 0 }]);
    },
  );

  it('rejects each durable event and delivery identity mutation without receipt or trigger effects', async () => {
    const baselinePayload = (eventId: string) => ({
      workspaceId,
      outboxEventId: eventId,
      workflowId,
      publishedVersionId: versionId,
    });
    const mutations: readonly Readonly<{
      name: string;
      event?: Readonly<{
        aggregateId?: string;
        aggregateType?: string;
        jobName?: string;
      }>;
      payload?: Readonly<{
        outboxEventId?: string;
        publishedVersionId?: string;
        workflowId?: string;
        workspaceId?: string;
      }>;
      storedChecksum?: string;
      deliveryEventId?: string;
      deliveryChecksum?: string;
    }>[] = [
      { name: 'aggregate id', event: { aggregateId: randomUUID() } },
      { name: 'aggregate type', event: { aggregateType: 'workflow.run' } },
      { name: 'job name', event: { jobName: 'dispatch-workflow-run' } },
      { name: 'payload workspace', payload: { workspaceId: randomUUID() } },
      { name: 'payload workflow', payload: { workflowId: randomUUID() } },
      {
        name: 'payload version',
        payload: { publishedVersionId: randomUUID() },
      },
      { name: 'payload event', payload: { outboxEventId: randomUUID() } },
      { name: 'stored checksum', storedChecksum: 'f'.repeat(64) },
      { name: 'delivery event', deliveryEventId: randomUUID() },
      { name: 'delivery checksum', deliveryChecksum: 'e'.repeat(64) },
    ];

    for (const mutation of mutations) {
      const eventId = randomUUID();
      const payload = { ...baselinePayload(eventId), ...mutation.payload };
      const payloadChecksum = canonicalOutboxPayloadChecksum(payload);
      await ownerQuery(
        `insert into app.outbox_events(id,workspace_id,job_name,
           aggregate_type,aggregate_id,payload,payload_checksum)
         values($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        [
          eventId,
          workspaceId,
          mutation.event?.jobName ?? 'reconcile-workflow-triggers',
          mutation.event?.aggregateType ?? 'workflow',
          mutation.event?.aggregateId ?? workflowId,
          JSON.stringify(payload),
          mutation.storedChecksum ?? payloadChecksum,
        ],
      );
      const triggerStateBefore = await ownerQuery(
        `select id,status,health_status,last_error_code,reconciled_at,updated_at
           from app.workflow_triggers where workspace_id=$1 and workflow_id=$2
           order by id`,
        [workspaceId, workflowId],
      );
      await expect(
        reconciliation.reconcile({
          workspaceId,
          workflowId,
          publishedVersionId: versionId,
          outboxEventId: eventId,
          delivery: {
            outboxEventId: mutation.deliveryEventId ?? eventId,
            payloadChecksum:
              mutation.deliveryChecksum ??
              mutation.storedChecksum ??
              payloadChecksum,
          },
        }),
        mutation.name,
      ).rejects.toBeInstanceOf(WorkflowTriggerReconciliationMismatchError);
      await expect(
        ownerQuery(
          `select id,status,health_status,last_error_code,reconciled_at,updated_at
             from app.workflow_triggers where workspace_id=$1 and workflow_id=$2
             order by id`,
          [workspaceId, workflowId],
        ),
      ).resolves.toMatchObject({ rows: triggerStateBefore.rows });
      await expect(
        ownerQuery<{ count: number }>(
          `select count(*)::int count from app.inbox_receipts
            where consumer_name='trigger-runtime.reconciliation'
              and message_id=$1`,
          [eventId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: 0 }] });
    }
  });

  it('rebuilds desired webhook and schedule rows inside publication', async () => {
    const { created, published, eventId } = await publishTriggerWorkflow();
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: created.workflowId,
        publishedVersionId: published.version.id,
        outboxEventId: eventId,
      }),
    ).resolves.toMatchObject([
      { nodeId: 'schedule', kind: 'schedule', status: 'active' },
      { nodeId: 'webhook', kind: 'webhook', status: 'configuration_required' },
    ]);
  });

  it('binds every webhook mutation and replay to its workflow parent', async () => {
    const target = await publishTriggerWorkflow();
    const other = await publishTriggerWorkflow();
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: target.created.workflowId,
        publishedVersionId: target.published.version.id,
        outboxEventId: target.eventId,
        delivery: {
          outboxEventId: target.eventId,
          payloadChecksum: target.eventChecksum,
        },
      }),
    ).resolves.toHaveLength(2);
    const ids = await workflowTriggerIds(target.created.workflowId);
    const missingWorkflowId = randomUUID();
    const wrongWorkspaceId = randomUUID();
    const provision = {
      workspaceId,
      workflowId: target.created.workflowId,
      actorId,
      triggerId: ids.webhookId,
      endpointId: randomUUID(),
      endpointKeyHash: hash(randomUUID()),
      secret: secret(),
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    };
    for (const invalid of [
      { workflowId: other.created.workflowId },
      { workflowId: missingWorkflowId },
      { workspaceId: wrongWorkspaceId },
    ]) {
      await expect(
        webhook.provision({ ...provision, ...invalid }),
      ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    }
    await expect(webhook.provision(provision)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: false,
    });
    await expect(webhook.provision(provision)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: true,
    });

    const endpointKeyHash = hash(randomUUID());
    const rotateEndpoint = {
      workspaceId,
      workflowId: target.created.workflowId,
      actorId,
      triggerId: ids.webhookId,
      endpointKeyHash,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    };
    for (const invalid of [
      { workflowId: other.created.workflowId },
      { workflowId: missingWorkflowId },
      { workspaceId: wrongWorkspaceId },
    ]) {
      await expect(
        webhook.rotateEndpoint({ ...rotateEndpoint, ...invalid }),
      ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    }
    await expect(webhook.rotateEndpoint(rotateEndpoint)).resolves.toMatchObject(
      { trigger: { id: ids.webhookId }, replayed: false },
    );
    await expect(webhook.rotateEndpoint(rotateEndpoint)).resolves.toMatchObject(
      { trigger: { id: ids.webhookId }, replayed: true },
    );

    const rotateSecret = {
      workspaceId,
      workflowId: target.created.workflowId,
      actorId,
      triggerId: ids.webhookId,
      endpointKeyHash,
      secret: secret(),
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    };
    for (const invalid of [
      { workflowId: other.created.workflowId },
      { workflowId: missingWorkflowId },
      { workspaceId: wrongWorkspaceId },
    ]) {
      await expect(
        webhook.rotateSecret({ ...rotateSecret, ...invalid }),
      ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    }
    await expect(webhook.rotateSecret(rotateSecret)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: false,
    });
    await expect(webhook.rotateSecret(rotateSecret)).resolves.toMatchObject({
      trigger: { id: ids.webhookId },
      replayed: true,
    });
  });

  it('applies archive state at reconciliation and gates new trigger work', async () => {
    const { created, published } = await publishTriggerWorkflow();
    const event = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await expect(
      deliverReconciliation(created.workflowId, published.version.id, event),
    ).resolves.toHaveLength(2);
    const provisioned = await provisionWebhook(created.workflowId);
    const verification = await webhook.resolveVerification(
      provisioned.endpointKeyHash,
    );
    if (verification === null) throw new Error('Expected webhook verification');
    const historyBeforeArchive = await immutableWorkflowHistory(
      created.workflowId,
    );
    await ownerQuery(
      `update app.trigger_schedules set next_fire_at=clock_timestamp()-interval '1 minute'
         where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, provisioned.scheduleId],
    );
    await setWorkflowLifecycle(created.workflowId, 'archived', 'deactivating');
    await expect(
      webhook.resolveVerification(provisioned.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(
      acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('archived-webhook-admission'),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ archived: true }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
    const claimed = await maintenancePool.query<{
      lease_token: string;
      trigger_id: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`archive-gate-${randomUUID()}`],
    );
    expect(claimed.rows).toHaveLength(1);
    const claim = claimed.rows[0];
    if (claim === undefined) throw new Error('Archived schedule claim missing');
    await expect(
      withWorkspaceTransaction(workerPool, workspaceId, (transaction) =>
        isScheduleClaimEligible(transaction, claim),
      ),
    ).resolves.toBe(false);
    await maintenancePool.query(
      'select app.release_trigger_schedule_claim($1,$2)',
      [claim.trigger_id, claim.lease_token],
    );
    await expect(
      schedules.setEnabled({
        workspaceId,
        actorId,
        workflowId: created.workflowId,
        triggerId: provisioned.scheduleId,
        enabled: true,
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toBeInstanceOf(ScheduleTriggerError);
    await expect(
      webhook.rotateEndpoint({
        workspaceId,
        workflowId: created.workflowId,
        actorId,
        triggerId: provisioned.webhookId,
        endpointKeyHash: hash(`archived-rotation-${randomUUID()}`),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const archiveEvent = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await expect(
      deliverReconciliation(
        created.workflowId,
        published.version.id,
        archiveEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          healthStatus: 'disabled',
          nodeId: 'schedule',
          status: 'disabled',
        }),
        expect.objectContaining({
          endpointReady: true,
          healthStatus: 'disabled',
          nodeId: 'webhook',
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'inactive',
      lifecycle_status: 'archived',
      published_version_id: published.version.id,
    });
    await expect(immutableWorkflowHistory(created.workflowId)).resolves.toEqual(
      historyBeforeArchive,
    );
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'active',
          kind: 'webhook',
          status: 'disabled',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'enabled',
          status: 'disabled',
        }),
      ]),
    );
  });

  it('migrates from zero, reconciles configuration, and exposes no hashes or secrets in health', async () => {
    await expect(checkDatabaseReadiness(readinessPool)).resolves.toMatchObject({
      migrationHead: EXPECTED_MIGRATION_HEAD,
    });
    await expect(
      checkDatabaseReadiness(workerReadinessPool),
    ).resolves.toMatchObject({
      role: 'pertexo_app',
    });
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId,
        publishedVersionId: versionId,
        outboxEventId,
      }),
    ).resolves.toMatchObject([
      { id: triggerId, status: 'configuration_required', endpointReady: false },
    ]);
    const { trigger: health } = await webhook.provision({
      workspaceId,
      workflowId,
      actorId,
      triggerId,
      endpointId,
      endpointKeyHash: endpointHash,
      secret: secret(),
      idempotencyKey: 'provision',
      requestHash: hash('provision'),
    });
    expect(health).toMatchObject({ status: 'active', endpointReady: true });
    expect(JSON.stringify(health)).not.toMatch(
      /hash|cipher|secret|nonce|authTag/u,
    );
    await expect(
      webhook.getHealth({
        workspaceId,
        actorId: randomUUID(),
        workflowId,
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
  });

  it('restores active resources while preserving explicit disablement across worker events', async () => {
    const disabledWorkflow = await publishTriggerWorkflow();
    const disabledStart = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await deliverReconciliation(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
      disabledStart,
    );
    const disabledResources = await provisionWebhook(
      disabledWorkflow.created.workflowId,
    );
    await schedules.setEnabled({
      workspaceId,
      actorId,
      workflowId: disabledWorkflow.created.workflowId,
      triggerId: disabledResources.scheduleId,
      enabled: false,
      idempotencyKey: randomUUID(),
      requestHash: hash(randomUUID()),
    });
    await workerQuery(
      `update app.webhook_trigger_endpoints set status='disabled',updated_at=clock_timestamp()
         where workspace_id=$1 and id=$2`,
      [workspaceId, disabledResources.endpointId],
    );
    await expect(
      triggerFacts(disabledWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_id: disabledResources.endpointId,
          endpoint_status: 'disabled',
          kind: 'webhook',
        }),
      ]),
    );
    await setWorkflowLifecycle(
      disabledWorkflow.created.workflowId,
      'archived',
      'deactivating',
    );
    const archiveEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        archiveEvent,
      ),
    ).resolves.toHaveLength(2);
    // Persist while archived, but delay delivery until after restore converges.
    const lateEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await setWorkflowLifecycle(
      disabledWorkflow.created.workflowId,
      'active',
      'activating',
    );
    const restoreEvent = await appendReconciliationEvent(
      disabledWorkflow.created.workflowId,
      disabledWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        restoreEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'disabled' }),
        expect.objectContaining({ nodeId: 'webhook', status: 'disabled' }),
      ]),
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        lateEvent,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'disabled' }),
        expect.objectContaining({ nodeId: 'webhook', status: 'disabled' }),
      ]),
    );
    await expect(
      deliverReconciliation(
        disabledWorkflow.created.workflowId,
        disabledWorkflow.published.version.id,
        restoreEvent,
      ),
    ).resolves.toEqual([]);
    await expect(
      workflowState(disabledWorkflow.created.workflowId),
    ).resolves.toMatchObject({
      activation_status: 'inactive',
      lifecycle_status: 'active',
    });
    await expect(
      triggerFacts(disabledWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'disabled',
          kind: 'webhook',
          status: 'disabled',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'disabled',
          status: 'disabled',
        }),
      ]),
    );

    const activeWorkflow = await publishTriggerWorkflow();
    const activeStart = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await deliverReconciliation(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
      activeStart,
    );
    await provisionWebhook(activeWorkflow.created.workflowId);
    await setWorkflowLifecycle(
      activeWorkflow.created.workflowId,
      'archived',
      'deactivating',
    );
    const activeArchive = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await deliverReconciliation(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
      activeArchive,
    );
    await setWorkflowLifecycle(
      activeWorkflow.created.workflowId,
      'active',
      'activating',
    );
    const activeRestore = await appendReconciliationEvent(
      activeWorkflow.created.workflowId,
      activeWorkflow.published.version.id,
    );
    await expect(
      deliverReconciliation(
        activeWorkflow.created.workflowId,
        activeWorkflow.published.version.id,
        activeRestore,
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'active' }),
        expect.objectContaining({
          endpointReady: true,
          nodeId: 'webhook',
          status: 'active',
        }),
      ]),
    );
    await expect(
      workflowState(activeWorkflow.created.workflowId),
    ).resolves.toMatchObject({
      activation_status: 'active',
      lifecycle_status: 'active',
    });
    await expect(
      triggerFacts(activeWorkflow.created.workflowId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint_status: 'active',
          kind: 'webhook',
          status: 'active',
        }),
        expect.objectContaining({
          kind: 'schedule',
          schedule_status: 'enabled',
          status: 'active',
        }),
      ]),
    );
  });

  it('projects partial, global, and archived failures without overwriting trigger facts', async () => {
    const { created, published } = await publishTriggerWorkflow();
    const start = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await deliverReconciliation(
      created.workflowId,
      published.version.id,
      start,
    );
    const resources = await provisionWebhook(created.workflowId);

    await ownerQuery(
      `update app.workflow_triggers set status='configuration_required',
         health_status='pending',last_error_code=null
         where workspace_id=$1 and id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      error: new Error('provider_partial_failure'),
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'healthy',
          kind: 'webhook',
          last_error_code: null,
          status: 'active',
        }),
        expect.objectContaining({
          health_status: 'unhealthy',
          kind: 'schedule',
          last_error_code: 'trigger.reconciliation_failed',
          status: 'error',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'degraded',
      lifecycle_status: 'active',
    });

    await ownerQuery(
      `update app.trigger_schedules set status='disabled',health_status='disabled',
         last_error_code=null where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await ownerQuery(
      `update app.workflow_triggers set status='disabled',health_status='disabled',
         last_error_code=null where workspace_id=$1 and id=$2`,
      [workspaceId, resources.scheduleId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      error: new Error('provider_disabled_resource'),
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'healthy',
          kind: 'webhook',
          last_error_code: null,
          status: 'active',
        }),
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          schedule_health_status: 'disabled',
          schedule_status: 'disabled',
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'degraded',
    });

    await ownerQuery(
      `update app.workflow_triggers set status='pending',health_status='pending'
         where workspace_id=$1 and id=$2`,
      [workspaceId, resources.webhookId],
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      error: new Error('provider_global_failure'),
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'unhealthy',
          kind: 'webhook',
          last_error_code: 'trigger.reconciliation_failed',
          status: 'error',
        }),
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'error',
    });

    await setWorkflowLifecycle(created.workflowId, 'archived', 'deactivating');
    const archiveEvent = await appendReconciliationEvent(
      created.workflowId,
      published.version.id,
    );
    await deliverReconciliation(
      created.workflowId,
      published.version.id,
      archiveEvent,
    );
    await reconciliation.recordFailure({
      workspaceId,
      workflowId: created.workflowId,
      publishedVersionId: published.version.id,
      error: new Error('provider_archived_failure'),
    });
    await expect(triggerFacts(created.workflowId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          health_status: 'disabled',
          kind: 'schedule',
          last_error_code: null,
          status: 'disabled',
        }),
        expect.objectContaining({
          endpoint_status: 'active',
          health_status: 'disabled',
          kind: 'webhook',
          last_error_code: null,
          status: 'disabled',
        }),
      ]),
    );
    await expect(workflowState(created.workflowId)).resolves.toMatchObject({
      activation_status: 'error',
      lifecycle_status: 'archived',
    });
  });

  it('rejects an old-version event without rewriting current health or history', async () => {
    const first = await publishTriggerWorkflow();
    await reconciliation.reconcile({
      workspaceId,
      workflowId: first.created.workflowId,
      publishedVersionId: first.published.version.id,
      outboxEventId: first.eventId,
    });
    const firstResources = await provisionWebhook(first.created.workflowId);
    await expect(
      webhook.resolveVerification(firstResources.endpointKeyHash),
    ).resolves.not.toBeNull();
    const second = await publishNextTriggerWorkflowVersion(
      first.created.workflowId,
    );
    const latestHealth = await reconciliation.reconcile({
      workspaceId,
      workflowId: first.created.workflowId,
      publishedVersionId: second.published.version.id,
      outboxEventId: second.eventId,
    });
    const historyBeforeStaleDelivery = await immutableWorkflowHistory(
      first.created.workflowId,
    );
    await expect(
      reconciliation.reconcile({
        workspaceId,
        workflowId: first.created.workflowId,
        publishedVersionId: first.published.version.id,
        outboxEventId: first.eventId,
        delivery: {
          outboxEventId: first.eventId,
          payloadChecksum: first.eventChecksum,
        },
      }),
    ).rejects.toBeInstanceOf(WorkflowTriggerStalePublicationError);
    await expect(
      webhook.getHealth({
        workspaceId,
        actorId,
        workflowId: first.created.workflowId,
      }),
    ).resolves.toEqual(latestHealth);
    await expect(
      immutableWorkflowHistory(first.created.workflowId),
    ).resolves.toEqual(historyBeforeStaleDelivery);
    await expect(
      workflowState(first.created.workflowId),
    ).resolves.toMatchObject({
      lifecycle_status: 'active',
      published_version_id: second.published.version.id,
    });
  });

  it('commits one skipped webhook event, preserves its receipt after release and exposes the reason', async () => {
    const { verification } = await createWebhookScenario({
      responseMode: 'workflow',
      responseWaitSeconds: 1,
    });
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('skip-payload'),
      idempotencyKeyHash: hash('skip-first'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ private: 'not in skip metadata' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    };
    const first = await acceptWebhook(input);
    await ownerQuery(
      `insert into app.workflow_concurrency_policies(workspace_id,workflow_id,active_run_limit,overflow) values($1,$2,1,'skip')`,
      [workspaceId, verification.workflowId],
    );
    const skippedInput = { ...input, idempotencyKeyHash: hash('skip-busy') };
    const skipped = { skipped: true, reason: 'concurrency_limit' };
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          webhook.acceptVerifiedDelivery(skippedInput),
        ),
      ),
    ).toEqual([skipped, skipped, skipped, skipped]);
    const counts = () =>
      ownerQuery(
        `select (select count(*)::int from app.workflow_runs where workflow_id=$1) runs,
      (select count(*)::int from app.usage_events where resource_id=$1 and category='trigger.skipped') skips,
      (select count(*)::int from app.idempotency_records where status='in_progress') incomplete`,
        [verification.workflowId],
      );
    expect((await counts()).rows).toEqual([
      { runs: 1, skips: 1, incomplete: 0 },
    ]);
    const history = await webhook.listDeliveries({
      workspaceId,
      actorId,
      workflowId: verification.workflowId,
      triggerId: verification.triggerId,
    });
    expect(
      history.items.filter((item) => item.outcome === 'skipped'),
    ).toHaveLength(4);
    expect(
      history.items
        .filter((item) => item.outcome === 'skipped')
        .every(
          (item) =>
            item.skipReason === 'concurrency_limit' &&
            item.runId === null &&
            item.httpStatus === 202,
        ),
    ).toBe(true);
    await ownerQuery(
      `update app.workflow_runs set status='canceled',completed_at=clock_timestamp() where id=$1`,
      [first.runId],
    );
    expect(await webhook.acceptVerifiedDelivery(skippedInput)).toEqual(skipped);
    await expect(
      webhook.acceptVerifiedDelivery({
        ...skippedInput,
        requestFingerprint: hash('changed'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryReplayMismatchError);
    await acceptWebhook({ ...input, idempotencyKeyHash: hash('skip-next') });
    expect((await counts()).rows).toEqual([
      { runs: 2, skips: 1, incomplete: 0 },
    ]);
    const metadata = await ownerQuery(
      `select metadata from app.usage_events where resource_id=$1 and category='trigger.skipped'`,
      [verification.workflowId],
    );
    expect(metadata.rows).toEqual([
      { metadata: { reason: 'concurrency_limit', triggerType: 'webhook' } },
    ]);
  });

  it('captures opt-in response policy atomically and preserves it for exact ingress retries', async () => {
    const scenario = await createWebhookScenario({
      responseMode: 'workflow',
      responseWaitSeconds: 1,
    });
    const verification = scenario.verification;
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('response-policy'),
      idempotencyKeyHash: hash(randomUUID()),
      runInput: webhookRunInput(verification.runInputMode, post({})),
      bodyBytes: 2,
      checkpointFactory,
    };
    const first = await acceptWebhook(input);
    expect(first).toMatchObject({ replayed: false, responseWaitSeconds: 1 });
    expect(
      await webhook.readResponse({ workspaceId, runId: first.runId }),
    ).toEqual({ state: 'pending' });
    const duplicate = await acceptWebhook(input);
    expect(duplicate).toEqual({ ...first, replayed: true });
    expect(
      (
        await ownerQuery(
          'select run_id,wait_seconds,body from app.webhook_run_responses where run_id=$1',
          [first.runId],
        )
      ).rows,
    ).toEqual([{ run_id: first.runId, wait_seconds: 1, body: null }]);
    const immediate = await createWebhookScenario();
    const accepted = await acceptWebhook({
      ...input,
      verification: immediate.verification,
      verifiedSecretVersionId: immediate.verification.currentSecret.id,
      idempotencyKeyHash: hash(randomUUID()),
    });
    expect(accepted.responseWaitSeconds).toBeUndefined();
    expect(
      (
        await ownerQuery(
          'select run_id from app.webhook_run_responses where run_id=$1',
          [accepted.runId],
        )
      ).rows,
    ).toEqual([]);
  });

  it('resolves eligible sealed references and atomically deduplicates concurrent delivery', async () => {
    const { resources, verification } = await createWebhookScenario();
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('payload-one'),
      idempotencyKeyHash: hash('sender-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'one' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    const accepted = await Promise.all([
      acceptWebhook(input),
      acceptWebhook(input),
    ]);
    expect(new Set(accepted.map(({ runId }) => runId)).size).toBe(1);
    expect(accepted.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    const pins = await ownerQuery(
      `select failure_notification_destination_id,
              failure_notification_destination_config_version,
              failure_notification_side_effect_class,
              failure_notification_connection_secret_version_id
         from app.workflow_runs where id=$1`,
      [accepted[0].runId],
    );
    expect(pins.rows).toEqual([
      {
        failure_notification_destination_id: notificationDestinationId,
        failure_notification_destination_config_version: 1,
        failure_notification_side_effect_class: 'idempotent_with_key',
        failure_notification_connection_secret_version_id:
          notificationSecretVersionId,
      },
    ]);
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('changed-payload'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryReplayMismatchError);
    const retention = await ownerQuery<{
      delivery_seconds: number;
      replay_seconds: number;
    }>(
      `select extract(epoch from delivery.expires_at-delivery.received_at)::integer delivery_seconds,
              extract(epoch from replay.expires_at-replay.created_at)::integer replay_seconds
         from app.webhook_trigger_deliveries delivery
         join app.webhook_trigger_replay_records replay on replay.delivery_id=delivery.id
        where delivery.endpoint_id=$1`,
      [resources.endpointId],
    );
    expect(retention.rows[0]).toEqual({
      delivery_seconds: 90 * 24 * 60 * 60,
      replay_seconds: 24 * 60 * 60,
    });
  });

  it('refuses new trigger work while the workflow is paused, still answering replays', async () => {
    const { published, resources, verification } =
      await createWebhookScenario();
    const pausedWorkflowId = published.created.workflowId;
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('before-pause'),
      idempotencyKeyHash: hash('before-pause-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'before-pause' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    const before = await acceptWebhook(input);
    // ADR 056: the fold records a pause exactly like this.
    await ownerQuery(
      `update app.workflows
          set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
              trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,
              trigger_pause_last_run_id=$3,
              trigger_pause_revision=trigger_pause_revision+1
        where workspace_id=$1 and id=$2`,
      [workspaceId, pausedWorkflowId, before.runId],
    );

    await expect(acceptWebhook(input)).resolves.toEqual({
      runId: before.runId,
      replayed: true,
    });
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('during-pause'),
        idempotencyKeyHash: hash('during-pause-key'),
        runInput: { event: 'during-pause' },
      }),
    ).rejects.toBeInstanceOf(WebhookWorkflowPausedError);
    const runs = await ownerQuery<{ count: number }>(
      `select count(*)::int as count from app.workflow_runs
        where workspace_id=$1 and workflow_id=$2`,
      [workspaceId, pausedWorkflowId],
    );
    expect(runs.rows).toEqual([{ count: 1 }]);

    await ownerQuery(
      `update app.trigger_schedules set next_fire_at=clock_timestamp()-interval '1 minute'
         where workspace_id=$1 and trigger_id=$2`,
      [workspaceId, resources.scheduleId],
    );
    const claimed = await maintenancePool.query<{
      lease_token: string;
      trigger_id: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`pause-gate-${randomUUID()}`],
    );
    const claim = claimed.rows[0];
    if (claim === undefined) throw new Error('Paused schedule claim missing');
    expect(claim.trigger_id).toBe(resources.scheduleId);
    await expect(pausedNow(claim)).resolves.toBe(true);
    await maintenancePool.query(
      'select app.release_trigger_schedule_claim($1,$2)',
      [claim.trigger_id, claim.lease_token],
    );
    const controls = authoring.autoPause;
    const scope = { workspaceId, workflowId: pausedWorkflowId, actorId };
    await controls.resumeWorkflow({
      ...scope,
      expectedPauseRevision: '2',
      idempotencyKey: randomUUID(),
    });
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('after-resume'),
        idempotencyKeyHash: hash('after-resume-key'),
        runInput: { event: 'after-resume' },
      }),
    ).resolves.toMatchObject({ replayed: false });
    const resumedClaim = await maintenancePool.query<{
      trigger_id: string;
      lease_token: string;
    }>(
      'select trigger_id,lease_token from app.claim_due_trigger_schedules($1,1,30)',
      [`resume-gate-${randomUUID()}`],
    );
    const resumed = resumedClaim.rows[0];
    if (resumed === undefined)
      throw new Error('Resumed schedule claim missing');
    expect(resumed.trigger_id).toBe(resources.scheduleId);
    await expect(pausedNow(resumed)).resolves.toBe(false);
    await maintenancePool.query(
      'select app.release_trigger_schedule_claim($1,$2)',
      [resumed.trigger_id, resumed.lease_token],
    );

    // A person's disabled resources remain disabled through pause, archive,
    // restore and resume. Only the separate pause state is cleared.
    await workerQuery(
      "update app.webhook_trigger_endpoints set status='disabled' where id=$1",
      [resources.endpointId],
    );
    await ownerQuery(
      "update app.workflow_triggers set status='disabled',health_status='disabled' where workflow_version_id=(select published_version_id from app.workflows where id=(select workflow_id from app.webhook_trigger_endpoints where id=$1)) and node_id=(select node_id from app.webhook_trigger_endpoints where id=$1)",
      [resources.endpointId],
    );
    await ownerQuery(
      "update app.trigger_schedules set status='disabled' where trigger_id=$1",
      [resources.scheduleId],
    );
    await ownerQuery(
      `update app.workflows set trigger_pause_state='paused',trigger_paused_at=clock_timestamp(),
      trigger_pause_reason='consecutive_failures',trigger_pause_failures=10,trigger_pause_last_run_id=$3,
      trigger_pause_revision=trigger_pause_revision+1 where workspace_id=$1 and id=$2`,
      [workspaceId, pausedWorkflowId, before.runId],
    );
    await authoring.transitionWorkflowLifecycle({
      ...scope,
      command: 'archive',
      expectedLifecycleRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await authoring.transitionWorkflowLifecycle({
      ...scope,
      command: 'restore',
      expectedLifecycleRevision: 2,
      idempotencyKey: randomUUID(),
    });
    expect((await controls.readWorkflowSettings(scope)).pauseState).toBe(
      'paused',
    );
    await controls.resumeWorkflow({
      ...scope,
      expectedPauseRevision: '4',
      idempotencyKey: randomUUID(),
    });
    await expect(
      ownerQuery(
        `select endpoint.status as endpoint_status,schedule.status as schedule_status
      from app.webhook_trigger_endpoints endpoint join app.trigger_schedules schedule on schedule.trigger_id=$2
      where endpoint.id=$1`,
        [resources.endpointId, resources.scheduleId],
      ),
    ).resolves.toMatchObject({
      rows: [{ endpoint_status: 'disabled', schedule_status: 'disabled' }],
    });
    await expect(
      acceptWebhook({
        ...input,
        requestFingerprint: hash('still-disabled'),
        idempotencyKeyHash: hash('still-disabled-key'),
        runInput: { event: 'still-disabled' },
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
  });

  it.each([false, true])(
    'prepares fresh input and coordination when a replay expires behind the admission fence (%s)',
    async (coordinated) => {
      const { resources, verification } = await createWebhookScenario(
        coordinated
          ? {
              coordination: {
                mode: 'deduplicate',
                key: { kind: 'run_input', path: '$.orderId' },
                windowSeconds: 60,
              },
            }
          : {},
      );
      const input = {
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ orderId: 'order-42', amount: 19 }),
        ),
        bodyBytes: 34,
        checkpointFactory,
      };
      const first = await webhook.acceptVerifiedDelivery(input);
      if (!('runId' in first)) throw new Error('Expected the initial run');
      const fence = await owner.connect();
      let replacement:
        ReturnType<typeof webhook.acceptVerifiedDelivery> | undefined;
      try {
        await fence.query('begin');
        await fence.query('set local role pertexo_owner');
        await fence.query("select set_config('app.workspace_id',$1,true)", [
          workspaceId,
        ]);
        const held = await fence.query<{ pid: number }>(
          'select pg_backend_pid() pid, id from app.workspaces where id=$1 for update',
          [workspaceId],
        );
        const pid = held.rows[0]?.pid;
        if (pid === undefined) throw new Error('Admission fence missing');
        replacement = webhook.acceptVerifiedDelivery(input);
        // Observe the blocked write: its preliminary read has seen the live receipt.
        await waitForBlockedBy(workerPool, pid, { timeout: 10_000 });
        await fence.query(
          `update app.webhook_trigger_replay_records set created_at=clock_timestamp()-interval '24 hours 2 seconds', expires_at=clock_timestamp()-interval '2 seconds' where workspace_id=$1 and endpoint_id=$2 and dedupe_key_hash=$3`,
          [workspaceId, resources.endpointId, input.idempotencyKeyHash],
        );
        await fence.query('commit');
      } finally {
        await fence.query('rollback');
        fence.release();
      }
      const result = await replacement;
      if (coordinated) {
        expect(result).toMatchObject({
          coordinated: true,
          outcome: 'deduplicated',
        });
      } else {
        expect(result).toMatchObject({ replayed: false });
        if (!('runId' in result)) throw new Error('Expected fresh admission');
        expect(result.runId).not.toBe(first.runId);
        const stored = await ownerQuery<{
          input_ref: { value: unknown } | null;
        }>('select input_ref from app.workflow_runs where id=$1', [
          result.runId,
        ]);
        expect(stored.rows[0]?.input_ref?.value).toEqual({
          orderId: 'order-42',
          amount: 19,
        });
      }
    },
    20_000,
  );

  it('serializes expired replay replacement with database time', async () => {
    const { resources, verification } = await createWebhookScenario();
    const requestFingerprint = hash('expired-keyed-payload');
    const dedupeKeyHash = hash('expired-keyed-key');
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint,
      idempotencyKeyHash: dedupeKeyHash,
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'expired-keyed' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    const first = await acceptWebhook(input);
    const observation = await ownerQuery<{ observed_at: Date }>(
      `update app.webhook_trigger_replay_records
          set created_at=clock_timestamp()-interval '24 hours 2 seconds',
              expires_at=clock_timestamp()-interval '2 seconds'
        where workspace_id=$1 and endpoint_id=$2 and dedupe_key_hash=$3
        returning clock_timestamp() observed_at`,
      [workspaceId, resources.endpointId, dedupeKeyHash],
    );
    expect(observation.rows[0]?.observed_at).toBeInstanceOf(Date);

    const raced = await Promise.all([
      acceptWebhook(input),
      acceptWebhook(input),
    ]);
    expect(new Set(raced.map(({ runId }) => runId)).size).toBe(1);
    expect(raced[0].runId).not.toBe(first.runId);
    expect(raced.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    // Admits twice; the race also records its losing exact replay.
    await expect(
      ownerQuery<{ outcome: string; count: number }>(
        `select outcome,count(*)::int count from app.webhook_trigger_deliveries
          where workspace_id=$1 and endpoint_id=$2
          group by outcome order by outcome`,
        [workspaceId, resources.endpointId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { outcome: 'accepted', count: 2 },
        { outcome: 'replayed', count: 1 },
      ],
    });
  });

  it('rolls back actual replay, run and outbox writes when delivery persistence fails', async () => {
    const { resources, verification } = await createWebhookScenario();
    const durableCounts = () =>
      ownerQuery<{
        deliveries: number;
        outbox_events: number;
        replay_records: number;
        runs: number;
      }>(
        `select
          (select count(*)::int from app.webhook_trigger_deliveries
            where workspace_id=$1 and endpoint_id=$2) deliveries,
          (select count(*)::int from app.webhook_trigger_replay_records
            where workspace_id=$1 and endpoint_id=$2) replay_records,
          (select count(*)::int from app.workflow_runs
            where workspace_id=$1 and workflow_id=$3) runs,
          (select count(*)::int from app.outbox_events
            where workspace_id=$1 and aggregate_type='workflow-run'
              and aggregate_id in (select id from app.workflow_runs
                where workspace_id=$1 and workflow_id=$3)) outbox_events`,
        [workspaceId, resources.endpointId, verification.workflowId],
      ).then((result) => result.rows[0]);
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('post-write-rollback'),
      idempotencyKeyHash: hash('post-write-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'post-write-rollback' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    };
    await acceptWebhook({
      ...input,
      idempotencyKeyHash: hash('positive-control-key'),
    });
    const before = await durableCounts();
    expect(before).toEqual({
      deliveries: 1,
      replay_records: 1,
      runs: 1,
      outbox_events: 1,
    });
    await ownerQuery(`create function public.reject_webhook_commit() returns trigger language plpgsql as $$
      begin
        if not exists(select 1 from app.webhook_trigger_replay_records where delivery_id=new.id)
          or not exists(select 1 from app.workflow_runs where id=new.workflow_run_id)
          or not exists(select 1 from app.outbox_events where aggregate_type='workflow-run' and aggregate_id=new.workflow_run_id)
        then raise exception 'Rollback test did not reach its writes'; end if;
        raise exception 'Forced post-write rollback';
      end $$;
      create trigger reject_webhook_commit before insert on app.webhook_trigger_deliveries
      for each row execute function public.reject_webhook_commit()`);
    try {
      await expect(acceptWebhook(input)).rejects.toMatchObject({
        cause: { code: 'P0001', message: 'Forced post-write rollback' },
      });
    } finally {
      await ownerQuery(
        'drop trigger reject_webhook_commit on app.webhook_trigger_deliveries; drop function public.reject_webhook_commit()',
      );
    }
    await expect(durableCounts()).resolves.toEqual(before);
    const accepted = await acceptWebhook(input);
    const replayed = await acceptWebhook(input);
    expect(replayed).toMatchObject({ runId: accepted.runId, replayed: true });
    await expect(durableCounts()).resolves.toEqual({
      deliveries: 3,
      replay_records: 2,
      runs: 2,
      outbox_events: 2,
    });
  });

  it('keeps graph-disabled trigger nodes externally materialized for execution-time skipping', async () => {
    const published = await publishTriggerWorkflow(true);
    const health = await deliverReconciliation(
      published.created.workflowId,
      published.published.version.id,
      {
        eventId: published.eventId,
        payloadChecksum: published.eventChecksum,
      },
    );
    expect(health).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'schedule', status: 'active' }),
        expect.objectContaining({
          nodeId: 'webhook',
          status: 'configuration_required',
        }),
      ]),
    );
    const resources = await provisionWebhook(published.created.workflowId);
    const verification = await webhook.resolveVerification(
      resources.endpointKeyHash,
    );
    if (verification === null)
      throw new Error('Expected graph-disabled external endpoint');
    await expect(
      acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('graph-disabled-ingress'),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ event: 'graph-disabled-ingress' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('configures authentication atomically, rotates across modes and fences stale proof even for retries', async () => {
    const { published, resources, verification } =
      await createWebhookScenario();
    const nextKey = hash(randomUUID());
    const nextSecret = secret();
    const authentication = {
      mode: 'secret_url' as const,
      allowedOrigins: ['https://app.example'],
    };
    const command = {
      workspaceId,
      actorId,
      workflowId: published.created.workflowId,
      triggerId: resources.webhookId,
      authentication,
      endpointKeyHash: nextKey,
      secret: nextSecret,
      idempotencyKey: randomUUID(),
      requestHash: hash('url-mode'),
    };
    const old = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('auth-before'),
      idempotencyKeyHash: hash('auth-before'),
      runInput: webhookRunInput(verification.runInputMode, post({})),
      bodyBytes: 2,
      checkpointFactory,
    };
    await acceptWebhook(old);
    await expect(
      webhook.configureAuthentication({ ...command, workflowId: randomUUID() }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    expect(await webhook.configureAuthentication(command)).toMatchObject({
      replayed: false,
      rotated: true,
      trigger: { authentication },
    });
    expect(
      await webhook.configureAuthentication({ ...command, secret: secret() }),
    ).toMatchObject({ replayed: true, rotated: false });
    await expect(
      webhook.resolveVerification(resources.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(acceptWebhook(old)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    const url = await webhook.resolveVerification(nextKey);
    expect(url).toMatchObject({
      authentication,
      currentSecret: { id: nextSecret.id },
    });
    expect(url?.previousSecret).toBeUndefined();
    if (url === null) throw new Error('URL endpoint unavailable');
    const input = {
      ...old,
      verification: url,
      verifiedSecretVersionId: nextSecret.id,
      requestFingerprint: hash('url-body'),
      idempotencyKeyHash: hash('url-body'),
    };
    const accepted = await acceptWebhook(input);
    expect(await acceptWebhook(input)).toEqual({
      ...accepted,
      replayed: true,
    });
    await expect(
      webhook.rotateSecret({
        ...command,
        endpointKeyHash: nextKey,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const origins = {
      ...authentication,
      allowedOrigins: ['https://other.example'],
    };
    expect(
      await webhook.configureAuthentication({
        ...command,
        authentication: origins,
        idempotencyKey: randomUUID(),
        requestHash: hash('origins-only'),
        endpointKeyHash: hash(randomUUID()),
        secret: secret(),
      }),
    ).toMatchObject({ rotated: false });
    expect(await webhook.resolveVerification(nextKey)).toMatchObject({
      authentication: origins,
      currentSecret: { id: nextSecret.id },
    });
    await expect(acceptWebhook(input)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    const headerKey = hash(randomUUID());
    expect(
      await webhook.configureAuthentication({
        ...command,
        authentication: {
          mode: 'header_secret',
          headerName: 'authorization',
          allowedOrigins: [],
        },
        endpointKeyHash: headerKey,
        secret: secret(),
        idempotencyKey: randomUUID(),
        requestHash: hash('header-mode'),
      }),
    ).toMatchObject({ rotated: true });
    await expect(webhook.resolveVerification(nextKey)).resolves.toBeNull();
    expect(
      (await webhook.resolveVerification(headerKey))?.previousSecret,
    ).toBeUndefined();
  });

  it('enforces the endpoint ingress boundary atomically under concurrency', async () => {
    const { resources } = await createWebhookScenario();
    const attempts = await Promise.allSettled(
      Array.from({ length: 61 }, () =>
        webhook.consumeIngressLimit(resources.endpointKeyHash),
      ),
    );
    expect(
      attempts.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(60);
    const denied = attempts.filter(({ status }) => status === 'rejected');
    expect(denied).toHaveLength(1);
    expect((denied[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      WebhookIngressRateLimitExceededError,
    );
  });

  it('invalidates old endpoint references at rotation commit and bounds prior secrets', async () => {
    const {
      published,
      resources,
      verification: oldVerification,
    } = await createWebhookScenario();
    const scenarioWorkflowId = published.created.workflowId;
    const nextEndpointHash = hash('endpoint-two');
    const acceptedBeforeRotation = {
      verification: oldVerification,
      verifiedSecretVersionId: oldVerification.currentSecret.id,
      requestFingerprint: hash('accepted-before-rotation'),
      idempotencyKeyHash: hash('accepted-before-rotation-key'),
      runInput: webhookRunInput(
        oldVerification.runInputMode,
        post({ event: 'accepted-before-rotation' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    await acceptWebhook(acceptedBeforeRotation);
    await webhook.rotateEndpoint({
      workspaceId,
      workflowId: scenarioWorkflowId,
      actorId,
      triggerId: resources.webhookId,
      endpointKeyHash: nextEndpointHash,
      idempotencyKey: 'rotate-endpoint',
      requestHash: hash('rotate-endpoint'),
    });
    await expect(
      webhook.resolveVerification(resources.endpointKeyHash),
    ).resolves.toBeNull();
    await expect(acceptWebhook(acceptedBeforeRotation)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    await expect(
      acceptWebhook({
        ...acceptedBeforeRotation,
        requestFingerprint: hash('changed-after-rotation'),
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
    await expect(
      acceptWebhook({
        verification: oldVerification,
        verifiedSecretVersionId: oldVerification.currentSecret.id,
        requestFingerprint: hash('rotation-race'),
        runInput: webhookRunInput(
          oldVerification.runInputMode,
          post({ event: 'rotation-race' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);

    const beforeSecretRotation =
      await webhook.resolveVerification(nextEndpointHash);
    if (beforeSecretRotation === null)
      throw new Error('Expected rotated endpoint');
    const nextSecret = secret();
    const beforeWrongKey = await ownerQuery(
      `select endpoint.current_secret_version_id,
              (select count(*)::integer from app.webhook_trigger_secret_versions secret
                where secret.workflow_id=endpoint.workflow_id and secret.node_id=endpoint.node_id) secret_count
         from app.webhook_trigger_endpoints endpoint where endpoint.id=$1`,
      [resources.endpointId],
    );
    await expect(
      webhook.rotateSecret({
        workspaceId,
        workflowId: scenarioWorkflowId,
        actorId,
        triggerId: resources.webhookId,
        endpointKeyHash: hash('wrong-endpoint'),
        secret: nextSecret,
        idempotencyKey: 'rotate-secret-wrong-key',
        requestHash: hash('rotate-secret-wrong-key'),
      }),
    ).rejects.toBeInstanceOf(WebhookTriggerNotFoundError);
    const afterWrongKey = await ownerQuery(
      `select endpoint.current_secret_version_id,
              (select count(*)::integer from app.webhook_trigger_secret_versions secret
                where secret.workflow_id=endpoint.workflow_id and secret.node_id=endpoint.node_id) secret_count
         from app.webhook_trigger_endpoints endpoint where endpoint.id=$1`,
      [resources.endpointId],
    );
    expect(afterWrongKey.rows).toEqual(beforeWrongKey.rows);
    await webhook.rotateSecret({
      workspaceId,
      workflowId: scenarioWorkflowId,
      actorId,
      triggerId: resources.webhookId,
      endpointKeyHash: nextEndpointHash,
      secret: nextSecret,
      idempotencyKey: 'rotate-secret',
      requestHash: hash('rotate-secret'),
    });
    const after = await webhook.resolveVerification(nextEndpointHash);
    expect(after?.currentSecret.id).toBe(nextSecret.id);
    expect(after?.previousSecret?.id).toBe(
      beforeSecretRotation.currentSecret.id,
    );
    const overlapMillis =
      (after?.previousSecret?.validUntil.getTime() ?? 0) -
      (after?.databaseTime.getTime() ?? 0);
    expect(overlapMillis).toBeGreaterThanOrEqual(299_000);
    expect(overlapMillis).toBeLessThanOrEqual(301_000);
    if (after?.previousSecret === undefined)
      throw new Error('Expected a previous secret overlap');
    await expect(
      acceptWebhook({
        verification: after,
        verifiedSecretVersionId: after.previousSecret.id,
        requestFingerprint: hash('previous-secret-before-expiry'),
        runInput: webhookRunInput(
          after.runInputMode,
          post({ event: 'previous-secret-before-expiry' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).resolves.toMatchObject({ replayed: false });
    const expiredSecret = await apiQuery<{
      current_secret_version_id: string;
      expired: boolean;
      previous_secret_version_id: string;
    }>(
      `update app.webhook_trigger_endpoints
          set previous_secret_valid_until=clock_timestamp()-interval '1 second'
        where workspace_id=$1 and id=$2
        returning current_secret_version_id,previous_secret_version_id,
          previous_secret_valid_until<=clock_timestamp() expired`,
      [workspaceId, after.endpointId],
    );
    expect(expiredSecret.rows).toEqual([
      {
        current_secret_version_id: nextSecret.id,
        previous_secret_version_id: after.previousSecret.id,
        expired: true,
      },
    ]);
    const expiredReference =
      await webhook.resolveVerification(nextEndpointHash);
    if (expiredReference === null)
      throw new Error('Expected endpoint after previous-secret expiry');
    await expect(
      acceptWebhook({
        verification: expiredReference,
        verifiedSecretVersionId: after.previousSecret.id,
        requestFingerprint: hash('previous-secret-after-expiry'),
        runInput: webhookRunInput(
          expiredReference.runInputMode,
          post({ event: 'previous-secret-after-expiry' }),
        ),
        bodyBytes: 64,
        checkpointFactory,
      }),
    ).rejects.toBeInstanceOf(WebhookDeliveryIneligibleError);
  });

  it('rolls back replay and delivery admission when workspace eligibility changes', async () => {
    const { verification } = await createWebhookScenario();
    await ownerQuery(
      "update app.workspaces set status='suspended' where id=$1",
      [workspaceId],
    );
    const input = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('rollback-payload'),
      idempotencyKeyHash: hash('rollback-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'rollback' }),
      ),
      bodyBytes: 64,
      checkpointFactory,
    } as const;
    await expect(acceptWebhook(input)).rejects.toBeInstanceOf(
      WebhookDeliveryIneligibleError,
    );
    await ownerQuery("update app.workspaces set status='active' where id=$1", [
      workspaceId,
    ]);
    await expect(acceptWebhook(input)).resolves.toMatchObject({
      replayed: false,
    });
  });

  it('records metadata-only delivery outcomes and pages the retained log', async () => {
    const { published, resources, verification } =
      await createWebhookScenario();
    const admitted = {
      verification,
      verifiedSecretVersionId: verification.currentSecret.id,
      requestFingerprint: hash('delivery-log-payload'),
      idempotencyKeyHash: hash('delivery-log-key'),
      runInput: webhookRunInput(
        verification.runInputMode,
        post({ event: 'delivery-log' }),
      ),
      bodyBytes: 321,
      checkpointFactory,
    } as const;
    const accepted = await acceptWebhook(admitted);
    await expect(acceptWebhook(admitted)).resolves.toEqual({
      runId: accepted.runId,
      replayed: true,
    });
    const endpoint = {
      workspaceId,
      triggerId: resources.webhookId,
      endpointId: resources.endpointId,
    };
    const rejections = [
      ['authentication_failed', 'not_checked', 'stale_timestamp'],
      ['authentication_failed', 'mismatch', 'not_checked'],
      ['invalid_request', 'verified', 'not_checked'],
      ['conflict', 'verified', 'conflict'],
      ['rate_limited', 'verified', 'new'],
    ] as const;
    for (const [index, [outcome, signatureCheck, replayCheck]] of [
      ...rejections.entries(),
    ])
      await webhook.recordRejectedDelivery({
        endpoint,
        outcome,
        signatureCheck,
        replayCheck,
        bodyBytes: index,
      });
    await expect(
      webhook.recordRejectedDelivery({
        endpoint,
        outcome: 'conflict',
        signatureCheck: 'mismatch',
        replayCheck: 'new',
        bodyBytes: 1,
      }),
    ).rejects.toMatchObject({
      cause: { constraint: 'webhook_trigger_deliveries_outcome_valid' },
    });

    const read = {
      workspaceId,
      actorId,
      workflowId: published.created.workflowId,
      triggerId: resources.webhookId,
      limit: 3,
    };
    const nextPage = (cursor: WebhookDeliveryPosition | undefined) => {
      if (cursor === undefined) throw new Error('Expected another page');
      return webhook.listDeliveries({ ...read, after: cursor });
    };
    const first = await webhook.listDeliveries(read);
    const second = await nextPage(first.nextCursor);
    const third = await nextPage(second.nextCursor);
    expect(
      [first, second, third].map((page) =>
        page.items.map(({ outcome, httpStatus, bodyBytes }) => [
          outcome,
          httpStatus,
          bodyBytes,
        ]),
      ),
    ).toEqual([
      [
        ['rate_limited', 429, 4],
        ['conflict', 409, 3],
        ['invalid_request', 400, 2],
      ],
      [
        ['authentication_failed', 401, 1],
        ['authentication_failed', 401, 0],
        ['replayed', 202, 321],
      ],
      [['accepted', 202, 321]],
    ]);
    expect(third.nextCursor).toBeUndefined();
    expect(second.items[2]).toMatchObject({
      signatureCheck: 'verified',
      replayCheck: 'duplicate',
      runId: accepted.runId,
    });
    expect(third.items[0]).toMatchObject({
      signatureCheck: 'verified',
      replayCheck: 'new',
      runId: accepted.runId,
    });
    expect(first.items.every(({ runId }) => runId === null)).toBe(true);
    const columns = await ownerQuery<{ keys: string[] }>(
      `select array_agg(key order by key) keys from (
         select distinct jsonb_object_keys(to_jsonb(delivery)) key
           from app.webhook_trigger_deliveries delivery
          where workspace_id=$1 and endpoint_id=$2) keys`,
      [workspaceId, resources.endpointId],
    );
    expect(columns.rows[0]?.keys).toEqual([
      'body_bytes',
      'coordination_event_id',
      'endpoint_id',
      'expires_at',
      'http_status',
      'id',
      'outcome',
      'received_at',
      'replay_check',
      'signature_check',
      'skip_reason',
      'workflow_run_id',
      'workspace_id',
    ]);

    await ownerQuery(
      `update app.webhook_trigger_deliveries
          set received_at=clock_timestamp()-interval '91 days',
              expires_at=clock_timestamp()-interval '1 day'
        where workspace_id=$1 and endpoint_id=$2 and outcome='rate_limited'`,
      [workspaceId, resources.endpointId],
    );
    const retained = await webhook.listDeliveries({ ...read, limit: 100 });
    expect(retained.items.map(({ outcome }) => outcome)).not.toContain(
      'rate_limited',
    );
    expect(retained.items).toHaveLength(6);

    for (const hidden of [
      { ...read, actorId: randomUUID() },
      { ...read, triggerId: resources.scheduleId },
      { ...read, workflowId: workflowId },
      { ...read, workspaceId: randomUUID() },
    ])
      await expect(webhook.listDeliveries(hidden)).rejects.toBeInstanceOf(
        WebhookTriggerNotFoundError,
      );
    const otherTenant = await readinessPool.connect();
    try {
      await otherTenant.query('begin');
      await otherTenant.query("select set_config('app.workspace_id',$1,true)", [
        randomUUID(),
      ]);
      await expect(
        otherTenant.query(
          'select id from app.webhook_trigger_deliveries where endpoint_id=$1',
          [resources.endpointId],
        ),
      ).resolves.toMatchObject({ rows: [] });
      await otherTenant.query('rollback');
    } finally {
      otherTenant.release();
    }
  });

  it.each([
    [{}, { orderId: 'A-1' }],
    [
      { runInput: 'request' },
      {
        method: 'POST',
        body: { orderId: 'A-1' },
        query: { source: 'shop' },
        headers: { 'x-shop-event': 'order.paid' },
      },
    ],
  ])(
    'starts the run with the input its trigger asks for %#',
    async (config, expected) => {
      const { verification } = await createWebhookScenario(config);
      const { runId } = await acceptWebhook({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        runInput: webhookRunInput(verification.runInputMode, {
          method: 'POST',
          body: { orderId: 'A-1' },
          query: { source: 'shop' },
          headers: { 'x-shop-event': 'order.paid' },
        }),
        bodyBytes: 17,
        checkpointFactory,
      });
      const stored = await ownerQuery<{ input_ref: { value: unknown } }>(
        'select input_ref from app.workflow_runs where id=$1',
        [runId],
      );
      expect(stored.rows[0]?.input_ref.value).toEqual(expected);
    },
  );

  it('says a webhook that already has an endpoint can’t take another', async () => {
    const { verification } = await createWebhookScenario();
    await expect(
      webhook.provision({
        workspaceId,
        workflowId: verification.workflowId,
        actorId,
        triggerId: verification.triggerId,
        endpointId: randomUUID(),
        endpointKeyHash: hash(`endpoint-${randomUUID()}`),
        secret: secret(),
        idempotencyKey: randomUUID(),
        requestHash: hash(randomUUID()),
      }),
    ).rejects.toMatchObject({
      name: 'WebhookTriggerStateError',
      reason: 'provisioned',
    });
  });

  it.each(['deduplicate', 'debounce', 'throttle'] as const)(
    'coordinates verified %s deliveries before ordinary run admission',
    async (mode) => {
      const scenario = await createWebhookScenario({
        coordination: {
          mode,
          key: { kind: 'run_input', path: '$.orderId' },
          ...(mode === 'debounce'
            ? { quietSeconds: 1 }
            : { windowSeconds: 60 }),
          ...(mode === 'throttle' ? { limit: 1, onExcess: 'delay' } : {}),
        },
      });
      const verification = scenario.verification;
      const input = {
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ orderId: 'order-42' }),
        ),
        bodyBytes: 22,
        checkpointFactory,
      };
      const first = await webhook.acceptVerifiedDelivery(input);
      const replay = await webhook.acceptVerifiedDelivery(input);
      expect(replay).toEqual(
        'runId' in first ? { ...first, replayed: true } : first,
      );
      const second = await webhook.acceptVerifiedDelivery({
        ...input,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
      });
      let coordinationOutcome;
      if (mode === 'deduplicate') {
        coordinationOutcome = 'deduplicated';
      } else {
        if (mode === 'debounce') {
          coordinationOutcome = 'debounced';
        } else {
          coordinationOutcome = 'throttled';
        }
      }
      expect(second).toMatchObject({
        coordinated: true,
        outcome: coordinationOutcome,
      });
      const history = await webhook.listDeliveries({
        workspaceId,
        actorId,
        workflowId: verification.workflowId,
        triggerId: verification.triggerId,
      });
      expect(history.items).toHaveLength(3);
      expect(
        history.items.every((item) => item.coordination !== undefined),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'releases a pending webhook with response context or refuses its disabled endpoint (%s)',
    async (disable) => {
      const scenario = await createWebhookScenario({
        responseMode: 'workflow',
        responseWaitSeconds: 1,
        coordination: {
          mode: 'debounce',
          key: { kind: 'run_input', path: '$.orderId' },
          quietSeconds: 3600,
        },
      });
      const verification = scenario.verification;
      const input = {
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash(randomUUID()),
        idempotencyKeyHash: hash(randomUUID()),
        runInput: webhookRunInput(
          verification.runInputMode,
          post({ orderId: 'order-42' }),
        ),
        bodyBytes: 22,
        checkpointFactory,
      };
      const receipt = await webhook.acceptVerifiedDelivery(input);
      if (!('coordinated' in receipt))
        throw new Error('Expected deferred webhook');
      await ownerQuery(
        "update app.trigger_coordinated_events set due_at=clock_timestamp()-interval '1 second' where id=$1",
        [receipt.eventId],
      );
      expect(
        (
          await ownerQuery(
            'select status,endpoint_id from app.trigger_coordinated_events where id=$1',
            [receipt.eventId],
          )
        ).rows,
      ).toEqual([{ status: 'pending', endpoint_id: verification.endpointId }]);
      if (disable)
        expect(
          (
            await workerQuery(
              "update app.webhook_trigger_endpoints set status='disabled' where id=$1 returning status",
              [verification.endpointId],
            )
          ).rows,
        ).toEqual([{ status: 'disabled' }]);
      const scanner = createTriggerEventScanner(
        apiConfig,
        undefined,
        maintenanceConfig(apiConfig),
      );
      try {
        await scanner.scanDue({ limit: 100, checkpointFactory });
      } finally {
        await scanner.close();
      }
      const event = (
        await ownerQuery<{
          status: string;
          reason: string | null;
          run_id: string | null;
          input_ref: unknown;
        }>(
          'select status,reason,run_id,input_ref from app.trigger_coordinated_events where id=$1',
          [receipt.eventId],
        )
      ).rows[0];
      expect(event).toMatchObject({
        status: disable ? 'refused' : 'started',
        reason: disable ? 'endpoint_disabled' : null,
        input_ref: null,
      });
      if (!disable) {
        if (event?.run_id === null || event?.run_id === undefined)
          throw new Error('Missing admitted run');
        expect(
          await webhook.readResponse({ workspaceId, runId: event.run_id }),
        ).toEqual({ state: 'pending' });
        expect(await webhook.acceptVerifiedDelivery(input)).toEqual(receipt);
      }
    },
  );

  it('still serves other work while a burst waits on its workspace, then accepts the whole burst', async () => {
    const { verification, resources } = await createWebhookScenario();
    const held = await holdAdmissionRow(owner, workspaceId);
    const burst = Array.from({ length: 20 }, (_, at) =>
      webhook.acceptVerifiedDelivery({
        verification,
        verifiedSecretVersionId: verification.currentSecret.id,
        requestFingerprint: hash('burst-payload'),
        idempotencyKeyHash: hash(`burst-${String(at)}`),
        runInput: webhookRunInput(verification.runInputMode, post({})),
        bodyBytes: 2,
        checkpointFactory,
      }),
    );
    const settled = Promise.allSettled(burst);
    try {
      await expect
        .poll(() => held.blocked(), { timeout: 10_000 })
        .toBeGreaterThan(0);
      // The stuck row must not cost anyone else a connection.
      const servedInTime = await Promise.race([
        webhook
          .resolveVerification(resources.endpointKeyHash)
          .then((reference) => reference !== null),
        delay(3_000).then(() => false),
      ]);
      expect(servedInTime).toBe(true);
    } finally {
      await held.release();
    }
    const outcomes = await settled;
    expect(outcomes.filter(({ status }) => status === 'rejected')).toEqual([]);
    const { rows } = await ownerQuery<{ runs: number }>(
      'select count(*)::int runs from app.workflow_runs where workflow_id=$1',
      [verification.workflowId],
    );
    expect(rows).toEqual([{ runs: burst.length }]);
  }, 30_000);

  it('refuses a delivery that waited too long, starts nothing for it and accepts its retry exactly once', async () => {
    const { verification } = await createWebhookScenario();
    const pool = new Pool({ connectionString: apiConfig.connectionString });
    const eventPreparation = createEventCoordinationPreparation();
    const accept = (
      turns: ReturnType<typeof createWorkspaceTurns>,
      key: string,
    ) =>
      acceptVerifiedWebhookDelivery(
        pool,
        { eventPreparation, turns },
        {
          verification,
          verifiedSecretVersionId: verification.currentSecret.id,
          requestFingerprint: hash('refused-payload'),
          idempotencyKeyHash: hash(key),
          runInput: webhookRunInput(verification.runInputMode, post({})),
          bodyBytes: 2,
          checkpointFactory,
        },
      );
    const runs = async () =>
      (
        await ownerQuery<{ count: number }>(
          'select count(*)::int count from app.workflow_runs where workflow_id=$1',
          [verification.workflowId],
        )
      ).rows[0]?.count;
    const replayRows = async (key: string) =>
      (
        await ownerQuery<{ count: number }>(
          'select count(*)::int count from app.webhook_trigger_replay_records where dedupe_key_hash=$1',
          [hash(key)],
        )
      ).rows[0]?.count;

    const turns = createWorkspaceTurns({ atOnce: 1, maxWaitMillis: 100 });
    try {
      const held = await holdAdmissionRow(owner, workspaceId);
      const first = accept(turns, 'first-in-line');
      let refusal: unknown;
      try {
        await expect.poll(() => held.blocked(), { timeout: 10_000 }).toBe(1);
        await accept(turns, 'refused-in-line');
      } catch (error) {
        refusal = error;
      } finally {
        await held.release();
      }
      expect(refusal).toBeInstanceOf(WebhookIntakeBusyError);
      await first;
      expect(await runs()).toBe(1);
      expect(await replayRows('refused-in-line')).toBe(0);

      const retried = await accept(turns, 'refused-in-line');
      const again = await accept(turns, 'refused-in-line');
      expect(again).toMatchObject({
        replayed: true,
        runId: 'runId' in retried ? retried.runId : 'no run',
      });
      expect(await runs()).toBe(2);
    } finally {
      await eventPreparation.close();
      await pool.end();
    }
  }, 30_000);
});
