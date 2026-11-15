import { describe, expect, it } from 'vitest';
import {
  concurrencyMayRefuse,
  concurrencyRefusesRun,
  skipsWorkflowConcurrency,
} from '../../../src/runs/commands/acceptance/concurrency.js';

const skip = { overflow: 'skip', active_run_limit: 2 };

describe('workflow concurrency rules', () => {
  it('lets calls and test runs skip workflow concurrency', () => {
    expect(skipsWorkflowConcurrency('workflow_call')).toBe(true);
    expect(skipsWorkflowConcurrency('test')).toBe(true);
    expect(skipsWorkflowConcurrency('manual')).toBe(false);
  });

  it('refuses only under a skip policy with a limit', () => {
    expect(concurrencyMayRefuse(skip)).toBe(true);
    expect(concurrencyMayRefuse({ ...skip, overflow: 'queue' })).toBe(false);
    expect(concurrencyMayRefuse({ ...skip, active_run_limit: null })).toBe(
      false,
    );
    expect(concurrencyMayRefuse(undefined)).toBe(false);
  });

  it('refuses once active and queued runs together reach the limit', () => {
    expect(
      concurrencyRefusesRun(skip, { active_runs: 1, queued_runs: 0 }),
    ).toBe(false);
    expect(
      concurrencyRefusesRun(skip, { active_runs: 1, queued_runs: 1 }),
    ).toBe(true);
    expect(
      concurrencyRefusesRun(
        { ...skip, overflow: 'queue' },
        { active_runs: 5, queued_runs: 5 },
      ),
    ).toBe(false);
  });
});
