import { afterAll, beforeAll, it } from 'vitest';
import { coordinatorFixture as fixture } from '../../support/coordinator/consumer.js';
import { qualified, assertCleanup } from './failure-routing/fixture.js';
import { createRoutingBase } from './failure-routing/execution/setup.js';
import { startRoutingWorkers } from './failure-routing/execution/start.js';
import { openRoutedRun } from './failure-routing/execution/pending.js';
import { resumeHandledRun } from './failure-routing/execution/resume.js';
import { assertRoutingOutcomes } from './failure-routing/execution/outcomes.js';
import { assertDataFailureRoutes } from './failure-routing/execution/data.js';
import { assertCallableAndRetention } from './failure-routing/execution/callable.js';

qualified(
  'failure handlers through durable outbox and compiled workers',
  () => {
    beforeAll(fixture.setup, 60_000);
    afterAll(fixture.restoreServicesAndClose);
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
  },
);
