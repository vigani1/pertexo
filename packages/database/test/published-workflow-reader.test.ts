import { describe, expect, it } from 'vitest';

import {
  classifyPublishedWorkflowVersionRow,
  PublishedWorkflowVersionCorruptError,
} from '../src/runs/published-workflow.js';

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
    executable_json: null,
    executable_schema_version: null,
  } as const;
  const v2 = {
    ...base,
    checksum: `wf:v2:sha256:${'2'.repeat(64)}`,
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
      },
    });
  });

  it.each([
    ['null row', null],
    ['partial V2 columns', { ...v2, executable_json: null }],
    ['malformed checksum', { ...v2, checksum: 'wf:v2:sha256:nope' }],
    ['array executable', { ...v2, executable_json: [] }],
    ['null executable', { ...v2, executable_json: null }],
    ['unexpected column', { ...v2, graph_json: {} }],
  ])('fails closed for %s', (_name, row) => {
    expect(() => classifyPublishedWorkflowVersionRow(row)).toThrow(
      PublishedWorkflowVersionCorruptError,
    );
  });
});
