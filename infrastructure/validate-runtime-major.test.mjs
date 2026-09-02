import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeMajorSurfaces } from './validate-runtime-major.mjs';

function setupNodeStep(selector) {
  return (
    '- uses: actions/setup-node@v6\n' +
    '  with:\n' +
    `    node-version: ${selector}\n`
  );
}

function workflow(...steps) {
  const indentedSteps = steps
    .join('')
    .trimEnd()
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
  return (
    'jobs:\n' +
    '  test:\n' +
    '    runs-on: ubuntu-latest\n' +
    '    steps:\n' +
    `${indentedSteps}\n`
  );
}

const validSurfaces = {
  packageJson: {
    engines: { node: '>=24.0.0 <25.0.0' },
    devDependencies: { '@types/node': '24.13.3' },
  },
  workflows: new Map([
    ['ci.yml', workflow(setupNodeStep('24'), setupNodeStep("'24'"))],
  ]),
  dockerfile:
    'FROM node:24.18.1-bookworm-slim@sha256:abc AS build\n' +
    'FROM node:24.18.1-bookworm-slim@sha256:def AS runtime\n',
};

test('accepts matching runtime, ambient types, CI, and container majors', () => {
  assert.equal(validateRuntimeMajorSurfaces(validSurfaces), 24);
});

for (const [surface, update] of [
  [
    'ambient Node types',
    {
      packageJson: {
        ...validSurfaces.packageJson,
        devDependencies: { '@types/node': '25.0.0' },
      },
    },
  ],
  [
    'CI setup-node',
    { workflows: new Map([['ci.yml', workflow(setupNodeStep('25'))]]) },
  ],
  [
    'container base image',
    { dockerfile: 'FROM node:25.1.0-bookworm-slim@sha256:abc AS runtime\n' },
  ],
]) {
  test(`rejects a drifting ${surface} major`, () => {
    assert.throws(
      () => validateRuntimeMajorSurfaces({ ...validSurfaces, ...update }),
      /Node 24/,
    );
  });
}

test('rejects an engine range that spans more than one major', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        packageJson: {
          ...validSurfaces.packageJson,
          engines: { node: '>=24.0.0 <26.0.0' },
        },
      }),
    /single Node major/,
  );
});

test('rejects a dynamic setup-node selector even when another literal matches', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            workflow(
              setupNodeStep('24'),
              setupNodeStep('${{ matrix.node-version }}'),
            ),
          ],
        ]),
      }),
    /literal Node major/,
  );
});

test('rejects a drifting selector on a quoted setup-node action', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            workflow(
              setupNodeStep('24'),
              '- uses: "actions/setup-node@v6"\n' +
                '  with:\n' +
                '    node-version: 25\n',
            ),
          ],
        ]),
      }),
    /Node 24/,
  );
});

test('rejects a drifting selector on a case-variant setup-node action', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            workflow(
              setupNodeStep('24'),
              '- uses: Actions/setup-node@v6\n' +
                '  with:\n' +
                '    node-version: 25\n',
            ),
          ],
        ]),
      }),
    /Node 24/,
  );
});

test('ignores setup-node-like text inside a run block scalar', () => {
  assert.equal(
    validateRuntimeMajorSurfaces({
      ...validSurfaces,
      workflows: new Map([
        [
          'ci.yml',
          workflow(
            setupNodeStep('24'),
            '- run: |\n' +
              '    echo preparing fixture\n' +
              '    uses: actions/setup-node@v6\n',
          ),
        ],
      ]),
    }),
    24,
  );
});

test('rejects syntactically invalid workflow YAML', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          ...validSurfaces.workflows,
          ['invalid.yml', 'jobs:\n  test: [\n'],
        ]),
      }),
    /valid workflow YAML/,
  );
});

test('rejects node-version-file selectors that the gate cannot resolve', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            workflow(
              '- uses: actions/setup-node@v6\n' +
                '  with:\n' +
                '    node-version: 24\n' +
                '    node-version-file: .nvmrc\n',
            ),
          ],
        ]),
      }),
    /node-version-file/,
  );
});

test('rejects a setup-node step without a selector beside a valid step', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            workflow(setupNodeStep('24'), '- uses: actions/setup-node@v6\n'),
          ],
        ]),
      }),
    /each setup-node step/,
  );
});

test('rejects a setup-node step masked by an unrelated node-version key', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            'env:\n' +
              '  node-version: 24\n' +
              workflow('- uses: actions/setup-node@v6\n'),
          ],
        ]),
      }),
    /each setup-node step/,
  );
});

test('rejects a setup-node step masked by a sibling node-version key', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          [
            'ci.yml',
            workflow(
              '- uses: actions/setup-node@v6\n' +
                '  with:\n' +
                '    cache: pnpm\n' +
                '  env:\n' +
                '    node-version: 24\n',
            ),
          ],
        ]),
      }),
    /each setup-node step/,
  );
});
