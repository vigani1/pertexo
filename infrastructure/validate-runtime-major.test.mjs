import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRuntimeMajorSurfaces } from './validate-runtime-major.mjs';

const validSurfaces = {
  packageJson: {
    engines: { node: '>=24.0.0 <25.0.0' },
    devDependencies: { '@types/node': '24.13.3' },
  },
  workflows: new Map([['ci.yml', "node-version: 24\nnode-version: '24'\n"]]),
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
  ['CI setup-node', { workflows: new Map([['ci.yml', 'node-version: 25\n']]) }],
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
            'node-version: 24\nnode-version: ${{ matrix.node-version }}\n',
          ],
        ]),
      }),
    /literal Node major/,
  );
});

test('rejects node-version-file selectors that the gate cannot resolve', () => {
  assert.throws(
    () =>
      validateRuntimeMajorSurfaces({
        ...validSurfaces,
        workflows: new Map([
          ['ci.yml', 'node-version: 24\nnode-version-file: .nvmrc\n'],
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
            '- uses: actions/setup-node@v6\n' +
              '  with:\n' +
              '    node-version: 24\n' +
              '- uses: actions/setup-node@v6\n',
          ],
        ]),
      }),
    /each setup-node step/,
  );
});
