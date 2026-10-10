import { describe, expect, it } from 'vitest';
import {
  isWorkflowCallDefinition,
  workflowCallConfigSchema,
} from '../../src/index.js';
const target = {
  workflowId: '00000000-0000-4000-8000-000000000001',
  workflowVersionId: '00000000-0000-4000-8000-000000000002',
  executableChecksum: `wf:sha256:${'a'.repeat(64)}`,
};

describe('Call immutable target contract', () => {
  it('accepts one exact workflow, version and executable identity', () => {
    expect(workflowCallConfigSchema.parse({ target })).toEqual({ target });
    expect(isWorkflowCallDefinition({ key: 'core.call', version: 1 })).toBe(
      true,
    );
    expect(isWorkflowCallDefinition({ key: 'core.call', version: 2 })).toBe(
      false,
    );
    expect(isWorkflowCallDefinition({ key: 'core.manual', version: 1 })).toBe(
      false,
    );
  });
  it.each([
    { target: { ...target, workflowId: 'current' } },
    { target: { ...target, workflowVersionId: 'latest' } },
    { target: { ...target, executableChecksum: 'unchecked' } },
    { target: { ...target, workspaceId: target.workflowId } },
    { target, fireAndForget: true },
  ])('rejects an unresolved or unsupported target %j', (input) => {
    expect(workflowCallConfigSchema.safeParse(input).success).toBe(false);
  });
});
