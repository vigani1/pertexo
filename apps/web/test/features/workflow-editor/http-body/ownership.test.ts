import { expect, it } from 'vitest';
import {
  applyBodyValue,
  bodyValue,
  newFormPart,
  validateBodyDraft,
} from '@/features/workflow-editor/model/inspector/http-body';
import type { WorkflowNode } from '@/features/workflow-editor/model/graph/scopes';

it('keeps address and header mappings when replacing and editing the HTTP body', () => {
  const node: WorkflowNode = {
    id: 'http',
    definition: { key: 'http.request', version: 1 },
    configVersion: 1,
    position: { x: 0, y: 0 },
    config: {
      method: 'POST',
      url: 'https://example.test/orders/{orderId}',
      headers: { 'X-Trace': '{traceId}' },
    },
    inputMappings: {
      orderId: { kind: 'run_input', path: '$.orderId' },
      traceId: { kind: 'literal', value: 'trace' },
      body: { kind: 'literal', value: 'old body' },
    },
    connectionRefs: {},
  };
  const part = newFormPart('text');
  const result = validateBodyDraft(
    { mode: 'multipart', parts: [part] },
    { nodes: [node], edges: [] },
    node.id,
  );
  if (!result.ok) throw new Error(result.error);
  const multipart = { ...node, ...applyBodyValue(result.value, node) };
  expect(multipart.inputMappings).toEqual({
    orderId: node.inputMappings.orderId,
    traceId: node.inputMappings.traceId,
    [part.inputKey]: { kind: 'literal', value: '' },
  });
  const loaded = bodyValue(multipart);
  if (loaded === undefined)
    throw new Error('Expected a readable multipart body');
  const edited = {
    ...multipart,
    ...applyBodyValue(
      {
        ...loaded,
        inputMappings: {
          [part.inputKey]: { kind: 'literal', value: 'edited part' },
        },
      },
      multipart,
    ),
  };
  expect(edited.inputMappings).toEqual({
    orderId: node.inputMappings.orderId,
    traceId: node.inputMappings.traceId,
    [part.inputKey]: { kind: 'literal', value: 'edited part' },
  });
  const raw = applyBodyValue(
    {
      multipart: undefined,
      inputMappings: { body: { kind: 'literal', value: 'new body' } },
    },
    edited,
  );
  expect(raw.inputMappings).toEqual({
    orderId: node.inputMappings.orderId,
    traceId: node.inputMappings.traceId,
    body: { kind: 'literal', value: 'new body' },
  });
  expect(raw.config).toEqual(node.config);
});
