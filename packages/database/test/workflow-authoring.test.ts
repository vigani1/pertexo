import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { EXPECTED_MIGRATION_HEAD } from '../src/readiness.js';
import { reconcileWorkflowTriggersPayload } from '../src/workflow-authoring.js';

const migrationUrl = new URL(
  '../migrations/0012_workflow_authoring.sql',
  import.meta.url,
);
const integrationUsageMigrationUrl = new URL(
  '../migrations/0021_workflow_integration_usage.sql',
  import.meta.url,
);

describe('workflow authoring migration contract', () => {
  it('advances the reviewed migration head', () => {
    expect(EXPECTED_MIGRATION_HEAD).toBe(
      '0035_slack_bot_token_connections.sql',
    );
  });

  it('emits the identifier-only trigger-reconciliation payload', () => {
    const payload = reconcileWorkflowTriggersPayload({
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      publishedVersionId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      workspaceId: '44444444-4444-4444-8444-444444444444',
    });
    expect(payload).toEqual({
      schemaVersion: 1,
      outboxEventId: '11111111-1111-4111-8111-111111111111',
      publishedVersionId: '22222222-2222-4222-8222-222222222222',
      workflowId: '33333333-3333-4333-8333-333333333333',
      workspaceId: '44444444-4444-4444-8444-444444444444',
    });
    expect(() =>
      reconcileWorkflowTriggersPayload({
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        publishedVersionId: '22222222-2222-4222-8222-222222222222',
        traceparent: 'arbitrary',
        workflowId: '33333333-3333-4333-8333-333333333333',
        workspaceId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toThrow();
    expect(
      reconcileWorkflowTriggersPayload({
        outboxEventId: '11111111-1111-4111-8111-111111111111',
        publishedVersionId: '22222222-2222-4222-8222-222222222222',
        traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
        workflowId: '33333333-3333-4333-8333-333333333333',
        workspaceId: '44444444-4444-4444-8444-444444444444',
      }),
    ).toHaveProperty(
      'traceparent',
      '00-11111111111111111111111111111111-2222222222222222-01',
    );
  });

  it('models one draft and same-workspace relationships', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('workflow_id uuid PRIMARY KEY');
    expect(sql).toContain(
      'REFERENCES app.workflows (workspace_id, id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'REFERENCES app.workflow_versions (workspace_id, workflow_id, id)',
    );
  });

  it('defines integration usage as a tenant-scoped disposable projection', async () => {
    const sql = await readFile(integrationUsageMigrationUrl, 'utf8');
    expect(sql).toContain('CREATE TABLE app.workflow_integration_usage');
    expect(sql).toContain('workflow_integration_usage_impact_idx');
    expect(sql).toContain('workflow_integration_usage_connection_idx');
    expect(sql).toContain(
      'ALTER TABLE app.workflow_integration_usage FORCE ROW LEVEL SECURITY',
    );
    expect(sql).toContain(
      'GRANT SELECT, INSERT, DELETE ON app.workflow_integration_usage',
    );
    expect(sql).toContain(
      'REFERENCES app.workflow_versions (workspace_id, id) ON DELETE CASCADE',
    );
    expect(sql).toContain(
      'REFERENCES app.connections (workspace_id, id) ON DELETE RESTRICT',
    );
  });

  it('forces RLS and keeps workflow versions immutable', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const table of ['workflows', 'workflow_drafts', 'workflow_versions']) {
      expect(sql).toContain(
        `ALTER TABLE app.${table} FORCE ROW LEVEL SECURITY`,
      );
    }
    expect(sql).toContain('CREATE TRIGGER workflow_versions_immutable');
    expect(sql).toContain("CHECK (checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$')");
    expect(sql).toContain(
      'CONSTRAINT workflow_drafts_schema_version_supported CHECK (schema_version = 1)',
    );
    expect(sql).toContain(
      'CONSTRAINT workflow_versions_schema_version_supported CHECK (schema_version = 1)',
    );
    expect(sql).toContain('ON app.outbox_events (job_name, available_at, id)');
    expect(sql).toContain('workflows_created_at_millisecond_precision');
    expect(sql).toContain('ON app.workflows (workspace_id, name, id)');
  });

  it('uses an atomic creator without serving draft insert or delete grants', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('CREATE FUNCTION app.create_workflow_with_draft');
    expect(sql).toContain("membership.role IN ('owner', 'admin', 'builder')");
    expect(sql).toContain("'workflow.create'");
    expect(sql).toContain("'workflow.created'");
    expect(sql).toContain("status = 'completed'");
    expect(sql).toContain(
      'REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER',
    );
    expect(sql).not.toMatch(/GRANT INSERT ON app\.workflow_drafts/u);
  });

  it('gives the worker no workflow authoring or version read grant', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).not.toMatch(
      /GRANT SELECT[^;]+workflow_versions[^;]+worker_runtime_role/su,
    );
    expect(sql).not.toMatch(
      /GRANT (?:INSERT|UPDATE|DELETE)[^;]+workflow_(?:drafts|versions)[^;]+worker_runtime_role/su,
    );
  });
});
