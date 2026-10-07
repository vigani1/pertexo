import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';
import { WORKFLOW_ORGANIZATION_GATES } from '../testing/workflow-organization-gates.mjs';

import {
  INLINE_CALL_HTTP_COMMAND,
  INLINE_CALL_HTTP_VALIDATE_COMMAND,
  validateCiGatePolicy,
} from './validate-ci-gates.mjs';

const qualityBundleScripts = [
  'docs:check',
  'format:check',
  'runtime:check',
  'network-registry:check',
  'dependencies:check',
  'database:schema:check',
  'lint',
  'complexity:check',
  'duplication:check',
  'contracts:check',
  'typecheck',
];

function fixture() {
  const packageManifest = {
    scripts: {
      'architecture:check': 'node architecture.mjs',
      build: 'tsc --build',
      'built-exports:check': 'node exports.mjs',
      check:
        'pnpm ci:gates:check && pnpm quality:local:check && pnpm architecture:check && pnpm build && pnpm built-exports:check',
      'ci:gates:check': 'node validate-ci-gates.mjs',
      'mutation:check':
        'node infrastructure/quality/verify-mutation-sensitivity.mjs',
      'performance:local:check': 'node performance.mjs',
      'quality:local': 'node local-quality.mjs',
      'quality:local:check':
        'pnpm quality:local:contracts && pnpm performance:local:check',
      'quality:local:contracts': 'node local-quality.test.mjs',
      'test:browser-probes': 'pnpm --filter @pertexo/api test:browser-probes',
      'prepush:check':
        'pnpm check && pnpm test:coverage && pnpm test:browser-probes',
      'prepush:fast':
        'pnpm ci:gates:check && pnpm quality:local:check && pnpm architecture:check && pnpm build && pnpm built-exports:check && pnpm prepush:changed',
    },
  };
  const workflow = parseYaml(`
jobs:
  quality:
    timeout-minutes: 15
    steps:
      - run: pnpm ci:gates:check
      - run: pnpm build
      - run: pnpm architecture:check
      - run: pnpm built-exports:check
  integration:
    steps:
      - run: pnpm mutation:check
      - run: >-
          pnpm --filter @pertexo/api exec vitest run
          --exclude test/platform/compatibility-rollout.integration.test.ts
          --exclude test/editor-browser.integration.test.ts
          --exclude test/usage-browser.integration.test.ts
          --exclude test/workflow-concurrency-browser.integration.test.ts
          --exclude test/connection-health-browser.integration.test.ts
          --exclude test/curated-template-origin-guard.integration.test.ts
          --exclude test/workflow-authoring/organization.integration.test.ts
          --exclude test/workflow-authoring/favorite-persistence.integration.test.ts
          --exclude test/workflow-authoring/folders-bulk.integration.test.ts
          --exclude test/workflow-organization-browser.integration.test.ts
          --outputFile=../../artifacts/api-gates.json
      - run: >-
          pnpm --filter @pertexo/database exec vitest run
          --exclude test/workflow-template-origin-boundary.integration.test.ts
          --exclude test/workflow-organization.integration.test.ts
          --exclude test/workflow-organization-read.integration.test.ts
          --exclude test/workflow-organization-readiness.integration.test.ts
          --exclude test/workflow-organization-maintenance-plans.integration.test.ts
          --exclude test/workflow-folders-batch.integration.test.ts
          --exclude test/workflow-organization-adapters.integration.test.ts
          --exclude test/workflow-tags.integration.test.ts
          --outputFile=../../artifacts/database-gates.json
  browser:
    steps:
      - run: pnpm --filter @pertexo/web exec playwright install --with-deps chromium firefox webkit
      - run: pnpm test:browser-probes
  curated-templates:
    env:
      COMPOSE_PROJECT_NAME: pertexo-ci-\${{ github.run_id }}-\${{ github.run_attempt }}-curated-templates
    steps:
      - uses: actions/checkout@test
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@test
        with:
          version: 11.22.0
      - uses: actions/setup-node@test
        with:
          node-version: 24
      - run: pnpm install --frozen-lockfile
      - run: |
          export PNPM_CONFIG_STORE_DIR="$(pnpm store path --silent)"
          export PNPM_CONFIG_CACHE_DIR="$RUNNER_TEMP/curated-cutover-pnpm-cache"
          printf 'PNPM_CONFIG_STORE_DIR=%s\\nPNPM_CONFIG_CACHE_DIR=%s\\n' "$PNPM_CONFIG_STORE_DIR" "$PNPM_CONFIG_CACHE_DIR" >> "$GITHUB_ENV"
          node infrastructure/testing/prepare-curated-cutover-cache.mjs
      - run: pnpm build
      - run: pnpm --filter @pertexo/web exec playwright install --with-deps chromium
      - run: docker compose up -d --wait postgres redis
      - env:
          DATABASE_ADMIN_URL: postgresql://postgres:pertexo-local-superuser@127.0.0.1:5432/postgres
          DATABASE_MIGRATION_URL: postgresql://pertexo_migration:pertexo-local-migration@127.0.0.1:5432/pertexo
          DATABASE_API_URL: postgresql://pertexo_api:pertexo-local-api@127.0.0.1:5432/pertexo
          DATABASE_WORKER_URL: postgresql://pertexo_worker:pertexo-local-worker@127.0.0.1:5432/pertexo
          DATABASE_DISPATCHER_URL: postgresql://pertexo_dispatcher:pertexo-local-dispatcher@127.0.0.1:5432/pertexo
          REDIS_URL: redis://:pertexo-local-redis@127.0.0.1:6379/0
          EDITOR_BROWSER_OWNED_FIXTURE: 'true'
        run: |
          test "$(docker compose port postgres 5432)" = "127.0.0.1:$POSTGRES_PORT"
          test "$(docker compose port redis 6379)" = "127.0.0.1:$REDIS_PORT"
          postgres_id=$(docker inspect --format '{{.Id}}' "$(docker compose ps -q postgres)")
          redis_id=$(docker inspect --format '{{.Id}}' "$(docker compose ps -q redis)")
          export EDITOR_BROWSER_OWNERSHIP_MANIFEST="$postgres_id:$redis_id"
          node infrastructure/testing/run-curated-template-qualification.mjs --reports-directory "$RUNNER_TEMP/curated-template-qualification"
      - if: always()
        run: docker compose down -v --remove-orphans
      - if: always()
        uses: actions/upload-artifact@test
        with:
          path: \${{ runner.temp }}/curated-template-qualification
          if-no-files-found: error
`);
  const organization = clone(workflow.jobs['curated-templates']);
  organization.env.COMPOSE_PROJECT_NAME =
    'pertexo-ci-${{ github.run_id }}-${{ github.run_attempt }}-workflow-organization-qualification';
  for (const step of organization.steps) {
    if (step.run?.includes('prepare-curated-cutover-cache.mjs'))
      step.run = `set -euo pipefail\n${step.run}`;
    if (step.run?.includes('run-curated-template-qualification.mjs')) {
      step.env.DATABASE_MAINTENANCE_URL =
        'postgresql://pertexo_maintenance:pertexo-local-maintenance@127.0.0.1:5432/pertexo';
      step.run = `set -euo pipefail\n${step.run}`
        .replaceAll(
          'curated-template-qualification',
          'workflow-organization-qualification',
        )
        .replace(
          'export EDITOR_BROWSER_OWNERSHIP_MANIFEST="$postgres_id:$redis_id"',
          'export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn --arg project "$COMPOSE_PROJECT_NAME" --arg postgres "$postgres_id" --arg redis "$redis_id" --argjson postgresPort "$POSTGRES_PORT" --argjson redisPort "$REDIS_PORT" \'{project:$project,postgres:{id:$postgres,port:$postgresPort},redis:{id:$redis,port:$redisPort}}\')',
        );
    }
    if (step.with?.path)
      step.with.path = step.with.path.replace(
        'curated-template-qualification',
        'workflow-organization-qualification',
      );
  }
  workflow.jobs['workflow-organization-qualification'] = organization;
  workflow.jobs['inline-workflow-call-http'] = {
    'timeout-minutes': 15,
    env: {
      ...workflow.jobs['curated-templates'].steps.find(
        (step) => step.env?.DATABASE_ADMIN_URL,
      ).env,
      DATABASE_OPERATOR_URL:
        'postgresql://pertexo_operator:pertexo-local-operator@127.0.0.1:5432/pertexo',
      COMPOSE_PROJECT_NAME:
        'pertexo-ci-${{ github.run_id }}-${{ github.run_attempt }}-inline-workflow-call-http',
      INLINE_WORKFLOW_CALL_HTTP_INTEGRATION: 'true',
    },
    steps: [
      { run: 'pnpm install --frozen-lockfile' },
      { run: 'pnpm build' },
      { run: 'docker compose up -d --wait --wait-timeout 120 postgres redis' },
      {
        env: {
          INLINE_WORKFLOW_CALL_GATE_REPORT:
            '${{ runner.temp }}/inline-workflow-call-http/report.json',
        },
        run: [
          'set -euo pipefail',
          'mkdir -p "$RUNNER_TEMP/inline-workflow-call-http"',
          'test "$(docker compose port postgres 5432)" = "127.0.0.1:$POSTGRES_PORT"',
          'test "$(docker compose port redis 6379)" = "127.0.0.1:$REDIS_PORT"',
          INLINE_CALL_HTTP_COMMAND,
          INLINE_CALL_HTTP_VALIDATE_COMMAND,
        ].join('\n'),
      },
      {
        if: 'always()',
        run: 'timeout 120 docker compose down -v --remove-orphans',
      },
      {
        if: 'always()',
        uses: 'actions/upload-artifact@test',
        with: {
          path: '${{ runner.temp }}/inline-workflow-call-http',
          'if-no-files-found': 'error',
        },
      },
    ],
  };
  for (const name of qualityBundleScripts) {
    packageManifest.scripts[name] = 'node fixture.mjs';
  }
  workflow.jobs.quality.steps.splice(2, 0, {
    run: `set -o pipefail\nmkdir -p artifacts\nnode infrastructure/quality/run-ci-quality.mjs --quality ${qualityBundleScripts.join(' ')} --contracts quality:local:check 2>&1 | tee artifacts/quality.log`,
  });
  const ownership = [
    'set -euo pipefail',
    'postgres_id=$(docker inspect --format \'{{.Id}}\' "$(docker compose ps -q postgres)")',
    'redis_id=$(docker inspect --format \'{{.Id}}\' "$(docker compose ps -q redis)")',
    'export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn --arg project "$COMPOSE_PROJECT_NAME" --arg postgres "$postgres_id" --arg redis "$redis_id" --argjson postgresPort "$POSTGRES_PORT" --argjson redisPort "$REDIS_PORT" \'{project:$project,postgres:{id:$postgres,port:$postgresPort},redis:{id:$redis,port:$redisPort}}\')',
  ].join('\n');
  for (const step of workflow.jobs.integration.steps) {
    if (!/artifacts\/(?:api|database)-gates\.json/u.test(step.run)) continue;
    step.env = { EDITOR_BROWSER_OWNED_FIXTURE: 'true' };
    step.run = `${ownership}\n${step.run}`;
  }
  return { packageManifest, workflow };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function currentWorkflow() {
  return parseYaml(
    await readFile(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    ),
  );
}

async function currentPolicyInput() {
  return {
    packageManifest: JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ),
    workflow: await currentWorkflow(),
  };
}

test('bounds browser APT acquisition without changing signed sources or browser coverage', async () => {
  const { workflow } = await currentPolicyInput();
  const browser = workflow.jobs.browser;
  const preparationIndex = browser.steps.findIndex(
    (step) => step.name === 'Bound browser dependency network acquisition',
  );
  assert.ok(preparationIndex >= 0);
  const preparation = browser.steps[preparationIndex];
  assert.equal(preparation.shell, 'bash');
  assert.equal(preparation.if, undefined);
  assert.equal(preparation['continue-on-error'], undefined);
  assert.equal(browser['timeout-minutes'], 15);
  assert.equal(
    browser.steps[preparationIndex + 1].run,
    'pnpm --filter @pertexo/web exec playwright install --with-deps chromium firefox webkit',
  );

  // Execute the actual workflow shell against disposable fixtures, not host APT.
  // Only the three filesystem targets and privilege elevation are substituted.
  const directory = await mkdtemp(path.join(tmpdir(), 'pertexo-browser-apt-'));
  const sources = path.join(directory, 'ubuntu.sources');
  const mirrors = path.join(directory, 'apt-mirrors.txt');
  const configuration = path.join(directory, 'network.conf');
  const mirrorList =
    'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\n' +
    'https://archive.ubuntu.com/ubuntu/\tpriority:2\n' +
    'https://security.ubuntu.com/ubuntu/\tpriority:3\n';
  const signedSources =
    `URIs: mirror+file:${mirrors}\n` +
    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n';
  const command = preparation.run
    .replaceAll('/etc/apt/sources.list.d/ubuntu.sources', sources)
    .replaceAll('/etc/apt/apt-mirrors.txt', mirrors)
    .replaceAll('/etc/apt/apt.conf.d/99-pertexo-browser-network', configuration)
    .replace('sudo tee ', 'tee ');
  const execute = () => promisify(execFile)('bash', ['-c', command]);
  try {
    await writeFile(mirrors, mirrorList);
    await writeFile(sources, signedSources);
    await execute();
    assert.equal(
      await readFile(configuration, 'utf8'),
      'Acquire::http::Timeout "15";\nAcquire::https::Timeout "15";\nAcquire::Retries "1";\n',
    );
    assert.equal(await readFile(mirrors, 'utf8'), mirrorList);
    assert.equal(await readFile(sources, 'utf8'), signedSources);
    for (const invalidMirrors of [
      mirrorList.replace(
        'https://archive.ubuntu.com',
        'http://archive.ubuntu.com',
      ),
      mirrorList.replace('https://archive.ubuntu.com', 'https://example.com'),
      mirrorList.replace('\tpriority:2', '\tpriority:1'),
      mirrorList + 'https://example.com/ubuntu/\tpriority:4\n',
    ]) {
      await rm(configuration, { force: true });
      await writeFile(mirrors, invalidMirrors);
      await assert.rejects(execute);
      await assert.rejects(readFile(configuration), { code: 'ENOENT' });
    }
    await writeFile(mirrors, mirrorList);
    for (const invalidSources of [
      signedSources.replace('mirror+file:', 'https:'),
      signedSources.replace('ubuntu-archive-keyring', 'untrusted-keyring'),
    ]) {
      await writeFile(sources, invalidSources);
      await assert.rejects(execute);
      await assert.rejects(readFile(configuration), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('requires registered inline Call HTTP qualification with strict no-skip evidence', async () => {
  const input = await currentPolicyInput();
  assert.doesNotThrow(() => validateCiGatePolicy(input));
  for (const mutate of [
    (job) => {
      job.if = 'false';
    },
    (job) => {
      job['continue-on-error'] = true;
    },
    (job) => {
      job['timeout-minutes'] = 60;
    },
    (job) => {
      job.env.INLINE_WORKFLOW_CALL_HTTP_INTEGRATION = 'false';
    },
    (job) => {
      job.env.COMPOSE_PROJECT_NAME = 'pertexo-fixed-shared';
    },
    (job) => {
      const step = job.steps.find((step) =>
        step.run?.includes(INLINE_CALL_HTTP_COMMAND),
      );
      job.env.INLINE_WORKFLOW_CALL_GATE_REPORT =
        step.env.INLINE_WORKFLOW_CALL_GATE_REPORT;
      delete step.env.INLINE_WORKFLOW_CALL_GATE_REPORT;
    },
    (job) => {
      job.env.INLINE_WORKFLOW_CALL_GATE_REPORT =
        '${{ runner.temp }}/inline-workflow-call-http/report.json';
    },
    (job) => {
      job.steps.find((step) =>
        step.run?.includes(INLINE_CALL_HTTP_COMMAND),
      ).env.INLINE_WORKFLOW_CALL_GATE_REPORT = '/tmp/incorrect-report.json';
    },
    (job) => {
      job.env.DATABASE_API_URL = 'postgresql://postgres@127.0.0.1:5432/pertexo';
    },
    (job) => {
      job.steps.find((step) =>
        step.run?.includes(INLINE_CALL_HTTP_COMMAND),
      ).if = 'false';
    },
    (job) => {
      job.steps.find((step) =>
        step.run?.includes(INLINE_CALL_HTTP_COMMAND),
      ).run = 'echo passed';
    },
    (job) => {
      const step = job.steps.find((step) =>
        step.run?.includes(INLINE_CALL_HTTP_VALIDATE_COMMAND),
      );
      step.run = step.run.replace("qualification' 1", "qualification' 0");
    },
    (job) => {
      job.steps.find((step) => step.run?.startsWith('docker compose up')).run =
        'docker compose up -d postgres redis';
    },
    (job) => {
      job.steps.find((step) => step.run?.includes('docker compose down')).if =
        'failure()';
    },
    (job) => {
      job.steps.find((step) =>
        step.uses?.startsWith('actions/upload-artifact@'),
      ).with['if-no-files-found'] = 'ignore';
    },
  ]) {
    const changed = clone(input);
    mutate(changed.workflow.jobs['inline-workflow-call-http']);
    assert.throws(() => validateCiGatePolicy(changed), /inline Call HTTP/u);
  }
  const absent = clone(input);
  delete absent.workflow.jobs['inline-workflow-call-http'];
  assert.throws(() => validateCiGatePolicy(absent), /inline Call HTTP/u);
});

function assertRequiredLiveBrowserGate(workflow, gate) {
  const steps = workflow.jobs.browser.steps;
  const normalize = (command) =>
    command
      .replaceAll(/\\\s*\n\s*/gu, ' ')
      .replaceAll(/\s+/gu, ' ')
      .trim();
  const commands = (step) =>
    typeof step.run === 'string'
      ? step.run
          .replaceAll(/\\\s*\n\s*/gu, ' ')
          .split('\n')
          .map(normalize)
      : [];
  const command = `pnpm --filter @pertexo/api exec vitest run --config vitest.integration.config.ts ${gate.file} --reporter=default --reporter=json --outputFile=../../${gate.report}`;
  const runs = steps.filter((step) => commands(step).includes(command));
  assert.equal(
    runs.length,
    1,
    'the browser job must own the live test exactly once',
  );
  const [run] = runs;
  assert.equal(run.if, undefined);
  assert.notEqual(run['continue-on-error'], true);
  assert.equal(run.env[gate.flag], 'true');
  for (const [key, value] of Object.entries(gate.env ?? {}))
    assert.equal(run.env[key], value);
  assert.ok(
    commands(run).includes(
      `node infrastructure/coverage/validate-vitest-gate-report.mjs ${gate.report} '${gate.title}' 1`,
    ),
  );
  const prerequisites = steps.slice(0, steps.indexOf(run));
  for (const prerequisite of [
    'pnpm --filter @pertexo/web exec playwright install --with-deps chromium firefox webkit',
    'pnpm --filter @pertexo/api... build',
    'docker compose up -d --wait postgres redis',
    ...(gate.prerequisites ?? []),
  ]) {
    const step = prerequisites.find(
      (candidate) =>
        typeof candidate.run === 'string' &&
        normalize(candidate.run) === prerequisite,
    );
    assert.ok(step, `missing live browser prerequisite: ${prerequisite}`);
    assert.equal(step.if, undefined);
    assert.notEqual(step['continue-on-error'], true);
  }
  assert.equal(
    workflow.jobs.browser.env.COMPOSE_PROJECT_NAME,
    'pertexo-ci-${{ github.run_id }}-${{ github.run_attempt }}-browser',
  );
  assert.ok(
    steps
      .slice(steps.indexOf(run) + 1)
      .some(
        (step) =>
          step.if === 'always()' &&
          step['continue-on-error'] !== true &&
          step.run === 'docker compose down -v --remove-orphans',
      ),
  );
  assert.ok(
    steps
      .slice(steps.indexOf(run) + 1)
      .some(
        (step) =>
          step.if === 'always()' &&
          step['continue-on-error'] !== true &&
          step.with?.path === gate.report &&
          step.with?.['if-no-files-found'] === 'error',
      ),
  );
}

const usageBrowserGate = Object.freeze({
  file: 'test/usage-browser.integration.test.ts',
  flag: 'USAGE_BROWSER_INTEGRATION',
  report: 'artifacts/usage-browser-gates.json',
  title: 'Usage browser integration gate',
});
const concurrencyBrowserGate = Object.freeze({
  file: 'test/workflow-concurrency-browser.integration.test.ts',
  flag: 'WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION',
  report: 'artifacts/workflow-concurrency-browser-gates.json',
  title: 'Workflow concurrency browser integration gate',
  env: {
    WORKFLOW_CONCURRENCY_COMPOSE_PROJECT: '${{ env.COMPOSE_PROJECT_NAME }}',
  },
  prerequisites: ['pnpm --filter @pertexo/worker... build'],
});
const connectionHealthBrowserGate = Object.freeze({
  file: 'test/connection-health-browser.integration.test.ts',
  flag: 'CONNECTION_HEALTH_BROWSER_INTEGRATION',
  report: 'artifacts/connection-health-browser-gates.json',
  title: 'Connection health browser integration gate',
  env: { CONNECTION_HEALTH_COMPOSE_PROJECT: '${{ env.COMPOSE_PROJECT_NAME }}' },
  prerequisites: ['pnpm --filter @pertexo/worker... build'],
});

const duplicationBrowserGate = Object.freeze({
  file: 'test/editor-browser.integration.test.ts',
  flag: 'EDITOR_BROWSER_INTEGRATION',
  report: 'artifacts/workflow-duplication-browser-gates.json',
  title: 'Workflow duplication browser integration gate',
  env: {
    EDITOR_BROWSER_CASE: 'duplication',
    EDITOR_BROWSER_OWNED_FIXTURE: 'true',
  },
  prerequisites: ['pnpm --filter @pertexo/worker... build'],
});
const inputCasesBrowserGate = Object.freeze({
  file: 'test/editor-browser.integration.test.ts',
  flag: 'EDITOR_BROWSER_INTEGRATION',
  report: 'artifacts/workflow-input-cases-browser-gates.json',
  title: 'Workflow input cases browser integration gate',
  env: {
    EDITOR_BROWSER_CASE: 'input-cases',
    EDITOR_BROWSER_OWNED_FIXTURE: 'true',
  },
  prerequisites: ['pnpm --filter @pertexo/worker... build'],
});
test('owns enabled input case browser evidence and retains real HTTP in ordinary CI', async () => {
  const workflow = await currentWorkflow();
  assertRequiredLiveBrowserGate(workflow, inputCasesBrowserGate);
  const browser = workflow.jobs.browser.steps.find(
    (step) => step.env?.EDITOR_BROWSER_CASE === 'input-cases',
  );
  assert.ok(
    browser.run.includes('export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn'),
  );
  assert.ok(browser.run.includes('docker inspect --format'));
  const integration = workflow.jobs.integration.steps.find((step) =>
    step.run?.includes('artifacts/api-gates.json'),
  );
  assert.ok(
    !integration.run.includes(
      '--exclude test/workflow-authoring/input-cases.integration.test.ts',
    ),
  );
  assert.equal(workflow.env.API_IDENTITY_INTEGRATION, 'true');
});
test('rejects disabled, substituted and zero-minimum input case browser evidence', async () => {
  for (const mutate of [
    (step) => {
      step.if = 'false';
    },
    (step) => {
      step['continue-on-error'] = true;
    },
    (step) => {
      step.env.EDITOR_BROWSER_CASE = 'duplication';
    },
    (step) => {
      step.env.EDITOR_BROWSER_INTEGRATION = 'false';
    },
    (step) => {
      step.env.EDITOR_BROWSER_OWNED_FIXTURE = 'false';
    },
    (step) => {
      step.run = step.run.replace(
        "'Workflow input cases browser integration gate' 1",
        "'Workflow input cases browser integration gate' 0",
      );
    },
  ]) {
    const workflow = await currentWorkflow();
    mutate(
      workflow.jobs.browser.steps.find(
        (step) => step.env?.EDITOR_BROWSER_CASE === 'input-cases',
      ),
    );
    assert.throws(() =>
      assertRequiredLiveBrowserGate(workflow, inputCasesBrowserGate),
    );
  }
});

const portabilityBrowserGate = Object.freeze({
  ...duplicationBrowserGate,
  report: 'artifacts/workflow-portability-browser-gates.json',
  title: 'Workflow portability browser integration gate',
  env: {
    EDITOR_BROWSER_CASE: 'portability',
    EDITOR_BROWSER_OWNED_FIXTURE: 'true',
  },
});

test('owns enabled portability browser proof and ordinary HTTP/database integration tests', async () => {
  const workflow = await currentWorkflow();
  assertRequiredLiveBrowserGate(workflow, portabilityBrowserGate);
  const browser = workflow.jobs.browser.steps.find(
    (step) => step.env?.EDITOR_BROWSER_CASE === 'portability',
  );
  assert.ok(
    browser.run.includes('export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn'),
  );
  assert.ok(browser.run.includes('docker inspect --format'));
  const integration = workflow.jobs.integration.steps;
  const api = integration.find((step) =>
    step.run?.includes('artifacts/api-gates.json'),
  );
  const database = integration.find((step) =>
    step.run?.includes('artifacts/database-gates.json'),
  );
  assert.ok(
    !api.run.includes(
      '--exclude test/workflow-authoring/portability.integration.test.ts',
    ),
  );
  assert.ok(
    !database.run.includes(
      '--exclude test/workflow-authoring-portability.integration.test.ts',
    ),
  );
  assert.equal(workflow.env.API_IDENTITY_INTEGRATION, 'true');
});

test('rejects disabled, unowned or zero-minimum portability browser proof', async () => {
  for (const mutate of [
    (step) => {
      step.if = 'false';
    },
    (step) => {
      step['continue-on-error'] = true;
    },
    (step) => {
      step.env.EDITOR_BROWSER_CASE = 'duplication';
    },
    (step) => {
      step.env.EDITOR_BROWSER_INTEGRATION = 'false';
    },
    (step) => {
      step.env.EDITOR_BROWSER_OWNED_FIXTURE = 'false';
    },
    (step) => {
      step.run = step.run.replace(
        "'Workflow portability browser integration gate' 1",
        "'Workflow portability browser integration gate' 0",
      );
    },
  ]) {
    const workflow = await currentWorkflow();
    mutate(
      workflow.jobs.browser.steps.find(
        (step) => step.env?.EDITOR_BROWSER_CASE === 'portability',
      ),
    );
    assert.throws(() =>
      assertRequiredLiveBrowserGate(workflow, portabilityBrowserGate),
    );
  }
});

test('owns enabled duplication browser evidence and keeps duplication HTTP/database tests in ordinary CI', async () => {
  const workflow = await currentWorkflow();
  assertRequiredLiveBrowserGate(workflow, duplicationBrowserGate);
  const browser = workflow.jobs.browser.steps.find(
    (step) => step.env?.EDITOR_BROWSER_CASE === 'duplication',
  );
  assert.ok(
    browser.run.includes('export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn'),
  );
  assert.ok(browser.run.includes('docker inspect --format'));
  const integration = workflow.jobs.integration.steps.find((step) =>
    step.run?.includes('artifacts/api-gates.json'),
  );
  assert.ok(
    !integration.run.includes(
      '--exclude test/workflow-authoring/duplicate.integration.test.ts',
    ),
  );
  assert.equal(workflow.env.API_IDENTITY_INTEGRATION, 'true');
});

test('rejects disabled, differently selected or zero-minimum duplication browser evidence', async () => {
  for (const mutate of [
    (step) => {
      step.if = 'false';
    },
    (step) => {
      step['continue-on-error'] = true;
    },
    (step) => {
      step.env.EDITOR_BROWSER_CASE = 'nested-conflict';
    },
    (step) => {
      step.env.EDITOR_BROWSER_INTEGRATION = 'false';
    },
    (step) => {
      step.env.EDITOR_BROWSER_OWNED_FIXTURE = 'false';
    },
    (step) => {
      step.run = step.run.replace(
        "'Workflow duplication browser integration gate' 1",
        "'Workflow duplication browser integration gate' 0",
      );
    },
  ]) {
    const workflow = await currentWorkflow();
    mutate(
      workflow.jobs.browser.steps.find(
        (step) => step.env?.EDITOR_BROWSER_CASE === 'duplication',
      ),
    );
    assert.throws(() =>
      assertRequiredLiveBrowserGate(workflow, duplicationBrowserGate),
    );
  }
});

test('routes connection health through one enabled strict API/worker/browser proof and keeps real HTTP in ordinary integration', async () => {
  const workflow = await currentWorkflow();
  assertRequiredLiveBrowserGate(workflow, connectionHealthBrowserGate);
  const step = workflow.jobs.integration.steps.find((candidate) =>
    candidate.run?.includes('artifacts/api-gates.json'),
  );
  assert.equal(
    step.env.CONNECTION_HEALTH_COMPOSE_PROJECT,
    '${{ env.COMPOSE_PROJECT_NAME }}',
  );
  assert.ok(
    !step.run.includes(
      '--exclude test/connection-health-http.integration.test.ts',
    ),
  );
});

test('rejects optional or unfenced connection health browser evidence', async () => {
  for (const mutate of [
    (step) => {
      step.if = 'false';
    },
    (step) => {
      step['continue-on-error'] = true;
    },
    (step) => {
      step.env.CONNECTION_HEALTH_BROWSER_INTEGRATION = 'false';
    },
    (step) => {
      delete step.env.CONNECTION_HEALTH_COMPOSE_PROJECT;
    },
    (step) => {
      step.env.CONNECTION_HEALTH_COMPOSE_PROJECT = 'pertexo';
    },
    (step) => {
      step.run = step.run.replace(
        "'Connection health browser integration gate' 1",
        "'Connection health browser integration gate' 0",
      );
    },
  ]) {
    const workflow = await currentWorkflow();
    const step = workflow.jobs.browser.steps.find(
      (candidate) =>
        candidate.env?.CONNECTION_HEALTH_BROWSER_INTEGRATION !== undefined,
    );
    mutate(step);
    assert.throws(() =>
      assertRequiredLiveBrowserGate(workflow, connectionHealthBrowserGate),
    );
  }
});

test('routes the real Usage browser journey to an enabled browser-installed gate with strict evidence', async () => {
  assertRequiredLiveBrowserGate(await currentWorkflow(), usageBrowserGate);
});

test('routes the real concurrency browser journey to an enabled API/worker/browser gate with strict evidence', async () => {
  const workflow = await currentWorkflow();
  assertRequiredLiveBrowserGate(workflow, concurrencyBrowserGate);
  assert.equal(workflow.env.API_IDENTITY_INTEGRATION, 'true');
  for (const name of [
    'DATABASE_ADMIN_URL',
    'DATABASE_MIGRATION_URL',
    'DATABASE_API_URL',
    'DATABASE_WORKER_URL',
    'DATABASE_DISPATCHER_URL',
    'DATABASE_MAINTENANCE_URL',
    'DATABASE_LIFECYCLE_COMMAND_URL',
    'DATABASE_OPERATOR_URL',
    'REDIS_URL',
  ]) {
    const url = new URL(workflow.env[name]);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(url.protocol, name === 'REDIS_URL' ? 'redis:' : 'postgresql:');
    assert.equal(
      url.port,
      name === 'REDIS_URL'
        ? workflow.env.REDIS_PORT
        : workflow.env.POSTGRES_PORT,
    );
  }
});

test('rejects missing, optional or incorrectly owned concurrency browser proof routes', async () => {
  const original = await currentWorkflow();
  const runStep = (workflow) =>
    workflow.jobs.browser.steps.find(
      (step) =>
        step.env?.WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION !== undefined,
    );
  const buildStep = (workflow) =>
    workflow.jobs.browser.steps.find(
      (step) => step.run === 'pnpm --filter @pertexo/worker... build',
    );
  for (const mutate of [
    (workflow) => {
      runStep(workflow).if = 'false';
    },
    (workflow) => {
      runStep(workflow)['continue-on-error'] = true;
    },
    (workflow) => {
      runStep(workflow).env.WORKFLOW_CONCURRENCY_BROWSER_INTEGRATION = 'false';
    },
    (workflow) => {
      delete runStep(workflow).env.WORKFLOW_CONCURRENCY_COMPOSE_PROJECT;
    },
    (workflow) => {
      runStep(workflow).env.WORKFLOW_CONCURRENCY_COMPOSE_PROJECT = 'pertexo';
    },
    (workflow) => {
      buildStep(workflow).if = 'false';
    },
    (workflow) => {
      buildStep(workflow)['continue-on-error'] = true;
    },
    (workflow) => {
      const steps = workflow.jobs.browser.steps;
      steps.push(...steps.splice(steps.indexOf(buildStep(workflow)), 1));
    },
    (workflow) => {
      runStep(workflow).run = runStep(workflow)
        .run.split('\n')
        .filter(
          (line) =>
            !line.includes('validate-vitest-gate-report') &&
            !line.includes("'Workflow concurrency browser integration gate'"),
        )
        .join('\n');
    },
    (workflow) => {
      workflow.jobs.browser.steps.find(
        (step) => step.with?.path === concurrencyBrowserGate.report,
      ).with['if-no-files-found'] = 'ignore';
    },
    (workflow) => {
      workflow.jobs.browser.steps.find(
        (step) => step.run === 'docker compose down -v --remove-orphans',
      ).if = 'success()';
    },
    (workflow) => {
      workflow.jobs.browser.steps.find(
        (step) => step.run === 'docker compose down -v --remove-orphans',
      )['continue-on-error'] = true;
    },
    (workflow) => {
      workflow.jobs.browser.steps.find(
        (step) => step.with?.path === concurrencyBrowserGate.report,
      )['continue-on-error'] = true;
    },
  ]) {
    const workflow = clone(original);
    mutate(workflow);
    assert.throws(() =>
      assertRequiredLiveBrowserGate(workflow, concurrencyBrowserGate),
    );
  }
});

test('rejects missing or weakened ordinary draft integration ownership', () => {
  for (const report of ['api', 'database']) {
    for (const mutate of [
      (step) => delete step.env.EDITOR_BROWSER_OWNED_FIXTURE,
      (step) => (step.env.EDITOR_BROWSER_OWNED_FIXTURE = 'false'),
      (step) => (step.if = 'false'),
      (step) => (step['continue-on-error'] = true),
      (step) => (step.run = step.run.replace('set -euo pipefail', 'set -e')),
      (step) =>
        (step.run = step.run.replace(
          'export EDITOR_BROWSER_OWNERSHIP_MANIFEST=$(jq -cn',
          'export OTHER_MANIFEST=$(jq -cn',
        )),
      (step) =>
        (step.run = step.run.replace('docker inspect', 'echo fake-container')),
      (step) =>
        (step.run = step.run.replace(
          '$COMPOSE_PROJECT_NAME',
          'pertexo-shared',
        )),
      (step) => (step.run = step.run.replace('$POSTGRES_PORT', '55435')),
      (step) => (step.run = step.run.replace('$REDIS_PORT', '56379')),
      (step) => {
        const lines = step.run.split('\n');
        const manifest = lines.splice(3, 1)[0];
        step.run = [...lines, manifest].join('\n');
      },
    ]) {
      const input = fixture();
      const step = input.workflow.jobs.integration.steps.find((candidate) =>
        candidate.run.includes(`artifacts/${report}-gates.json`),
      );
      mutate(step);
      assert.throws(
        () => validateCiGatePolicy(input),
        /ordinary draft integration/u,
      );
    }
  }
});

test('accepts the required local, ordinary-CI, and deliberate exclusion mapping', () => {
  assert.deepEqual(validateCiGatePolicy(fixture()), {
    requiredGates: [
      'architecture:check',
      'built-exports:check',
      'quality:local:check',
    ],
  });
});

test('rejects an omitted or duplicated ordinary CI gate', () => {
  const omitted = fixture();
  const architectureIndex = omitted.workflow.jobs.quality.steps.findIndex(
    (step) => step.run === 'pnpm architecture:check',
  );
  omitted.workflow.jobs.quality.steps.splice(architectureIndex, 1);
  assert.throws(
    () => validateCiGatePolicy(omitted),
    /architecture:check exactly once; observed 0/u,
  );

  const duplicated = fixture();
  duplicated.workflow.jobs.quality.steps.push({
    run: 'pnpm built-exports:check',
  });
  assert.throws(
    () => validateCiGatePolicy(duplicated),
    /built-exports:check exactly once; observed 2/u,
  );
});

test('rejects a missing or duplicated original quality-bundle command', () => {
  for (const name of qualityBundleScripts) {
    const omitted = fixture();
    const omittedStep = omitted.workflow.jobs.quality.steps.find((step) =>
      step.run.includes('--quality'),
    );
    omittedStep.run = omittedStep.run.replace(` ${name} `, ' ');
    assert.throws(() => validateCiGatePolicy(omitted), /exactly once/u);
    const duplicated = fixture();
    const duplicatedStep = duplicated.workflow.jobs.quality.steps.find((step) =>
      step.run.includes('--quality'),
    );
    duplicatedStep.run = duplicatedStep.run.replace(
      ` ${name} `,
      ` ${name} ${name} `,
    );
    assert.throws(() => validateCiGatePolicy(duplicated), /exactly once/u);
  }
});

test('requires the unchanged quality deadline and build before every quality gate', () => {
  const longer = fixture();
  longer.workflow.jobs.quality['timeout-minutes'] = 30;
  assert.throws(() => validateCiGatePolicy(longer), /15-minute/u);
  for (const name of [...qualityBundleScripts, 'quality:local:check']) {
    const early = fixture();
    const steps = early.workflow.jobs.quality.steps;
    const index = steps.findIndex((step) => step.run.includes(` ${name} `));
    steps.unshift(...steps.splice(index, 1));
    assert.throws(() => validateCiGatePolicy(early), /build before/u);
  }
});

test('rejects built-export validation before its build owner', () => {
  const input = fixture();
  const steps = input.workflow.jobs.quality.steps;
  const buildIndex = steps.findIndex((step) => step.run === 'pnpm build');
  const exportIndex = steps.findIndex(
    (step) => step.run === 'pnpm built-exports:check',
  );
  [steps[buildIndex], steps[exportIndex]] = [
    steps[exportIndex],
    steps[buildIndex],
  ];
  assert.throws(
    () => validateCiGatePolicy(input),
    /quality job must build before validating built exports/u,
  );

  const local = fixture();
  local.packageManifest.scripts.check =
    'pnpm ci:gates:check && pnpm quality:local:check && pnpm architecture:check && pnpm built-exports:check && pnpm build';
  assert.throws(
    () => validateCiGatePolicy(local),
    /check script must build before validating built exports/u,
  );
});

test('rejects an unknown direct package command', () => {
  const input = fixture();
  input.workflow.jobs.integration.steps.push({ run: 'pnpm unknown:check' });
  assert.throws(
    () => validateCiGatePolicy(input),
    /integration job invokes unknown package script unknown:check/u,
  );
});

test('the concrete joined command rejects hidden, missing, duplicated, conditional, and reordered gates', async () => {
  const original = await currentPolicyInput();
  const joined = (input) =>
    input.workflow.jobs.quality.steps.find((step) =>
      step.run?.includes('node infrastructure/quality/run-ci-quality.mjs'),
    );
  assert.ok(joined(original));
  for (const mutate of [
    (input) => {
      joined(input).run = joined(input).run.replace(' lint ', ' ');
    },
    (input) => {
      joined(input).run = joined(input).run.replace(' lint ', ' lint lint ');
    },
    (input) => {
      joined(input).run = joined(input).run.replace(
        ' lint ',
        ' unknown:check ',
      );
    },
    (input) => {
      joined(input).run = joined(input)
        .run.replace('--quality docs:check', '--quality format:check')
        .replace('format:check runtime:check', 'docs:check runtime:check');
    },
    (input) => {
      joined(input).run += '\ntrue';
    },
    (input) => {
      joined(input).run = joined(input).run.replace(
        'set -o pipefail',
        'set +o pipefail',
      );
    },
    (input) => {
      joined(input).if = 'success()';
    },
    (input) => {
      joined(input)['continue-on-error'] = true;
    },
    (input) => {
      input.workflow.jobs.quality.steps.push({ ...joined(input) });
    },
    (input) => {
      const steps = input.workflow.jobs.quality.steps;
      const index = steps.findIndex(
        (step) => step.run === 'pnpm architecture:check',
      );
      steps.unshift(...steps.splice(index, 1));
    },
    (input) => {
      const steps = input.workflow.jobs.quality.steps;
      const index = steps.findIndex(
        (step) => step.run === 'pnpm built-exports:check',
      );
      const joinIndex = steps.indexOf(joined(input));
      steps.splice(joinIndex, 0, ...steps.splice(index, 1));
    },
  ]) {
    const input = clone(original);
    mutate(input);
    assert.throws(() => validateCiGatePolicy(input));
  }
});

test('quality owner cannot skip, hide, redirect, or replace required lane execution', async () => {
  const original = await currentPolicyInput();
  const joined = (input) =>
    input.workflow.jobs.quality.steps.find((step) =>
      step.run?.includes('node infrastructure/quality/run-ci-quality.mjs'),
    );
  const build = (input) =>
    input.workflow.jobs.quality.steps.find((step) => step.run === 'pnpm build');
  for (const mutate of [
    (input) => {
      input.workflow.jobs.quality.if = 'false';
    },
    (input) => {
      input.workflow.jobs.quality.needs = 'optional-job';
    },
    (input) => {
      input.workflow.jobs.quality.strategy = { matrix: { gate: ['quality'] } };
    },
    (input) => {
      input.workflow.jobs.quality['continue-on-error'] = true;
    },
    (input) => {
      input.workflow.jobs.quality['continue-on-error'] = '${{ true }}';
    },
    (input) => {
      input.workflow.jobs.quality.defaults = { run: { shell: 'true {0}' } };
    },
    (input) => {
      input.workflow.defaults = { run: { shell: 'true {0}' } };
    },
    (input) => {
      joined(input).shell = 'true {0}';
    },
    (input) => {
      joined(input)['continue-on-error'] = '${{ true }}';
    },
    (input) => {
      build(input).if = 'false';
    },
    (input) => {
      build(input)['continue-on-error'] = '${{ true }}';
    },
    (input) => {
      build(input).shell = 'true {0}';
    },
    (input) => {
      build(input)['working-directory'] = 'packages/database';
    },
    (input) => {
      input.workflow.jobs.quality.steps.find(
        (step) => step.run === 'pnpm architecture:check',
      ).shell = 'true {0}';
    },
    (input) => {
      input.workflow.jobs.quality.steps.find(
        (step) => step.run === 'pnpm ci:gates:check',
      ).if = 'false';
    },
    (input) => {
      input.workflow.jobs.quality.steps.push({ run: "bash -c 'pnpm lint'" });
    },
    (input) => {
      const steps = input.workflow.jobs.quality.steps;
      steps.splice(
        steps.indexOf(joined(input)),
        1,
        ...[...qualityBundleScripts, 'quality:local:check'].map((name) => ({
          run: `pnpm ${name}`,
        })),
      );
    },
  ]) {
    const input = clone(original);
    mutate(input);
    assert.throws(() => validateCiGatePolicy(input));
  }
  const safeExplicitShell = clone(original);
  safeExplicitShell.workflow.jobs.quality.defaults = {
    run: { shell: 'bash', 'working-directory': '.' },
  };
  safeExplicitShell.workflow.jobs.quality['continue-on-error'] = false;
  assert.doesNotThrow(() => validateCiGatePolicy(safeExplicitShell));
});

test('rejects missing local ownership and an opaque root script', () => {
  const missing = fixture();
  missing.packageManifest.scripts.check =
    'pnpm ci:gates:check && pnpm quality:local:check && pnpm build && pnpm built-exports:check';
  assert.throws(
    () => validateCiGatePolicy(missing),
    /check script must invoke architecture:check exactly once; observed 0/u,
  );

  const opaque = fixture();
  opaque.packageManifest.scripts.check = 'pnpm build; pnpm built-exports:check';
  assert.throws(
    () => validateCiGatePolicy(opaque),
    /sequence of named pnpm scripts/u,
  );
});

test('rejects full local qualification in ordinary CI and misplaced mutation execution', () => {
  const fullQualification = fixture();
  fullQualification.workflow.jobs.quality.steps.push({
    run: 'pnpm quality:local',
  });
  assert.throws(
    () => validateCiGatePolicy(fullQualification),
    /quality:local must remain excluded from ordinary CI/u,
  );

  const misplacedMutation = clone(fixture());
  misplacedMutation.workflow.jobs.integration.steps =
    misplacedMutation.workflow.jobs.integration.steps.filter(
      (step) => step.run !== 'pnpm mutation:check',
    );
  misplacedMutation.workflow.jobs.quality.steps.push({
    run: 'pnpm mutation:check',
  });
  assert.throws(
    () => validateCiGatePolicy(misplacedMutation),
    /mutation:check must be owned exactly once by the integration job/u,
  );

  const changedMutation = fixture();
  changedMutation.packageManifest.scripts['mutation:check'] =
    'node another-mutation-runner.mjs';
  assert.throws(
    () => validateCiGatePolicy(changedMutation),
    /mutation:check must retain the local qualification implementation/u,
  );
});

test('requires performance validation beneath the local runner contract gate', () => {
  const input = fixture();
  input.packageManifest.scripts['quality:local:check'] =
    'pnpm quality:local:contracts';
  assert.throws(
    () => validateCiGatePolicy(input),
    /performance:local:check exactly once; observed 0/u,
  );
});

test('requires browser probes exactly once in the installed-browser lane', () => {
  for (const change of ['omitted', 'duplicated', 'misplaced']) {
    const input = fixture();
    if (change === 'duplicated')
      input.workflow.jobs.browser.steps.push({
        run: 'pnpm test:browser-probes',
      });
    else {
      input.workflow.jobs.browser.steps.pop();
      if (change === 'misplaced')
        input.workflow.jobs.quality.steps.push({
          run: 'pnpm test:browser-probes',
        });
    }
    assert.throws(
      () => validateCiGatePolicy(input),
      /test:browser-probes must be owned exactly once by the browser job/u,
    );
  }
});

test('rejects optional probes or missing, late or optional browser installation', () => {
  for (const change of [
    'optional-probes',
    'allowed-failure',
    'missing-install',
    'late-install',
    'optional-install',
  ]) {
    const input = fixture();
    const steps = input.workflow.jobs.browser.steps;
    if (change === 'optional-probes') steps[1].if = 'false';
    if (change === 'allowed-failure') steps[1]['continue-on-error'] = true;
    if (change === 'missing-install') steps.shift();
    if (change === 'late-install') steps.reverse();
    if (change === 'optional-install') steps[0].if = 'false';
    assert.throws(
      () => validateCiGatePolicy(input),
      /browser (?:probes|installation) must/u,
    );
  }
});

test('requires local pre-push to execute the separate browser probes', () => {
  const input = fixture();
  input.packageManifest.scripts['prepush:check'] =
    'pnpm check && pnpm test:coverage';
  assert.throws(
    () => validateCiGatePolicy(input),
    /prepush:check script must invoke test:browser-probes exactly once/u,
  );
});

test('requires the fast pre-push gate to keep every static gate from check', () => {
  const input = fixture();
  input.packageManifest.scripts['prepush:fast'] =
    'pnpm ci:gates:check && pnpm build && pnpm built-exports:check && pnpm prepush:changed';
  assert.throws(
    () => validateCiGatePolicy(input),
    /prepush:fast script must invoke quality:local:check exactly once/u,
  );
});

test('lets the fast pre-push gate scope lint, typecheck, and tests to the change', () => {
  const input = fixture();
  input.packageManifest.scripts.check +=
    ' && pnpm lint && pnpm typecheck && pnpm test';
  assert.equal(validateCiGatePolicy(input).requiredGates.length, 3);

  input.packageManifest.scripts['prepush:fast'] =
    'pnpm ci:gates:check && pnpm quality:local:check && pnpm architecture:check && pnpm build && pnpm built-exports:check';
  assert.throws(
    () => validateCiGatePolicy(input),
    /prepush:fast script must invoke prepush:changed exactly once/u,
  );
});

test('requires the fast pre-push gate to build before validating exports', () => {
  const input = fixture();
  input.packageManifest.scripts['prepush:fast'] =
    'pnpm ci:gates:check && pnpm quality:local:check && pnpm architecture:check && pnpm built-exports:check && pnpm build && pnpm prepush:changed';
  assert.throws(
    () => validateCiGatePolicy(input),
    /prepush:fast script must build before validating built exports/u,
  );
});

test('rejects orphaned curated-template owned fixtures in ordinary CI', async () => {
  const { packageManifest, workflow } = await currentPolicyInput();
  delete workflow.jobs['curated-templates'];
  assert.throws(
    () => validateCiGatePolicy({ packageManifest, workflow }),
    /curated-template.*owner/u,
  );
});

const organizationJob = (input) =>
  input.workflow.jobs['workflow-organization-qualification'];
const organizationRun = (input) =>
  organizationJob(input).steps.find((step) =>
    step.run?.includes('run-workflow-organization-qualification.mjs'),
  );

test('routes every F07 fixture to its exact owner without excluding ordinary behavior', async () => {
  const original = await currentPolicyInput();
  for (const gate of WORKFLOW_ORGANIZATION_GATES.filter((gate) =>
    [
      'organization-database',
      'organization-api',
      'organization-browser',
    ].includes(gate.id),
  )) {
    const report = gate.id === 'organization-database' ? 'database' : 'api';
    for (const file of gate.command.filter((argument) =>
      argument.startsWith('test/'),
    )) {
      const input = clone(original);
      const step = input.workflow.jobs.integration.steps.find((candidate) =>
        candidate.run?.includes(`artifacts/${report}-gates.json`),
      );
      step.run = step.run.replace(`--exclude ${file}`, '');
      assert.throws(
        () => validateCiGatePolicy(input),
        /ordinary (?:API|database)/u,
        file,
      );
    }
  }
  for (const report of ['api', 'database']) {
    const input = clone(original);
    const step = input.workflow.jobs.integration.steps.find((candidate) =>
      candidate.run?.includes(`artifacts/${report}-gates.json`),
    );
    step.run = step.run.replace(
      `--outputFile=../../artifacts/${report}-gates.json`,
      `--exclude test/ordinary-behavior.integration.test.ts --outputFile=../../artifacts/${report}-gates.json`,
    );
    assert.throws(
      () => validateCiGatePolicy(input),
      /ordinary (?:API|database)/u,
    );
  }
});

test('requires the dedicated F07 qualification owner and fail-closed exact runner', async () => {
  const original = await currentPolicyInput();
  assert.doesNotThrow(() => validateCiGatePolicy(original));
  for (const [label, mutate] of [
    [
      'omitted job',
      (input) => {
        delete input.workflow.jobs['workflow-organization-qualification'];
      },
    ],
    [
      'conditional job',
      (input) => {
        organizationJob(input).if = 'false';
      },
    ],
    [
      'optional job',
      (input) => {
        organizationJob(input)['continue-on-error'] = true;
      },
    ],
    [
      'shared project',
      (input) => {
        organizationJob(input).env.COMPOSE_PROJECT_NAME =
          original.workflow.jobs['curated-templates'].env.COMPOSE_PROJECT_NAME;
      },
    ],
    [
      'missing runner',
      (input) => {
        const job = organizationJob(input);
        job.steps = job.steps.filter((step) => step !== organizationRun(input));
      },
    ],
    [
      'conditional runner',
      (input) => {
        organizationRun(input).if = 'false';
      },
    ],
    [
      'optional runner',
      (input) => {
        organizationRun(input)['continue-on-error'] = true;
      },
    ],
    [
      'substitute runner',
      (input) => {
        organizationRun(input).run = organizationRun(input).run.replace(
          'run-workflow-organization-qualification.mjs',
          'run-curated-template-qualification.mjs',
        );
      },
    ],
    [
      'different reports',
      (input) => {
        organizationRun(input).run = organizationRun(input).run.replace(
          '$RUNNER_TEMP/workflow-organization-qualification',
          '/tmp/old-reports',
        );
      },
    ],
    [
      'ignored failure',
      (input) => {
        organizationRun(input).run += ' || true';
      },
    ],
    [
      'conditional command',
      (input) => {
        organizationRun(input).run = organizationRun(input).run.replace(
          'node infrastructure/testing/run-workflow-organization',
          'false && node infrastructure/testing/run-workflow-organization',
        );
      },
    ],
    [
      'no fail-closed shell',
      (input) => {
        organizationRun(input).run = organizationRun(input).run.replace(
          'set -euo pipefail',
          'set +e',
        );
      },
    ],
  ]) {
    const input = clone(original);
    mutate(input);
    assert.throws(
      () => validateCiGatePolicy(input),
      /workflow-organization/u,
      label,
    );
  }
});

test('rejects unsafe F07 role URLs, lost ownership, and weakened fixture witnesses', async () => {
  const original = await currentPolicyInput();
  const run = organizationRun(original);
  for (const name of Object.keys(run.env)) {
    for (const mutation of ['missing', 'foreign']) {
      const input = clone(original);
      if (mutation === 'missing')
        Reflect.deleteProperty(organizationRun(input).env, name);
      else
        organizationRun(input).env[name] =
          name === 'EDITOR_BROWSER_OWNED_FIXTURE'
            ? 'false'
            : 'postgresql://wrong:wrong@remote.example.test:5432/pertexo';
      assert.throws(
        () => validateCiGatePolicy(input),
        /workflow-organization/u,
        `${name}:${mutation}`,
      );
    }
  }
  for (const [before, after] of [
    ['docker inspect --format', 'echo'],
    ['docker compose ps -q postgres', 'docker compose ps -q shared-postgres'],
    ['docker compose ps -q redis', 'docker compose ps -q shared-redis'],
    ['EDITOR_BROWSER_OWNERSHIP_MANIFEST', 'OTHER_MANIFEST'],
    ['$(jq -cn', '$(echo'],
    [
      'test "$(docker compose port postgres 5432)"',
      'echo "$(docker compose port postgres 5432)"',
    ],
    ['127.0.0.1:$REDIS_PORT', '0.0.0.0:$REDIS_PORT'],
    ['--arg project "$COMPOSE_PROJECT_NAME"', '--arg project shared'],
    ['--argjson postgresPort "$POSTGRES_PORT"', '--argjson postgresPort 5433'],
    [
      'postgres:{id:$postgres,port:$postgresPort}',
      'postgres:{id:$redis,port:$postgresPort}',
    ],
  ]) {
    const input = clone(original);
    organizationRun(input).run = organizationRun(input).run.replace(
      before,
      after,
    );
    assert.throws(
      () => validateCiGatePolicy(input),
      /workflow-organization/u,
      before,
    );
  }
});

test('requires F07 full history, frozen install, normal build, Chromium, and shared archived cache', async () => {
  const original = await currentPolicyInput();
  for (const selector of [
    (step) => step.uses?.startsWith('actions/checkout@'),
    (step) => step.uses?.startsWith('actions/setup-node@'),
    (step) => step.uses?.startsWith('pnpm/action-setup@'),
    (step) => step.run === 'pnpm install --frozen-lockfile',
    (step) => step.run === 'pnpm build',
    (step) => step.run?.includes('playwright install'),
    (step) => step.run === 'docker compose up -d --wait postgres redis',
    (step) => step.run?.includes('prepare-curated-cutover-cache.mjs'),
  ]) {
    for (const mutation of [
      'missing',
      'optional',
      'conditional',
      'late',
      'duplicate',
    ]) {
      const input = clone(original);
      const job = organizationJob(input);
      const step = job.steps.find(selector);
      if (mutation === 'missing') job.steps.splice(job.steps.indexOf(step), 1);
      if (mutation === 'optional') step['continue-on-error'] = true;
      if (mutation === 'conditional') step.if = 'false';
      if (mutation === 'duplicate') job.steps.push(clone(step));
      if (mutation === 'late') {
        // The build, browser, services, and cache must precede qualification.
        if (step.uses || step.run === 'pnpm install --frozen-lockfile')
          continue;
        job.steps.splice(job.steps.indexOf(step), 1);
        job.steps.push(step);
      }
      assert.throws(
        () => validateCiGatePolicy(input),
        /workflow-organization/u,
        mutation,
      );
    }
  }
  for (const [before, after] of [
    ['$(pnpm store path --silent)', '/tmp/another-store'],
    ['$RUNNER_TEMP/curated-cutover-pnpm-cache', '/tmp/another-cache'],
    ['>> "$GITHUB_ENV"', ''],
    ['prepare-curated-cutover-cache.mjs', 'prepare-another-cache.mjs'],
    [
      'prepare-curated-cutover-cache.mjs',
      'prepare-curated-cutover-cache.mjs || true',
    ],
    ['set -euo pipefail', 'set +e'],
  ]) {
    const input = clone(original);
    const preparation = organizationJob(input).steps.find((step) =>
      step.run?.includes('prepare-curated-cutover-cache.mjs'),
    );
    preparation.run = preparation.run.replace(before, after);
    assert.throws(
      () => validateCiGatePolicy(input),
      /workflow-organization/u,
      before,
    );
  }
  for (const [action, setting, weakened] of [
    ['actions/checkout@', 'fetch-depth', 1],
    ['actions/setup-node@', 'node-version', 22],
    ['pnpm/action-setup@', 'version', 'latest'],
  ]) {
    const input = clone(original);
    organizationJob(input).steps.find((step) =>
      step.uses?.startsWith(action),
    ).with[setting] = weakened;
    assert.throws(
      () => validateCiGatePolicy(input),
      /workflow-organization/u,
      setting,
    );
  }
});

test('requires F07 always cleanup and complete strict qualification uploads', async () => {
  const original = await currentPolicyInput();
  for (const kind of ['cleanup', 'upload']) {
    for (const mutation of [
      'missing',
      'optional',
      'success-only',
      'early',
      'duplicate',
      'weakened',
    ]) {
      const input = clone(original);
      const job = organizationJob(input);
      const step = job.steps.find((candidate) =>
        kind === 'cleanup'
          ? candidate.run === 'docker compose down -v --remove-orphans'
          : candidate.with?.name === 'workflow-organization-qualification',
      );
      if (mutation === 'missing') job.steps.splice(job.steps.indexOf(step), 1);
      if (mutation === 'optional') step['continue-on-error'] = true;
      if (mutation === 'success-only') step.if = 'success()';
      if (mutation === 'duplicate') job.steps.push(clone(step));
      if (mutation === 'early') {
        job.steps.splice(job.steps.indexOf(step), 1);
        job.steps.unshift(step);
      }
      if (mutation === 'weakened') {
        if (kind === 'cleanup') step.run = 'docker compose down';
        else step.with['if-no-files-found'] = 'ignore';
      }
      assert.throws(
        () => validateCiGatePolicy(input),
        /workflow-organization/u,
        `${kind}:${mutation}`,
      );
    }
  }
  const input = clone(original);
  organizationJob(input).steps.find(
    (step) => step.with?.name === 'workflow-organization-qualification',
  ).with.path = '${{ runner.temp }}/curated-template-qualification';
  assert.throws(() => validateCiGatePolicy(input), /workflow-organization/u);
});

test('rejects absent, optional, late, or unshared archived dependency preparation', async () => {
  for (const mutation of [
    'missing',
    'optional',
    'conditional',
    'late',
    'store',
    'cache',
    'sharing',
  ]) {
    const input = await currentPolicyInput();
    const steps = input.workflow.jobs['curated-templates'].steps;
    const preparation = steps.find((step) =>
      step.run?.includes('prepare-curated-cutover-cache.mjs'),
    );
    if (mutation === 'missing') steps.splice(steps.indexOf(preparation), 1);
    else if (mutation === 'optional') preparation['continue-on-error'] = true;
    else if (mutation === 'conditional') preparation.if = 'false';
    else if (mutation === 'late') {
      steps.splice(steps.indexOf(preparation), 1);
      steps.push(preparation);
    } else if (mutation === 'store')
      preparation.run = preparation.run.replace(
        '$(pnpm store path --silent)',
        '/other/store',
      );
    else if (mutation === 'cache')
      preparation.run = preparation.run.replace(
        '$RUNNER_TEMP/curated-cutover-pnpm-cache',
        '/other/cache',
      );
    else preparation.run = preparation.run.replace('>> "$GITHUB_ENV"', '');
    assert.throws(
      () => validateCiGatePolicy(input),
      /curated-template.*cache/u,
      mutation,
    );
  }
});

test('rejects dropped, conditional, optional, or substituted curated-template qualification', async () => {
  const original = await currentPolicyInput();
  const qualification = (workflow) =>
    workflow.jobs['curated-templates'].steps.find((step) =>
      step.run?.includes('run-curated-template-qualification.mjs'),
    );
  for (const mutate of [
    (workflow) => {
      workflow.jobs['curated-templates'].steps = workflow.jobs[
        'curated-templates'
      ].steps.filter((step) => step !== qualification(workflow));
    },
    (workflow) => {
      workflow.jobs['curated-templates'].if = 'false';
    },
    (workflow) => {
      workflow.jobs['curated-templates']['continue-on-error'] = true;
    },
    (workflow) => {
      qualification(workflow).if = 'false';
    },
    (workflow) => {
      qualification(workflow)['continue-on-error'] = true;
    },
    (workflow) => {
      qualification(workflow).run = qualification(workflow).run.replace(
        'run-curated-template-qualification.mjs',
        'run-another-qualification.mjs',
      );
    },
  ]) {
    const input = clone(original);
    mutate(input.workflow);
    assert.throws(() => validateCiGatePolicy(input), /curated-template/u);
  }
});

test('rejects lost curated-template cleanup, artifact, and ordinary-suite routing', async () => {
  const original = await currentPolicyInput();
  for (const mutate of [
    (workflow) => {
      workflow.jobs['curated-templates'].steps = workflow.jobs[
        'curated-templates'
      ].steps.filter(
        (step) => step.run !== 'docker compose down -v --remove-orphans',
      );
    },
    (workflow) => {
      workflow.jobs['curated-templates'].steps.find(
        (step) => step.with?.name === 'curated-template-qualification',
      ).with['if-no-files-found'] = 'ignore';
    },
    (workflow) => {
      const step = workflow.jobs.integration.steps.find((candidate) =>
        candidate.run?.includes('artifacts/api-gates.json'),
      );
      step.run = step.run.replace(
        /\s*--exclude test\/curated-template-origin-guard\.integration\.test\.ts/u,
        '',
      );
    },
    (workflow) => {
      const step = workflow.jobs.integration.steps.find((candidate) =>
        candidate.run?.includes('artifacts/database-gates.json'),
      );
      step.run = step.run.replace(
        /\s*--exclude test\/workflow-template-origin-boundary\.integration\.test\.ts/u,
        '',
      );
    },
  ]) {
    const input = clone(original);
    mutate(input.workflow);
    assert.throws(
      () => validateCiGatePolicy(input),
      /curated-template|ordinary (?:API|database)/u,
    );
  }
});
