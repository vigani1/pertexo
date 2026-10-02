import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parse as parseYaml } from 'yaml';

import { validateCiGatePolicy } from './validate-ci-gates.mjs';

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
    steps:
      - run: pnpm ci:gates:check
      - run: pnpm build
      - run: pnpm architecture:check
      - run: pnpm built-exports:check
      - run: pnpm quality:local:check
  integration:
    steps:
      - run: pnpm mutation:check
  browser:
    steps:
      - run: pnpm --filter @pertexo/web exec playwright install --with-deps chromium firefox webkit
      - run: pnpm test:browser-probes
`);
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
  omitted.workflow.jobs.quality.steps.splice(2, 1);
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

test('rejects built-export validation before its build owner', () => {
  const input = fixture();
  const steps = input.workflow.jobs.quality.steps;
  [steps[1], steps[3]] = [steps[3], steps[1]];
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
  misplacedMutation.workflow.jobs.integration.steps = [];
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
