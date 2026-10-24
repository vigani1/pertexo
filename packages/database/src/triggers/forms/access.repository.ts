import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowForms } from '../../schema/triggers/forms.js';
import { auditEvents } from '../../schema/foundation.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { FormAccess } from '@pertexo/contracts';
import {
  claimCommand,
  completeCommand,
} from '../../platform/idempotency/repository.js';
import { generatePersistedId } from '../../platform/persisted-id.js';
import { FormAccessConflictError } from './errors.js';
import type { FormStore } from './contract.js';
export const capabilityHash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const accessSelection = {
  access: workflowForms.access,
  publicId: workflowForms.publicId,
  revision: workflowForms.revision,
};
export async function readFormAccess(
  client: PoolClient,
  input: Readonly<{ workspaceId: string; workflowId: string }>,
): Promise<FormAccess> {
  const rows = await drizzle(client)
    .select(accessSelection)
    .from(workflowForms)
    .where(
      and(
        eq(workflowForms.workspaceId, input.workspaceId),
        eq(workflowForms.workflowId, input.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return rows[0] ?? { access: 'members', publicId: null, revision: 0 };
}
export async function changeFormAccess(
  client: PoolClient,
  input: Parameters<FormStore['setAccess']>[0],
  nodeId: string,
): Promise<FormAccess> {
  const command = {
    workspaceId: input.workspaceId,
    operation: 'form.access',
    scope: `${input.actorId}:${input.workflowId}`,
    idempotencyKey: input.idempotencyKey,
  };
  const digest =
    input.access === 'public' ? capabilityHash(input.capability) : null;
  const replay = await claimCommand<FormAccess>(client, {
    ...command,
    request: {
      access: input.access,
      expectedRevision: input.expectedRevision,
      capabilityHash: digest,
    },
    resourceId: input.workflowId,
  });
  if (replay !== null) return replay;
  const current = await readFormAccess(client, input);
  if (current.revision !== input.expectedRevision)
    throw new FormAccessConflictError();
  const db = drizzle(client);
  const result = await db
    .insert(workflowForms)
    .values({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      publicId: generatePersistedId(),
      access: input.access,
      capabilityHash: digest,
      revision: 1,
      nodeId,
    })
    .onConflictDoUpdate({
      target: [workflowForms.workspaceId, workflowForms.workflowId],
      set: {
        access: input.access,
        capabilityHash: digest,
        nodeId,
        revision: sql`${workflowForms.revision}+1`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning(accessSelection)
    .catch(rethrowQueryFailure);
  const changed = result[0];
  if (changed === undefined) throw new Error('Form access write missing');
  await db
    .insert(auditEvents)
    .values({
      id: generatePersistedId(),
      workspaceId: input.workspaceId,
      actorUserId: input.actorId,
      action: 'form.access_changed',
      targetType: 'workflow',
      targetId: input.workflowId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: { access: changed.access, revision: changed.revision },
    })
    .catch(rethrowQueryFailure);
  await completeCommand(client, command, changed);
  return changed;
}
