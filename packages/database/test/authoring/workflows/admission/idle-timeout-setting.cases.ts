import { expect, it, vi } from 'vitest';

import {
  admitWorkflowAuthoring,
  authoringIdleBudgetIsSafe,
} from '../../../../src/authoring/workflows/admission.queries.js';

import { graph, valid, budget } from './fixture.js';

export function registerIdleTimeoutSettings(): void {
  it.each([
    ['35000', 'ms', true],
    ['2251', 'ms', true],
    ['2250', 'ms', false],
    ['2', 's', false],
    ['3', 's', true],
    ['1', 'min', true],
    ['2250001', 'us', true],
    ['0', 'ms', false],
    ['-1', 'ms', false],
    ['NaN', 'ms', false],
    ['2.5', 's', false],
    ['99999999999999999999', 'ms', false],
    ['35000', 'unknown', false],
    [undefined, 'ms', false],
    ['35000', null, false],
  ])('qualifies setting %s unit %s as %s', (setting, unit, expected) => {
    expect(authoringIdleBudgetIsSafe(setting, unit)).toBe(expected);
  });

  it('fails closed before dispatch without wiring, with unknown/unlimited or too-small effective settings', async () => {
    const validator = vi.fn().mockResolvedValue(valid);
    const query = vi.fn().mockResolvedValue(budget);
    await expect(
      admitWorkflowAuthoring({ query }, undefined, graph),
    ).rejects.toMatchObject({ reason: 'not_configured' });
    expect(query).not.toHaveBeenCalled();
    for (const rows of [
      [],
      [{ setting: '0', unit: 'ms' }],
      [{ setting: '2250', unit: 'ms' }],
    ]) {
      query.mockResolvedValue({ rows });
      await expect(
        admitWorkflowAuthoring({ query }, validator, graph),
      ).rejects.toMatchObject({ reason: 'database_budget' });
    }
    expect(validator).not.toHaveBeenCalled();
  });

  it('rechecks the actual connection each admission and forwards cancellation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(budget)
      .mockResolvedValueOnce({ rows: [{ setting: '1000', unit: 'ms' }] });
    const validator = vi.fn().mockResolvedValue(valid);
    const controller = new AbortController();
    await expect(
      admitWorkflowAuthoring({ query }, validator, graph, {
        signal: controller.signal,
      }),
    ).resolves.toBe(valid);
    expect(validator).toHaveBeenCalledWith(graph, {
      signal: controller.signal,
    });
    await expect(
      admitWorkflowAuthoring({ query }, validator, graph),
    ).rejects.toMatchObject({ reason: 'database_budget' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(validator).toHaveBeenCalledOnce();
    query.mockResolvedValue(budget);
    controller.abort();
    await expect(
      admitWorkflowAuthoring({ query }, validator, graph, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(validator).toHaveBeenCalledOnce();
  });
}
