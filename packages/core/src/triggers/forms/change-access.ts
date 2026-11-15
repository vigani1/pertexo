import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../../governance/audit/facts.js';
import type { PoolClient } from 'pg';
import type { FormAccess } from '@pertexo/contracts';
import { FormAccessConflictError } from './form.errors.js';
import type { SetFormAccessInput } from './form-admission.types.js';
import {
  capabilityHash,
  readFormAccess,
  upsertFormAccess,
} from './access.repository.js';

export async function changeFormAccess(
  client: PoolClient,
  input: SetFormAccessInput,
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
  const changed = await upsertFormAccess(client, input, nodeId, digest);
  await appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'form.access_changed',
    targetType: 'workflow',
    targetId: input.workflowId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: { access: changed.access, revision: changed.revision },
  });
  await completeCommand(client, command, changed);
  return changed;
}
