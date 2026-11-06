import { expiredRunSql, retainedTestRunSql } from '../../runs/data-policy.js';
import { and, eq, exists, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import {
  artifactOwnerReferences,
  type ArtifactOwnerFamily,
  workflowTestSnapshots,
  workflowTestSuiteCases,
  workflowTestSuites,
  workflowDrafts,
  workflowVersions,
  workflowInputCases,
  workflowInputCasePayloads,
  workflowStepSamples,
  previewRuns,
  workflowRuns,
  nodeRuns,
  nodeAttempts,
  runEvents,
  runCheckpoints,
  pendingRunTasks,
} from '@pertexo/database/schema';
const reference = alias(artifactOwnerReferences, 'artifact_reference');
const snapshot = alias(workflowTestSnapshots, 'snapshot');
const entry = alias(workflowTestSuiteCases, 'entry');
const suite = alias(workflowTestSuites, 'suite');
const draft = alias(workflowDrafts, 'draft');
const version = alias(workflowVersions, 'version');
const payload = alias(workflowInputCasePayloads, 'payload');
const inputCase = alias(workflowInputCases, 'input_case');
const sample = alias(workflowStepSamples, 'sample');
const preview = alias(previewRuns, 'preview');
const run = alias(workflowRuns, 'run');
const node = alias(nodeRuns, 'node');
const attempt = alias(nodeAttempts, 'attempt');
const event = alias(runEvents, 'event');
const checkpoint = alias(runCheckpoints, 'checkpoint');
const task = alias(pendingRunTasks, 'task');
const db = new QueryBuilder();
type ReferenceOwner = Readonly<{
  build(where: SQL | undefined): SQLWrapper;
  workspace: SQLWrapper;
  workflow: SQLWrapper;
  retained?: SQL;
  accessibleWhen?: SQL;
  identity: SQL;
}>;
const liveRunValues = sql`${run.detailsPurgedAt} is null and ${retainedTestRunSql('run', 'clock_timestamp()')} and not (${expiredRunSql('run', 'details')})`;
/** Retention and access share existing reference facts, including sharing through a readable owner. */
const OWNERS: Record<ArtifactOwnerFamily, ReferenceOwner> = {
  workflow_test_snapshots: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(snapshot)
        .where(where),
    workspace: snapshot.workspaceId,
    workflow: snapshot.workflowId,
    retained: sql`${snapshot.expiresAt}>clock_timestamp()`,
    identity: sql`${snapshot.id}=${reference.ownerId}`,
  },
  workflow_test_suite_cases: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(entry)
        .innerJoin(
          suite,
          and(
            eq(suite.workspaceId, entry.workspaceId),
            eq(suite.id, entry.suiteId),
          ),
        )
        .where(where),
    workspace: entry.workspaceId,
    workflow: suite.workflowId,
    retained: sql`${suite.expiresAt}>clock_timestamp()`,
    identity: sql`${entry.suiteId}=${reference.ownerId} and ${entry.ordinal}=${reference.ownerSubId}`,
  },
  workflow_drafts: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(draft)
        .where(where),
    workspace: draft.workspaceId,
    workflow: draft.workflowId,
    identity: sql`${draft.workflowId}=${reference.ownerId}`,
  },
  workflow_versions: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(version)
        .where(where),
    workspace: version.workspaceId,
    workflow: version.workflowId,
    identity: sql`${version.id}=${reference.ownerId}`,
  },
  workflow_input_case_payloads: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(payload)
        .innerJoin(
          inputCase,
          and(
            eq(inputCase.workspaceId, payload.workspaceId),
            eq(inputCase.id, payload.caseId),
          ),
        )
        .where(where),
    workspace: payload.workspaceId,
    workflow: inputCase.workflowId,
    accessibleWhen: sql`${inputCase.deletedAt} is null and ${inputCase.revision}=${payload.revision}`,
    identity: sql`${payload.caseId}=${reference.ownerId} and ${payload.revision}=${reference.ownerSubId}`,
  },
  workflow_step_samples: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(sample)
        .where(where),
    workspace: sample.workspaceId,
    workflow: sample.workflowId,
    retained: sql`${sample.expiresAt}>clock_timestamp()`,
    identity: sql`${sample.id}=${reference.ownerId}`,
  },
  preview_runs: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(preview)
        .where(where),
    workspace: preview.workspaceId,
    workflow: preview.workflowId,
    retained: sql`${preview.expiresAt}>clock_timestamp()`,
    identity: sql`${preview.id}=${reference.ownerId}`,
  },
  workflow_runs: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(run)
        .where(where),
    workspace: run.workspaceId,
    workflow: run.workflowId,
    accessibleWhen: sql`((${reference.ownerSlot}='input_ref' and ${run.inputRefExpiresAt}>clock_timestamp()) or (${reference.ownerSlot}='output_ref' and ${liveRunValues}))`,
    identity: sql`${run.id}=${reference.ownerId}`,
  },
  node_runs: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(node)
        .innerJoin(
          run,
          and(
            eq(run.workspaceId, node.workspaceId),
            eq(run.id, node.workflowRunId),
          ),
        )
        .where(where),
    workspace: node.workspaceId,
    workflow: run.workflowId,
    accessibleWhen: liveRunValues,
    identity: sql`${node.id}=${reference.ownerId}`,
  },
  node_attempts: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(attempt)
        .innerJoin(
          node,
          and(
            eq(node.workspaceId, attempt.workspaceId),
            eq(node.id, attempt.nodeRunId),
          ),
        )
        .innerJoin(
          run,
          and(
            eq(run.workspaceId, node.workspaceId),
            eq(run.id, node.workflowRunId),
          ),
        )
        .where(where),
    workspace: attempt.workspaceId,
    workflow: run.workflowId,
    accessibleWhen: liveRunValues,
    identity: sql`${attempt.id}=${reference.ownerId}`,
  },
  run_events: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(event)
        .innerJoin(
          run,
          and(
            eq(run.workspaceId, event.workspaceId),
            eq(run.id, event.workflowRunId),
          ),
        )
        .where(where),
    workspace: event.workspaceId,
    workflow: run.workflowId,
    accessibleWhen: liveRunValues,
    identity: sql`${event.workflowRunId}=${reference.ownerId} and ${event.sequence}=${reference.ownerSubId}`,
  },
  run_checkpoints: {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(checkpoint)
        .innerJoin(
          run,
          and(
            eq(run.workspaceId, checkpoint.workspaceId),
            eq(run.id, checkpoint.workflowRunId),
          ),
        )
        .where(where),
    workspace: checkpoint.workspaceId,
    workflow: run.workflowId,
    accessibleWhen: liveRunValues,
    identity: sql`${checkpoint.workflowRunId}=${reference.ownerId}`,
  },
  pending_run_tasks: {
    // A response's files are its own until the resumed step outputs them.
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(task)
        .innerJoin(
          run,
          and(eq(run.workspaceId, task.workspaceId), eq(run.id, task.runId)),
        )
        .where(where),
    workspace: task.workspaceId,
    workflow: run.workflowId,
    accessibleWhen: liveRunValues,
    identity: sql`${task.id}=${reference.ownerId}`,
  },
};
/** Probe derived facts first, then apply current owner visibility and lifetime policy. */
export function artifactReferenceOwnersSql(
  workspace: SQL,
  artifact: SQL,
  visible?: (workflow: SQL) => SQL,
): SQL<boolean> {
  const owners = Object.entries(OWNERS).map(([family, owner]) =>
    and(
      eq(reference.ownerFamily, family),
      exists(
        owner.build(
          and(
            sql`${owner.workspace}=${reference.workspaceId}`,
            owner.identity,
            owner.retained,
            visible === undefined ? undefined : owner.accessibleWhen,
            visible === undefined ? undefined : visible(sql`${owner.workflow}`),
          ),
        ),
      ),
    ),
  );
  return sql<boolean>`${exists(
    db
      .select({ one: sql`1` })
      .from(reference)
      .where(
        and(
          sql`${reference.workspaceId}=${workspace}::uuid`,
          sql`${reference.artifactId}=${artifact}::uuid`,
          sql`(${sql.join(owners, sql` or `)})`,
        ),
      ),
  )}`;
}
