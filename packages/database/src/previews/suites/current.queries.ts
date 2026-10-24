import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { workflowDrafts } from '../../schema/authoring/workflows.js';
import {
  workflowInputCases,
  workflowInputCasePayloads,
} from '../../schema/authoring/input-cases.js';
import { workflowStepSamples } from '../../schema/authoring/step-samples.js';
import { workspaceVariables } from '../../schema/variables.js';
import { rethrowQueryFailure } from '../../platform/query-errors.js';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkflowTestSuiteCurrent } from '@pertexo/contracts';
import { canonicalJson } from '@pertexo/workflow-model';
import type { SampleScope } from '../../authoring/step-samples/contract.js';
import { WorkflowTestError } from '../workflows/contract.js';
/** The same metadata signature prepares suites and labels publish freshness. */
export async function readSuiteCurrent(
  client: PoolClient,
  input: SampleScope,
  frozenVariableSetRevision?: number | null,
): Promise<WorkflowTestSuiteCurrent> {
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
  const revision = draft[0]?.revision;
  if (revision === undefined) throw new WorkflowTestError('not_found');
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
    .limit(51)
    .catch(rethrowQueryFailure);
  if (cases.length > 50) throw new WorkflowTestError('cases_changed');
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
  const variables =
    frozenVariableSetRevision === undefined
      ? await db
          .select({ revision: workspaceVariables.revision })
          .from(workspaceVariables)
          .where(eq(workspaceVariables.workspaceId, input.workspaceId))
          .catch(rethrowQueryFailure)
      : undefined;
  const variableSetRevision =
    frozenVariableSetRevision === undefined
      ? (variables?.[0]?.revision ?? null)
      : frozenVariableSetRevision;
  const identity = {
    draftRevision: revision,
    cases: cases.map(({ id, revision }) => ({ id, revision })),
    samples: pins.map((row) => ({
      nodeId: row.nodeId,
      sampleId: row.id,
    })),
    variableSetRevision,
  };
  return {
    ...identity,
    cases: cases,
    signature: createHash('sha256')
      .update(
        canonicalJson({
          ...identity,
          expiredSampleIds: pins
            .filter((pin) => pin.expired)
            .map((pin) => pin.id),
        }),
      )
      .digest('hex'),
  };
}

export function readSuiteCasePayloads(client: PoolClient, input: SampleScope) {
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
    .limit(50)
    .catch(rethrowQueryFailure);
}
