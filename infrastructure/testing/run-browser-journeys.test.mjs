import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

import { journeyCommand } from './run-browser-journeys.mjs';
import { shardCommand, workerSuitePhases } from './run-worker-suite.mjs';
import { runSideBySide, slotEnvironment } from './side-by-side.mjs';

const base = {
  COMPOSE_PROJECT_NAME: 'pertexo-ci-1-1-browser',
  POSTGRES_PORT: '5432',
  REDIS_PORT: '6379',
  ARTIFACT_STORE_PORT: '9090',
  DATABASE_ADMIN_URL: 'postgresql://postgres:secret@127.0.0.1:5432/postgres',
  DATABASE_MIGRATION_URL: 'postgresql://m:secret@127.0.0.1:5432/pertexo',
  DATABASE_URL: 'postgresql://a:secret@127.0.0.1:5432/pertexo',
  DATABASE_MAINTENANCE_URL: 'postgresql://x:secret@127.0.0.1:5432/pertexo',
  REDIS_URL: 'redis://:secret@127.0.0.1:6379/0',
  ARTIFACT_STORE_ENDPOINT: 'http://127.0.0.1:9090',
};

test('every stack gets services, ports and a web build nothing else touches', () => {
  const [first, second] = [0, 1].map((slot) => slotEnvironment(base, slot));
  for (const name of Object.keys(first))
    assert.notEqual(first[name], second[name], name);
  assert.equal(
    second.DATABASE_URL,
    'postgresql://a:secret@127.0.0.1:5532/pertexo',
  );
  assert.match(second.COMPOSE_PROJECT_NAME, /^pertexo-ci-\d+-\d+-browser$/u);
  assert.equal(second.REDIS_URL, 'redis://:secret@127.0.0.1:6479/0');
  assert.equal(second.ARTIFACT_STORE_ENDPOINT, 'http://127.0.0.1:9190');
});

test('the SAML journey has room on the port beside its web port', () => {
  const ports = [0, 1, 2].map((slot) =>
    Number(slotEnvironment(base, slot).PERTEXO_LIVE_WEB_PORT),
  );
  for (const port of ports) assert.ok(!ports.includes(port + 1));
});

test('hands out every journey once, and a slow one holds up only its own stack', async () => {
  const log = [];
  const results = await runSideBySide(
    ['slow', 'a', 'b'],
    ['first', 'second'],
    async (journey, slot) => {
      log.push(`${journey}:${slot}`);
      await new Promise((resolve) => {
        setTimeout(resolve, journey === 'slow' ? 40 : 1);
      });
      return journey;
    },
  );
  assert.deepEqual(results.sort(), ['a', 'b', 'slow']);
  assert.deepEqual(log, ['slow:first', 'a:second', 'b:second']);
});

test('a journey that fails still leaves the others to run', async () => {
  const results = await runSideBySide(['bad', 'good'], ['only'], (journey) =>
    Promise.resolve({ journey, passed: journey !== 'bad' }),
  );
  assert.deepEqual(results.map(({ journey }) => journey).sort(), [
    'bad',
    'good',
  ]);
});

test('runs each kind of journey under its own switch', () => {
  assert.equal(journeyCommand('forms').env.EDITOR_BROWSER_CASE, 'forms');
  assert.equal(
    journeyCommand('security').env.SECURITY_BROWSER_INTEGRATION,
    'true',
  );
  assert.ok(journeyCommand('oauth2').args.includes('@pertexo/worker'));
});

// Named once each and spelled whole: a list wrapped at a hyphen once ran `webhook-`.
test('CI runs every journey exactly once, under its whole name', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const named = ci.jobs.browser.strategy.matrix.include.flatMap(
    ({ journeys }) => journeys.split(/\s+/u).filter(Boolean),
  );
  assert.equal(new Set(named).size, named.length);
  const cases = readFileSync(
    'apps/api/test/browser/editor/fixture/environment.ts',
    'utf8',
  );
  const known = new Set([
    ...[...cases.matchAll(/^ {4}'([a-z0-9-]+)',$/gmu)].map(([, name]) => name),
    'usage',
    'security',
    'organization-saml',
    'workflow-concurrency',
    'connection-health',
    'oauth2',
    'workflow-organization',
  ]);
  assert.deepEqual(
    named.filter((journey) => !known.has(journey)),
    [],
  );
  assert.deepEqual(
    [...known].filter((journey) => !named.includes(journey)),
    [],
  );
});

test('CI runs the journeys Code steps need where their Python is installed', () => {
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const browser = ci.jobs.browser;
  const live = browser.strategy.matrix.include.filter(({ suite }) =>
    suite.startsWith('live'),
  );
  const python = browser.steps.find(({ uses }) =>
    uses?.startsWith('actions/setup-python'),
  );
  const withCode = live.find(({ journeys }) => /\bcode\b/u.test(journeys));
  assert.ok(python.if.includes(withCode.suite));
});

test('the worker suite runs every shard, each on a stack of its own', () => {
  const commands = [0, 1, 2].map((shard) => shardCommand(shard, 3));
  assert.deepEqual(
    commands.map(({ args }) => args.find((a) => a.startsWith('--shard'))),
    ['--shard=1/3', '--shard=2/3', '--shard=3/3'],
  );
  const projects = [0, 1, 2].map(
    (slot) =>
      slotEnvironment(
        { ...base, COMPOSE_PROJECT_NAME: 'pertexo-ci-1-1-integration' },
        slot,
      ).COMPOSE_PROJECT_NAME,
  );
  assert.equal(new Set(projects).size, 3);
  for (const project of projects)
    assert.match(project, /^pertexo-ci-\d+-\d+-integration$/u);
});

test('cold-worker For Each recovery runs alone before the parallel worker shards', () => {
  const file = 'test/runs/consumer/foreach-cancellation.integration.test.ts';
  const phases = workerSuitePhases(3);
  assert.equal(phases.length, 2);
  assert.equal(phases[0].length, 1);
  assert.equal(phases[0][0].stack, 0);
  assert.ok(phases[0][0].command.args.includes(file));
  assert.ok(
    !phases[0][0].command.args.some((arg) => arg.startsWith('--shard')),
  );
  assert.deepEqual(
    phases[1].map(({ stack }) => stack),
    [0, 1, 2],
  );
  for (const { command } of phases[1]) {
    assert.ok(command.args.includes(`--exclude=${file}`));
  }
});

test('explicit worker selections keep their requested files and shard arguments', () => {
  const selection = ['test/connections', '--reporter=verbose'];
  const phases = workerSuitePhases(3, selection);
  assert.equal(phases.length, 1);
  assert.deepEqual(
    phases[0].map(({ command }) => command),
    [0, 1, 2].map((shard) => shardCommand(shard, 3, selection)),
  );
});
