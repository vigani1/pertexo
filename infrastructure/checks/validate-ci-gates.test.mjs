import assert from 'node:assert/strict';
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
