import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflows } from '../../schema/authoring/workflows.js';
import { workflowIntegrationUsage as integrationUsage } from '../../schema/authoring/integrations.js';
import { auditEvents } from '../../schema/foundation.js';
import { outboxEvents } from '../../schema/transport.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { revokeRemovedFormAccess } from '../../triggers/forms/publication.repository.js';

import { generatePersistedId } from '../../platform/persisted-id.js';

import { workflowIntegrationUsage } from '@pertexo/workflow-model/server';

import type { PoolClient } from 'pg';

import { canonicalOutboxPayloadChecksum } from '../../outbox/events.repository.js';

import type { WorkflowVersionRecord } from '../workflows/representation/contract.js';

import {
  reconcileWorkflowTriggersPayload,
  persistPublishedWorkflowTriggers,
} from './trigger-reconciliation.repository.js';
import { persistPublicationCalls } from './calls.repository.js';

import {
  uuidSchema,
  providerKeySchema,
  operationKeySchema,
  type PublicationCandidateInput,
  type CompiledPublication,
} from './contract.js';

export async function persistPublicationProjections(
  client: PoolClient,
  input: PublicationCandidateInput,
  {
    workflowId,
    publication,
    version,
  }: Readonly<{
    workflowId: string;
    publication: CompiledPublication;
    version: WorkflowVersionRecord;
  }>,
): Promise<void> {
  await revokeRemovedFormAccess(
    client,
    input.workspaceId,
    workflowId,
    publication.graph,
  );
  const usage = workflowIntegrationUsage(
    version.graphJson,
    publication.definitionCatalog,
  ).map((item) => ({
    connectionId: uuidSchema.parse(item.connectionId),
    operationKey: operationKeySchema.parse(item.operationKey),
    providerKey: providerKeySchema.parse(item.providerKey),
  }));
  const db = drizzle(client);
  await db
    .delete(integrationUsage)
    .where(
      and(
        eq(integrationUsage.workspaceId, input.workspaceId),
        eq(integrationUsage.workflowVersionId, version.id),
      ),
    )
    .catch(rethrowQueryFailure);
  if (usage.length > 0)
    await db
      .insert(integrationUsage)
      .values(
        usage.map((item) => ({
          ...item,
          workspaceId: input.workspaceId,
          workflowVersionId: version.id,
        })),
      )
      .catch(rethrowQueryFailure);
  await persistPublicationCalls(
    client,
    input.workspaceId,
    version.id,
    publication.calls,
  );
  await persistPublishedWorkflowTriggers(client, {
    workspaceId: input.workspaceId,
    workflowId,
    version,
  });
}

export async function finalizePublication(
  client: PoolClient,
  input: PublicationCandidateInput,
  {
    workflowId,
    version,
    reused,
  }: Readonly<{
    workflowId: string;
    version: WorkflowVersionRecord;
    reused: boolean;
  }>,
): Promise<void> {
  const db = drizzle(client);
  await db
    .update(workflows)
    .set({
      publishedVersionId: version.id,
      activationStatus: 'activating',
      updatedAt: sql`transaction_timestamp()`,
    })
    .where(
      and(
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.id, workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  const eventId = generatePersistedId();
  const payload = reconcileWorkflowTriggersPayload({
    workspaceId: input.workspaceId,
    outboxEventId: eventId,
    workflowId,
    publishedVersionId: version.id,
    ...(input.traceparent === undefined
      ? {}
      : { traceparent: input.traceparent }),
  });
  await db
    .insert(outboxEvents)
    .values({
      id: eventId,
      workspaceId: input.workspaceId,
      jobName: 'reconcile-workflow-triggers',
      aggregateType: 'workflow',
      aggregateId: workflowId,
      payload,
      payloadChecksum: canonicalOutboxPayloadChecksum(payload),
    })
    .catch(rethrowQueryFailure);
  await db
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: 'workflow.published',
      targetType: 'workflow',
      targetId: workflowId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: {
        checksum: version.checksum,
        reused,
        versionId: version.id,
        versionNumber: version.versionNumber,
      },
    })
    .catch(rethrowQueryFailure);
}
