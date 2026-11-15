import { expect, it } from 'vitest';
import { countByStatus } from '@/features/connections/model/connection-counts';

it('counts working, revoked, and every other status as needing a reconnect', () => {
  expect(
    countByStatus([
      { status: 'active' },
      { status: 'active' },
      { status: 'revoked' },
      { status: 'reauthorization_required' },
      { status: 'reauthorization_required' },
    ]),
  ).toEqual({ active: 2, reconnect: 2, revoked: 1 });
  expect(countByStatus([])).toEqual({ active: 0, reconnect: 0, revoked: 0 });
});
