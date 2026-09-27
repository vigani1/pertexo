import { describe, expect, it } from 'vitest';

import {
  ROLES,
  SCHEDULE_TRIGGER_READ_ROLES,
  WEBHOOK_TRIGGER_READ_ROLES,
  hasCapability,
} from '../src/tenant-access/workspace-policy.js';

describe('trigger read policy', () => {
  it('keeps schedule metadata readable by every role', () => {
    expect(SCHEDULE_TRIGGER_READ_ROLES).toEqual(ROLES);
  });

  it('keeps webhook delivery metadata narrower than schedule and distinct from mutation access', () => {
    expect(WEBHOOK_TRIGGER_READ_ROLES).toEqual(['owner', 'admin', 'builder']);
    expect(WEBHOOK_TRIGGER_READ_ROLES).not.toContain('operator');
    expect(WEBHOOK_TRIGGER_READ_ROLES).not.toContain('viewer');
    expect(hasCapability('builder', 'connection:manage')).toBe(false);
  });
});
