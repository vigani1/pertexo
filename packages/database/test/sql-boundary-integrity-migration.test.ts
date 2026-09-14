import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('SQL boundary integrity migration', () => {
  it('makes named nullable checks total and validates retained rows', async () => {
    const migration = await readFile(
      new URL('../migrations/0088_sql_boundary_integrity.sql', import.meta.url),
      'utf8',
    );
    for (const constraint of [
      'node_compatibility_releases_catalog_object',
      'preview_runs_integration_identity_consistent',
      'node_runs_due_wakeup_consistent',
      'node_runs_wait_state_valid',
      'workflow_runs_deadline_wakeup_consistent',
      'failure_notification_destination_versions_config_strict',
      'workflow_runs_failure_notification_policy_complete',
      'trigger_schedules_recurrence_valid',
      'trigger_schedules_lease_valid',
      'retention_batches_lease_valid',
      'workspace_lifecycle_operations_lease_valid',
      'workspace_lifecycle_operations_result_valid',
      'workspace_purge_jobs_lease_valid',
      'workspace_purge_jobs_projection_valid',
      'workspace_purge_steps_lease_valid',
      'workspace_purge_completions_lease_valid',
      'operator_commands_completion_order',
      'operator_maintenance_rerun_outcome_valid',
    ]) {
      expect(migration).toContain(`DROP CONSTRAINT ${constraint}`);
      expect(migration).toContain(`VALIDATE CONSTRAINT ${constraint}`);
    }
    expect(migration).toContain(
      "jsonb_typeof(config->'connectionId')='string'",
    );
    expect(migration).toContain(') IS TRUE) NOT VALID');
  });

  it('accepts public UUIDv7 syntax and rejects absent bounds and leases', async () => {
    const migration = await readFile(
      new URL('../migrations/0088_sql_boundary_integrity.sql', import.meta.url),
      'utf8',
    );
    expect(migration.match(/\[1-8\]\[0-9a-f\]\{3\}/gu)).toHaveLength(5);
    expect(migration).not.toContain('[1-5][0-9a-f]{3}');
    expect(migration).toMatch(
      /CREATE OR REPLACE FUNCTION app\.validate_workflow_run_failure_notification_pin\(\)[\s\S]*?RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER/,
    );
    for (const guard of [
      'p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000',
      'p_retry_seconds IS NULL',
      'p_lease_seconds IS NULL',
      'p_operation_id IS NULL OR p_lease_token IS NULL',
      'p_job_id IS NULL OR p_lease_token IS NULL',
      'p_target_type IS NULL',
    ])
      expect(migration).toContain(guard);
    expect(migration.match(/IS DISTINCT FROM p_lease_token/gu)).toHaveLength(5);
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION app.lock_execution_artifact_references()',
    );
  });
});
