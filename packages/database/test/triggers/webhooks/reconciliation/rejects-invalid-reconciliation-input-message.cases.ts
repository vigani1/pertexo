import { randomUUID } from 'node:crypto';

import { expect, it } from 'vitest';

import { canonicalOutboxPayloadChecksum } from '../../../../src/outbox/events.repository.js';

import { WorkflowTriggerReconciliationMismatchError } from '../../../../src/triggers/reconciliation/repository.js';

import {
  workspaceId,
  workflowId,
  versionId,
  reconciliation,
  ownerQuery,
  publishTriggerWorkflow,
} from '../fixture.js';

export function registerRejectsInvalidReconciliationInputMessage(): void {
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
}
