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
  artifact_capacity_compatible: true,
  coordinator_run_store_compatible: true,
  current_user: 'pertexo_api',
  due_node_wakeups_compatible: true,
  durable_wait_compatible: true,
  execution_admission_compatible: true,
  execution_values_compatible: true,
  failure_notification_compatible: true,
  migration_head: '0081_schedule_claim_concurrency.sql',
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
  migrationHead: '0081_schedule_claim_concurrency.sql',
  minimumPostgresMajor: 18,
  ownerRole: 'pertexo_owner',
});

const capabilityFailures = Object.freeze([
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
    'artifact_capacity_compatible',
    'Artifact capacity schema, row-level security, or runtime grants are incompatible',
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
] as const satisfies readonly (readonly [keyof ReadinessRow, string])[]);

describe('database readiness capability probe', () => {
  it('composes every declared capability alias exactly once', () => {
    for (const field of Object.keys(readyRow).filter((key) =>
      key.endsWith('_compatible'),
    ))
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
        { ...readyRow, relforcerowsecurity: false },
        expected,
      );
    }).toThrow('Protected table does not force row-level security');
  });

  it.each(capabilityFailures)(
    'rejects false and null %s with its capability-specific failure',
    (field, message) => {
      for (const value of [false, null])
        expect(() => {
          assertDatabaseReadinessRow({ ...readyRow, [field]: value }, expected);
        }).toThrow(message);
    },
  );

  it.each([
    [undefined, 'Database readiness metadata is unavailable'],
    [{ ...readyRow, postgres_major: 17 }, 'PostgreSQL 18+ is required'],
    [
      { ...readyRow, migration_head: '0080_old.sql' },
      'Database migration head is incompatible',
    ],
    [
      { ...readyRow, owner: 'unexpected_owner' },
      'Protected table has an unexpected owner',
    ],
    [
      { ...readyRow, schema_compatible: false },
      'Protected table schema is incompatible',
    ],
    [
      { ...readyRow, relrowsecurity: false },
      'Protected table does not force row-level security',
    ],
    [
      { ...readyRow, relforcerowsecurity: false },
      'Protected table does not force row-level security',
    ],
  ] as const)('rejects invalid readiness metadata %#', (row, message) => {
    expect(() => {
      assertDatabaseReadinessRow(row, expected);
    }).toThrow(message);
  });

  it('accepts exactly no CRUD or full CRUD and rejects every partial grant', () => {
    const crudFields = [
      'can_select',
      'can_insert',
      'can_update',
      'can_delete',
    ] as const;
    expect(() => {
      assertDatabaseReadinessRow(
        {
          ...readyRow,
          can_select: false,
          can_insert: false,
          can_update: false,
          can_delete: false,
        },
        expected,
      );
    }).not.toThrow();
    for (const missing of crudFields)
      expect(() => {
        assertDatabaseReadinessRow({ ...readyRow, [missing]: false }, expected);
      }).toThrow('Runtime database grants are incompatible');
  });

  it.each(['can_truncate', 'can_references', 'can_trigger'] as const)(
    'rejects forbidden %s authority',
    (field) => {
      expect(() => {
        assertDatabaseReadinessRow({ ...readyRow, [field]: true }, expected);
      }).toThrow('Runtime database grants are incompatible');
    },
  );

  it.each(['rolsuper', 'rolbypassrls', 'owner_member'] as const)(
    'rejects privileged runtime role field %s',
    (field) => {
      expect(() => {
        assertDatabaseReadinessRow({ ...readyRow, [field]: true }, expected);
      }).toThrow('Runtime database role is privileged');
    },
  );

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
