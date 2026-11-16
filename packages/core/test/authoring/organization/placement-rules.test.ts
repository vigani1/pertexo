import { describe, expect, it } from 'vitest';
import { lifecycleAllowsChange } from '../../../src/authoring/organization/placement.js';

describe('organizing an archived workflow', () => {
  it('lets anyone organize an active workflow', () => {
    for (const kind of ['move', 'replace_tags', 'detach_tag'] as const)
      expect(lifecycleAllowsChange('builder', 'active', kind)).toBe(true);
  });

  it('lets only administrators move an archived workflow', () => {
    expect(lifecycleAllowsChange('admin', 'archived', 'move')).toBe(true);
    expect(lifecycleAllowsChange('owner', 'archived', 'move')).toBe(true);
    expect(lifecycleAllowsChange('builder', 'archived', 'move')).toBe(false);
    expect(lifecycleAllowsChange(null, 'archived', 'move')).toBe(false);
  });

  it('keeps an archived workflow’s tags, but lets anyone detach one', () => {
    expect(lifecycleAllowsChange('admin', 'archived', 'replace_tags')).toBe(
      false,
    );
    expect(lifecycleAllowsChange('builder', 'archived', 'detach_tag')).toBe(
      true,
    );
  });
});
