import { describe, expect, it } from 'vitest';
import { WORKFLOW_INPUT_CASE_LIMITS } from '@pertexo/workflow-model';
import { caseQuotaRefusal } from '../../../src/authoring/input-cases/case-quota.js';

const room = { workflowCount: 0, workspaceCount: 0, retainedBytes: 0 };

describe('input case quota', () => {
  it('refuses a new case once the workflow or workspace holds its cap', () => {
    expect(
      caseQuotaRefusal(
        { ...room, workflowCount: WORKFLOW_INPUT_CASE_LIMITS.perWorkflow },
        1,
        { create: true },
      ),
    ).toBe('workflow_count');
    expect(
      caseQuotaRefusal(
        { ...room, workspaceCount: WORKFLOW_INPUT_CASE_LIMITS.perWorkspace },
        1,
        { create: true },
      ),
    ).toBe('workspace_count');
  });

  it('lets an edit through at the case caps, which only creation counts', () => {
    expect(
      caseQuotaRefusal(
        {
          workflowCount: WORKFLOW_INPUT_CASE_LIMITS.perWorkflow,
          workspaceCount: WORKFLOW_INPUT_CASE_LIMITS.perWorkspace,
          retainedBytes: 0,
        },
        1,
        { create: false },
      ),
    ).toBeUndefined();
  });

  it('refuses a write that would pass the retained bytes, and takes one that fills them', () => {
    const full = WORKFLOW_INPUT_CASE_LIMITS.retainedBytes;
    expect(
      caseQuotaRefusal({ ...room, retainedBytes: full - 10 }, 11, {
        create: false,
      }),
    ).toBe('retained_bytes');
    expect(
      caseQuotaRefusal({ ...room, retainedBytes: full - 10 }, 10, {
        create: false,
      }),
    ).toBeUndefined();
  });
});
