import { describe, expect } from 'vitest';
import type { WorkflowLifecycleResponse } from '@pertexo/contracts';
import {
  closeWorkflowLifecycleApiFixture,
  createWorkflowLifecycleApiFixture,
  type WorkflowLifecycleApiFixture,
  type WorkflowHistory,
  workflowLifecycleIntegrationEnabled,
} from '../../lifecycle.support.js';

export const describeIntegration = workflowLifecycleIntegrationEnabled
  ? describe
  : describe.skip;

export type LifecycleResponse = WorkflowLifecycleResponse;

export function lifecyclePath(
  workspaceId: string,
  workflowId: string,
  command: 'archive' | 'restore',
): string {
  return `/v1/workspaces/${workspaceId}/workflows/${workflowId}/${command}`;
}

export function expectLifecycleResponse(
  response: Readonly<{
    statusCode: number;
    payload: string;
    json(): unknown;
  }>,
  expected: Readonly<{
    workspaceId: string;
    name: string;
    id: string;
    lifecycleStatus: 'active' | 'archived';
    lifecycleRevision: number;
    activationStatus: LifecycleResponse['workflow']['activationStatus'];
    webhookSetupRequired: boolean;
    publishedVersionId: string | null;
    replayed: boolean;
  }>,
): void {
  expect(response.statusCode, response.payload).toBe(202);
  const body = response.json() as LifecycleResponse;
  expect(Object.keys(body).sort()).toEqual(['replayed', 'workflow']);
  expect(Object.keys(body.workflow).sort()).toEqual([
    'activationStatus',
    'createdAt',
    'id',
    'lifecycleRevision',
    'lifecycleStatus',
    'name',
    'nameRevision',
    'publishedVersionId',
    'updatedAt',
    'webhookSetupRequired',
    'workspaceId',
  ]);
  expect(body.workflow.createdAt).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  );
  expect(body.workflow.updatedAt).toMatch(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
  );
  expect(body).toEqual({
    replayed: expected.replayed,
    workflow: {
      activationStatus: expected.activationStatus,
      webhookSetupRequired: expected.webhookSetupRequired,
      createdAt: body.workflow.createdAt,
      id: expected.id,
      lifecycleRevision: expected.lifecycleRevision,
      lifecycleStatus: expected.lifecycleStatus,
      name: expected.name,
      nameRevision: 1,
      publishedVersionId: expected.publishedVersionId,
      updatedAt: body.workflow.updatedAt,
      workspaceId: expected.workspaceId,
    },
  });
}

export async function expectHistoryUnchanged(
  fixture: WorkflowLifecycleApiFixture,
  workflowId: string,
  before: WorkflowHistory,
): Promise<void> {
  expect(await fixture.readHistory(workflowId)).toEqual(before);
}

export async function lifecycleFacts(
  fixture: WorkflowLifecycleApiFixture,
  workflowId: string,
): Promise<Readonly<{ audit: number; reconciliationOutbox: number }>> {
  return fixture.withOwner(async (client) => {
    const result = await client.query<{
      audit: string;
      reconciliation_outbox: string;
    }>(
      `select
         (select count(*)::text from app.audit_events
           where workspace_id=$1 and target_type='workflow' and target_id=$2
             and action in ('workflow.archived','workflow.restored')) as audit,
         (select count(*)::text from app.outbox_events
           where workspace_id=$1 and aggregate_id=$2
             and job_name='reconcile-workflow-triggers') as reconciliation_outbox`,
      [fixture.workspaceId, workflowId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('workflow lifecycle facts missing');
    return {
      audit: Number(row.audit),
      reconciliationOutbox: Number(row.reconciliation_outbox),
    };
  });
}

export let fixture: WorkflowLifecycleApiFixture;

export async function resetAuthenticatedWorkflowLifecycleHTTPCommandsFixture() {
  fixture = await createWorkflowLifecycleApiFixture();
}

export async function cleanAuthenticatedWorkflowLifecycleHTTPCommandsFixture() {
  await closeWorkflowLifecycleApiFixture(fixture);
}
