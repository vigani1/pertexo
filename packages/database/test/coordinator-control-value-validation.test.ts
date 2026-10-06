import { expect, it } from 'vitest';
import { inspectForEachCollection } from '@pertexo/workflow-model';
import {
  validateCoordinatorControlDeclarationSet,
  validateCoordinatorControlValue,
} from '../src/execution/coordinator/coordinator-control-value-validation.js';
import {
  nativeCoordinatorControlFixture as fixture,
  nativeControlId as id,
} from './support/coordinator-native-control.fixture.js';

it.each([{ items: [] }, { items: ['x'.repeat(300_000)] }])(
  'compares fresh empty/large artifact semantics against exact immutable loop parameters',
  ({ items }) => {
    const f = fixture(items);
    expect(
      validateCoordinatorControlValue(f.material, f.plan, f.source, f.value),
    ).toEqual(inspectForEachCollection(f.value));
    expect(() => {
      validateCoordinatorControlDeclarationSet(f.material, f.plan);
    }).not.toThrow();
  },
);

it.each(['count', 'checksum', 'reference', 'roots', 'sink', 'bound', 'scope'])(
  'rejects %s plan drift independently of the advance summaries',
  (kind) => {
    const f = fixture();
    if (f.plan.checkpoint.schemaVersion !== 3)
      throw new Error('native fixture missing');
    const loop = f.plan.checkpoint.loops[0];
    if (loop === undefined) throw new Error('loop fixture missing');
    const changed = { ...loop };
    if (kind === 'count') changed.collectionSize++;
    if (kind === 'checksum') changed.collectionChecksum = 'b'.repeat(64);
    if (kind === 'reference')
      changed.collection = { kind: 'artifact', artifactId: id(8) };
    if (kind === 'roots') changed.bodyRootNodeIds = ['other'];
    if (kind === 'sink') changed.bodySinkNodeId = 'other';
    if (kind === 'bound') changed.maxIterations++;
    if (kind === 'scope')
      changed.branchPath = [{ nodeId: 'branch', outputPort: 'yes' }];
    const plan = {
      ...f.plan,
      checkpoint: { ...f.plan.checkpoint, loops: [changed] },
    };
    expect(() =>
      validateCoordinatorControlValue(f.material, plan, f.source, f.value),
    ).toThrow();
  },
);

it('rejects invented loop or branch declarations absent from the freshly selected fact set', () => {
  const f = fixture();
  expect(() => {
    validateCoordinatorControlDeclarationSet(
      { ...f.material, sources: [] },
      f.plan,
    );
  }).toThrow();
  if (f.plan.checkpoint.schemaVersion !== 3)
    throw new Error('native fixture missing');
  const plan = {
    ...f.plan,
    checkpoint: {
      ...f.plan.checkpoint,
      branchSelections: [
        {
          invocationKey: 'invented',
          nodeId: 'branch',
          selectedOutputPort: 'true',
        },
      ],
    },
  };
  expect(() => {
    validateCoordinatorControlDeclarationSet(f.material, plan);
  }).toThrow();
});
