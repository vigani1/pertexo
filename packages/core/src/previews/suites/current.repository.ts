import type { WorkflowActor } from '../../shared/workflow-actor.types.js';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  workflowDrafts,
  workflowInputCases,
  workflowInputCasePayloads,
  workflowStepSamples,
  workspaceVariables,
} from '@pertexo/database/schema';
import { rethrowQueryFailure } from '@pertexo/database/primitives';
import type { PoolClient } from 'pg';
import { WORKFLOW_TEST_SUITE_MAX_CASES } from '@pertexo/workflow-model';

export async function readDraftRevision(
  client: PoolClient,
  input: WorkflowActor,
): Promise<number | undefined> {
  const db = drizzle(client);
  const draft = await db
    .select({ revision: workflowDrafts.revision })
    .from(workflowDrafts)
    .where(
      and(
        eq(workflowDrafts.workspaceId, input.workspaceId),
        eq(workflowDrafts.workflowId, input.workflowId),
      ),
    )
    .catch(rethrowQueryFailure);
  return draft[0]?.revision;
}

/** The live cases in order, one past the suite cap so an added case shows. */
export async function readSuiteCases(client: PoolClient, input: WorkflowActor) {
  const db = drizzle(client);
  const cases = await db
    .select({
      id: workflowInputCases.id,
      revision: workflowInputCases.revision,
      name: workflowInputCases.name,
    })
    .from(workflowInputCases)
    .where(
      and(
        eq(workflowInputCases.workspaceId, input.workspaceId),
        eq(workflowInputCases.workflowId, input.workflowId),
        isNull(workflowInputCases.deletedAt),
      ),
    )
    .orderBy(asc(workflowInputCases.createdAt), asc(workflowInputCases.id))
    // No more cases can be added, so reading one more proves a change.
    .limit(WORKFLOW_TEST_SUITE_MAX_CASES + 1)
    .catch(rethrowQueryFailure);
  return cases;
}

export async function readSuitePins(client: PoolClient, input: WorkflowActor) {
  const db = drizzle(client);
  const pins = await db
    .select({
      nodeId: workflowStepSamples.nodeId,
      id: workflowStepSamples.id,
      expired: sql<boolean>`${workflowStepSamples.expiresAt}<=clock_timestamp()`,
    })
    .from(workflowStepSamples)
    .where(
      and(
        eq(workflowStepSamples.workspaceId, input.workspaceId),
        eq(workflowStepSamples.workflowId, input.workflowId),
      ),
    )
    .orderBy(asc(workflowStepSamples.nodeId))
    .catch(rethrowQueryFailure);
  return pins;
}

export async function readVariablesRevision(
  client: PoolClient,
  workspaceId: string,
): Promise<number | null> {
  const variables = await drizzle(client)
    .select({ revision: workspaceVariables.revision })
    .from(workspaceVariables)
    .where(eq(workspaceVariables.workspaceId, workspaceId))
    .catch(rethrowQueryFailure);
  return variables[0]?.revision ?? null;
}

export function readSuiteCasePayloads(
  client: PoolClient,
  input: WorkflowActor,
) {
  return drizzle(client)
    .select({
      id: workflowInputCases.id,
      revision: workflowInputCases.revision,
      name: workflowInputCases.name,
      input: workflowInputCasePayloads.input,
      expectations: workflowInputCasePayloads.expectations,
    })
    .from(workflowInputCases)
    .innerJoin(
      workflowInputCasePayloads,
      and(
        eq(
          workflowInputCasePayloads.workspaceId,
          workflowInputCases.workspaceId,
        ),
        eq(workflowInputCasePayloads.caseId, workflowInputCases.id),
        eq(workflowInputCasePayloads.revision, workflowInputCases.revision),
      ),
    )
    .where(
      and(
        eq(workflowInputCases.workspaceId, input.workspaceId),
        eq(workflowInputCases.workflowId, input.workflowId),
        isNull(workflowInputCases.deletedAt),
      ),
    )
    .orderBy(asc(workflowInputCases.createdAt), asc(workflowInputCases.id))
    .limit(WORKFLOW_TEST_SUITE_MAX_CASES)
    .catch(rethrowQueryFailure);
}
