import type { WorkspaceVariablesCommandResponse } from '@pertexo/contracts';
import {
  appendAuditFact,
  claimCommand,
  completeCommand,
  lockVariableSet,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '@pertexo/database/schema';
import {
  EMPTY_VARIABLE_SNAPSHOT,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';

import {
  WorkspaceVariablesConflictError,
  type ReplaceWorkspaceVariablesInput,
} from './contract.js';
import { planWorkspaceVariableReplacement } from './replacement.js';

type AcceptedReplacement = Readonly<{ revision: number; changed: boolean }>;

/** A replacement that changes nothing keeps the revision and writes no audit. */
export async function replaceWorkspaceVariables(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
): Promise<WorkspaceVariablesCommandResponse> {
  const command = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
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
  if (replay !== null) return { ...replay, replayed: true };
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

/** With no head to lock yet, two first saves meet at the revision's primary key. */
async function saveVariableSet(
  client: PoolClient,
  input: ReplaceWorkspaceVariablesInput,
  set: Readonly<{
    revision: number;
    descriptions: Readonly<Record<string, string>>;
  }>,
): Promise<void> {
  const db = drizzle(client);
  const inserted = await db
    .insert(workspaceVariableSetRevisions)
    .values({
      workspaceId: input.workspaceId,
      revision: set.revision,
      values: input.values,
      descriptions: set.descriptions,
    })
    .onConflictDoNothing()
    .returning({ revision: workspaceVariableSetRevisions.revision })
    .catch(rethrowQueryFailure);
  if (inserted.length !== 1) throw new WorkspaceVariablesConflictError();
  const saved = await db
    .insert(workspaceVariables)
    .values({ workspaceId: input.workspaceId, revision: set.revision })
    .onConflictDoUpdate({
      target: workspaceVariables.workspaceId,
      set: { revision: set.revision, updatedAt: sql`clock_timestamp()` },
      setWhere: eq(workspaceVariables.revision, input.expectedRevision),
    })
    .returning({ revision: workspaceVariables.revision })
    .catch(rethrowQueryFailure);
  if (saved.length !== 1) throw new WorkspaceVariablesConflictError();
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
