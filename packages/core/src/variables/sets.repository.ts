import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  appendAuditFact,
  claimCommand,
  completeCommand,
  rethrowQueryFailure,
} from '@pertexo/database/primitives';
import {
  workspaceVariables,
  workspaceVariableSetRevisions,
} from '@pertexo/database/schema';
import {
  canonicalJson,
  WORKSPACE_VARIABLE_LIMITS,
} from '@pertexo/workflow-model';

import { planWorkspaceVariableReplacement } from './replacement.js';
import {
  WorkspaceVariablesConflictError,
  type WorkspaceVariablesStore,
} from './contract.js';
const result = z
  .object({ revision: z.number().int().nonnegative(), changed: z.boolean() })
  .strict();
export async function replaceWorkspaceVariables(
  client: PoolClient,
  input: Parameters<WorkspaceVariablesStore['replace']>[0],
) {
  const db = drizzle(client);
  const identity = {
    workspaceId: input.workspaceId,
    scope: input.actorId,
    operation: 'workspace.variables.replace',
    idempotencyKey: input.idempotencyKey,
  };
  const replay = await claimCommand(client, {
    ...identity,
    resourceId: input.workspaceId,
    requestHash: createHash('sha256')
      .update(
        canonicalJson({
          expectedRevision: input.expectedRevision,
          values: input.values,
          ...(input.descriptions === undefined
            ? {}
            : { descriptions: input.descriptions }),
        }),
      )
      .digest('hex'),
  });
  if (replay !== null) return { ...result.parse(replay), replayed: true };
  const current = await readCurrentVariableRevision(client, input.workspaceId);
  if (current.revision !== input.expectedRevision)
    throw new WorkspaceVariablesConflictError();
  const { descriptions, changedNames: names } =
    planWorkspaceVariableReplacement(current, input);
  let revision = current.revision;
  if (names.length > 0) {
    revision = current.revision + 1;
    const inserted = await db
      .insert(workspaceVariableSetRevisions)
      .values({
        workspaceId: input.workspaceId,
        revision,
        values: input.values,
        descriptions,
      })
      .onConflictDoNothing()
      .returning({ revision: workspaceVariableSetRevisions.revision })
      .catch(rethrowQueryFailure);
    if (inserted.length !== 1) throw new WorkspaceVariablesConflictError();
    const saved = await db
      .insert(workspaceVariables)
      .values({ workspaceId: input.workspaceId, revision })
      .onConflictDoUpdate({
        target: workspaceVariables.workspaceId,
        set: { revision, updatedAt: sql`clock_timestamp()` },
        setWhere: eq(workspaceVariables.revision, input.expectedRevision),
      })
      .returning({ revision: workspaceVariables.revision })
      .catch(rethrowQueryFailure);
    if (saved.length !== 1) throw new WorkspaceVariablesConflictError();
    await appendAuditFact(client, {
      workspaceId: input.workspaceId,
      actorId: input.actorId,
      action: 'workspace.variables_changed',
      targetType: 'workspace_variables',
      targetId: input.workspaceId,
      requestId: input.requestId ?? null,
      traceId: input.traceId ?? null,
      metadata: {
        revision,
        changedNames: names.slice(0, WORKSPACE_VARIABLE_LIMITS.count),
        ...(names.length > WORKSPACE_VARIABLE_LIMITS.count
          ? { changedCount: names.length, changedNamesTruncated: true }
          : {}),
      },
    });
  }
  const accepted = { revision, changed: names.length > 0 };
  await completeCommand(client, identity, accepted);
  return { ...accepted, replayed: false };
}

async function readCurrentVariableRevision(
  client: PoolClient,
  workspaceId: string,
) {
  const db = drizzle(client);
  const [head] = await db
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, workspaceId))
    .for('update')
    .catch(rethrowQueryFailure);
  const stored =
    head === undefined
      ? undefined
      : (
          await db
            .select({
              values: workspaceVariableSetRevisions.values,
              descriptions: workspaceVariableSetRevisions.descriptions,
            })
            .from(workspaceVariableSetRevisions)
            .where(
              and(
                eq(workspaceVariableSetRevisions.workspaceId, workspaceId),
                eq(workspaceVariableSetRevisions.revision, head.revision),
              ),
            )
            .catch(rethrowQueryFailure)
        )[0];
  if (head !== undefined && stored === undefined)
    throw new Error('Workspace variable revision is missing');
  return {
    revision: head?.revision ?? 0,
    values: stored?.values ?? {},
    descriptions: stored?.descriptions ?? {},
  };
}
