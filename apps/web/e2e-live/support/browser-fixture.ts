import { randomUUID } from 'node:crypto';
import { test as base } from '@playwright/test';

async function notifyLifetime(
  phase: 'browser-opened' | 'browser-disposed',
  instanceId: string,
) {
  const origin = process.env.PERTEXO_LIVE_MAIL_ORIGIN;
  // Isolated reporter probes have no API/database/Redis fixture to release.
  if (origin === undefined) return;
  const response = await fetch(`${origin}/${phase}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  });
  if (response.status !== 204)
    throw new Error('Owned browser lifetime acknowledgment failed');
}

/** Pending before launch, disposed only after explicit close; never inferred. */
export const test = base.extend<
  // Playwright's way to declare that this adds no test-scoped fixtures.
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type
  Record<never, never>,
  { browserLifetime: string }
>({
  browserLifetime: [
    async ({ browserName }, runFixtures) => {
      const instanceId = randomUUID();
      // This has no browser dependency: even a failed base launch retains the
      // pending receipt and cannot be masked by a previous worker's disposal.
      try {
        await notifyLifetime('browser-opened', instanceId);
      } catch {
        throw new Error(`Owned ${browserName} launch registration failed`);
      }
      await runFixtures(instanceId);
    },
    { scope: 'worker', auto: true },
  ],
  browser: [
    async ({ browserLifetime, browser }, runFixtures) => {
      // Dependency order registers ownership before resolving the base browser.
      // Use Playwright's original launch/options/connect and context behavior.
      let scenarioFailure: unknown;
      try {
        await runFixtures(browser);
      } catch (error) {
        scenarioFailure = error;
      }
      let disposalFailure: Error | undefined;
      try {
        await browser.close();
        await notifyLifetime('browser-disposed', browserLifetime);
      } catch {
        disposalFailure = new Error(
          'Owned browser shutdown failed; preserve fixture',
        );
      }
      if (scenarioFailure !== undefined && disposalFailure !== undefined)
        throw new AggregateError(
          [scenarioFailure, disposalFailure],
          'Browser scenario and disposal failed',
        );
      if (scenarioFailure instanceof Error) throw scenarioFailure;
      if (scenarioFailure !== undefined)
        throw new Error('Owned browser scenario failed');
      if (disposalFailure !== undefined) throw disposalFailure;
    },
    { scope: 'worker' },
  ],
});
