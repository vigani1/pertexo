import { ARTIFACT_DESCRIPTOR_JSON_PATH } from './descriptor-shape.js';
import { expiredRunSql, retainedTestRunSql } from '../../runs/data-policy.js';
import { and, eq, exists, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { alias, QueryBuilder } from 'drizzle-orm/pg-core';
import {
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
type OwnerValue =
  | Readonly<{ kind: 'authored'; value: SQL }>
  | Readonly<{
      kind: 'execution';
      value: SQL;
      format: 'value' | 'event' | 'checkpoint';
    }>;
type ReferenceOwner = Readonly<{
  build(where: SQL | undefined): SQLWrapper;
  workspace: SQLWrapper;
  workflow: SQLWrapper;
  retained?: SQL;
  accessibleWhen?: SQL;
  accessibleValues?: readonly OwnerValue[];
  values: readonly OwnerValue[];
}>;
const liveRunValues = sql`${run.detailsPurgedAt} is null and ${retainedTestRunSql('run', 'clock_timestamp()')} and not (${expiredRunSql('run', 'details')})`;
/** Retention and access share existing reference facts, including sharing through a readable owner. */
const OWNERS: readonly ReferenceOwner[] = [
  {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(snapshot)
        .where(where),
    workspace: snapshot.workspaceId,
    workflow: snapshot.workflowId,
    retained: sql`${snapshot.expiresAt}>clock_timestamp()`,
    values: [{ kind: 'authored', value: sql`${snapshot.graphJson}::jsonb` }],
  },
  {
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
    values: [{ kind: 'authored', value: sql`${entry.input}::jsonb` }],
  },
  {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(draft)
        .where(where),
    workspace: draft.workspaceId,
    workflow: draft.workflowId,
    values: [{ kind: 'authored', value: sql`${draft.graphJson}::jsonb` }],
  },
  {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(version)
        .where(where),
    workspace: version.workspaceId,
    workflow: version.workflowId,
    values: [{ kind: 'authored', value: sql`${version.graphJson}::jsonb` }],
  },
  {
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
    values: [{ kind: 'authored', value: sql`${payload.input}::jsonb` }],
  },
  {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(sample)
        .where(where),
    workspace: sample.workspaceId,
    workflow: sample.workflowId,
    retained: sql`${sample.expiresAt}>clock_timestamp()`,
    values: [executionReferences(sql`${sample.outputRef}::jsonb`)],
  },
  {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(preview)
        .where(where),
    workspace: preview.workspaceId,
    workflow: preview.workflowId,
    retained: sql`${preview.expiresAt}>clock_timestamp()`,
    values: [
      executionReferences(sql`${preview.inputRef}::jsonb`),
      { kind: 'authored', value: sql`${preview.executableNodeJson}::jsonb` },
      executionReferences(sql`${preview.outputRef}::jsonb`),
    ],
  },
  {
    build: (where) =>
      db
        .select({ one: sql`1` })
        .from(run)
        .where(where),
    workspace: run.workspaceId,
    workflow: run.workflowId,
    accessibleValues: [
      executionReferences(
        sql`case when ${run.inputRefExpiresAt}>clock_timestamp() then ${run.inputRef}::jsonb end`,
      ),
      executionReferences(
        sql`case when ${liveRunValues} then ${run.outputRef}::jsonb end`,
      ),
    ],
    values: [
      executionReferences(sql`${run.inputRef}::jsonb`),
      executionReferences(sql`${run.outputRef}::jsonb`),
    ],
  },
  {
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
    values: [
      executionReferences(sql`${node.inputRef}::jsonb`),
      executionReferences(sql`${node.outputRef}::jsonb`),
    ],
  },
  {
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
    values: [
      executionReferences(sql`${attempt.outputRef}::jsonb`),
      executionReferences(sql`${attempt.reconciliationRef}`),
    ],
  },
  {
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
    values: [executionReferences(sql`${event.payload}`, 'event')],
  },
  {
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
    values: [
      executionReferences(sql`${checkpoint.schedulerState}`, 'checkpoint'),
    ],
  },
  {
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
    values: [executionReferences(sql`${task.outputRef}::jsonb`)],
  },
];
function referencesArtifact(source: OwnerValue, artifact: SQL): SQL {
  if (source.kind === 'execution')
    return exists(
      db
        .select({ one: sql`1` })
        .from(
          sql`app.execution_artifact_ids(${source.value},${source.format}) reference`,
        )
        .where(sql`reference=${artifact}::uuid`),
    );
  return exists(
    db
      .select({ one: sql`1` })
      .from(
        sql`jsonb_path_query(${source.value},${ARTIFACT_DESCRIPTOR_JSON_PATH}::jsonpath) reference`,
      )
      .where(sql`lower(reference #>> '{}')=${artifact}::uuid::text`),
  );
}
/** SQL filters existing reference facts using an already-decided resource scope. */
export function artifactReferenceOwnersSql(
  workspace: SQL,
  artifact: SQL,
  visible?: (workflow: SQL) => SQL,
): SQL<boolean> {
  const owners = OWNERS.map((owner) => {
    const values =
      visible !== undefined && owner.accessibleValues !== undefined
        ? owner.accessibleValues
        : owner.values;
    return exists(
      owner.build(
        and(
          sql`${owner.workspace}=${workspace}::uuid`,
          owner.retained,
          visible === undefined ? undefined : owner.accessibleWhen,
          sql`(${sql.join(
            values.map((value) => referencesArtifact(value, artifact)),
            sql` or `,
          )})`,
          visible === undefined ? undefined : visible(sql`${owner.workflow}`),
        ),
      ),
    );
  });
  return sql`(${sql.join(owners, sql` or `)})`;
}

function executionReferences(
  value: SQL,
  format: 'value' | 'event' | 'checkpoint' = 'value',
): OwnerValue {
  return { kind: 'execution', value, format };
}
