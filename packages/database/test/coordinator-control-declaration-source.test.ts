import { expect, it } from 'vitest';
import {
  parseCoordinatorControlDeclarationInventory,
  type NativeCoordinatorControlDeclarationIdentity,
} from '../src/execution/coordinator/coordinator-control-declaration-source.js';

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const owner = {
  workspaceId: id(1),
  runId: id(2),
  workflowVersionId: id(3),
  expectedRevision: 4,
  delivery: { outboxEventId: id(4), payloadChecksum: 'a'.repeat(64) },
};
const identity: NativeCoordinatorControlDeclarationIdentity = {
  sequence: 5,
  invocationKey: 'nested-control',
  nodeId: 'loop',
  attemptId: id(5),
  output: { kind: 'artifact', artifactId: id(6) },
  controlKind: 'for_each',
  branchPath: [{ nodeId: 'branch', outputPort: 'yes' }],
  iterationPath: [{ loopNodeId: 'outer', ordinal: 2 }],
};
function source() {
  return {
    ...structuredClone(identity),
    valueSource: {
      slot: 'upstream_output',
      source: {
        kind: 'physical_output',
        workspaceId: owner.workspaceId,
        runId: owner.runId,
        workflowVersionId: owner.workflowVersionId,
        provenanceId: id(7),
        nodeId: identity.nodeId,
        invocationKey: identity.invocationKey,
        attemptId: identity.attemptId,
      },
      valueIdentity: {
        reference: { schemaVersion: 1, kind: 'artifact', artifactId: id(6) },
        sha256: 'b'.repeat(64),
        byteLength: 300_000,
        mediaType: 'application/vnd.pertexo.execution-value+json;version=1',
      },
    },
  };
}

it('reconciles every ordered scoped physical fact without inline payloads', () => {
  const actual = source();
  expect(
    parseCoordinatorControlDeclarationInventory([actual], owner, [identity]),
  ).toEqual([actual]);
  expect(parseCoordinatorControlDeclarationInventory([], owner, [])).toEqual(
    [],
  );
});

it.each([
  'sequence',
  'attempt',
  'invocation',
  'scope',
  'artifact',
  'workspace',
  'payload',
])(
  'rejects %s identity drift rather than dropping a needed control fact',
  (kind) => {
    const actual = source();
    if (kind === 'sequence') actual.sequence++;
    if (kind === 'attempt') actual.valueSource.source.attemptId = id(8);
    if (kind === 'invocation')
      actual.valueSource.source.invocationKey = 'other';
    if (kind === 'scope')
      actual.iterationPath = [{ loopNodeId: 'outer', ordinal: 3 }];
    if (kind === 'artifact')
      actual.valueSource.valueIdentity.reference.artifactId = id(8);
    if (kind === 'workspace') actual.valueSource.source.workspaceId = id(8);
    if (kind === 'payload')
      Object.assign(actual.valueSource.valueIdentity.reference, {
        value: 'forbidden',
      });
    expect(() =>
      parseCoordinatorControlDeclarationInventory([actual], owner, [identity]),
    ).toThrow(Error);
  },
);

it('rejects missing, duplicated and out-of-order facts', () => {
  expect(() =>
    parseCoordinatorControlDeclarationInventory([], owner, [identity]),
  ).toThrow(TypeError);
  const actual = source();
  expect(() =>
    parseCoordinatorControlDeclarationInventory([actual, actual], owner, [
      identity,
      identity,
    ]),
  ).toThrow(TypeError);
  const second = source();
  second.sequence = 4;
  second.attemptId = id(9);
  second.invocationKey = 'second';
  second.valueSource.source.attemptId = id(9);
  second.valueSource.source.invocationKey = 'second';
  const secondIdentity = {
    ...identity,
    sequence: 4,
    attemptId: id(9),
    invocationKey: 'second',
  };
  expect(() =>
    parseCoordinatorControlDeclarationInventory([actual, second], owner, [
      identity,
      secondIdentity,
    ]),
  ).toThrow(TypeError);
});

it('preserves parallel inline-only and excludes logical Call source shapes', () => {
  const parallel = source();
  parallel.controlKind = 'parallel';
  const expected = { ...identity, controlKind: 'parallel' as const };
  expect(() =>
    parseCoordinatorControlDeclarationInventory([parallel], owner, [expected]),
  ).toThrow(TypeError);
  const call = source();
  Object.assign(call.valueSource.source, { kind: 'workflow_call_result' });
  expect(() =>
    parseCoordinatorControlDeclarationInventory([call], owner, [identity]),
  ).toThrow(Error);
});
