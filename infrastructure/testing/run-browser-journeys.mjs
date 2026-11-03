import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  pullServices,
  report,
  runLogged,
  runSideBySide,
  startStack,
  stopStacks,
  summary,
} from './side-by-side.mjs';

/** What one journey runs. Each has its own switch, so nothing runs by accident. */
export function journeyCommand(journey) {
  const api = ['--filter', '@pertexo/api', 'exec', 'vitest', 'run'];
  const config = ['--config', 'vitest.integration.config.ts'];
  const inApi = (file, switches) => ({
    args: [...api, ...config, file],
    env: switches,
  });
  const owned = { EDITOR_BROWSER_OWNED_FIXTURE: 'true' };
  switch (journey) {
    case 'usage':
      return inApi('test/browser/usage.integration.test.ts', {
        USAGE_BROWSER_INTEGRATION: 'true',
      });
    case 'security':
      return inApi('test/browser/security/real-web.integration.test.ts', {
        SECURITY_BROWSER_INTEGRATION: 'true',
      });
    case 'organization-saml':
      return inApi('test/browser/editor/federation/saml.integration.test.ts', {
        EDITOR_BROWSER_INTEGRATION: 'true',
        EDITOR_BROWSER_CASE: journey,
        ...owned,
      });
    case 'workflow-concurrency':
      return inApi('test/browser/workflow-concurrency.integration.test.ts', {
        WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION: 'true',
      });
    case 'connection-health':
      return inApi('test/browser/connection-health.integration.test.ts', {
        CONNECTION_HEALTH_BROWSER_INTEGRATION: 'true',
      });
    case 'oauth2':
      return {
        args: [
          '--filter',
          '@pertexo/worker',
          'exec',
          'vitest',
          'run',
          ...config,
          'test/oauth2/browser.integration.test.ts',
        ],
        env: { OAUTH2_BROWSER_INTEGRATION: 'true' },
      };
    case 'workflow-organization':
      return inApi('test/browser/workflow-organization.integration.test.ts', {
        F07_ORGANIZATION_OWNED_FIXTURE: 'true',
        F07_ORGANIZATION_BROWSER_INTEGRATION: 'true',
        ...owned,
      });
    default:
      return inApi('test/browser/editor.integration.test.ts', {
        EDITOR_BROWSER_INTEGRATION: 'true',
        EDITOR_BROWSER_CASE: journey,
        ...owned,
      });
  }
}

async function main([slotCount, ...journeys]) {
  const count = Number(slotCount);
  if (!Number.isInteger(count) || count < 1 || journeys.length === 0)
    throw new Error(
      'usage: run-browser-journeys.mjs <side-by-side stacks> <journey...>',
    );
  const directory = mkdtempSync(join(tmpdir(), 'pertexo-journeys-'));
  const slots = Array.from({ length: count }, (_, slot) => slot);
  await pullServices();
  const environments = await Promise.all(slots.map(startStack));
  try {
    const results = await runSideBySide(
      journeys,
      environments,
      async (journey, environment) => {
        const result = await runLogged(
          journey,
          journeyCommand(journey),
          environment,
          directory,
        );
        report(result);
        return result;
      },
    );
    console.log(summary(results));
    if (results.some(({ passed }) => !passed)) process.exitCode = 1;
  } finally {
    await stopStacks(environments);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main(process.argv.slice(2));
}
