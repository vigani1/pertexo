import { expect, it } from 'vitest';
import { fixture, paste, save } from './step-sample.fixture.js';
import { authoring, queryAsOwner } from '../../support/workflow-authoring.js';

it('keeps a legacy sample available but marks it stale after the identity update', async () => {
  const f = await fixture();
  const pin = await authoring.stepSamples.put(paste(f));
  // The pre-update sample identity for this unchanged fixture.
  const legacy =
    '{"config":{"value":"real"},"configVersion":1,"connectionRefs":{},"definition":{"key":"test.placeholder","version":1},"disabled":false,"inputMappings":{},"structured":null}';
  await queryAsOwner(
    'update app.workflow_step_samples set binding=$2,retained_bytes=octet_length($2::text)+octet_length(output_ref) where id=$1',
    [pin.sampleId, legacy],
    f.scope.workspaceId,
  );
  const result = await authoring.stepSamples.get(f.scope);
  expect(result.sample).toMatchObject({ id: pin.sampleId, state: 'stale' });
  expect(result.output).toMatchObject({
    kind: 'inline',
    value: { fixture: true },
  });
});

it('keeps samples valid across notes edits and marks reordered mapping fields stale', async () => {
  const f = await fixture();
  const node = f.graph.nodes[0];
  if (node === undefined) throw new Error('Missing sample step');
  const a = { kind: 'literal', value: 1 } as const;
  const b = { kind: 'literal', value: 2 } as const;
  const configured = {
    ...f.graph,
    nodes: [{ ...node, inputMappings: { a, b } }],
  };
  const current = await save(f, configured);
  await authoring.stepSamples.put({
    ...paste(f),
    expectedDraftRevision: current.revision,
  });
  await save(f, {
    ...configured,
    notes: [
      {
        id: '00000000-0000-4000-8000-000000000001',
        text: 'Documentation',
        position: { x: 0, y: 0 },
        size: { width: 320, height: 200 },
        color: 'violet',
      },
    ],
  });
  expect((await authoring.stepSamples.get(f.scope)).sample?.state).toBe(
    'pinned',
  );
  await save(f, {
    ...configured,
    nodes: [{ ...node, inputMappings: { b, a } }],
  });
  expect((await authoring.stepSamples.get(f.scope)).sample?.state).toBe(
    'stale',
  );
});
