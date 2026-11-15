import { credentialCommandScope } from '@pertexo/database/platform';
import type { WorkspaceVariablesCommandResponse } from '@pertexo/contracts';
import { z } from 'zod';
import { requireReadableReceipt } from '../shared/receipts.js';
import { claimCommand, completeCommand } from '@pertexo/database/primitives';
import { appendAuditFact } from '../governance/audit/facts.js';
import { lockVariableSet } from './head.repository.js';
import {
  EMPTY_VARIABLE_SNAPSHOT,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';
import type { PoolClient } from 'pg';

import type { ReplaceWorkspaceVariablesInput } from './workspace-variables.types.js';
import { WorkspaceVariablesConflictError } from './workspace-variables.errors.js';
import { planWorkspaceVariableReplacement } from './replacement.js';
import { saveVariableSet } from './set.repository.js';

const acceptedReplacement = z
  .object({ revision: z.number().int().nonnegative(), changed: z.boolean() })
  .strict();
type AcceptedReplacement = z.output<typeof acceptedReplacement>;

/** A replacement that changes nothing keeps the revision and writes no audit. */
export async function replaceWorkspaceVariables(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
): Promise<WorkspaceVariablesCommandResponse> {
  const command = {
    workspaceId: input.workspaceId,
    scope: credentialCommandScope(input.actorId, input.commandCredentialId),
    operation: 'workspace.variables.replace',
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand<AcceptedReplacement>(client, {
    ...command,
    resourceId: input.workspaceId,
    request: {
      expectedRevision: input.expectedRevision,
      values: input.values,
      ...(input.descriptions === undefined
        ? {}
        : { descriptions: input.descriptions }),
    },
  });
  if (replay !== null) {
    requireReadableReceipt(acceptedReplacement, replay);
    return { ...replay, replayed: true };
  }
  const current = (await lockVariableSet(
    client,
    input.workspaceId,
    'update',
  )) ?? { ...EMPTY_VARIABLE_SNAPSHOT, descriptions: {} };
  if (current.revision !== input.expectedRevision)
    throw new WorkspaceVariablesConflictError();
  const { descriptions, changedNames } = planWorkspaceVariableReplacement(
    current,
    input,
  );
  const changed = changedNames.length > 0;
  const revision = changed ? current.revision + 1 : current.revision;
  if (changed) {
    await saveVariableSet(client, input, { revision, descriptions });
    await auditVariablesChanged(client, input, { revision, changedNames });
  }
  const accepted = { revision, changed };
  await completeCommand(client, command, accepted);
  return { ...accepted, replayed: false };
}

/** Names only, never values, and within the audit metadata budget. */
function auditVariablesChanged(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
  {
    revision,
    changedNames,
  }: Readonly<{ revision: number; changedNames: readonly string[] }>,
): Promise<void> {
  return appendAuditFact(client, {
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    action: 'workspace.variables_changed',
    targetType: 'workspace_variables',
    targetId: input.workspaceId,
    requestId: input.requestId ?? null,
    traceId: input.traceId ?? null,
    metadata: {
      revision,
      changedNames: changedNames.slice(0, WORKSPACE_VARIABLE_LIMITS.count),
      ...(changedNames.length > WORKSPACE_VARIABLE_LIMITS.count
        ? { changedCount: changedNames.length, changedNamesTruncated: true }
        : {}),
    },
  });
}
