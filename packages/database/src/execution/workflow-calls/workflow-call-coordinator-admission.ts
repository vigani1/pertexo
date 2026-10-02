import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { WORKFLOW_CALL_FAMILY_POLICY_V1 } from '@pertexo/workflow-model/workflow-call-contract';

import {
  expectedSetJson,
  parseCompatibilityReleaseExpectationSet,
  type CompatibilityReleaseExpectationSet,
} from '../../compatibility/compatibility-release.js';
import type { WorkspaceTransaction } from '../../tenant-access/workspace.js';
import {
  acceptWorkflowCallRunInputSchema,
  type AcceptWorkflowCallRunInput,
} from '../runs/workflow-call-acceptance.js';
import {
  workflowCallAdmissionContextSchema,
  type WorkflowCallAdmissionContext,
} from './workflow-call-admission.js';
import {
  acceptWorkflowCallCandidate,
  type WorkflowCallCandidateOutcome,
} from './workflow-call-candidate.js';

const parentContextSchema = workflowCallAdmissionContextSchema.omit({
  invocationKey: true,
});
type ParentContext = Readonly<z.input<typeof parentContextSchema>>;
type RecordedOutcome = Readonly<{
  invocationKey: string;
  outcome: WorkflowCallCandidateOutcome;
}>;

async function recordOutcome(
  transaction: WorkspaceTransaction,
  context: WorkflowCallAdmissionContext,
  outcome: WorkflowCallCandidateOutcome,
): Promise<void> {
  const journal =
    outcome.kind === 'accepted'
      ? {
          kind: 'admitted',
          childRunId: outcome.accepted.runId,
          outboxEventId: outcome.accepted.outboxEventId,
        }
      : outcome.kind === 'refused'
        ? { kind: 'refused', reasonCode: outcome.reasonCode }
        : { kind: 'aborted', reason: outcome.reason };
  await transaction.db.execute(sql`
    select app.record_workflow_call_outcome(
      ${context.parentRunId}::uuid,${context.expectedParentRevision}::integer,
      ${context.invocationKey},${JSON.stringify(journal)}::jsonb
    )
  `);
}

/**
 * Private coordinator admission pass on its existing tenant-scoped transaction.
 * All prerequisite/lineage locks precede every sequential candidate savepoint.
 * Record each definite outcome only AFTER its savepoint has been released.
 * Unexpected errors escape unchanged: the outer owner must roll back/reload.
 * This does not commit or seal the parent; its existing CAS/receipt owner must
 * persist the checkpoint and continuation, then invoke the post-CAS seal below.
 */
export async function admitWorkflowCallDeclarations(
  transaction: WorkspaceTransaction,
  input: ParentContext &
    Readonly<{
      compatibilityReleases: CompatibilityReleaseExpectationSet;
      candidates: readonly AcceptWorkflowCallRunInput[];
    }>,
): Promise<readonly RecordedOutcome[]> {
  const parent = parentContextSchema.parse({
    parentRunId: input.parentRunId,
    expectedParentRevision: input.expectedParentRevision,
  });
  const candidates = z
    .array(acceptWorkflowCallRunInputSchema)
    .max(WORKFLOW_CALL_FAMILY_POLICY_V1.maxChildRuns)
    .parse(input.candidates);
  const releases = parseCompatibilityReleaseExpectationSet(
    input.compatibilityReleases,
  );
  const keys = new Set<string>();
  for (const { call } of candidates) {
    if (
      call.parentRunId !== parent.parentRunId ||
      call.expectedParentRevision !== parent.expectedParentRevision ||
      keys.has(call.invocationKey)
    )
      throw new TypeError('Workflow Call admission pass context is invalid');
    keys.add(call.invocationKey);
  }
  if (candidates.length === 0) return Object.freeze([]);
  await transaction.db.execute(sql`
    select app.prelock_workflow_call_parent(
      ${parent.parentRunId}::uuid,${parent.expectedParentRevision}::integer,
      ${expectedSetJson(releases)}::jsonb
    )
  `);
  const results: RecordedOutcome[] = [];
  for (const candidate of candidates) {
    const outcome = await acceptWorkflowCallCandidate(transaction, candidate);
    await recordOutcome(transaction, candidate.call, outcome);
    results.push(
      Object.freeze({
        invocationKey: candidate.call.invocationKey,
        outcome,
      }),
    );
  }
  return Object.freeze(results);
}

/** SQL authenticates actual post-CAS state; these identifiers are not authority. */
export async function sealWorkflowCallAdmissionPass(
  transaction: WorkspaceTransaction,
  input: ParentContext & Readonly<{ continuationOutboxEventId?: string }>,
): Promise<void> {
  const parent = parentContextSchema.parse({
    parentRunId: input.parentRunId,
    expectedParentRevision: input.expectedParentRevision,
  });
  const continuation = z
    .uuid()
    .optional()
    .parse(input.continuationOutboxEventId);
  await transaction.db.execute(sql`
    select app.seal_workflow_call_parent(
      ${parent.parentRunId}::uuid,${parent.expectedParentRevision}::integer,
      ${continuation ?? null}::uuid
    )
  `);
}
