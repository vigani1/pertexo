export interface ReadinessRow {
  can_delete: boolean;
  can_insert: boolean;
  can_references: boolean;
  can_select: boolean;
  can_trigger: boolean;
  can_truncate: boolean;
  can_update: boolean;
  current_user: string;
  migration_head: string | null;
  owner_member: boolean;
  owner: string;
  policy_compatible: boolean;
  phase1_grants_compatible: boolean;
  phase1_policy_compatible: boolean;
  phase1_schema_compatible: boolean;
  oidc_grants_compatible: boolean;
  oidc_capacity_compatible: boolean;
  oidc_schema_compatible: boolean;
  phase2_grants_compatible: boolean;
  phase2_policy_compatible: boolean;
  phase2_schema_compatible: boolean;
  phase3_grants_compatible: boolean;
  phase3_policy_compatible: boolean;
  phase3_schema_compatible: boolean;
  phase4_connections_compatible: boolean;
  phase4_integration_usage_compatible: boolean;
  phase4_preview_artifacts_compatible: boolean;
  phase4_preview_terminal_facts_compatible: boolean;
  execution_values_compatible: boolean;
  coordinator_run_store_compatible: boolean;
  durable_wait_compatible: boolean;
  failure_notification_compatible: boolean;
  execution_admission_compatible: boolean;
  regional_write_admission_compatible: boolean;
  webhook_triggers_compatible: boolean;
  schedule_triggers_compatible: boolean;
  due_node_wakeups_compatible: boolean;
  postgres_major: number;
  relforcerowsecurity: boolean;
  relrowsecurity: boolean;
  rolbypassrls: boolean;
  rolsuper: boolean;
  schema_compatible: boolean;
}

export type CompatibleReadinessRow = ReadinessRow & {
  readonly migration_head: string;
};

type BooleanCapabilityField = {
  [Field in keyof ReadinessRow]: ReadinessRow[Field] extends boolean
    ? Field
    : never;
}[keyof ReadinessRow];

const CAPABILITY_FAILURES = Object.freeze([
  ['policy_compatible', 'Workspace row-level security policy is incompatible'],
  ['phase1_schema_compatible', 'Identity/workspace schema is incompatible'],
  [
    'phase1_policy_compatible',
    'Identity/workspace row-level security policy is incompatible',
  ],
  [
    'phase1_grants_compatible',
    'Identity/workspace runtime grants are incompatible',
  ],
  ['oidc_schema_compatible', 'OIDC login transaction schema is incompatible'],
  ['oidc_grants_compatible', 'OIDC login transaction grants are incompatible'],
  [
    'oidc_capacity_compatible',
    'OIDC login transaction capacity guard is incompatible',
  ],
  ['phase2_schema_compatible', 'Workflow authoring schema is incompatible'],
  [
    'phase2_policy_compatible',
    'Workflow authoring row-level security is incompatible',
  ],
  [
    'phase2_grants_compatible',
    'Workflow authoring runtime grants are incompatible',
  ],
  [
    'phase3_schema_compatible',
    'Published workflow execution schema is incompatible',
  ],
  [
    'phase3_policy_compatible',
    'Published workflow execution row-level security is incompatible',
  ],
  [
    'phase3_grants_compatible',
    'Published workflow execution grants are incompatible',
  ],
  [
    'execution_values_compatible',
    'Execution value persistence is incompatible',
  ],
  [
    'coordinator_run_store_compatible',
    'Coordinator RunStore grants are incompatible',
  ],
  ['due_node_wakeups_compatible', 'Due node wakeup authority is incompatible'],
  ['durable_wait_compatible', 'Durable Wait authority is incompatible'],
  [
    'failure_notification_compatible',
    'Run failure notification persistence is incompatible',
  ],
  [
    'execution_admission_compatible',
    'Execution admission persistence is incompatible',
  ],
  [
    'regional_write_admission_compatible',
    'Regional write admission persistence is incompatible',
  ],
  [
    'webhook_triggers_compatible',
    'Webhook trigger persistence is incompatible',
  ],
  [
    'schedule_triggers_compatible',
    'Schedule trigger persistence is incompatible',
  ],
  [
    'phase4_connections_compatible',
    'Connection persistence schema or grants are incompatible',
  ],
  [
    'phase4_integration_usage_compatible',
    'Workflow integration usage schema or grants are incompatible',
  ],
  [
    'phase4_preview_artifacts_compatible',
    'Preview artifact ownership schema or grants are incompatible',
  ],
  [
    'phase4_preview_terminal_facts_compatible',
    'Preview terminal fact schema or grants are incompatible',
  ],
] satisfies readonly (readonly [BooleanCapabilityField, string])[]);

export function assertReadinessSupport(input: {
  readonly supportedChecksumAlgorithms?: readonly string[];
  readonly supportedExecutableSchemaVersions?: readonly number[];
  readonly supportedGraphSchemaVersions?: readonly number[];
}): void {
  const graphVersions = input.supportedGraphSchemaVersions ?? [1];
  if (graphVersions.length !== 1 || graphVersions[0] !== 1)
    throw new Error('Workflow graph schema support is incompatible');
  const checksums = input.supportedChecksumAlgorithms ?? [
    'wf:v1:sha256',
    'wf:v2:sha256',
  ];
  if (
    checksums.length !== 2 ||
    checksums[0] !== 'wf:v1:sha256' ||
    checksums[1] !== 'wf:v2:sha256'
  )
    throw new Error('Workflow checksum support is incompatible');
  const executableVersions = input.supportedExecutableSchemaVersions ?? [2];
  if (executableVersions.length !== 1 || executableVersions[0] !== 2)
    throw new Error('Workflow executable schema support is incompatible');
}

export function assertDatabaseReadinessRow(
  row: ReadinessRow | undefined,
  expected: {
    readonly migrationHead: string;
    readonly minimumPostgresMajor: number;
    readonly ownerRole: string;
  },
): asserts row is CompatibleReadinessRow {
  if (row === undefined)
    throw new Error('Database readiness metadata is unavailable');
  if (row.postgres_major < expected.minimumPostgresMajor)
    throw new Error(
      `PostgreSQL ${String(expected.minimumPostgresMajor)}+ is required`,
    );
  if (row.migration_head !== expected.migrationHead)
    throw new Error('Database migration head is incompatible');
  if (row.owner !== expected.ownerRole)
    throw new Error('Protected table has an unexpected owner');
  if (!row.schema_compatible)
    throw new Error('Protected table schema is incompatible');
  if (!row.relrowsecurity || !row.relforcerowsecurity)
    throw new Error('Protected table does not force row-level security');
  for (const [field, message] of CAPABILITY_FAILURES)
    if (!row[field]) throw new Error(message);
  const hasProtectedTableAccess =
    row.can_select || row.can_insert || row.can_update || row.can_delete;
  if (
    (hasProtectedTableAccess &&
      (!row.can_select ||
        !row.can_insert ||
        !row.can_update ||
        !row.can_delete)) ||
    row.can_truncate ||
    row.can_references ||
    row.can_trigger
  )
    throw new Error('Runtime database grants are incompatible');
  if (row.rolsuper || row.rolbypassrls || row.owner_member)
    throw new Error('Runtime database role is privileged');
}

// One reviewed snapshot keeps startup readiness internally consistent while
// capability-owned columns make each failed invariant diagnosable.
export { DATABASE_READINESS_SQL } from './readiness-probe-sql.js';
