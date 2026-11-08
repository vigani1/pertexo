import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SlotWheel } from '@/features/usage/components/capacity-loom';
import { capacity } from './page/fixture';

it.each(
  (
    [
      [5, 2, 1, 2, 1, 2],
      [24, 6, 6, 6, 6, 12],
      [100, 24, 0, 6, 0, 18],
      [100, 25, 25, 6, 6, 12],
    ] as const
  ).map(([limit, active, reserved, runningBeads, heldBeads, freeBeads]) => ({
    limit,
    active,
    reserved,
    runningBeads,
    heldBeads,
    freeBeads,
  })),
)(
  'draws proportional running, held and free beads for limit $limit and $active running with $reserved held',
  ({ limit, active, reserved, runningBeads, heldBeads, freeBeads }) => {
    const { container } = render(
      <SlotWheel
        execution={{
          ...capacity.execution,
          activeRuns: active,
          reservedActiveSlots: reserved,
          activeCapacityConsumed: active + reserved,
          policy: {
            ...capacity.execution.policy,
            state: 'active',
            activeRunLimit: limit,
          },
        }}
      />,
    );
    expect(screen.getByRole('figure')).toHaveAccessibleName(
      `${String(active + reserved)} of ${String(limit)} runs in progress at once, 4 runs queued`,
    );
    expect(container.querySelectorAll('circle.fill-primary')).toHaveLength(
      runningBeads,
    );
    expect(container.querySelectorAll('circle.stroke-secondary')).toHaveLength(
      heldBeads,
    );
    expect(
      container.querySelectorAll('circle.stroke-border-strong'),
    ).toHaveLength(freeBeads);
  },
);
