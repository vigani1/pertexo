import { expiredRunSql, retainedTestRunSql } from '../../runs/data-policy.js';
import { sql, type SQL } from 'drizzle-orm';
type ReferenceOwner = Readonly<{
  from: string;
  alias: string;
  workflow: string;
  retained?: string;
  accessibleWhen?: string;
  accessibleValues?: readonly string[];
  values: readonly string[];
}>;

const LIVE_RUN_VALUES = `run.details_purged_at is null and ${retainedTestRunSql('run', 'clock_timestamp()')} and not (${expiredRunSql('run', 'details')})`;

/** Retention and access use the same existing reference facts, including deliberate sharing through a readable owner. */
const OWNERS: readonly ReferenceOwner[] = [
  {
    from: 'app.workflow_test_snapshots snapshot',
    alias: 'snapshot',
    workflow: 'snapshot.workflow_id',
    retained: 'snapshot.expires_at>clock_timestamp()',
    values: ['snapshot.graph_json::jsonb'],
  },
  {
    from: 'app.workflow_test_suite_cases entry join app.workflow_test_suites suite on suite.workspace_id=entry.workspace_id and suite.id=entry.suite_id',
    alias: 'entry',
    workflow: 'suite.workflow_id',
    retained: 'suite.expires_at>clock_timestamp()',
    values: ['entry.input::jsonb'],
  },
  {
    from: 'app.workflow_drafts draft',
    alias: 'draft',
    workflow: 'draft.workflow_id',
    values: ['draft.graph_json::jsonb'],
  },
  {
    from: 'app.workflow_versions version',
    alias: 'version',
    workflow: 'version.workflow_id',
    values: ['version.graph_json::jsonb'],
  },
  {
    from: 'app.workflow_input_case_payloads payload join app.workflow_input_cases input_case on input_case.workspace_id=payload.workspace_id and input_case.id=payload.case_id',
    alias: 'payload',
    workflow: 'input_case.workflow_id',
    accessibleWhen:
      'input_case.deleted_at is null and input_case.revision=payload.revision',
    values: ['payload.input::jsonb'],
  },
  {
    from: 'app.workflow_step_samples sample',
    alias: 'sample',
    workflow: 'sample.workflow_id',
    retained: 'sample.expires_at>clock_timestamp()',
    values: ['sample.output_ref::jsonb'],
  },
  {
    from: 'app.preview_runs preview',
    alias: 'preview',
    workflow: 'preview.workflow_id',
    retained: 'preview.expires_at>clock_timestamp()',
    values: [
      'preview.input_ref::jsonb',
      'preview.executable_node_json::jsonb',
      'preview.output_ref::jsonb',
    ],
  },
  {
    from: 'app.workflow_runs run',
    alias: 'run',
    workflow: 'run.workflow_id',
    accessibleValues: [
      `case when run.input_ref_expires_at>clock_timestamp() then run.input_ref::jsonb end`,
      `case when ${LIVE_RUN_VALUES} then run.output_ref::jsonb end`,
    ],
    values: ['run.input_ref::jsonb', 'run.output_ref::jsonb'],
  },
  {
    from: 'app.node_runs node join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id',
    alias: 'node',
    workflow: 'run.workflow_id',
    accessibleWhen: LIVE_RUN_VALUES,
    values: ['node.input_ref::jsonb', 'node.output_ref::jsonb'],
  },
  {
    from: 'app.node_attempts attempt join app.node_runs node on node.workspace_id=attempt.workspace_id and node.id=attempt.node_run_id join app.workflow_runs run on run.workspace_id=node.workspace_id and run.id=node.workflow_run_id',
    alias: 'attempt',
    workflow: 'run.workflow_id',
    accessibleWhen: LIVE_RUN_VALUES,
    values: ['attempt.output_ref::jsonb', 'attempt.reconciliation_ref'],
  },
  {
    from: 'app.run_events event join app.workflow_runs run on run.workspace_id=event.workspace_id and run.id=event.workflow_run_id',
    alias: 'event',
    workflow: 'run.workflow_id',
    accessibleWhen: LIVE_RUN_VALUES,
    values: ['event.payload'],
  },
  {
    from: 'app.run_checkpoints checkpoint join app.workflow_runs run on run.workspace_id=checkpoint.workspace_id and run.id=checkpoint.workflow_run_id',
    alias: 'checkpoint',
    workflow: 'run.workflow_id',
    accessibleWhen: LIVE_RUN_VALUES,
    values: ['checkpoint.scheduler_state'],
  },
];

/** SQL filters the existing reference facts using an already-decided resource scope. */
export function artifactReferenceOwnersSql(
  workspace: SQL,
  artifact: SQL,
  visible?: (workflow: SQL) => SQL,
): SQL {
  const owners = OWNERS.map(
    (owner) => sql`exists(select 1 from ${sql.raw(owner.from)}
    where ${sql.identifier(owner.alias)}.workspace_id=${workspace}
      ${owner.retained === undefined ? sql`` : sql`and ${sql.raw(owner.retained)}`}
      ${visible === undefined || owner.accessibleWhen === undefined ? sql`` : sql`and (${sql.raw(owner.accessibleWhen)})`}
      and (${sql.join(
        (visible !== undefined && owner.accessibleValues !== undefined
          ? owner.accessibleValues
          : owner.values
        ).map(
          (value) =>
            sql`app.jsonb_references_artifact(${sql.raw(value)},${artifact})`,
        ),
        sql` or `,
      )})
      ${visible === undefined ? sql`` : sql`and (${visible(sql.raw(owner.workflow))})`})`,
  );
  return sql`select (${sql.join(owners, sql` or `)}) referenced`;
}
