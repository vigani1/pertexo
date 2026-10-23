import { it } from 'vitest';

import { assertCleanup } from './fixture.js';
import { createRoutingBase } from './execution/setup.js';
import { startRoutingWorkers } from './execution/start.js';
import { openRoutedRun } from './execution/pending.js';
import { resumeHandledRun } from './execution/resume.js';
import { assertRoutingOutcomes } from './execution/outcomes.js';
import { assertDataFailureRoutes } from './execution/data.js';
import { assertCallableAndRetention } from './execution/callable.js';

export function registerRetainsSourceFailureTruthResumesSelected(): void {
  it('retains source failure truth, resumes its selected handler after coordinator restart, and preserves terminal precedence', async () => {
    const base = await createRoutingBase();
    const { releaseHandler, owners } = base;
    let primary: unknown;
    try {
      const workers = await startRoutingWorkers(base);
      const scenario = { ...base, ...workers };
      const first = await openRoutedRun(scenario);
      await resumeHandledRun(scenario, first);
      await assertRoutingOutcomes(scenario);
      await assertDataFailureRoutes(scenario);
      await assertCallableAndRetention(scenario, first);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      releaseHandler();
      const closed = await Promise.allSettled(
        owners.reverse().map((close) => close()),
      );
      const errors = closed.flatMap((r) =>
        r.status === 'rejected' ? [r.reason as unknown] : [],
      );
      assertCleanup(errors, primary);
    }
  }, 90_000);
}
