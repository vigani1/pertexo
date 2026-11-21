import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
  const api = [
    '--filter',
    '@pertexo/api',
    'exec',
    'vitest',
    'run',
    '--experimental.fsModuleCache',
  ];
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
      return {
        ...inApi('test/browser/security/real-web.integration.test.ts', {
          SECURITY_BROWSER_INTEGRATION: 'true',
        }),
        // It starts and removes an nginx container: see journeyPhases.
        changesNetwork: true,
      };
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

/**
 * Starting or removing a container adds or drops a network interface on the
 * runner, and Chromium answers by closing every open connection, loopback
 * included, with ERR_NETWORK_CHANGED. So a journey that does so runs first,
 * with no other browser beside it; the rest share the stacks.
 */
export function journeyPhases(journeys) {
  const changesNetwork = (journey) =>
    journeyCommand(journey).changesNetwork === true;
  const shared = journeys.filter((journey) => !changesNetwork(journey));
  return [
    ...journeys.filter(changesNetwork).map((journey) => [journey]),
    ...(shared.length > 0 ? [shared] : []),
  ];
}

async function compareCuratedExecutions(environment, directory) {
  const command = journeyCommand('curated-templates');
  const results = [];
  const snapshots = [];
  for (const inline of [false, true]) {
    const label = inline ? 'curated-inline' : 'curated-attempt';
    const snapshot = join(directory, `${label}.json`);
    const result = await runLogged(
      label,
      {
        ...command,
        env: {
          ...command.env,
          WORKFLOW_COORDINATOR_INLINE_STEPS: String(inline),
          CURATED_INLINE_EQUIVALENCE_FILE: snapshot,
        },
      },
      environment,
      directory,
    );
    report(result);
    results.push(result);
    if (!result.passed) return results;
    snapshots.push(JSON.parse(readFileSync(snapshot, 'utf8')));
  }
  compareExecutionSnapshots(snapshots[1], snapshots[0]);
  return results;
}

function compareExecutionSnapshots(inline, delivered) {
  assert.deepStrictEqual(
    inline.map(({ name }) => name),
    delivered.map(({ name }) => name),
  );
  for (const [index, snapshot] of inline.entries()) {
    const expected = delivered[index];
    assert.deepStrictEqual(snapshot.run, expected.run, `${snapshot.name} run`);
    for (const field of ['nodes', 'attempts', 'events']) {
      assert.equal(
        snapshot[field].length,
        expected[field].length,
        `${snapshot.name} ${field} count`,
      );
      for (const [i, record] of snapshot[field].entries()) {
        assert.deepStrictEqual(
          record,
          expected[field][i],
          `${snapshot.name} ${field} record ${i + 1}`,
        );
      }
    }
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
    const results = [];
    for (const phase of journeyPhases(journeys))
      results.push(
        ...(await runSideBySide(
          phase,
          environments,
          async (journey, environment) => {
            if (journey === 'curated-templates')
              return compareCuratedExecutions(environment, directory);
            const result = await runLogged(
              journey,
              journeyCommand(journey),
              environment,
              directory,
            );
            report(result);
            return [result];
          },
        )),
      );
    const completed = results.flat();
    console.log(summary(completed));
    if (completed.some(({ passed }) => !passed)) process.exitCode = 1;
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
