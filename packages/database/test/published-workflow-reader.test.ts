import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  classifyPublishedWorkflowVersionRow,
  PublishedWorkflowVersionCorruptError,
} from '../src/execution/published-workflow-reader.js';

const migrationUrl = new URL(
  '../migrations/0013_published_workflow_execution.sql',
  import.meta.url,
);

describe('published workflow execution migration contract', () => {
  it('adds a V2 executable envelope while preserving V1 rows', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain('executable_schema_version integer');
    expect(sql).toContain('executable_json jsonb');
    expect(sql).toContain('compatibility_release_epoch integer');
    expect(sql).toContain("checksum ~ '^wf:v1:sha256:[0-9a-f]{64}$'");
    expect(sql).toContain("checksum ~ '^wf:v2:sha256:[0-9a-f]{64}$'");
    expect(sql).toContain('octet_length(executable_json::text) <= 1048576');
  });

  it('grants the worker only the execution projection columns', async () => {
    const sql = await readFile(migrationUrl, 'utf8');
    expect(sql).toContain(
      'CREATE POLICY workflow_versions_worker_execution_read',
    );
    expect(sql).toMatch(
      /GRANT SELECT \(\s*id, workspace_id, workflow_id, version_number, schema_version,\s*checksum, executable_schema_version, executable_json,\s*compatibility_release_epoch\s*\)\s*ON app\.workflow_versions TO \{\{worker_runtime_role\}\}/su,
    );
    expect(sql).not.toMatch(
      /GRANT SELECT \([^)]*graph_json[^)]*\)[^;]*worker_runtime_role/su,
    );
  });
});

describe('published workflow row classification', () => {
  const base = {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: '22222222-2222-4222-8222-222222222222',
    workflow_id: '33333333-3333-4333-8333-333333333333',
    version_number: 2,
    schema_version: 1,
  } as const;
  const v1 = {
    ...base,
    checksum: `wf:v1:sha256:${'1'.repeat(64)}`,
    compatibility_release_epoch: null,
    executable_json: null,
    executable_schema_version: null,
  } as const;
  const v2 = {
    ...base,
    checksum: `wf:v2:sha256:${'2'.repeat(64)}`,
    compatibility_release_epoch: 7,
    executable_json: { deliberately: 'shallow projection only' },
    executable_schema_version: 2,
  } as const;

  it('distinguishes absence, retained V1, and a shallow V2 projection', () => {
    expect(classifyPublishedWorkflowVersionRow(undefined)).toEqual({
      kind: 'not_found',
    });
    expect(classifyPublishedWorkflowVersionRow(v1)).toMatchObject({
      kind: 'non_executable',
      workflowVersion: { id: base.id, checksum: v1.checksum },
    });
    expect(classifyPublishedWorkflowVersionRow(v2)).toMatchObject({
      kind: 'v2_projection',
      workflowVersion: {
        executableJson: v2.executable_json,
        compatibilityReleaseEpoch: 7,
      },
    });
  });

  it.each([
    ['null row', null],
    ['partial V2 columns', { ...v2, executable_json: null }],
    ['malformed checksum', { ...v2, checksum: 'wf:v2:sha256:nope' }],
    ['array executable', { ...v2, executable_json: [] }],
    ['null executable', { ...v2, executable_json: null }],
    ['invalid epoch', { ...v2, compatibility_release_epoch: 0 }],
    ['unexpected column', { ...v2, graph_json: {} }],
  ])('fails closed for %s', (_name, row) => {
    expect(() => classifyPublishedWorkflowVersionRow(row)).toThrow(
      PublishedWorkflowVersionCorruptError,
    );
  });
});
