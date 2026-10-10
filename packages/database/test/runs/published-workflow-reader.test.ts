import { describe, expect, it } from 'vitest';

import {
  parsePublishedWorkflowRow,
  PublishedWorkflowVersionCorruptError,
} from '../../src/runs/published-workflow.js';

describe('published workflow rows', () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111',
    workspace_id: '22222222-2222-4222-8222-222222222222',
    workflow_id: '33333333-3333-4333-8333-333333333333',
    version_number: 2,
    checksum: `wf:sha256:${'2'.repeat(64)}`,
    executable_json: { deliberately: 'shallow projection only' },
  } as const;

  it('reads absence and a published version with its executable', () => {
    expect(parsePublishedWorkflowRow(undefined)).toBeNull();
    expect(parsePublishedWorkflowRow(row)).toEqual({
      checksum: row.checksum,
      executableJson: row.executable_json,
      id: row.id,
      versionNumber: 2,
      workflowId: row.workflow_id,
      workspaceId: row.workspace_id,
    });
  });

  it.each([
    ['null row', null],
    ['malformed checksum', { ...row, checksum: 'wf:sha256:nope' }],
    ['array executable', { ...row, executable_json: [] }],
    ['null executable', { ...row, executable_json: null }],
    ['unexpected column', { ...row, graph_json: {} }],
  ])('fails closed for %s', (_name, value) => {
    expect(() => parsePublishedWorkflowRow(value)).toThrow(
      PublishedWorkflowVersionCorruptError,
    );
  });
});
