import type { PublishedWorkflowV3Projection } from '@pertexo/database/execution';
import {
  CORE_REGISTRY_RELEASE,
  CORE_REGISTRY_RELEASE_SUCCESSOR,
} from '@pertexo/nodes-core';
import {
  buildWorkflowExecutableV3,
  composeExecutableCompatibilityReleaseV3,
  createExecutableCompatibilityReleaseSupport,
} from '@pertexo/workflow-engine';
import { describe, expect, it } from 'vitest';
import { verifyPersistedWorkflowProjection } from '../src/execution/persisted-workflow-projection.js';
import {
  VERSION_ID,
  WORKFLOW_ID,
  WORKSPACE_ID,
  graph,
} from './support/execution-engine.fixture.js';

const admission = composeExecutableCompatibilityReleaseV3(
  CORE_REGISTRY_RELEASE,
);
const current = composeExecutableCompatibilityReleaseV3(
  CORE_REGISTRY_RELEASE_SUCCESSOR,
);
const support = createExecutableCompatibilityReleaseSupport([
  admission,
  current,
]);
const executable = buildWorkflowExecutableV3({
  graph: {
    ...graph(),
    schemaVersion: 2,
    callable: {
      schemaVersion: 1,
      input: { type: 'object', properties: {}, required: [] },
      result: { type: 'object', properties: {}, required: [] },
      resultSelector: { kind: 'literal', value: {} },
    },
  },
  release: admission,
});
const currentDescription = support.descriptions.at(-1);
if (currentDescription === undefined)
  throw new Error('Missing current release fixture');
const projection: PublishedWorkflowV3Projection = {
  id: VERSION_ID,
  workspaceId: WORKSPACE_ID,
  workflowId: WORKFLOW_ID,
  versionNumber: 1,
  schemaVersion: 2,
  checksum: executable.checksum,
  executableSchemaVersion: 3,
  executableJson: executable.envelope,
  compatibilityReleaseEpoch: admission.epoch,
  currentCompatibilityRelease: currentDescription,
};

describe('persisted explicit V3 artifact authentication', () => {
  it('authenticates the exact admitted artifact against a distinct supported current catalog', () => {
    const verified = verifyPersistedWorkflowProjection(projection, {
      admissionRelease: admission,
      releaseSupport: support,
    });
    expect(verified.checksum).toBe(executable.checksum);
    expect(verified.envelope.schemaVersion).toBe(3);
    expect(verified.envelope.compatibilityReleaseEpoch).toBe(admission.epoch);
    expect(admission.epoch).not.toBe(current.epoch);
    expect(
      verifyPersistedWorkflowProjection(projection, {
        admissionRelease: admission,
        releaseSupport: support,
      }).checksum,
    ).toBe(verified.checksum);
    expect(Object.isFrozen(verified.envelope)).toBe(true);
  });

  it.each([
    { ...projection, checksum: `wf:v3:sha256:${'f'.repeat(64)}` },
    {
      ...projection,
      executableJson: { ...executable.envelope, schemaVersion: 2 },
    },
    {
      ...projection,
      executableJson: { ...executable.envelope, sourceGraphSchemaVersion: 1 },
    },
    {
      ...projection,
      executableJson: {
        ...executable.envelope,
        familyPolicy: { ...executable.envelope.familyPolicy, maxDepth: 99 },
      },
    },
    {
      ...projection,
      executableJson: {
        ...executable.envelope,
        graph: { ...executable.envelope.graph, callable: undefined },
      },
    },
  ])(
    'rejects tampered V3 body/checksum without a V2 fallback %#',
    (candidate) => {
      expect(() =>
        verifyPersistedWorkflowProjection(candidate, {
          admissionRelease: admission,
          releaseSupport: support,
        }),
      ).toThrow();
    },
  );

  it('rejects outer epoch disagreement and missing/unsupported catalog truth', () => {
    expect(() =>
      verifyPersistedWorkflowProjection(
        { ...projection, compatibilityReleaseEpoch: current.epoch },
        { admissionRelease: admission, currentRelease: current },
      ),
    ).toThrow('epoch');
    const { currentCompatibilityRelease: _current, ...withoutCurrent } =
      projection;
    expect(() =>
      verifyPersistedWorkflowProjection(withoutCurrent, {
        admissionRelease: admission,
        releaseSupport: support,
      }),
    ).toThrow('missing');
    expect(() =>
      verifyPersistedWorkflowProjection(
        { ...projection, compatibilityReleaseEpoch: current.epoch + 1 },
        { admissionRelease: admission, releaseSupport: support },
      ),
    ).toThrow('missing');
    expect(() =>
      verifyPersistedWorkflowProjection(
        {
          ...projection,
          currentCompatibilityRelease: {
            ...currentDescription,
            fingerprint: `node-compat:v1:sha256:${'f'.repeat(64)}`,
          },
        },
        { admissionRelease: admission, releaseSupport: support },
      ),
    ).toThrow();
  });

  it('rejects mislabeled outer graph or executable format rather than trusting a valid body alone', () => {
    const malformed = {
      ...projection,
      schemaVersion: 1,
    } as unknown as PublishedWorkflowV3Projection;
    expect(() =>
      verifyPersistedWorkflowProjection(malformed, {
        admissionRelease: admission,
        currentRelease: current,
      }),
    ).toThrow('format columns');
    const unsupported = {
      ...projection,
      executableSchemaVersion: 4,
    } as unknown as PublishedWorkflowV3Projection;
    expect(() =>
      verifyPersistedWorkflowProjection(unsupported, {
        admissionRelease: admission,
        currentRelease: current,
      }),
    ).toThrow();
  });
});
