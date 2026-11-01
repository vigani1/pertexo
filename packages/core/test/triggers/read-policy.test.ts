import { describe, expect, it } from 'vitest';

import {
  ROLES,
  WORKFLOW_EDITOR_ROLES,
  hasCapability,
} from '@pertexo/workflow-model';

describe('trigger read policy', () => {
  it('keeps schedule metadata readable by every role', () => {
    expect(ROLES).toEqual(['owner', 'admin', 'builder', 'operator', 'viewer']);
  });

  it('keeps webhook delivery metadata narrower than schedule and distinct from mutation access', () => {
    expect(WORKFLOW_EDITOR_ROLES).toEqual(['owner', 'admin', 'builder']);
    expect(WORKFLOW_EDITOR_ROLES).not.toContain('operator');
    expect(WORKFLOW_EDITOR_ROLES).not.toContain('viewer');
    expect(hasCapability('builder', 'connection:manage')).toBe(false);
  });
});
