import { describe, expect, it } from 'vitest';

import {
  assertDatabaseReadinessRow,
  assertReadinessSupport,
  DATABASE_READINESS_SQL,
  type ReadinessRow,
} from '../src/platform/readiness-probe.js';

const readyRow = Object.freeze({
  can_delete: true,
  can_insert: true,
  can_references: false,
  can_select: true,
  can_trigger: false,
  can_truncate: false,
  can_update: true,
  coordinator_run_store_compatible: true,
  current_user: 'pertexo_api',
  due_node_wakeups_compatible: true,
  durable_wait_compatible: true,
  execution_admission_compatible: true,
  execution_values_compatible: true,
  failure_notification_compatible: true,
  migration_head: '0077_replay_read_locks.sql',
  oidc_capacity_compatible: true,
  oidc_grants_compatible: true,
  oidc_schema_compatible: true,
  owner: 'pertexo_owner',
  owner_member: false,
  phase1_grants_compatible: true,
  phase1_policy_compatible: true,
  phase1_schema_compatible: true,
  phase2_grants_compatible: true,
  phase2_policy_compatible: true,
  phase2_schema_compatible: true,
  phase3_grants_compatible: true,
  phase3_policy_compatible: true,
  phase3_schema_compatible: true,
  phase4_connections_compatible: true,
  phase4_integration_usage_compatible: true,
  phase4_preview_artifacts_compatible: true,
  phase4_preview_terminal_facts_compatible: true,
  policy_compatible: true,
  postgres_major: 18,
  regional_write_admission_compatible: true,
  relforcerowsecurity: true,
  relrowsecurity: true,
  rolbypassrls: false,
  rolsuper: false,
  schedule_triggers_compatible: true,
  schema_compatible: true,
  webhook_triggers_compatible: true,
}) satisfies ReadinessRow;

const expected = Object.freeze({
  migrationHead: '0077_replay_read_locks.sql',
  minimumPostgresMajor: 18,
  ownerRole: 'pertexo_owner',
});

describe('database readiness capability probe', () => {
  it('composes every capability column into one consistent snapshot', () => {
    for (const field of [
      'phase1_schema_compatible',
      'phase2_schema_compatible',
      'phase3_schema_compatible',
      'coordinator_run_store_compatible',
      'phase4_connections_compatible',
      'webhook_triggers_compatible',
      'schedule_triggers_compatible',
      'migration_head',
    ])
      expect(
        DATABASE_READINESS_SQL.match(new RegExp(`as ${field}`, 'gu')),
      ).toHaveLength(1);
  });

  it('names the capability owner while preserving fail-closed role checks', () => {
    expect(() => {
      assertDatabaseReadinessRow(readyRow, expected);
    }).not.toThrow();
    expect(() => {
      assertDatabaseReadinessRow(
        { ...readyRow, phase2_policy_compatible: false },
        expected,
      );
    }).toThrow('Workflow authoring row-level security is incompatible');
    expect(() => {
      assertDatabaseReadinessRow(
        { ...readyRow, relforcerowsecurity: false },
        expected,
      );
    }).toThrow('Protected table does not force row-level security');
  });

  it('rejects unsupported graph, checksum, and executable contracts', () => {
    expect(() => {
      assertReadinessSupport({});
    }).not.toThrow();
    expect(() => {
      assertReadinessSupport({ supportedGraphSchemaVersions: [1, 2] });
    }).toThrow('Workflow graph schema support is incompatible');
    expect(() => {
      assertReadinessSupport({
        supportedChecksumAlgorithms: ['wf:v2:sha256'],
      });
    }).toThrow('Workflow checksum support is incompatible');
    expect(() => {
      assertReadinessSupport({ supportedExecutableSchemaVersions: [1] });
    }).toThrow('Workflow executable schema support is incompatible');
  });
});
