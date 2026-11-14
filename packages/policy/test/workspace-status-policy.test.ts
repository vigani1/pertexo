import { expect, it } from 'vitest';
import {
  DISCOVERABLE_WORKSPACE_STATUSES,
  UNPURGED_WORKSPACE_STATUSES,
} from '@pertexo/policy';

it('exports current-member discovery statuses without opening other unpurged operations', () => {
  expect(DISCOVERABLE_WORKSPACE_STATUSES).toEqual([
    'active',
    'suspended',
    'pending_deletion',
    'purging',
  ]);
  expect(UNPURGED_WORKSPACE_STATUSES).toEqual([
    'active',
    'suspended',
    'pending_deletion',
  ]);
});
