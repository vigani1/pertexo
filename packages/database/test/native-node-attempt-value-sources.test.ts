import { describe, expect, it } from 'vitest';

import { parseNativeNodeAttemptValueSources } from '../src/execution/node-attempts/native-node-attempt-value-sources.js';

const workspaceId = '00000000-0000-4000-8000-000000000101';
const runId = '00000000-0000-4000-8000-000000000102';
const workflowVersionId = '00000000-0000-4000-8000-000000000103';
const provenanceId = '00000000-0000-4000-8000-000000000104';
const context = {
  workspaceId,
  runId,
  workflowVersionId,
  nodeId: 'consumer',
  invocationKey: 'consumer',
  admissionKind: 'execute',
  graphSchemaVersion: 2,
  executableSchemaVersion: 3,
  executableChecksum: `wf:v3:sha256:${'a'.repeat(64)}`,
  checkpointSchemaVersion: 3,
  runInputPresent: true,
  upstreamNodeOutputs: [],
};
const runInput = {
  slot: 'run_input',
  source: {
    kind: 'run_input',
    workspaceId,
    runId,
    workflowVersionId,
    provenanceId,
  },
  snapshot: {
    reference: { schemaVersion: 1, kind: 'inline', value: null },
    byteLength: 4,
    sha256: '74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b',
    serializedValue: 'null',
  },
};
const physicalOutput = {
  slot: 'upstream_output',
  source: {
    kind: 'physical_output',
    workspaceId,
    runId,
    workflowVersionId,
    provenanceId,
    nodeId: 'physical',
    invocationKey: 'physical-scope',
    attemptId: '00000000-0000-4000-8000-000000000105',
  },
  snapshot: runInput.snapshot,
};
const logicalResult = {
  slot: 'upstream_output',
  source: {
    kind: 'workflow_call_result',
    workspaceId,
    provenanceId,
    parentRunId: runId,
    parentWorkflowVersionId: workflowVersionId,
    childRunId: '00000000-0000-4000-8000-000000000106',
    childWorkflowVersionId: '00000000-0000-4000-8000-000000000107',
    nodeId: 'call',
    invocationKey: 'call-scope',
  },
  snapshot: {
    reference: {
      schemaVersion: 1,
      kind: 'artifact',
      artifactId: '00000000-0000-4000-8000-000000000108',
    },
    byteLength: 300_000,
    sha256: 'a'.repeat(64),
  },
};

describe('explicit native attempt source projection (not SQL authority)', () => {
  it('requires one exact nearest collection source and rejects missing, duplicated and wrong ordinal/node projections', () => {
    const structuredScope = { loopNodeId: 'loop', ordinal: 1 };
    const scope = { ...context, runInputPresent: false, structuredScope };
    const collection = {
      ...physicalOutput,
      slot: 'structured_collection',
      source: {
        ...physicalOutput.source,
        nodeId: 'loop',
        collection: {
          ...structuredScope,
          collectionSize: 2,
          declaredCollectionChecksum: 'a'.repeat(64),
        },
      },
    };
    expect(
      parseNativeNodeAttemptValueSources(scope, [collection]),
    ).toMatchObject({ structuredCollection: collection });
    expect(() => parseNativeNodeAttemptValueSources(scope, [])).toThrow(
      'collection source is missing',
    );
    expect(() =>
      parseNativeNodeAttemptValueSources(scope, [collection, collection]),
    ).toThrow('duplicated or out of scope');
    expect(() =>
      parseNativeNodeAttemptValueSources(
        { ...scope, structuredScope: undefined },
        [collection],
      ),
    ).toThrow('out of scope');
    for (const changed of [
      { ordinal: 0 },
      { loopNodeId: 'outer' },
      { collectionSize: 1 },
    ])
      expect(() =>
        parseNativeNodeAttemptValueSources(scope, [
          {
            ...collection,
            source: {
              ...collection.source,
              collection: { ...collection.source.collection, ...changed },
            },
          },
        ]),
      ).toThrow('out of scope');
  });
  it('projects a native run input with its exact accepted source and original bytes', () => {
    expect(parseNativeNodeAttemptValueSources(context, [runInput])).toEqual({
      runInput,
      completedNodeOutputs: [],
    });
  });
  it('preserves requested scope order and distinguishes logical child results from physical attempts', () => {
    expect(
      parseNativeNodeAttemptValueSources(
        {
          ...context,
          runInputPresent: false,
          upstreamNodeOutputs: [
            { nodeId: 'call', invocationKey: 'call-scope' },
            { nodeId: 'physical', invocationKey: 'physical-scope' },
          ],
        },
        [physicalOutput, logicalResult],
      ),
    ).toEqual({
      runInput: null,
      completedNodeOutputs: [logicalResult, physicalOutput],
    });
  });
  it('projects a Wait resume value only for the current node scope', () => {
    const resumeOutput = {
      ...physicalOutput,
      slot: 'wait_resume_output',
      source: {
        ...physicalOutput.source,
        nodeId: 'consumer',
        invocationKey: 'consumer',
      },
    };
    expect(
      parseNativeNodeAttemptValueSources(
        { ...context, admissionKind: 'wait_resume', runInputPresent: false },
        [resumeOutput],
      ),
    ).toEqual({
      runInput: null,
      resumeOutput,
      completedNodeOutputs: [],
    });
  });
  it('retains whitespace-bearing original inline bytes rather than re-encoding them', () => {
    const original = {
      ...runInput,
      snapshot: {
        ...runInput.snapshot,
        serializedValue: '  null\n',
        byteLength: 7,
        sha256:
          '1de3b0dead53fa3985bd22be34a0318b79273ce0f081aae1b0759464c7c526f0',
      },
    };
    expect(
      parseNativeNodeAttemptValueSources(context, [original]).runInput,
    ).toEqual(original);
  });
  it('rejects duplicate slots rather than silently replacing source truth', () => {
    expect(() =>
      parseNativeNodeAttemptValueSources(context, [runInput, runInput]),
    ).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(
        {
          ...context,
          upstreamNodeOutputs: [
            { nodeId: 'physical', invocationKey: 'physical-scope' },
          ],
        },
        [physicalOutput, physicalOutput],
      ),
    ).toThrow();
  });
  it.each([
    { graphSchemaVersion: 1 },
    { executableSchemaVersion: 2 },
    { checkpointSchemaVersion: 2 },
    { executableChecksum: `wf:v2:sha256:${'a'.repeat(64)}` },
  ])(
    'never selects this projection for retained or partial native grammars %j',
    (patch) => {
      expect(() =>
        parseNativeNodeAttemptValueSources({ ...context, ...patch }, [
          runInput,
        ]),
      ).toThrow();
    },
  );
  it('requires all and only the exact requested upstream scopes', () => {
    const requested = {
      ...context,
      runInputPresent: false,
      upstreamNodeOutputs: [
        { nodeId: 'physical', invocationKey: 'physical-scope' },
      ],
    };
    expect(() => parseNativeNodeAttemptValueSources(requested, [])).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(context, [physicalOutput]),
    ).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(requested, [
        {
          ...physicalOutput,
          source: { ...physicalOutput.source, nodeId: 'other' },
        },
      ]),
    ).toThrow();
  });
  it('requires Wait resume material only for a resume admission and matching node scope', () => {
    const resume = { ...physicalOutput, slot: 'wait_resume_output' };
    expect(() =>
      parseNativeNodeAttemptValueSources(context, [resume]),
    ).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(
        { ...context, admissionKind: 'wait_resume' },
        [resume],
      ),
    ).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(
        { ...context, admissionKind: 'wait_resume' },
        [],
      ),
    ).toThrow();
  });
  it('requires source identity and immutable byte metadata, not a bare candidate reference', () => {
    expect(() =>
      parseNativeNodeAttemptValueSources(context, [
        logicalResult.snapshot.reference,
      ]),
    ).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(context, [
        { ...runInput, snapshot: { ...runInput.snapshot, byteLength: 5 } },
      ]),
    ).toThrow();
    expect(() =>
      parseNativeNodeAttemptValueSources(context, [
        {
          ...runInput,
          source: { ...runInput.source, provenanceId: undefined },
        },
      ]),
    ).toThrow();
  });
});
