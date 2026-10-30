import { expect, it } from 'vitest';
import {
  actorId,
  apiPool,
  authoring,
  draftNode,
  emptyGraph,
  finishTransactionClient,
  otherActorId,
  otherVersionId,
  otherWorkflowId,
  otherWorkspaceId,
  randomUUID,
  saveCurrentDraft,
  workflowId,
  workspaceId,
} from '../../../support/workflow-authoring.js';
import { ZodError } from 'zod';

export function registerRejectsAbsentContextCrossTenant(): void {
  it('rejects absent-context and cross-tenant writes for every publication relation', async () => {
    const attempts: readonly (readonly [string, unknown[]])[] = [
      [
        `insert into app.workflow_versions
          (id, workspace_id, workflow_id, version_number,
           graph_json, checksum, executable_json, published_by)
         values ($1, $2, $3, 999, '{}'::jsonb, $4, '{}'::jsonb, $5)`,
        [
          randomUUID(),
          otherWorkspaceId,
          otherWorkflowId,
          `wf:sha256:${'1'.repeat(64)}`,
          otherActorId,
        ],
      ],
      [
        `insert into app.audit_events
          (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
         values ($1, $2, $3, 'workflow.published', 'workflow', $4, '{}'::jsonb)`,
        [randomUUID(), otherWorkspaceId, otherActorId, otherWorkflowId],
      ],
      [
        `insert into app.idempotency_records
          (id, workspace_id, operation, scope, key_hash, request_hash,
           status, resource_id, result_ref)
         values ($1, $2, 'workflow.publish', $3, $4, $5,
           'in_progress', $6, '{}'::jsonb)`,
        [
          randomUUID(),
          otherWorkspaceId,
          `${otherActorId}:${otherWorkflowId}`,
          '2'.repeat(64),
          '3'.repeat(64),
          otherWorkflowId,
        ],
      ],
      [
        `insert into app.outbox_events
          (id, workspace_id, job_name, aggregate_type,
           aggregate_id, payload, payload_checksum)
         values ($1, $2, 'reconcile-workflow-triggers', 'workflow',
           $3, '{}'::jsonb, $4)`,
        [randomUUID(), otherWorkspaceId, otherWorkflowId, '4'.repeat(64)],
      ],
    ];
    for (const [statement, parameters] of attempts) {
      const client = await apiPool.connect();
      let transactionOpen = false;
      let primaryError: unknown;
      try {
        await client.query('begin');
        transactionOpen = true;
        await client.query("select set_config('app.workspace_id', $1, true)", [
          workspaceId,
        ]);
        await expect(client.query(statement, parameters)).rejects.toMatchObject(
          { code: '42501' },
        );
        await client.query('rollback');
        transactionOpen = false;
      } catch (error: unknown) {
        primaryError = error;
      }
      await finishTransactionClient(client, {
        label: 'Cross-tenant publication relation proof',
        primaryError,
        transactionOpen,
      });
    }

    const absent = await apiPool.connect();
    try {
      await expect(
        absent.query(
          `insert into app.audit_events
            (id, workspace_id, actor_user_id, action, target_type, target_id, metadata)
           values ($1, $2, $3, 'workflow.published', 'workflow', $4, '{}'::jsonb)`,
          [randomUUID(), workspaceId, actorId, workflowId],
        ),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      absent.release();
    }
    expect(otherVersionId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('accepts the exact compact graph limit and rejects one byte over before insert', async () => {
    const graphEnvelope = {
      ...emptyGraph,
      nodes: [draftNode('large', { padding: '' })],
    };
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify(graphEnvelope),
      'utf8',
    );
    const exactGraph = {
      ...graphEnvelope,
      nodes: [
        draftNode('large', {
          padding: 'x'.repeat(1_048_576 - envelopeBytes),
        }),
      ],
    };
    const exactCreated = await authoring.createWorkflow({
      actorId,
      emptyGraph: exactGraph,
      idempotencyKey: 'create-exact-limit',
      name: 'Exact limit',
      workspaceId,
    });
    expect(exactCreated.workflowId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph: {
          ...exactGraph,
          nodes: [
            draftNode('large', {
              padding: `${String(exactGraph.nodes[0]?.config.padding)}x`,
            }),
          ],
        },
        idempotencyKey: 'create-over-limit',
        name: 'Over limit',
        workspaceId,
      }),
    ).rejects.toThrow('graph bytes exceed the graph limit');
  });

  it('uses the workflow-model contract at every draft persistence boundary', async () => {
    await expect(
      authoring.createWorkflow({
        actorId,
        emptyGraph: {},
        idempotencyKey: 'create-invalid-graph',
        name: 'Invalid graph',
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(
      saveCurrentDraft(authoring, {
        actorId,
        expectedRevision: 1,
        graphJson: { ...emptyGraph, unknown: true },
        workflowId,
        workspaceId,
      }),
    ).rejects.toBeInstanceOf(ZodError);

    const corrupted = await authoring.createWorkflow({
      actorId,
      emptyGraph,
      idempotencyKey: 'create-corrupt-read-proof',
      name: 'Corrupt read proof',
      workspaceId,
    });
    const api = await apiPool.connect();
    let transactionOpen = false;
    let primaryError: unknown;
    try {
      await api.query('begin');
      transactionOpen = true;
      await api.query("select set_config('app.workspace_id', $1, true)", [
        workspaceId,
      ]);
      await api.query(
        "update app.workflow_drafts set graph_json = '{}'::jsonb where workflow_id = $1",
        [corrupted.workflowId],
      );
      await api.query('commit');
      transactionOpen = false;
    } catch (error: unknown) {
      primaryError = error;
    }
    await finishTransactionClient(api, {
      label: 'Corrupt draft fixture update',
      primaryError,
      transactionOpen,
    });
    await expect(
      authoring.getDraft(workspaceId, corrupted.workflowId, actorId),
    ).rejects.toBeInstanceOf(ZodError);
  });
}
