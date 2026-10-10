import { describe, expect, it } from 'vitest';

import {
  actorId,
  apiPool,
  apiUrl,
  archiveWrite,
  authoring,
  createHash,
  createWorkflowAuthoringDatabase,
  currentRepresentationTag,
  emptyGraph,
  failAtWrite,
  finishTransactionClient,
  holdAtWrite,
  parseDatabaseConfig,
  publicationWrite,
  queryAsOwner,
  randomUUID,
  waitForPostgresLock,
  waitForOperationEntry,
  withApplicationName,
  workspaceId,
} from '../../support/workflow-authoring.js';

type LifecycleFacts = Readonly<{
  lifecycleStatus: string;
  lifecycleRevision: number;
  activationStatus: string;
  publishedVersionId: string | null;
  idempotencyClaims: number;
  reconciliationOutbox: number;
  auditEvents: number;
}>;

describe('workflow lifecycle command persistence', () => {
  it.each(['workspaceId', 'id'] as const)(
    'rejects a replay whose durable lifecycle workflow %s does not match its claim',
    async (identityField) => {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `lifecycle-corrupt-create-${identityField}`,
        name: `Lifecycle corrupt ${identityField}`,
        workspaceId,
      });
      const idempotencyKey = `lifecycle-corrupt-archive-${identityField}`;
      const command = {
        actorId,
        command: 'archive' as const,
        expectedLifecycleRevision: 1,
        idempotencyKey,
        workflowId: created.workflowId,
        workspaceId,
      };
      await expect(
        authoring.transitionWorkflowLifecycle(command),
      ).resolves.toMatchObject({ replayed: false });
      await queryAsOwner(
        `update app.idempotency_records
            set result_ref=jsonb_set(
              result_ref,$2::text[],to_jsonb($3::text),false)
          where workspace_id=$4 and operation='workflow.archive'
            and key_hash=$1
          returning key_hash`,
        [
          createHash('sha256').update(idempotencyKey).digest('hex'),
          ['workflow', identityField],
          randomUUID(),
          workspaceId,
        ],
        workspaceId,
      );

      await expect(
        authoring.transitionWorkflowLifecycle(command),
      ).rejects.toThrow(
        'Stored workflow command result names another workflow',
      );
    },
  );

  it('grants the API runtime only the new lifecycle revision column', async () => {
    const result = await apiPool.query<{
      lifecycle_revision: boolean;
      id: boolean;
      workspace_id: boolean;
      created_by: boolean;
    }>(
      `select
         has_column_privilege(current_user,'app.workflows','lifecycle_revision','UPDATE') lifecycle_revision,
         has_column_privilege(current_user,'app.workflows','id','UPDATE') id,
         has_column_privilege(current_user,'app.workflows','workspace_id','UPDATE') workspace_id,
         has_column_privilege(current_user,'app.workflows','created_by','UPDATE') created_by`,
    );
    expect(result.rows[0]).toEqual({
      lifecycle_revision: true,
      id: false,
      workspace_id: false,
      created_by: false,
    });
  });

  it('rolls back every lifecycle step, including the idempotency claim', async () => {
    const steps = [
      'claim',
      'workflow',
      'outbox',
      'audit',
      'idempotency',
    ] as const;

    for (const step of steps) {
      const created = await authoring.createWorkflow({
        actorId,
        emptyGraph,
        idempotencyKey: `lifecycle-rollback-create-${step}`,
        name: `Lifecycle rollback ${step}`,
        workspaceId,
      });
      await authoring.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          created.workflowId,
          actorId,
        ),
        idempotencyKey: `lifecycle-rollback-publish-${step}`,
        requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
        workflowId: created.workflowId,
        workspaceId,
      });
      const before = await lifecycleFacts(created.workflowId);
      const fault = await failAtWrite(archiveWrite(step, created.workflowId));
      try {
        await expect(
          authoring.transitionWorkflowLifecycle({
            actorId,
            command: 'archive',
            expectedLifecycleRevision: 1,
            idempotencyKey: `lifecycle-rollback-${step}`,
            workflowId: created.workflowId,
            workspaceId,
          }),
        ).rejects.toThrow(fault.message);
      } finally {
        await fault.remove();
      }
      expect(await lifecycleFacts(created.workflowId)).toEqual(before);
      await expect(
        authoring.transitionWorkflowLifecycle({
          actorId,
          command: 'archive',
          expectedLifecycleRevision: 1,
          idempotencyKey: `lifecycle-rollback-${step}`,
          workflowId: created.workflowId,
          workspaceId,
        }),
      ).resolves.toMatchObject({
        replayed: false,
        workflow: { lifecycleStatus: 'archived', lifecycleRevision: 2 },
      });
      expect(await lifecycleFacts(created.workflowId)).toMatchObject({
        lifecycleStatus: 'archived',
        lifecycleRevision: 2,
        idempotencyClaims: 1,
        reconciliationOutbox: 2,
        auditEvents: 1,
      });
    }
  });

  it('serializes publication and lifecycle commands on the workflow row', async () => {
    const archiveFirst = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'lifecycle-archive-first-create',
      name: 'Lifecycle archive first',
      workspaceId,
    });
    const archiveHold = await holdAtWrite(
      archiveWrite('workflow', archiveFirst.workflowId),
    );
    const archiveApplication = `laf-${randomUUID()}`;
    const archiveFirstCommand = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(apiUrl, archiveApplication),
        max: 1,
      }),
    );
    const archiveFirstPublisherApplication = `lafp-${randomUUID()}`;
    const archiveFirstPublisher = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          archiveFirstPublisherApplication,
        ),
        max: 1,
      }),
    );
    try {
      const archive = archiveFirstCommand.transitionWorkflowLifecycle({
        actorId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: 'lifecycle-archive-first-archive',
        workflowId: archiveFirst.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        archiveHold.reached(),
        archive,
        'archive-first lifecycle command',
      );
      const publish = archiveFirstPublisher.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          archiveFirst.workflowId,
          actorId,
        ),
        idempotencyKey: 'lifecycle-archive-first-publish',
        requestHash: 'a'.repeat(64),
        workflowId: archiveFirst.workflowId,
        workspaceId,
      });
      await waitForPostgresLock(archiveFirstPublisherApplication);
      await archiveHold.release();
      await expect(archive).resolves.toMatchObject({
        workflow: { lifecycleStatus: 'archived', publishedVersionId: null },
      });
      await expect(publish).rejects.toMatchObject({
        name: 'WorkflowNotFoundError',
      });
      expect(await lifecycleFacts(archiveFirst.workflowId)).toMatchObject({
        lifecycleStatus: 'archived',
        lifecycleRevision: 2,
        publishedVersionId: null,
        idempotencyClaims: 1,
        reconciliationOutbox: 0,
        auditEvents: 1,
      });
    } finally {
      await archiveHold.release();
      await Promise.all([
        archiveFirstCommand.close(),
        archiveFirstPublisher.close(),
      ]);
      await archiveHold.remove();
    }

    const publicationFirst = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'lifecycle-publication-first-create',
      name: 'Lifecycle publication first',
      workspaceId,
    });
    const publishHold = await holdAtWrite(
      publicationWrite('version', publicationFirst.workflowId),
    );
    const publicationFirstApplication = `lpf-${randomUUID()}`;
    const publicationFirstPublisher = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          publicationFirstApplication,
        ),
        max: 1,
      }),
    );
    const publicationFirstArchiveApplication = `lpfa-${randomUUID()}`;
    const publicationFirstArchive = createWorkflowAuthoringDatabase(
      parseDatabaseConfig({
        connectionString: withApplicationName(
          apiUrl,
          publicationFirstArchiveApplication,
        ),
        max: 1,
      }),
    );
    try {
      const publish = publicationFirstPublisher.publishWorkflow({
        actorId,
        representationTag: await currentRepresentationTag(
          authoring,
          workspaceId,
          publicationFirst.workflowId,
          actorId,
        ),
        idempotencyKey: 'lifecycle-publication-first-publish',
        requestHash: 'b'.repeat(64),
        workflowId: publicationFirst.workflowId,
        workspaceId,
      });
      await waitForOperationEntry(
        publishHold.reached(),
        publish,
        'publication-first command',
      );
      const archive = publicationFirstArchive.transitionWorkflowLifecycle({
        actorId,
        command: 'archive',
        expectedLifecycleRevision: 1,
        idempotencyKey: 'lifecycle-publication-first-archive',
        workflowId: publicationFirst.workflowId,
        workspaceId,
      });
      await waitForPostgresLock(publicationFirstArchiveApplication);
      await publishHold.release();
      const publication = await publish;
      expect(publication).toMatchObject({
        version: { workflowId: publicationFirst.workflowId },
      });
      const archived = await archive;
      expect(archived).toMatchObject({
        workflow: {
          lifecycleStatus: 'archived',
          lifecycleRevision: 2,
        },
      });
      expect(archived.workflow.publishedVersionId).toBe(publication.version.id);
      expect(await lifecycleFacts(publicationFirst.workflowId)).toMatchObject({
        lifecycleStatus: 'archived',
        lifecycleRevision: 2,
        idempotencyClaims: 1,
        reconciliationOutbox: 2,
        auditEvents: 1,
      });
    } finally {
      await publishHold.release();
      await Promise.all([
        publicationFirstPublisher.close(),
        publicationFirstArchive.close(),
      ]);
      await publishHold.remove();
    }
  });
});

async function lifecycleFacts(workflowId: string): Promise<LifecycleFacts> {
  const client = await apiPool.connect();
  let transactionOpen = false;
  let primaryError: unknown;
  let facts: LifecycleFacts | undefined;
  try {
    await client.query('begin');
    transactionOpen = true;
    await client.query("select set_config('app.workspace_id', $1, true)", [
      workspaceId,
    ]);
    const result = await client.query<{
      lifecycle_status: string;
      lifecycle_revision: number;
      activation_status: string;
      published_version_id: string | null;
      idempotency_claims: string;
      reconciliation_outbox: string;
      audit_events: string;
    }>(
      `select lifecycle_status,lifecycle_revision,activation_status,
          published_version_id,
          (select count(*) from app.idempotency_records
            where resource_id=$1 and operation='workflow.archive')::text idempotency_claims,
          (select count(*) from app.outbox_events
            where aggregate_id=$1 and job_name='reconcile-workflow-triggers')::text reconciliation_outbox,
          (select count(*) from app.audit_events
            where target_id=$1 and action in ('workflow.archived','workflow.restored'))::text audit_events
       from app.workflows where id=$1`,
      [workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('workflow facts missing');
    await client.query('commit');
    transactionOpen = false;
    facts = {
      lifecycleStatus: row.lifecycle_status,
      lifecycleRevision: row.lifecycle_revision,
      activationStatus: row.activation_status,
      publishedVersionId: row.published_version_id,
      idempotencyClaims: Number(row.idempotency_claims),
      reconciliationOutbox: Number(row.reconciliation_outbox),
      auditEvents: Number(row.audit_events),
    };
  } catch (error: unknown) {
    primaryError = error;
  }
  await finishTransactionClient(client, {
    label: 'Lifecycle facts query',
    primaryError,
    transactionOpen,
  });
  if (facts === undefined)
    throw new Error('Lifecycle facts query returned no facts');
  return facts;
}
