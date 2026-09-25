import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  checkDatabasePreactivationReadiness,
  checkDatabaseReadiness,
  checkDatabaseServingReadiness,
  EXPECTED_MIGRATION_HEAD,
} from '../src/platform/readiness.js';
import type { ReadinessRow } from '../src/platform/readiness-probe.js';

const catalogJson = JSON.stringify({
  domain: 'pertexo.node-compatibility-release',
  schemaVersion: 1,
});
const compatibilityRelease = Object.freeze({
  catalogJson,
  epoch: 1,
  fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
});

const startupRow = Object.freeze({
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
  migration_head: EXPECTED_MIGRATION_HEAD,
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

describe('steady database serving readiness', () => {
  it('pins the reviewed migration head', () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe('0115_webhook_delivery_log.sql');
  });

  it('checks only bounded live compatibility state', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          current_user: 'pertexo_api',
          migration_head: EXPECTED_MIGRATION_HEAD,
          postgres_major: 18,
        },
      ],
    });

    await expect(
      checkDatabaseServingReadiness({ query } as unknown as Pool),
    ).resolves.toEqual({
      migrationHead: EXPECTED_MIGRATION_HEAD,
      postgresMajor: 18,
      role: 'pertexo_api',
    });

    expect(query).toHaveBeenCalledOnce();
    const statement = String(query.mock.calls[0]?.[0]);
    expect(statement).toContain('schema_migrations');
    expect(statement).not.toMatch(
      /pg_(?:attribute|class|constraint|index|policy|proc|trigger)/u,
    );
    expect(statement).not.toContain('has_function_privilege');
    expect(statement).not.toContain('has_table_privilege');
  });

  it.each([
    [[], 'Database serving readiness metadata is unavailable'],
    [
      [
        {
          ...startupRow,
          migration_head: EXPECTED_MIGRATION_HEAD,
          postgres_major: 17,
        },
      ],
      'PostgreSQL major version is unsupported',
    ],
    [
      [{ ...startupRow, migration_head: '0080_old.sql', postgres_major: 18 }],
      'Database migration head is incompatible',
    ],
  ] as const)(
    'rejects incompatible serving metadata %#',
    async (rows, message) => {
      const query = vi.fn().mockResolvedValue({ rows });
      await expect(
        checkDatabaseServingReadiness({ query } as unknown as Pool),
      ).rejects.toThrow(message);
      expect(query).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['single', { expectedCompatibilityRelease: compatibilityRelease }],
    ['set', { expectedCompatibilityReleases: [compatibilityRelease] }],
  ] as const)(
    'checks an expected compatibility release %s on the serving path',
    async (_kind, expectationOptions) => {
      const query = vi
        .fn()
        .mockResolvedValueOnce({
          rows: [
            {
              current_user: 'pertexo_api',
              migration_head: EXPECTED_MIGRATION_HEAD,
              postgres_major: 18,
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              catalog_json: JSON.parse(catalogJson) as unknown,
              epoch: compatibilityRelease.epoch,
              fingerprint: compatibilityRelease.fingerprint,
            },
          ],
        });

      await expect(
        checkDatabaseServingReadiness({ query } as unknown as Pool, {
          ownerRole: 'pertexo_owner',
          ...expectationOptions,
        }),
      ).resolves.toMatchObject({ role: 'pertexo_api' });
      expect(query).toHaveBeenCalledTimes(2);
      expect(String(query.mock.calls[1]?.[0])).toContain(
        _kind === 'single'
          ? 'lock_node_compatibility_current('
          : 'lock_node_compatibility_current_supported(',
      );
    },
  );

  it('fails closed when expected serving compatibility is absent', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            current_user: 'pertexo_api',
            migration_head: EXPECTED_MIGRATION_HEAD,
            postgres_major: 18,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    await expect(
      checkDatabaseServingReadiness({ query } as unknown as Pool, {
        expectedCompatibilityRelease: compatibilityRelease,
        ownerRole: 'pertexo_owner',
      }),
    ).rejects.toThrow(
      'Node compatibility release does not match this artifact',
    );
  });

  it('runs the full startup authority audit before optional preactivation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [startupRow] })
      .mockResolvedValueOnce({
        rows: [
          {
            compatible: true,
            current_role_can_read: true,
            current_role_can_write: false,
            worker_can_read: true,
            worker_can_write: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ compatible: true }] })
      .mockResolvedValueOnce({
        rows: [
          {
            catalog_json: JSON.parse(catalogJson) as unknown,
            epoch: compatibilityRelease.epoch,
            fingerprint: compatibilityRelease.fingerprint,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            epoch: compatibilityRelease.epoch,
            fingerprint: compatibilityRelease.fingerprint,
          },
        ],
      });

    await expect(
      checkDatabasePreactivationReadiness({ query } as unknown as Pool, {
        apiRuntimeRole: 'pertexo_api',
        expectedCompatibilityReleases: [compatibilityRelease],
        ownerRole: 'pertexo_owner',
        preactivationTarget: compatibilityRelease,
        workerRuntimeRole: 'pertexo_worker',
      }),
    ).resolves.toMatchObject({ role: 'pertexo_api' });
    expect(query).toHaveBeenCalledTimes(5);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      'phase4_connections_compatible',
    );
    expect(String(query.mock.calls[1]?.[0])).toContain(
      'node_compatibility_releases',
    );
    expect(String(query.mock.calls[2]?.[0])).toContain(
      'node_compatibility_preactivation_checks',
    );
    expect(String(query.mock.calls[3]?.[0])).toContain(
      'lock_node_compatibility_current_supported',
    );
    expect(String(query.mock.calls[4]?.[0])).toContain(
      'from app.node_compatibility_releases',
    );
  });

  it('rejects unsupported startup contracts before querying', async () => {
    const query = vi.fn();
    await expect(
      checkDatabaseReadiness({ query } as unknown as Pool, {
        ownerRole: 'pertexo_owner',
        supportedExecutableSchemaVersions: [1],
      }),
    ).rejects.toThrow('Workflow executable schema support is incompatible');
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ['startup', checkDatabaseReadiness],
    ['serving', checkDatabaseServingReadiness],
  ] as const)(
    'rejects ambiguous %s expectations before querying',
    async (_kind, checkReadiness) => {
      const query = vi.fn();
      const expectation = {
        epoch: 1,
        fingerprint: `node-compat:v1:sha256:${'a'.repeat(64)}`,
        catalogJson: '{}',
      };

      await expect(
        checkReadiness({ query } as unknown as Pool, {
          ownerRole: 'pertexo_owner',
          expectedCompatibilityRelease: expectation,
          expectedCompatibilityReleases: [expectation],
        }),
      ).rejects.toThrow(
        'Compatibility release readiness configuration is ambiguous',
      );
      expect(query).not.toHaveBeenCalled();
    },
  );
});
