import { describe, expect, it } from 'vitest';

import {
  apiPool,
  checkDatabaseReadiness,
  dispatcherPool,
  executeAsOwner,
  workerPool,
} from './support/workflow-authoring.integration.support.js';

describe('workflow authoring readiness', () => {
  it('passes role-aware readiness for API, worker, and dispatcher', async () => {
    const apiReadiness = await checkDatabaseReadiness(apiPool);
    const workerReadiness = await checkDatabaseReadiness(workerPool);
    const dispatcherReadiness = await checkDatabaseReadiness(dispatcherPool);
    expect(apiReadiness.role).toBe('pertexo_api');
    expect(workerReadiness.role).toBe('pertexo_worker');
    expect(dispatcherReadiness.role).toBe('pertexo_dispatcher');
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        supportedGraphSchemaVersions: [],
      }),
    ).rejects.toThrow('Workflow graph schema support is incompatible');
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        supportedChecksumAlgorithms: [],
      }),
    ).rejects.toThrow('Workflow checksum support is incompatible');
    await expect(
      checkDatabaseReadiness(apiPool, {
        ownerRole: 'pertexo_owner',
        supportedExecutableSchemaVersions: [],
      }),
    ).rejects.toThrow('Workflow executable schema support is incompatible');
  });

  it('fails readiness on policy, grant, function, and dispatch-index drift', async () => {
    const workspacePolicy = `
      alter policy workflows_workspace_scope on app.workflows
      to pertexo_owner, pertexo_api
      using (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))
      with check (workspace_id::text = nullif(current_setting('app.workspace_id', true), ''))`;

    await executeAsOwner(`
      alter policy workflows_workspace_scope on app.workflows
      using (true) with check (true)`);
    try {
      await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
        'Workflow authoring row-level security is incompatible',
      );
    } finally {
      await executeAsOwner(workspacePolicy);
    }

    await executeAsOwner(
      'grant select on app.workflow_versions to pertexo_worker',
    );
    try {
      await expect(checkDatabaseReadiness(workerPool)).rejects.toThrow(
        'Workflow authoring runtime grants are incompatible',
      );
    } finally {
      await executeAsOwner(`
        revoke select on app.workflow_versions from pertexo_worker;
        grant select (
          id, workspace_id, workflow_id, version_number, schema_version,
          checksum, executable_schema_version, executable_json,
          compatibility_release_epoch
        ) on app.workflow_versions to pertexo_worker`);
    }

    const creatorSignature = `app.create_workflow_with_draft(
      uuid, uuid, varchar, uuid, integer, jsonb, char, char, varchar, varchar
    )`;
    await executeAsOwner(
      `alter function ${creatorSignature} set search_path = pg_catalog, public`,
    );
    try {
      await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
        'Workflow authoring schema is incompatible',
      );
    } finally {
      await executeAsOwner(
        `alter function ${creatorSignature} set search_path = pg_catalog, pg_temp`,
      );
    }

    await executeAsOwner('drop index app.outbox_events_dispatch_job_due_idx');
    try {
      await expect(checkDatabaseReadiness(apiPool)).rejects.toThrow(
        'Workflow authoring schema is incompatible',
      );
    } finally {
      await executeAsOwner(`
        create index outbox_events_dispatch_job_due_idx
        on app.outbox_events (job_name, available_at, id)
        where published_at is null and failed_at is null`);
    }
  });
});
